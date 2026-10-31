/**
 * 体检 / 本地服务探测
 *
 * 萌新装完一堆本地服务，最常见的问题是"哪个没开"和"端口填错了"。
 * 这里一次性把所有依赖探一遍，每条都给**下一步该干嘛**，不用自己猜。
 *
 * 探测只读，不改任何配置；要改的话由调用方（命令 / WebUI）确认后 patchConfig。
 */
import net from "node:net"
import fs from "node:fs"
import { ping } from "./llm.js"
import { listCharacters } from "./character.js"
import * as st from "./st.js"
import { ttsStatus } from "./tts.js"
import { PLUGIN_DIR, resolve } from "./config.js"

const log = () => globalThis.logger || console

/** TCP 探端口，不依赖 http */
export function probePort(host, port, timeout = 1200) {
  return new Promise(resolve => {
    const sock = new net.Socket()
    let done = false
    const fin = ok => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {}
      resolve(ok)
    }
    sock.setTimeout(timeout)
    sock.once("connect", () => fin(true))
    sock.once("timeout", () => fin(false))
    sock.once("error", () => fin(false))
    sock.connect(port, host)
  })
}

function parseUrl(u) {
  try {
    const x = new URL(String(u))
    return { host: x.hostname === "0.0.0.0" ? "127.0.0.1" : x.hostname || "127.0.0.1", port: Number(x.port || (x.protocol === "https:" ? 443 : 80)) }
  } catch {
    return null
  }
}

async function headOk(url, timeout = 2500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    return { ok: r.status < 500, status: r.status }
  } catch (e) {
    return { ok: false, msg: String(e.message).slice(0, 80) }
  }
}

/**
 * 后端的轻量探活：只看 /models 通不通，不发对话请求。
 * 体检页要秒开，不能每次都等一句"回复一个字：好"。
 */
async function lightPing(prov) {
  const t0 = Date.now()
  const type = String(prov.type || "openai").toLowerCase()
  const base = String(prov.baseUrl || (type === "ollama" ? "http://127.0.0.1:11434" : "")).replace(/\/+$/, "")
  if (!base) return null
  const url = type === "ollama" ? `${base}/api/tags` : `${base}/models`
  try {
    const r = await fetch(url, {
      headers: type === "ollama" ? {} : { Authorization: `Bearer ${prov.apiKey || ""}` },
      signal: AbortSignal.timeout(3500),
    })
    const ms = Date.now() - t0
    if (r.status === 401 || r.status === 403) return { ok: false, msg: `鉴权失败（HTTP ${r.status}），apiKey 不对`, ms }
    if (r.status >= 500) return { ok: false, msg: `服务端错误 HTTP ${r.status}`, ms }
    if (!r.ok) return { ok: false, msg: `HTTP ${r.status}`, ms }
    return { ok: true, msg: "接口连通", ms }
  } catch {
    return null // 拿不准就交给完整的 ping
  }
}

/** 20 秒缓存：来回点标签页不该每次都重新探一遍 */
let cache = { at: 0, rows: null, key: "" }

/**
 * 全量体检。
 * @param {object} conf
 * @param {boolean} fresh true = 不吃缓存
 * @returns {Promise<Array<{id,name,ok,level,detail,hint,patch?}>>}
 */
