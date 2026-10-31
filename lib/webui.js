/**
 * 喵呜 WebUI
 *
 * 零依赖的本地控制台（node:http），跟锅巴那套一样：开网页 → 输密码 → 用。
 * 能干的事：
 *   概览 / 角色卡 / 记忆 / 本地酒馆 / 配置
 *
 * 安全边界：
 *   - 默认只听 127.0.0.1，不对外
 *   - 必须密码登录，cookie 会话 12 小时
 *   - 配置接口只放行白名单字段，apiKey 永远不返回明文
 */
import http from "node:http"
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import crypto from "node:crypto"
import path from "node:path"
import { loadConfig, patchConfig, providerOf, PLUGIN_DIR } from "./config.js"
import { listCharacters, loadCharacter, importCharacter, characterDir } from "./character.js"
import { currentCard } from "./persona.js"
import * as mem from "./memory.js"
import * as st from "./st.js"
import * as clock from "./clock.js"
import * as tts from "./tts.js"
import { probeAll, autoFix } from "./probe.js"
import { pressure, contextReport, forceCompress, fmtUsage } from "./compress.js"

const log = () => globalThis.logger || console

/* ------------------------------------------------------------ 会话 */

const sessions = new Map() // sid -> { exp, qq }
let SESSION_MS = 12 * 3600 * 1000

function newSid() {
  return crypto.randomBytes(24).toString("hex")
}

/** 登录态；顺便把 session 挂到 req 上，后面取当前用户要用 */
function authed(req) {
  const sid = parseCookies(req).mw_sid
  if (!sid) return false
  const s = sessions.get(sid)
  if (!s) return false
  if (Date.now() > s.exp) {
    sessions.delete(sid)
    return false
  }
  s.exp = Date.now() + SESSION_MS
  req._sess = s
  return true
}

