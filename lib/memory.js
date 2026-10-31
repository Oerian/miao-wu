/**
 * 分层记忆（支持命名存档）
 *
 * 1. 工作记忆  ctx      —— 最近 N 轮原文
 * 2. 情景摘要  summary  —— 被压缩掉的旧对话的摘要
 * 3. 情景记忆  episodes —— 提炼出来的"发生过的事"
 * 4. 实体记忆  facts    —— 主人是谁、偏好、约定、临时场景
 * 5. 出场状态  cast     —— 当前谁在场，从谁切过来的
 * 6. 绘图方案  plan     —— 上一张图的 tag
 *
 * 命名存档（profile）：
 *   同一个 QQ 可以开多份独立记忆，互不干扰。
 *   默认存档用不带前缀的 key（向后兼容），其它存档加前缀：
 *     default → miaowu:ctx:123
 *     工作     → miaowu:工作:ctx:123
 *
 * 存储：Redis 为主 + 本地文件双写。Redis 没起也能用。
 */
import fs from "node:fs"
import path from "node:path"
import { dataDir } from "./config.js"
import { writeFileAtomic, ymd } from "./util.js"

const P = "miaowu"
const DEFAULT_PROFILE = "default"
const log = () => globalThis.logger || console

let DIR = ""

function dir(conf) {
  if (!DIR) DIR = path.join(dataDir(conf || {}), "kv")
  try {
    fs.mkdirSync(DIR, { recursive: true })
  } catch {}
  return DIR
}

function fileOf(conf, key) {
  /*
   * 落盘文件名要满足两个条件：
   *   1. 不能带冒号 —— Windows 上 "a:b.json" 会被当成 NTFS 备用数据流，open 直接 ENOENT
   *   2. 必须可逆 —— 存档名是中文，用 \w 过滤会把「工作」「生活」全变成 "_"，
   *      几个存档共用一个文件，隔离就废了
   * 所以用百分号转义，读目录时再还原。
   */
  const safe = encodeURIComponent(key)
  return path.join(dir(conf), safe + ".json")
}

/* ------------------------------------------------------------ KV 底座 */

async function kvGet(conf, key) {
  const c = globalThis.redis
  if (c?.isOpen) {
    try {
      const v = await c.get(key)
      if (v != null) {
        try {
          return JSON.parse(v)
        } catch {
          return v
        }
      }
      return null
    } catch {}
  }
  try {
    const box = JSON.parse(fs.readFileSync(fileOf(conf, key), "utf-8"))
    if (box.exp && Date.now() > box.exp) return null
    return box.v
  } catch {
    return null
  }
}

async function kvSet(conf, key, val, ttlSec = 0) {
  const payload = JSON.stringify(val)
  const c = globalThis.redis
  if (c?.isOpen) {
    try {
      if (ttlSec > 0) await c.setEx(key, ttlSec, payload)
      else await c.set(key, payload)
    } catch (e) {
      log().debug?.(`[miao-wu] redis 写失败，仅落盘：${e.message}`)
    }
  }
  const exp = ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0
  try {
    await writeFileAtomic(fileOf(conf, key), JSON.stringify({ v: val, t: Date.now(), exp }))
  } catch (e) {
    log().debug?.(`[miao-wu] 落盘失败：${e.message}`)
  }
}

async function kvDel(conf, key) {
  const c = globalThis.redis
  if (c?.isOpen) {
    try {
      await c.del(key)
    } catch {}
  }
  try {
    fs.unlinkSync(fileOf(conf, key))
  } catch {}
}

/* ------------------------------------------------------- 通用 KV 出口 */

/**
 * 给别的模块（clock 之类）用的通用读写。
 * 不暴露 kvGet/kvSet 原名，免得外面绕过存档规则乱写 key。
 */
export async function kvLoad(conf, key) {
  return kvGet(conf, key)
}

export async function kvSave(conf, key, val, ttlSec = 0) {
  return kvSet(conf, key, val, ttlSec)
}

/**
 * 有数据的所有 QQ。
 *
 * 定时器要跨用户扫，WebUI 也要让人切用户，所以得知道"有哪些人"。
 * 从 ctx key 反推（`miaowu:ctx:123` / `miaowu:工作:ctx:123`）。
 */