export async function probeAll(conf, fresh = false) {
  const key = `${conf.active}|${conf.draw?.bridgeUrl}|${conf.sillytavern?.dir}|${conf.tts?.url}`
  if (!fresh && cache.rows && cache.key === key && Date.now() - cache.at < 20000) return cache.rows

  const out = []

  /* 1. 对话后端 */
  const prov = conf.providers?.[conf.active]
  if (!prov) {
    out.push({
      id: "llm",
      name: "对话后端",
      ok: false,
      level: "error",
      detail: `active 指向的「${conf.active}」不存在`,
      hint: "config.yaml 的 active 要等于 providers 下某个 key",
    })
  } else {
    let t = await lightPing({ ...prov, __name: conf.active })
    if (!t) t = await ping({ ...prov, __name: conf.active })
    out.push({
      id: "llm",
      name: "对话后端",
      ok: t.ok,
      level: t.ok ? "ok" : "error",
      detail: `${conf.active} / ${prov.model} · ${t.ok ? "连通" : t.msg}（${t.ms}ms）`,
      hint: t.ok ? "" : `检查 baseUrl（现在是 ${prov.baseUrl || "（空）"}）和 apiKey；本地起没起？`,
      patch: null,
    })
  }

  /* 2. Ollama（可选，本地兜底） */
  const oll = await probePort("127.0.0.1", 11434)
  if (oll) {
    let detail = "在跑"
    try {
      const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2500) })
      const d = await r.json()
      const names = (d.models || []).map(m => m.name)
      detail = `在跑 · ${names.length} 个模型${names.length ? `：${names.slice(0, 4).join(", ")}` : ""}`
      const want = conf.providers?.ollama?.model
      if (want && !names.some(n => n === want || n.split(":")[0] === String(want).split(":")[0])) {
        detail += ` · 没看到 ${want}`
      }
    } catch {}
    out.push({ id: "ollama", name: "Ollama", ok: true, level: "ok", detail, hint: "断网兜底可以切到它：active: ollama" })
  } else {
    out.push({
      id: "ollama",
      name: "Ollama",
      ok: false,
      level: "info",
      detail: "没起",
      hint: "可选。想要「断网也能聊」就启动它，然后 active 填 ollama",
    })
  }

  /* 3. 绘图 */
  const dc = conf.draw || {}
  if (dc.enabled === false) {
    out.push({ id: "draw", name: "绘图", ok: false, level: "info", detail: "关着", hint: "config.yaml 的 draw.enabled 改 true" })
  } else {
    const u = parseUrl(dc.bridgeUrl)
    const alive = u ? await probePort(u.host, u.port) : false
    let detail = alive ? `端口通（${dc.bridgeUrl}）` : `连不上 ${dc.bridgeUrl}`
    let hint = alive ? "" : "先把 ComfyUI / comfy-bridge 起起来；端口不是 7860 就改 draw.bridgeUrl"
    if (alive) {
      const h = await headOk(`${String(dc.bridgeUrl).replace(/\/+$/, "")}/sdapi/v1/options`)
      if (h.ok) detail += " · A1111 接口可用"
      else detail += ` · 端口通但 A1111 接口不响应（${h.status || h.msg}）`
    }
    out.push({ id: "draw", name: "绘图", ok: alive, level: alive ? "ok" : "error", detail, hint })
  }

  /* 4. 酒馆 */
  const sc = conf.sillytavern || {}
  if (sc.enabled === false) {
    out.push({ id: "st", name: "本地酒馆", ok: false, level: "info", detail: "关着", hint: "想导入酒馆的卡就打开 sillytavern.enabled" })
  } else if (!sc.dir) {
    out.push({ id: "st", name: "本地酒馆", ok: false, level: "warn", detail: "没填目录", hint: "sillytavern.dir 填酒馆安装目录，例：E:\\SillyTavern" })
  } else if (!fs.existsSync(String(sc.dir))) {
    out.push({ id: "st", name: "本地酒馆", ok: false, level: "error", detail: `目录不存在：${sc.dir}`, hint: "路径写错了，或者酒馆挪走了" })
  } else {
    const s = await st.stStatus(conf)
    out.push({
      id: "st",
      name: "本地酒馆",
      ok: s.ok,
      level: s.httpOk ? "ok" : "warn",
      detail: s.ok ? `卡 ${s.chars} · 聊天 ${s.chatDirs} · 世界书 ${s.worlds} · 预设 ${s.presets}${s.httpOk ? ` · 服务在线 ${s.version}` : " · HTTP 没连上（只能读文件）"}` : s.msg,
      hint: s.ok ? "" : "检查 sillytavern.dir 是否指向酒馆根目录（有 config.yaml 和 data 的那层）",
    })
  }

  /* 5. TTS */
  const ts = await ttsStatus(conf)
  out.push({
    id: "tts",
    name: "语音",
    ok: ts.online && ts.refOk && ts.enabled,
    level: ts.online ? (ts.refOk ? "ok" : "warn") : "info",
    detail: `${ts.engine} · ${ts.online ? "服务在" : "服务没起"}${ts.refOk ? " · 参考音频有" : " · 没配参考音频"}${ts.enabled ? "" : " · 功能关着"}`,
    hint: ts.msg,
  })

  /* 6. Redis（可选，加速用） */
  const rd = globalThis.redis?.isOpen
    ? true
    : await probePort("127.0.0.1", 6379)
  out.push({
    id: "redis",
    name: "Redis",
    ok: !!rd,
    level: rd ? "ok" : "info",
    detail: rd ? "在跑（记忆双写更快）" : "没起（只用本地文件，不影响功能）",
    hint: rd ? "" : "可选。想装：memurai 或 docker run -p 6379:6379 redis",
  })

  /* 7. 角色卡 */
  const cards = listCharacters(conf)
  out.push({
    id: "cards",
    name: "角色卡",
    ok: cards.length > 0,
    level: cards.length ? "ok" : "error",
    detail: cards.length ? `${cards.length} 张` : "一张都没有",
    hint: cards.length ? "" : `把卡放进 ${resolve(conf.cast?.dir || "config/characters")}，支持 .md / .json / .png`,
  })

  cache = { at: Date.now(), rows: out, key }
  return out
}

