/**
 * 本地酒馆（SillyTavern）直连
 *
 * 不碰酒馆的浏览器前端，直接吃它的数据目录 + HTTP 接口：
 *   - 角色卡：data/<user>/characters/*.png|json（V2 卡，PNG 里塞 base64）
 *   - 聊天记录：data/<user>/chats/<角色>/*.jsonl
 *   - 世界书：data/<user>/worlds/*.json
 *   - 预设 / 破限：data/<user>/OpenAI Settings/*.json
 *
 * 端口和 basicAuth 直接从酒馆的 config.yaml 读，用户不用把密码抄一遍。
 */
import fs from "node:fs"
import path from "node:path"
import yaml from "yaml"
import { readRawCard, importCharacter } from "./character.js"
import * as mem from "./memory.js"
import { resolve } from "./config.js"

const log = () => globalThis.logger || console

/* ------------------------------------------------------------ 定位 */

/**
 * 读出酒馆的配置：优先用喵呜配置里的，缺的从酒馆自己的 config.yaml 补。
 * @returns {{ok:boolean, root:string, user:string, url:string, auth:string, msg?:string}}
 */
export function stInfo(conf) {
  const c = conf?.sillytavern || {}
  const root = String(c.dir || "").trim()
  if (!root) return { ok: false, root: "", user: "default-user", url: "", auth: "", msg: "没配 sillytavern.dir" }
  if (!fs.existsSync(root)) return { ok: false, root, user: "default-user", url: "", auth: "", msg: `目录不存在：${root}` }

  let stCfg = {}
  try {
    stCfg = yaml.parse(fs.readFileSync(path.join(root, "config.yaml"), "utf-8")) || {}
  } catch (e) {
    log().debug?.(`[miao-wu] 读酒馆 config.yaml 失败：${e.message}`)
  }

  const port = stCfg.port || 8001
  const user = String(c.user || "default-user")
  const username = c.username || stCfg.basicAuthUser?.username || ""
  const password = c.password || stCfg.basicAuthUser?.password || ""
  const url = String(c.url || `http://127.0.0.1:${port}`).replace(/\/+$/, "")
  const auth = username ? "Basic " + Buffer.from(`${username}:${password}`).toString("base64") : ""

  return { ok: true, root, user, url, auth, port }
}

/** 各个数据目录的实际路径 */
export function stDirs(conf) {
  const info = stInfo(conf)
  if (!info.ok) return { ok: false, msg: info.msg }
  const base = path.join(info.root, "data", info.user)
  return {
    ok: true,
    root: info.root,
    base,
    chars: path.join(base, "characters"),
    chats: path.join(base, "chats"),
    worlds: path.join(base, "worlds"),
    presets: [
      path.join(base, "OpenAI Settings"),
      path.join(base, "TextGen Settings"),
      path.join(base, "KoboldAI Settings"),
      path.join(base, "NovelAI Settings"),
      path.join(base, "instruct"),
    ],
  }
}

/* ------------------------------------------------------------ 连通性 */

/** 探一下酒馆服务在不在（带 basicAuth） */
export async function stStatus(conf) {
  const info = stInfo(conf)
  const dirs = stDirs(conf)
  if (!info.ok) return { ok: false, msg: info.msg }

  let version = ""
  let httpOk = false
  try {
    const headers = info.auth ? { Authorization: info.auth } : {}
    const r = await fetch(`${info.url}/version`, { headers, signal: AbortSignal.timeout(4000) })
    if (r.ok) {
      const j = await r.json()
      version = j.pkgVersion || j.agent || ""
      httpOk = true
    }
  } catch (e) {
    log().debug?.(`[miao-wu] 酒馆 /version 连不上：${e.message}`)
  }

  const count = p => {
    try {
      return fs.readdirSync(p).filter(f => !f.startsWith(".")).length
    } catch {
      return 0
    }
  }

  return {
    ok: true,
    httpOk,
    version,
    url: info.url,
    root: info.root,
    chars: count(dirs.chars),
    chatDirs: count(dirs.chats),
    worlds: count(dirs.worlds),
    presets: dirs.presets.reduce((n, p) => n + count(p), 0),
    msg: httpOk ? "服务在线" : "数据目录能读，但 HTTP 没连上（酒馆可能没开，导入导出照样能用）",
  }
}