export async function allUsers(conf) {
  const out = new Set()
  // 有上下文、或者有定时提醒的，都算"这个插件认识的用户"
  // （只设过闹钟还没聊过天的人，也不能把闹钟弄丢）
  const QQ_OF = /(?:^|:)(?:ctx|remind):(\d+)$/

  const c = globalThis.redis
  if (c?.isOpen) {
    try {
      for (const pat of [`${P}:*ctx:*`, `${P}:*remind:*`]) {
        for (const key of await c.keys(pat)) {
          const m = String(key).match(QQ_OF)
          if (m) out.add(m[1])
        }
      }
    } catch {}
  }

  try {
    for (const f of fs.readdirSync(dir(conf))) {
      if (!f.endsWith(".json")) continue
      let key = ""
      try {
        key = decodeURIComponent(f.slice(0, -5))
      } catch {
        continue
      }
      const m = key.match(QQ_OF)
      if (m) out.add(m[1])
    }
  } catch {}

  return [...out]
}


/* -------------------------------------------------------- 存档（profile） */

/** 存档名缓存，免得每读一次上下文就多查一次 kv */
const profCache = new Map()

/** 存档名只留中文/字母/数字/下划线，防 key 和路径被搞坏 */
export function sanitizeProfile(name) {
  const s = String(name || "")
    .trim()
    .replace(/[:/\\.*?"<>|\s]+/g, "_")
    .slice(0, 24)
  return s || DEFAULT_PROFILE
}

const curProfileKey = qq => `${P}:cur:${qq}`
const profListKey = qq => `${P}:profs:${qq}`

/** 记过名的存档集合。光靠 ctx 推断会漏掉「刚建好还没说话」的空档 */
async function readProfSet(conf, qq) {
  const arr = await kvGet(conf, profListKey(qq))
  return new Set(Array.isArray(arr) ? arr.map(String) : [])
}

async function addProf(conf, qq, name) {
  const set = await readProfSet(conf, qq)
  if (set.has(name)) return set
  set.add(name)
  await kvSet(conf, profListKey(qq), [...set].sort())
  return set
}

export async function getProfile(conf, qq) {
  const k = String(qq)
  const hit = profCache.get(k)
  if (hit) return hit
  const v = await kvGet(conf, curProfileKey(qq))
  const name = sanitizeProfile(v || conf?.memory?.defaultProfile || DEFAULT_PROFILE)
  profCache.set(k, name)
  return name
}

export async function setProfile(conf, qq, name) {
  const n = sanitizeProfile(name)
  profCache.set(String(qq), n)
  await kvSet(conf, curProfileKey(qq), n)
  await addProf(conf, qq, n)
  return n
}

/** 列出这个 QQ 下所有存档 */
export async function listProfiles(conf, qq) {
  const out = await readProfSet(conf, qq)

  // Redis
  const c = globalThis.redis
  if (c?.isOpen) {
    try {
      if (await c.get(`${P}:ctx:${qq}`)) out.add(DEFAULT_PROFILE)
      const keys = await c.keys(`${P}:*:ctx:${qq}`)
      for (const key of keys) {
        const m = key.match(new RegExp(`^${P}:(.+):ctx:${qq}$`))
        if (m) out.add(m[1])
      }
    } catch {}
  }

  // 文件（Redis 没起时唯一来源）
  try {
    for (const f of fs.readdirSync(dir(conf))) {
      if (!f.endsWith(".json")) continue
      let key = ""
      try {
        key = decodeURIComponent(f.slice(0, -5))
      } catch {
        continue
      }
      if (key === `${P}:ctx:${qq}`) {
        out.add(DEFAULT_PROFILE)
        continue
      }
      const m = key.match(new RegExp(`^${P}:(.+):ctx:${qq}$`))
      if (m) out.add(m[1])
    }
  } catch {}

  if (!out.size) out.add(DEFAULT_PROFILE)
  return [...out].sort()
}

/** 按存档拼 key。默认存档不带前缀，保持兼容 */
function keyOf(qq, prof, kind) {
  return prof === DEFAULT_PROFILE ? `${P}:${kind}:${qq}` : `${P}:${prof}:${kind}:${qq}`
}

async function keysOf(conf, qq) {
  const prof = await getProfile(conf, qq)
  return {
    prof,
    ctx: keyOf(qq, prof, "ctx"),
    sum: keyOf(qq, prof, "sum"),
    ep: keyOf(qq, prof, "ep"),
    fact: keyOf(qq, prof, "fact"),
    cast: keyOf(qq, prof, "cast"),
    plan: keyOf(qq, prof, "plan"),
    last: keyOf(qq, prof, "last"),
    noreply: keyOf(qq, prof, "noreply"),
    pro: d => keyOf(qq, prof, `pro:${d}`),
  }
}

/* -------------------------------------------------------- 工作记忆 */

export async function loadCtx(conf, qq) {
  const k = await keysOf(conf, qq)
  const ttlMin = conf?.chat?.ttlMin ?? 240
  const arr = await kvGet(conf, k.ctx)
  if (!Array.isArray(arr) || !arr.length) return []
  const last = arr[arr.length - 1]
  if (last?.t && Date.now() - last.t > ttlMin * 60000) return []
  return arr
}

export async function saveCtx(conf, qq, arr) {
  const k = await keysOf(conf, qq)
  const ttlMin = conf?.chat?.ttlMin ?? 240
  /*
   * 保留轮数必须大于压缩触发阈值，否则上下文在到达阈值前就被截断，
   * 压缩永远触发不了。喂给模型时 buildMessages 还会按 maxTurns 再截一次。
   */
  const maxTurns = Number(conf?.chat?.maxTurns ?? 12)
  const trigger = Number(conf?.compress?.triggerTurns ?? 16)
  const keepTurns = Number(conf?.compress?.keepTurns ?? 8)
  const cap = Math.max(maxTurns, conf?.compress?.enabled === false ? maxTurns : trigger + keepTurns)
  const trimmed = arr.slice(-cap * 2)
  await kvSet(conf, k.ctx, trimmed, ttlMin * 60)
  return trimmed
}

export async function pushCtx(conf, qq, userText, botText) {
  const arr = await loadCtx(conf, qq)
  const now = Date.now()
  if (userText) arr.push({ role: "user", content: String(userText), t: now })
  if (botText) arr.push({ role: "assistant", content: String(botText), t: now })
  return saveCtx(conf, qq, arr)
}

/** 只塞一条 assistant（开场白用） */
export async function pushAssistant(conf, qq, text) {
  const arr = await loadCtx(conf, qq)
  if (!text) return arr
  arr.push({ role: "assistant", content: String(text), t: Date.now() })
  return saveCtx(conf, qq, arr)
}

export async function dropOldest(conf, qq, n) {
  const arr = await loadCtx(conf, qq)
  if (n <= 0) return arr
  const rest = arr.slice(n)
  await saveCtx(conf, qq, rest)
  return rest
}

/**
 * 砍掉最后 n 条（「重来」「撤回」用）
 * @returns {{removed: object[], ctx: object[]}}
 */
export async function popLast(conf, qq, n = 1) {
  const arr = await loadCtx(conf, qq)
  const cnt = Math.min(Math.max(0, n), arr.length)
  const removed = arr.slice(arr.length - cnt)
  const rest = arr.slice(0, arr.length - cnt)
  await saveCtx(conf, qq, rest)
  return { removed, ctx: rest }
}

/** 改写最后一条 assistant（「改」命令用） */
export async function setLastAssistant(conf, qq, text) {
  const arr = await loadCtx(conf, qq)
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].role === "assistant") {
      arr[i] = { ...arr[i], content: String(text), t: Date.now() }
      await saveCtx(conf, qq, arr)
      return true
    }
  }
  return false
}