function parseCookies(req) {
  const out = {}
  const raw = req.headers.cookie || ""
  for (const part of raw.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function eq(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

/* ------------------------------------------------------------ 工具 */

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(body)
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on("data", c => {
      n += c.length
      if (n > limit) {
        reject(new Error("请求太大"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })
}

/** 给前端看的后端信息，key 只露位数 */
function maskProvider(p) {
  if (!p) return null
  const k = String(p.apiKey || "")
  return {
    name: p.__name || "",
    model: p.model || "",
    type: p.type || "openai",
    baseUrl: p.baseUrl || p.url || "",
    key: k ? `${k.slice(0, 4)}…${k.slice(-4)}（${k.length} 位）` : "（空）",
  }
}

/**
 * 主人的 QQ。
 *
 * 云崽有些版本不把 config 挂到 globalThis 上，所以先看全局，
 * 没有再直接去读云崽自己的 lib/config。解析一次就缓存，
 * 每条请求都去 import 太浪费。
 */
let MASTER = ""
let MASTER_TRIED = false
async function ensureMaster() {
  if (MASTER_TRIED) return MASTER
  MASTER_TRIED = true
  const pick0 = v => {
    const arr = Array.isArray(v) ? v : v ? [v] : []
    return String(arr.filter(Boolean)[0] || "")
  }
  MASTER = pick0(globalThis.cfg?.masterQQ)
  if (!MASTER) {
    try {
      const mod = await import("../../../lib/config/config.js")
      MASTER = pick0(mod.default?.masterQQ)
    } catch (e) {
      log().debug?.(`[喵呜] 读 masterQQ 失败：${e.message}`)
    }
  }
  return MASTER
}

function qq0() {
  return MASTER || ""
}

/** 这个会话当前在看哪个 QQ 的记忆 */
function userOf(req, conf) {
  const s = req._sess
  if (s?.qq) return String(s.qq)
  return qq0()
}

/** 所有人的列表：主人 + 白名单 + 有记忆的其他人 */
async function allUsers(conf) {
  const out = []
  const seen = new Set()
  const master = qq0()
  const push = (qq, master) => {
    if (!qq || seen.has(qq)) return
    seen.add(qq)
    out.push({ qq, master })
  }
  push(master, true)
  for (const q of (conf.scope?.whitelist || []).map(String)) push(q, false)
  for (const q of await mem.allUsers(conf)) push(q, false)
  return out
}

/* ------------------------------------------------------------ 业务接口 */

async function apiState(conf, qq) {
  const { card } = await currentCard(conf, qq)
  const ctx = qq ? await mem.loadCtx(conf, qq) : []
  const sum = qq ? await mem.getSummary(conf, qq) : { text: "", turns: 0 }
  const eps = qq ? await mem.listEpisodes(conf, qq) : []
  const prof = qq ? await mem.getProfile(conf, qq) : "default"
  const profiles = qq ? await mem.listProfiles(conf, qq) : ["default"]
  const p = conf.providers?.[conf.active]

  // 上下文压力（页面上的进度条要这个）
  let ctxPressure = null
  try {
    const prov = providerOf(conf, conf.compress?.provider || "")
    const pr = await pressure(conf, qq, prov, { systemChars: 1500 })
    ctxPressure = { ...pr, text: fmtUsage(pr.usage) }
  } catch {}

  const reminds = qq ? await clock.listReminders(conf, qq) : []

  return {
    ok: true,
    qq,
    enabled: conf.enabled,
    backend: maskProvider(p ? { ...p, __name: conf.active } : null),
    card: card ? { id: card.id, name: card.name, format: card.format } : null,
    cards: listCharacters(conf).length,
    profile: prof,
    profiles,
    memory: {
      turns: Math.floor(ctx.length / 2),
      summaryChars: [...String(sum.text || "")].length,
      episodes: eps.length,
    },
    compress: { enabled: conf.compress?.enabled, mode: conf.compress?.mode || "remind", trigger: conf.compress?.triggerTurns },
    pressure: ctxPressure,
    clock: {
      enabled: conf.clock?.enabled !== false,
      // 拆成"日期 + 时刻"两段：卡片窄，一整串会被拦腰折断
      date: (() => {
        const d = new Date()
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${"日一二三四五六"[d.getDay()]}`
      })(),
      now: (() => {
        const d = new Date()
        return `${clock.dayPart(d.getHours())} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      })(),
      festival: clock.festivalOf(new Date()),
      reminds: reminds.filter(r => !r.done).length,
    },
    tts: { enabled: conf.tts?.enabled === true, mode: conf.tts?.mode || "sometimes", engine: conf.tts?.engine || "gptsovits" },
    proactive: {
      enabled: conf.proactive?.enabled === true,
      style: conf.proactive?.style || "auto",
      hours: conf.proactive?.activeHours || [9, 23],
      maxPerDay: conf.proactive?.maxPerDay ?? 3,
      today: qq ? await mem.getProactiveCount(conf, qq) : 0,
    },
    draw: { enabled: conf.draw?.enabled },
    st: { enabled: conf.sillytavern?.enabled !== false, dir: conf.sillytavern?.dir || "" },
    webui: {
      host: conf.webui?.host || "127.0.0.1",
      port: conf.webui?.port || 5199,
      lan: lanAddresses(),
      open: (conf.webui?.host || "127.0.0.1") === "0.0.0.0",
    },
  }
}

const CFG_WHITELIST = [
  "enabled",
  "active",
  "debug",
  "scope",
  "chat",
  "compress",
  "memory",
  "cast",
  "lorebook",
  "immersion",
  "humanize",
  "proactive",
  "clock",
  "tts",
  "draw",
  "tavern",
  "sillytavern",
  "webui",
]

/** webui 段真正能写的键（其余是读出来的状态，比如 lan / open） */
const WEBUI_KEYS = ["enabled", "host", "port", "password", "sessionHours"]

function apiConfig(conf) {
  const out = {}
  for (const k of CFG_WHITELIST) out[k] = conf[k]
  // webui 里有密码，永远不往外吐明文
  if (out.webui) {
    out.webui = { ...out.webui, password: conf.webui?.password ? "（已设置）" : "" }
  }
  // 后端只给结构，不给 key
  out.providers = {}
  for (const [name, p] of Object.entries(conf.providers || {})) {
    out.providers[name] = {
      model: p.model,
      type: p.type || "openai",
      baseUrl: p.baseUrl || p.url || "",
      hasKey: !!p.apiKey,
      contextTokens: p.contextTokens || 0,
    }
  }
  return out
}

/* ------------------------------------------------------------ 页面 */

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>喵呜 · 登录</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:"Microsoft YaHei","PingFang SC",sans-serif;
    background:radial-gradient(900px 500px at 80% 0%,#ffe9d6,transparent 60%),
      radial-gradient(700px 420px at 0% 100%,#e7eef6,transparent 60%),#f6f3ef;color:#2c2a28}
  .box{width:min(340px,calc(100vw - 34px));background:#fffdfb;border:1px solid #ece4da;border-radius:16px;
    padding:30px 28px 26px;box-shadow:0 10px 30px rgba(120,96,74,.10)}
  h1{font-size:24px;letter-spacing:4px;margin-bottom:6px}
  .sub{font-size:12px;color:#9a938b;margin-bottom:22px}
  input{width:100%;padding:12px 12px;border:1px solid #e6ded4;border-radius:9px;
    font-size:16px;background:#fbf8f5;outline:none;color:#2c2a28}
  input:focus{border-color:#d8a57c;background:#fff}
  button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:9px;cursor:pointer;
    background:#c1743f;color:#fff;font-size:14px;letter-spacing:2px}
  button:hover{background:#b0693c}
  .err{margin-top:12px;font-size:12px;color:#c0442f;min-height:16px}
  .tips{margin-top:20px;font-size:11px;color:#a89f96;line-height:1.7}
</style></head>
<body>
<form class="box" onsubmit="return go(event)">
  <h1>喵呜</h1>
  <div class="sub">本地控制台 · 需要密码</div>
  <input id="pw" type="password" placeholder="密码" autofocus autocomplete="current-password">
  <button type="submit">进入</button>
  <div class="err" id="err"></div>
  <div class="tips">密码在 <code>config/config.yaml</code> 的 <code>webui.password</code>。<br>
  忘了就把那行删掉，重启机器人会生成新的并打日志。</div>
</form>
<script>
async function go(e){
  e.preventDefault()
  const pw = document.getElementById('pw').value
  const r = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})})
  const j = await r.json().catch(()=>({}))
  if (j.ok) location.href = '/app'
  else document.getElementById('err').textContent = j.msg || '密码不对'
  return false
}
</script>
</body></html>`

const APP_FILE = path.join(PLUGIN_DIR, "resources", "webui", "app.html")
let appHtmlCache = ""
function appHtml() {
  if (appHtmlCache) return appHtmlCache
  try {
    appHtmlCache = fs.readFileSync(APP_FILE, "utf-8")
  } catch (e) {
    log().error?.(`[喵呜] WebUI 页面读不到：${e.message}`)
    appHtmlCache = `<meta charset="utf-8"><p style="font:14px sans-serif;padding:20px">
      app.html 丢了，找不到 ${APP_FILE}</p>`
  }
  return appHtmlCache
}

/* ------------------------------------------------------------ 路由 */

async function route(req, res) {
  const url = new URL(req.url, "http://x")
  const p = url.pathname
  const conf = loadConfig()
  await ensureMaster()

  // 未登录只给登录页和登录接口
  if (!authed(req)) {
    if (p === "/api/login" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}))
      const want = String(conf.webui?.password || "")
      if (!want) return json(res, 500, { ok: false, msg: "服务端没设密码，看日志" })
      if (!eq(body.password || "", want)) return json(res, 401, { ok: false, msg: "密码不对" })
      const sid = newSid()
      sessions.set(sid, { exp: Date.now() + SESSION_MS, qq: qq0() })
      res.setHeader("Set-Cookie", `mw_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`)
      return json(res, 200, { ok: true })
    }
    if (p === "/" || p === "/app") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      return res.end(LOGIN_HTML)
    }
    if (p.startsWith("/api/")) return json(res, 401, { ok: false, msg: "没登录" })
    res.writeHead(404).end("not found")
    return
  }

  // 已经登录还访问根路径 → 直接进控制台（否则会看到一段 {"no route"} 的 JSON）
  if (p === "/" || p === "/index.html") {
    res.writeHead(302, { Location: "/app" })
    return res.end()
  }
  if (p === "/app") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    return res.end(appHtml())
  }
  if (p === "/api/logout") {
    const sid = parseCookies(req).mw_sid
    if (sid) sessions.delete(sid)
    res.setHeader("Set-Cookie", "mw_sid=; Path=/; Max-Age=0")
    return json(res, 200, { ok: true })
  }

  /* ---- 状态 ---- */
  if (p === "/api/state") return json(res, 200, await apiState(conf, userOf(req, conf)))

  /* ---- 用户切换（别的 QQ 也玩这只猫时，控制台能看谁的记忆） ---- */
  if (p === "/api/users") return json(res, 200, { ok: true, list: await allUsers(conf), current: userOf(req, conf) })
  if (p === "/api/user" && req.method === "POST") {
    const body = await readBody(req)
    const want = String(body.qq || "").trim()
    if (!want) return json(res, 400, { ok: false, msg: "没给 qq" })
    // 白名单里的人就算还没聊过天，也允许切过去看（首次消息才有得看）
    const known = await allUsers(conf)
    const wl = (conf.scope?.whitelist || []).map(String)
    if (!known.some(x => x.qq === want) && !wl.includes(want)) {
      return json(res, 404, { ok: false, msg: `没有 ${want} 的记忆` })
    }
    if (req._sess) req._sess.qq = want
    return json(res, 200, { ok: true, current: want })
  }

  /* ---- 上下文 ---- */
  if (p === "/api/context") {
    const qq = userOf(req, conf)
    const prov = providerOf(conf, conf.compress?.provider || "")
    const pr = await pressure(conf, qq, prov, { systemChars: 1500 })
    return json(res, 200, { ok: true, ...pr, text: fmtUsage(pr.usage), report: await contextReport(conf, qq, prov, { systemChars: 1500 }) })
  }
  if (p === "/api/compress" && req.method === "POST") {
    const qq = userOf(req, conf)
    const { card } = await currentCard(conf, qq)
    const prov = providerOf(conf, conf.compress?.provider || "")
    const r = await forceCompress(conf, qq, prov, card)
    return json(res, r.ok ? 200 : 400, r)
  }

  /* ---- 体检 ---- */
  if (p === "/api/probe") {
    const rows = await probeAll(conf, url.searchParams.get("fresh") === "1")
    return json(res, 200, { ok: true, rows })
  }
  if (p === "/api/probe/fix" && req.method === "POST") {
    const { patch, notes } = await autoFix(conf)
    if (!Object.keys(patch).length) return json(res, 200, { ok: false, msg: "没有能自动修的项", notes: [] })
    patchConfig(patch)
    return json(res, 200, { ok: true, notes, patch })
  }

  /* ---- 定时提醒 ---- */
  if (p === "/api/clock") {
    const qq = userOf(req, conf)
    if (req.method === "GET") {
      const list = await clock.listReminders(conf, qq)
      return json(res, 200, {
        ok: true,
        now: clock.clockText(conf),
        festival: clock.festivalOf(new Date()),
        list: list.map((r, i) => ({ ...r, idx: i + 1, when: clock.fmtAt(r.at) })),
      })
    }
    if (req.method === "POST") {
      const body = await readBody(req)
      const w = body.at ? { ok: true, at: Number(body.at), repeat: body.repeat || "" } : clock.parseWhen(String(body.when || ""))
      if (!w.ok) return json(res, 400, { ok: false, msg: w.msg || "时间没解析出来" })
      const r = await clock.addReminder(conf, qq, { at: w.at, text: String(body.text || ""), repeat: w.repeat, h: w.h, m: w.m, raw: body.when })
      return json(res, r.ok ? 200 : 400, r)
    }
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id") || ""
      const r = await clock.cancelReminder(conf, qq, id)
      return json(res, r.ok ? 200 : 400, r)
    }
  }

  /* ---- 语音 ---- */
  if (p === "/api/tts") {
    const s = await tts.ttsStatus(conf)
    return json(res, 200, { ok: true, status: s, cfg: { mode: conf.tts?.mode, chance: conf.tts?.chance, maxChars: conf.tts?.maxChars } })
  }
  if (p === "/api/tts/test" && req.method === "POST") {
    const r = await tts.synthesize(conf, "嗯…听得到吗？这是我现在的声音。")
    return json(res, r.ok ? 200 : 400, r)
  }
  if (p === "/api/tts/audio") {
    const f = url.searchParams.get("file") || ""
    // 只允许读 data/tts 下的文件，防目录穿越
    const base = path.resolve(PLUGIN_DIR, "data", "tts")
    const full = path.resolve(f)
    if (!full.startsWith(base) || !fs.existsSync(full)) return json(res, 404, { ok: false })
    res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" })
    return fs.createReadStream(full).pipe(res)
  }

  /* ---- 角色卡 ---- */
  if (p === "/api/chars") {
    const list = listCharacters(conf).map(c => ({ id: c.id, name: c.name, format: c.format, tags: c.tags || [] }))
    return json(res, 200, { ok: true, list, dir: characterDir(conf) })
  }
  if (p === "/api/char") {
    const id = url.searchParams.get("id") || ""
    const card = loadCharacter(conf, id)
    if (!card) return json(res, 404, { ok: false, msg: "没有这张卡" })
    return json(res, 200, {
      ok: true,
      card: {
        id: card.id,
        name: card.name,
        format: card.format,
        description: card.description,
        personality: card.personality,
        styleExtra: card.styleExtra,
        relExtra: card.relExtra,
        habitExtra: card.habitExtra,
        drawExtra: card.drawExtra,
        scenario: card.scenario,
        mesExample: card.mesExample,
        firstMes: card.firstMes,
        greetingPool: card.greetingPool,
        inheritedFrom: card.meta?.inheritedFrom || [],
      },
    })
  }
  if (p === "/api/char/import" && req.method === "POST") {
    const body = await readBody(req)
    const r = importCharacter(conf, String(body.path || ""))
    return json(res, r.ok ? 200 : 400, r)
  }

  /* ---- 记忆 ---- */
  if (p === "/api/memory") {
    const qq = userOf(req, conf)
    if (!qq) return json(res, 400, { ok: false, msg: "没配置 masterQQ" })
    const want = url.searchParams.get("profile")
    if (want) await mem.setProfile(conf, qq, want)
    const prof = await mem.getProfile(conf, qq)
    const ctx = await mem.loadCtx(conf, qq)
    const sum = await mem.getSummary(conf, qq)
    const eps = await mem.listEpisodes(conf, qq)
    const facts = await mem.listFacts(conf, qq)
    return json(res, 200, {
      ok: true,
      profile: prof,
      profiles: await mem.listProfiles(conf, qq),
      summary: sum,
      episodes: eps.slice(-30),
      facts: Object.entries(facts)
        .filter(([k]) => !k.startsWith(mem.HIDDEN))
        .map(([k, v]) => ({ key: k, value: v?.v ?? v, t: v?.t })),
      hidden: Object.entries(facts)
        .filter(([k]) => k.startsWith(mem.HIDDEN))
        .map(([k, v]) => ({ key: k.slice(2), value: v?.v ?? v })),
      ctx: ctx.slice(-20),
    })
  }
  if (p === "/api/memory/forget" && req.method === "POST") {
    const qq = userOf(req, conf)
    const body = await readBody(req)
    await mem.forgetAll(conf, qq, { keepFacts: !!body.keepFacts })
    return json(res, 200, { ok: true })
  }

  /* ---- 本地酒馆 ---- */
  if (p === "/api/st") {
    const s = await st.stStatus(conf)
    return json(res, 200, {
      ok: true,
      status: s,
      chars: s.ok ? st.listStChars(conf).map(c => ({ id: c.id, name: c.name, format: c.format, desc: c.desc })) : [],
      worlds: s.ok ? st.listStWorlds(conf) : [],
      presets: s.ok ? st.listStPresets(conf).filter(x => x.kind === "OpenAI Settings").slice(0, 60) : [],
    })
  }
  if (p === "/api/st/import" && req.method === "POST") {
    const body = await readBody(req)
    const r = st.importStChar(conf, String(body.name || ""))
    return json(res, r.ok ? 200 : 400, r)
  }
  if (p === "/api/st/chats") {
    const name = url.searchParams.get("name") || ""
    return json(res, 200, { ok: true, list: st.listStChats(conf, name) })
  }
  if (p === "/api/st/world" && req.method === "POST") {
    const body = await readBody(req)
    const r = st.importStWorld(conf, String(body.name || ""))
    return json(res, r.ok ? 200 : 400, r)
  }
  if (p === "/api/st/preset") {
    const name = url.searchParams.get("name") || ""
    return json(res, 200, st.readStPreset(conf, name))
  }

  /* ---- 配置 ---- */
  if (p === "/api/config") {
    if (req.method === "GET") return json(res, 200, { ok: true, config: apiConfig(conf) })
    if (req.method === "POST") {
      const body = await readBody(req)
      const patch = {}
      for (const [k, v] of Object.entries(body.patch || {})) {
        if (CFG_WHITELIST.includes(k)) patch[k] = v
      }
      // 页面回传的 webui.password 是掩码（或原密码），别拿它覆盖真密码
      if (patch.webui && typeof patch.webui === "object") {
        // apiState 会把 lan / open 这类"读出来的状态"混进 webui，别写回配置文件
        for (const k of Object.keys(patch.webui)) {
          if (!WEBUI_KEYS.includes(k)) delete patch.webui[k]
        }
        const pwd = patch.webui.password
        if (!pwd || pwd === "（已设置）" || pwd === conf.webui?.password) delete patch.webui.password
        if (!Object.keys(patch.webui).length) delete patch.webui
      }
      if (!Object.keys(patch).length) return json(res, 400, { ok: false, msg: "没有可写的字段" })
      const before = { host: conf.webui?.host, port: conf.webui?.port }
      const next = patchConfig(patch)
      let bound = null
      const touched = patch.webui && typeof patch.webui === "object"
      if (touched && (patch.webui.host !== undefined || patch.webui.port !== undefined)) {
        bound = await rebindWebUI()
      }
      return json(res, 200, {
        ok: true,
        config: apiConfig(next),
        webui: bound,
        before,
      })
    }
  }

  return json(res, 404, { ok: false, msg: "no route" })
}

/* ------------------------------------------------------------ 启动 */

let server = null

/** 首次启动时如果没有密码，生成一个并写回配置 */
function ensurePassword(conf) {
  const cur = String(conf.webui?.password || "")
  if (cur) return cur
  const pw = String(crypto.randomInt(100000, 999999))
  try {
    patchConfig({ webui: { ...(conf.webui || {}), password: pw } })
    log().mark?.(`[喵呜] WebUI 密码已生成：${pw}（写在 config.yaml 的 webui.password）`)
  } catch (e) {
    log().warn?.(`[喵呜] WebUI 密码写入失败：${e.message}`)
  }
  return pw
}

export function startWebUI() {
  if (server) return server
  let conf
  try {
    conf = loadConfig()
  } catch {
    return null
  }
  const wc = conf.webui || {}
  if (wc.enabled === false) return null

  const pw = ensurePassword(conf)
  if (!pw) return null

  SESSION_MS = Math.max(1, Number(wc.sessionHours ?? 12)) * 3600 * 1000

  const host = wc.host || "127.0.0.1"
  const port = Number(wc.port || 5199)

  server = http.createServer((req, res) => {
    route(req, res).catch(err => {
      log().error?.(`[喵呜] WebUI ${req.url} 出错：${err.stack || err}`)
      if (!res.headersSent) json(res, 500, { ok: false, msg: String(err.message || err) })
    })
  })

  server.on("error", err => {
    if (err.code === "EADDRINUSE") {
      log().warn?.(`[喵呜] WebUI 端口 ${port} 被占用，跳过启动（可能另一个实例已经在跑）`)
      server = null
      return
    }
    log().error?.(`[喵呜] WebUI 启动失败：${err.message}`)
    server = null
  })

  server.__host = host
  server.__port = port

  server.listen(port, host, () => {
    log().mark?.(`[喵呜] WebUI 已启动 http://${host}:${port}（密码在 config.yaml 的 webui.password）`)
    // 听 0.0.0.0 的时候，顺手把局域网地址打出来 —— 手机照着输就能开
    if (host === "0.0.0.0" || host === "::") {
      const ips = lanAddresses()
      if (ips.length) {
        log().mark?.(`[喵呜] 手机/平板可以开：${ips.map(ip => `http://${ip}:${port}`).join("  或  ")}`)
      }
      log().warn?.(`[喵呜] WebUI 正在对局域网开放 —— 密码是唯一那道门，别用 6 位纯数字`)
    }
  })

  return server
}

/**
 * 改了 webui.host / webui.port 之后原地重绑，不用重启云崽。
 * 手机能不能打开控制台，就取决于这一步。
 */
export async function rebindWebUI() {
  let conf
  try {
    conf = loadConfig()
  } catch {
    return { ok: false, msg: "配置读不出来" }
  }
  const wc = conf.webui || {}
  if (wc.enabled === false) return { ok: false, msg: "控制台是关着的（webui.enabled: false）" }

  const host = wc.host || "127.0.0.1"
  const port = Number(wc.port || 5199)

  if (server && server.__host === host && server.__port === port) {
    return { ok: true, changed: false, host, port, lan: host === "0.0.0.0" ? lanAddresses() : [] }
  }

  // 换端口时先探一下，别把现成的服务停了才发现新端口被占
  if (server && port !== server.__port) {
    const free = await portFree(host, port)
    if (!free) return { ok: false, msg: `端口 ${port} 已经被别的程序占着，没敢切过去` }
  }

  if (server) {
    // 注意：这里不能 await close 的回调 —— 正在等的这条请求自己就是一条活连接，
    // 回调永远等不到。close() 会同步关掉 listening 句柄，端口立刻就能重新绑。
    const old = server
    server = null
    try {
      old.close()
      old.closeIdleConnections?.()
    } catch {}
  }
  SESSION_MS = Math.max(1, Number(wc.sessionHours ?? 12)) * 3600 * 1000
  const s = startWebUI()
  if (!s) return { ok: false, msg: `新地址 ${host}:${port} 没起来（端口可能被占了）` }

  // listen 是异步的，等一小会儿确认真的绑上了
  await new Promise(r => setTimeout(r, 300))
  if (!server) return { ok: false, msg: `新地址 ${host}:${port} 绑定失败，端口可能被占用。去 config.yaml 改回来` }
  return { ok: true, changed: true, host, port, lan: host === "0.0.0.0" ? lanAddresses() : [] }
}

/** 试探某个地址能不能绑（绑上就立刻放掉） */
function portFree(host, port) {
  return new Promise(resolve => {
    const s = net.createServer()
    let done = false
    const fin = ok => {
      if (done) return
      done = true
      try {
        s.close()
      } catch {}
      resolve(ok)
    }
    s.once("error", () => fin(false))
    s.once("listening", () => fin(true))
    try {
      s.listen(port, host)
    } catch {
      fin(false)
    }
  })
}

/** 本机的局域网 IPv4 —— 按"手机更可能连上"的顺序排 */
export function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue
      // 169.254 是没拿到 DHCP 时的自分配地址，手机连不上，别摆出来误导人
      if (a.address.startsWith("169.254.")) continue
      out.push({ ip: a.address, name })
    }
  }
  const score = ip => {
    if (ip.startsWith("192.168.")) return 0 // 家用路由器最常见
    if (ip.startsWith("10.")) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
    return 3
  }
  return out.sort((a, b) => score(a.ip) - score(b.ip)).map(x => x.ip)
}