/** 「#喵呜 体检」的文字版 */export function healthText(rows) {
  const icon = r => (r.ok ? "✓" : r.level === "error" ? "✕" : r.level === "warn" ? "!" : "·")
  const bad = rows.filter(r => !r.ok && r.level !== "info")
  const head = bad.length
    ? `体检：${bad.length} 项要注意`
    : "体检：全部正常"
  const body = rows.map(r => `${icon(r)} ${r.name}：${r.detail}${!r.ok && r.hint ? `\n    → ${r.hint}` : ""}`)
  return [head, "", ...body].join("\n")
}

/**
 * 能自动修的建议（只给"确定安全"的，比如按探测到的端口写回配置）
 * @returns {Promise<{patch:object, notes:string[]}>}
 */
export async function autoFix(conf) {
  const patch = {}
  const notes = []

  // 酒馆：目录存在但没填 → 尝试常见位置
  if (conf.sillytavern?.enabled !== false && !conf.sillytavern?.dir) {
    for (const guess of ["E:\\SillyTavern", "D:\\SillyTavern", "C:\\SillyTavern"]) {
      if (fs.existsSync(`${guess}\\config.yaml`)) {
        patch.sillytavern = { ...county(conf.sillytavern), dir: guess }
        notes.push(`酒馆目录按常见位置填成 ${guess}`)
        break
      }
    }
  }

  // 绘图：7860 不通但 7861/8188 通 → 换端口（ComfyUI 原生是 8188，bridge 是 7860）
  const dc = conf.draw || {}
  if (dc.enabled !== false && dc.bridgeUrl) {
    const u = parseUrl(dc.bridgeUrl)
    if (u && !(await probePort(u.host, u.port))) {
      for (const alt of [7861, 7860, 8188]) {
        if (alt === u.port) continue
        if (await probePort(u.host, alt)) {
          patch.draw = { ...dc, bridgeUrl: `http://${u.host}:${alt}` }
          notes.push(`绘图端口 ${u.port} 不通，但 ${alt} 通 —— 已按 ${alt} 写回`)
          break
        }
      }
    }
  }

  return { patch, notes }
}

function county(x) {
  return x && typeof x === "object" ? x : {}
}

/** 给 WebUI 的概览用：一句话总结整体状态 */
export async function summaryLine(conf) {
  const rows = await probeAll(conf)
  const bad = rows.filter(r => !r.ok && r.level !== "info")
  const warn = rows.filter(r => r.ok === false && r.level === "info")
  return {
    total: rows.length,
    problems: bad.length,
    optional: warn.length,
    text: bad.length ? `${bad.length} 项异常：${bad.map(b => b.name).join("、")}` : "全部正常",
  }
}

export { PLUGIN_DIR, log }