/** 最后一条 user 说了什么（「重来」要知道重新回哪句） */
export async function lastUserText(conf, qq) {
  const arr = await loadCtx(conf, qq)
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].role === "user") return arr[i].content
  }
  return ""
}

/* -------------------------------------------------------- 情景摘要 */

export async function getSummary(conf, qq) {
  const k = await keysOf(conf, qq)
  const s = await kvGet(conf, k.sum)
  return s && s.text ? s : { text: "", turns: 0, t: 0 }
}

export async function setSummary(conf, qq, text, turns) {
  const k = await keysOf(conf, qq)
  const box = { text: String(text || ""), turns: Number(turns || 0), t: Date.now() }
  await kvSet(conf, k.sum, box, (conf?.chat?.ttlMin ?? 240) * 60)
  return box
}

/* -------------------------------------------------------- 情景记忆 */

export async function listEpisodes(conf, qq) {
  const k = await keysOf(conf, qq)
  const arr = await kvGet(conf, k.ep)
  return Array.isArray(arr) ? arr : []
}

export async function addEpisode(conf, qq, text, kind = "event") {
  const t = String(text || "").trim()
  if (!t) return null
  const k = await keysOf(conf, qq)
  const arr = await listEpisodes(conf, qq)
  if (arr.some(e => e.text === t)) return null
  const item = { t: Date.now(), text: t, kind }
  arr.push(item)
  const max = Number(conf?.memory?.maxEpisodes ?? 200)
  await kvSet(conf, k.ep, arr.slice(-max))
  return item
}