/* ------------------------------------------------------------ 角色卡 */

/**
 * 列出酒馆里的角色卡。
 * @returns {Array<{id,name,file,format,desc}>}
 */
export function listStChars(conf) {
  const dirs = stDirs(conf)
  if (!dirs.ok) return []
  let files = []
  try {
    files = fs.readdirSync(dirs.chars).filter(f => !f.startsWith("."))
  } catch {
    return []
  }

  const out = []
  for (const f of files) {
    const ext = path.extname(f).toLowerCase()
    const full = path.join(dirs.chars, f)
    try {
      // 目录形式的卡
      if (fs.statSync(full).isDirectory()) {
        const inner = ["card.png", "card.json", "card.md"].map(x => path.join(full, x)).find(p => fs.existsSync(p))
        if (!inner) continue
        const card = readRawCard(inner, path.basename(f))
        out.push(mk(card, inner, path.basename(f)))
        continue
      }
      if (![".png", ".json", ".md", ".markdown"].includes(ext)) continue
      const card = readRawCard(full, path.basename(f, ext))
      out.push(mk(card, full, path.basename(f, ext)))
    } catch (e) {
      log().debug?.(`[miao-wu] 读酒馆卡 ${f} 失败：${e.message}`)
    }
  }
  return out.filter(c => c.name)

  function mk(card, file, id) {
    return {
      id,
      name: card?.name || id,
      file,
      format: card?.format || "?",
      desc: String(card?.description || "")
        .replace(/\s+/g, " ")
        .slice(0, 60),
    }
  }
}

/** 按名字或 id 找一张酒馆卡 */
export function findStChar(conf, key) {
  const k = String(key || "").trim()
  if (!k) return null
  const list = listStChars(conf)
  return (
    list.find(c => c.id === k) ||
    list.find(c => c.name === k) ||
    list.find(c => c.name.includes(k)) ||
    list.find(c => c.id.includes(k)) ||
    null
  )
}

/** 把酒馆的卡导进喵呜（复制文件） */
export function importStChar(conf, key) {
  const hit = findStChar(conf, key)
  if (!hit) return { ok: false, msg: `酒馆里没有「${key}」这张卡` }
  const r = importCharacter(conf, hit.file)
  if (!r.ok) return r
  return { ...r, name: hit.name, msg: `已从酒馆导入「${hit.name}」` }
}

/* ------------------------------------------------------------ 聊天记录 */