export async function recentEpisodes(conf, qq, n = 8) {
  const arr = await listEpisodes(conf, qq)
  return arr.slice(-n)
}

/* -------------------------------------------------------- 实体记忆 */

export async function listFacts(conf, qq) {
  const k = await keysOf(conf, qq)
  const o = await kvGet(conf, k.fact)
  return o && typeof o === "object" && !Array.isArray(o) ? o : {}
}

export async function setFact(conf, qq, key, value) {
  const k = await keysOf(conf, qq)
  const o = await listFacts(conf, qq)
  o[String(key)] = { v: String(value), t: Date.now() }
  await kvSet(conf, k.fact, o)
  return o
}

export async function delFact(conf, qq, key) {
  const k = await keysOf(conf, qq)
  const o = await listFacts(conf, qq)
  delete o[String(key)]
  await kvSet(conf, k.fact, o)
  return o
}

/** 内部专用键，带这个前缀的不显示在「关于他」里 */
export const HIDDEN = "__"

export async function getHidden(conf, qq, key) {
  const o = await listFacts(conf, qq)
  return o[`${HIDDEN}${key}`]?.v || ""
}

export async function setHidden(conf, qq, key, value) {
  if (value === "" || value == null) {
    return delFact(conf, qq, `${HIDDEN}${key}`)
  }
  return setFact(conf, qq, `${HIDDEN}${key}`, value)
}

/** 拼成 "名字：小明；工作：程序员"（自动跳过内部键） */
export async function factsLine(conf, qq, limit = 12) {
  const o = await listFacts(conf, qq)
  const ents = Object.entries(o)
    .filter(([k]) => !k.startsWith(HIDDEN))
    .sort((a, b) => (b[1]?.t || 0) - (a[1]?.t || 0))
    .slice(0, limit)
  if (!ents.length) return ""
  return ents.map(([k, v]) => `${k}：${v?.v ?? v}`).join("；")
}

/* -------------------------------------------------------- 出场状态 */

export async function getCast(conf, qq) {
  const k = await keysOf(conf, qq)
  const o = await kvGet(conf, k.cast)
  return o && typeof o === "object" ? o : null
}

export async function setCast(conf, qq, charId, charName) {
  const k = await keysOf(conf, qq)
  const old = (await getCast(conf, qq)) || { history: [] }
  const box = {
    current: charId,
    name: charName || charId,
    since: Date.now(),
    history: [
      ...(old.history || []),
      { id: charId, name: charName || charId, at: Date.now(), from: old.current || "" },
    ].slice(-30),
  }
  await kvSet(conf, k.cast, box)
  return box
}

/* -------------------------------------------------------- 绘图方案 */

export async function saveLastPlan(conf, qq, plan, subject) {
  const k = await keysOf(conf, qq)
  const ttlMin = Number(conf?.draw?.lastPlanTtlMin ?? 30)
  const box = {
    subject: String(subject || ""),
    positive: plan.positive,
    negative: plan.negative,
    width: plan.width,
    height: plan.height,
    steps: plan.steps,
    cfg: plan.cfg,
    lora: plan.lora || [],
    createdAt: Date.now(),
  }
  await kvSet(conf, k.plan, box, ttlMin * 60)
  return box
}