/** ST 的聊天目录是按"头像 key"分的，一般等于图片文件名 */
function chatDirOf(conf, charKey) {
  const dirs = stDirs(conf)
  if (!dirs.ok) return ""
  const hit = findStChar(conf, charKey)
  const cands = []
  if (hit) {
    cands.push(path.basename(hit.file, path.extname(hit.file)))
    cands.push(hit.name)
  }
  cands.push(String(charKey))

  try {
    const all = fs.readdirSync(dirs.chats, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    for (const c of cands) {
      const exact = all.find(n => n === c)
      if (exact) return path.join(dirs.chats, exact)
    }
    // 退一步：模糊匹配（角色名可能被改过）
    if (hit) {
      const loose = all.find(n => n.includes(hit.name) || hit.name.includes(n))
      if (loose) return path.join(dirs.chats, loose)
    }
  } catch {}
  return ""
}

/** 列出某个角色的聊天文件 */
export function listStChats(conf, charKey) {
  const dir = chatDirOf(conf, charKey)
  if (!dir) return []
  let files = []
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"))
  } catch {
    return []
  }
  return files
    .map(f => {
      const full = path.join(dir, f)
      const st = fs.statSync(full)
      return {
        file: full,
        name: f.replace(/\.jsonl$/, ""),
        mtime: st.mtimeMs,
        size: st.size,
        turns: Math.max(0, Math.round((fs.readFileSync(full, "utf-8").split("\n").filter(Boolean).length - 1) / 2)),
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

/** 解析一个 jsonl 聊天 */
export function readStChat(file, limit = 0) {
  let lines = []
  try {
    lines = fs.readFileSync(file, "utf-8").split("\n").filter(l => l.trim())
  } catch {
    return []
  }
  const msgs = []
  for (const line of lines) {
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || typeof o.mes !== "string") continue
    if (o.is_system) continue
    const text = String(o.mes).trim()
    if (!text) continue
    msgs.push({
      isUser: !!o.is_user,
      name: String(o.name || ""),
      text,
      date: o.send_date || "",
    })
  }
  return limit > 0 ? msgs.slice(-limit) : msgs
}

/**
 * 把酒馆的一段进度接进当前存档。
 *
 * 只搬最近 maxTurns 轮：搬太多会把 QQ 这边的上下文直接撑爆，
 * 而老的部分本来就该靠摘要活着。
 */
export async function resumeStChat(conf, qq, charKey, file) {
  const target = file || listStChats(conf, charKey)[0]?.file
  if (!target) return { ok: false, msg: `「${charKey}」在酒馆里没有聊天记录` }

  const maxTurns = Number(conf?.chat?.maxTurns ?? 12)
  const msgs = readStChat(target, maxTurns * 2)
  if (!msgs.length) return { ok: false, msg: "那个聊天文件是空的" }

  const arr = msgs.map(m => ({
    role: m.isUser ? "user" : "assistant",
    content: m.text,
    t: Date.now(),
  }))

  await mem.saveCtx(conf, qq, arr)
  const lastUser = [...msgs].reverse().find(m => m.isUser)?.text || ""
  await mem.addEpisode(conf, qq, `从酒馆接入了进度（${msgs.length} 条消息），最后停在：${lastUser.slice(0, 40)}`, "import")

  const hit = findStChar(conf, charKey)
  return {
    ok: true,
    n: msgs.length,
    file: target,
    charName: hit?.name || charKey,
    msg: `接上了 ${Math.floor(msgs.length / 2)} 轮，最后一句是「${lastUser.slice(0, 30)}」`,
  }
}

/**
 * 把当前 QQ 对话导出成酒馆能打开的聊天文件。
 * 写进 chats/<角色目录>/ 下，浏览器里刷新角色就能看到。
 */
export async function exportStChat(conf, qq, charKey, userName = "主人") {
  const hit = findStChar(conf, charKey)
  if (!hit) return { ok: false, msg: `酒馆里没有「${charKey}」这张卡，导出了也用不了` }

  const dirs = stDirs(conf)
  const dir = chatDirOf(conf, charKey) || path.join(dirs.chats, path.basename(hit.file, path.extname(hit.file)))
  fs.mkdirSync(dir, { recursive: true })

  const msgs = await mem.loadCtx(conf, qq)
  if (!msgs.length) return { ok: false, msg: "这边还没有对话，没东西可导" }

  const stamp = new Date()
  const pad = n => String(n).padStart(2, "0")
  const name = `${hit.name} - QQ ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}@${pad(stamp.getHours())}h${pad(stamp.getMinutes())}m${pad(stamp.getSeconds())}s`
  const file = path.join(dir, `${name}.jsonl`)

  const head = {
    user_name: userName,
    character_name: hit.name,
    create_date: stamp.toISOString(),
    chat_metadata: {},
  }
  const lines = [JSON.stringify(head)]
  for (const m of msgs) {
    const isUser = m.role === "user"
    lines.push(
      JSON.stringify({
        name: isUser ? userName : hit.name,
        is_user: isUser,
        is_system: false,
        send_date: new Date(m.t || Date.now()).toISOString(),
        mes: String(m.content || ""),
        extra: {},
      }),
    )
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8")
  return { ok: true, file, n: msgs.length, msg: `导出了 ${msgs.length} 条到酒馆：${path.basename(file)}` }
}

/* ------------------------------------------------------------ 世界书 */

export function listStWorlds(conf) {
  const dirs = stDirs(conf)
  if (!dirs.ok) return []
  try {
    return fs
      .readdirSync(dirs.worlds)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const full = path.join(dirs.worlds, f)
        let n = 0
        try {
          const j = JSON.parse(fs.readFileSync(full, "utf-8"))
          n = Object.keys(j.entries || {}).length
        } catch {}
        return { id: f.replace(/\.json$/, ""), file: full, name: f.replace(/\.json$/, ""), entries: n }
      })
  } catch {
    return []
  }
}

/**
 * 世界书直接复制进 config/lorebooks/ 就行 ——
 * lorebook.js 本来就认酒馆的 {entries:{...}} 结构。
 */
export function importStWorld(conf, key) {
  const list = listStWorlds(conf)
  const hit = list.find(w => w.id === key) || list.find(w => w.id.includes(key))
  if (!hit) return { ok: false, msg: `酒馆里没有「${key}」这本世界书` }

  const dir = path.join(resolve(conf?.lorebook?.dir || "config/lorebooks"), "")
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `${path.basename(hit.file)}`)
  fs.copyFileSync(hit.file, dest)
  return { ok: true, file: dest, entries: hit.entries, msg: `已导入世界书「${hit.name}」（${hit.entries} 条）` }
}

/* ------------------------------------------------------------ 预设 */

export function listStPresets(conf) {
  const dirs = stDirs(conf)
  if (!dirs.ok) return []
  const out = []
  for (const d of dirs.presets) {
    let files = []
    try {
      files = fs.readdirSync(d).filter(f => f.endsWith(".json"))
    } catch {
      continue
    }
    for (const f of files) {
      out.push({
        id: f.replace(/\.json$/, ""),
        name: f.replace(/\.json$/, ""),
        kind: path.basename(d),
        file: path.join(d, f),
      })
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

/**
 * 读一个预设，抽出有用的那几条 prompt。
 * 酒馆的 prompts 是 [{identifier, name, content, role, ...}]。
 */
export function readStPreset(conf, key) {
  const list = listStPresets(conf)
  const hit = list.find(p => p.id === key) || list.find(p => p.id.includes(key))
  if (!hit) return { ok: false, msg: `没有「${key}」这个预设` }

  let j = {}
  try {
    j = JSON.parse(fs.readFileSync(hit.file, "utf-8"))
  } catch (e) {
    return { ok: false, msg: `预设解析失败：${e.message}` }
  }

  const prompts = Array.isArray(j.prompts) ? j.prompts : []
  const pick = re => prompts.find(p => re.test(String(p.identifier || "")) || re.test(String(p.name || "")))
  const grab = p => (p && typeof p.content === "string" ? p.content.trim() : "")

  return {
    ok: true,
    name: hit.name,
    kind: hit.kind,
    file: hit.file,
    main: grab(pick(/^main$/i)),
    jailbreak: grab(pick(/jailbreak/i)),
    postHistory: grab(pick(/post[-_]?history/i)),
    enhance: grab(pick(/enhance/i)),
    all: prompts.map(p => ({ name: String(p.name || p.identifier || ""), content: grab(p) })).filter(p => p.content),
    meta: {
      temperature: j.temperature,
      top_p: j.top_p,
      max_tokens: j.openai_max_tokens || j.max_tokens,
      prompts: prompts.length,
    },
  }
}