export async function loadLastPlan(conf, qq) {
  const k = await keysOf(conf, qq)
  const p = await kvGet(conf, k.plan)
  return p?.positive ? p : null
}

/* -------------------------------------------------------- 互动时间 */

export async function touchLast(conf, qq) {
  const k = await keysOf(conf, qq)
  await kvSet(conf, k.last, Date.now())
}

export async function getLast(conf, qq) {
  const k = await keysOf(conf, qq)
  return Number(await kvGet(conf, k.last)) || 0
}

export async function idleMinutes(conf, qq) {
  const last = await getLast(conf, qq)
  if (!last) return -1
  return Math.floor((Date.now() - last) / 60000)
}

export async function getProactiveCount(conf, qq) {
  const k = await keysOf(conf, qq)
  return Number(await kvGet(conf, k.pro(ymd()))) || 0
}

export async function incProactiveCount(conf, qq) {
  const k = await keysOf(conf, qq)
  const n = (await getProactiveCount(conf, qq)) + 1
  await kvSet(conf, k.pro(ymd()), n, 172800)
  return n
}

/**
 * 连续几次主动说话没人回。
 * 一直不理还一直发，就成了骚扰 —— 到上限就停下来等对方开口。
 */
export async function getNoReply(conf, qq) {
  const k = await keysOf(conf, qq)
  return Number(await kvGet(conf, k.noreply)) || 0
}

export async function bumpNoReply(conf, qq) {
  const k = await keysOf(conf, qq)
  const n = (await getNoReply(conf, qq)) + 1
  await kvSet(conf, k.noreply, n)
  return n
}

export async function resetNoReply(conf, qq) {
  const k = await keysOf(conf, qq)
  await kvDel(conf, k.noreply)
}

/* -------------------------------------------------------- 存档操作 */

/** 清空当前存档（可选保住个人资料） */
export async function forgetAll(conf, qq, { keepFacts = false } = {}) {
  const k = await keysOf(conf, qq)
  await kvDel(conf, k.ctx)
  await kvDel(conf, k.sum)
  await kvDel(conf, k.ep)
  await kvDel(conf, k.plan)
  await kvDel(conf, k.cast)
  await kvDel(conf, k.noreply)
  if (!keepFacts) await kvDel(conf, k.fact)
}

/**
 * 复制存档（开分支用：把当前进度复制一份，接着玩不同的可能）
 */
export async function copyProfile(conf, qq, from, to) {
  const f = sanitizeProfile(from)
  const t = sanitizeProfile(to)
  if (f === t) return { ok: false, msg: "存档名一样，不用复制" }
  let n = 0
  for (const kind of ["ctx", "sum", "ep", "fact", "cast"]) {
    const v = await kvGet(conf, keyOf(qq, f, kind))
    if (v == null) continue
    await kvSet(conf, keyOf(qq, t, kind), v)
    n++
  }
  if (!n) return { ok: false, msg: "源存档是空的，没东西可复制" }
  await addProf(conf, qq, t)
  await addProf(conf, qq, f)
  return { ok: true, msg: `已复制 ${n} 项到存档「${t}」` }
}

/** 删掉一个存档 */
export async function deleteProfile(conf, qq, name) {
  const p = sanitizeProfile(name)
  if (p === DEFAULT_PROFILE) return { ok: false, msg: "默认存档不能删（想清空就发「#喵呜 忘」）" }
  for (const kind of ["ctx", "sum", "ep", "fact", "cast", "plan", "last"]) {
    await kvDel(conf, keyOf(qq, p, kind))
  }
  const cur = await getProfile(conf, qq)
  if (cur === p) await setProfile(conf, qq, DEFAULT_PROFILE)
  // 从名册里划掉（setProfile 会把 default 补回来）
  const set = await readProfSet(conf, qq)
  if (set.delete(p)) await kvSet(conf, profListKey(qq), [...set].sort())
  return { ok: true, msg: `存档「${p}」已删` }
}

export { DEFAULT_PROFILE }
