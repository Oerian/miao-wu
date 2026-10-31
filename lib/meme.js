/**
 * 表情包系统
 *
 * 识别 → 收藏 → 制作 → 发送，全链路：
 *   1. 识别   主人发图时用视觉模型判断是什么、什么情绪、配什么 tag。
 *             优先云端识图（当前对话后端，Gemini 3.8 等多模态模型），
 *             失败才落回本地 Ollama 视觉模型（qwen3-vl 等）—— 隐私可控
 *   2. 收藏   是表情包且没存过（sha1 去重）就自动收进库，上限防膨胀
 *   3. 制作   [[做表情:文字]] 拿最近一张图（画的/收的）配字渲染成图
 *   4. 发送   [[发表情:描述]] 从库里按描述挑一张最贴的
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { chat, extractJSON } from "./llm.js"
import { dataDir } from "./config.js"
import { tokens } from "./util.js"

const log = () => globalThis.logger || console

/* ------------------------------------------------------------ 存储目录 */

export function memeDir(conf) {
  const d = path.join(dataDir(conf), "memes")
  try { fs.mkdirSync(d, { recursive: true }) } catch { }
  return d
}

function metaPath(conf) {
  const d = memeDir(conf)
  return path.join(d, "meta.json")
}

function loadMeta(conf) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(conf), "utf-8")) || { list: [] }
  } catch {
    return { list: [] }
  }
}

function saveMeta(conf, meta) {
  const file = metaPath(conf)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2))
  fs.renameSync(tmp, file)
}

/* ------------------------------------------------------------ 识别 */

const VISION_PROMPT = `看这张图，判断它是不是"表情包/梗图"（而不是普通照片、截图、二维码）。
只输出一个 JSON 对象，格式：
{"type":"表情包|截图|照片|其他","caption":"一句话描述画面内容（20字内）","emotion":"主要情绪，如 好笑/无语/生气/可爱/震惊/阴阳怪气","tags":["2-4个关键词"]}
type 用"表情包"仅当它是拿来斗图的那种图。不要输出别的任何字。`

/**
 * 视觉识别。优先云端对话后端（多模态），失败落回本地 Ollama 视觉模型。
 * @param {object} conf 插件配置
 * @param {Buffer} imgBuf 图片字节
 * @param {string} mime image/png 等
 * @param {object} prov 当前对话 provider（多模态走它）
 * @returns {Promise<{type,caption,emotion,tags}|null>} 识别失败返回 null
 */
export async function visionDescribe(conf, imgBuf, mime, prov) {
  const b64 = imgBuf.toString("base64")
  const dataUrl = `data:${mime || "image/png"};base64,${b64}`

  // 1) 云端：OpenAI 兼容 vision 格式（image_url 内容块）
  if (prov && conf.meme?.visionCloud !== false) {
    try {
      const raw = await chat(prov, [{
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }], { maxTokens: 200, temperature: 0.3, retries: 1, timeoutMs: 60000 })
      const parsed = extractJSON(raw)
      if (parsed?.caption) return normalizeVision(parsed)
    } catch (e) {
      log().warn?.(`[miao-wu] 云端识图失败，落回本地：${String(e.message).slice(0, 80)}`)
    }
  }

  // 2) 本地：Ollama 视觉模型（qwen3-vl 等）
  const local = conf.meme?.localVision
  if (local !== false) {
    try {
      const base = String(conf.meme?.ollamaUrl || "http://127.0.0.1:11434").replace(/\/+$/, "")
      const model = String(conf.meme?.localModel || "qwen3-vl-4b")
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 90000)
      let res
      try {
        res = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [{ role: "user", content: VISION_PROMPT, images: [b64] }],
            options: { temperature: 0.3, num_predict: 200 },
          }),
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const parsed = extractJSON(data?.message?.content || "")
      if (parsed?.caption) return normalizeVision(parsed)
    } catch (e) {
      log().warn?.(`[miao-wu] 本地识图也失败：${String(e.message).slice(0, 80)}`)
    }
  }
  return null
}

function normalizeVision(v) {
  const tags = Array.isArray(v.tags) ? v.tags.map(t => String(t)).slice(0, 6) : []
  return {
    type: String(v.type || "其他"),
    caption: String(v.caption || "").slice(0, 60),
    emotion: String(v.emotion || "").slice(0, 20),
    tags,
  }
}

/* ------------------------------------------------------------ 收藏 */

const sha1 = buf => crypto.createHash("sha1").update(buf).digest("hex")

/**
 * 收一张表情包。sha1 去重；超过上限时挤掉最旧且最少使用的。
 * @returns {{ok:boolean, id?:string, dup?:boolean, msg:string}}
 */
export function addMeme(conf, buf, meta, mime = "image/png") {
  const dir = memeDir(conf)
  const all = loadMeta(conf)
  const hash = sha1(buf)
  if (all.list.some(m => m.hash === hash)) {
    return { ok: false, dup: true, msg: "已经在库里了" }
  }

  const ext = mime.includes("gif") ? "gif" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png"
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const file = path.join(dir, `${id}.${ext}`)
  fs.writeFileSync(file, buf)

  all.list.push({
    id,
    file: path.basename(file),
    hash,
    caption: String(meta?.caption || "").slice(0, 60),
    emotion: String(meta?.emotion || "").slice(0, 20),
    tags: meta?.tags || [],
    from: String(meta?.from || "").slice(0, 30),
    t: Date.now(),
    uses: 0,
  })

  // 上限：挤掉最旧最少用
  const max = Number(conf.meme?.maxCount ?? 100)
  if (all.list.length > max) {
    all.list.sort((a, b) => a.uses - b.uses || a.t - b.t)
    const drop = all.list[0]
    try { fs.unlinkSync(path.join(dir, drop.file)) } catch { }
    all.list = all.list.slice(1)
  }
  saveMeta(conf, all)
  return { ok: true, id, msg: "已收藏" }
}

export function listMemes(conf) {
  return loadMeta(conf).list
}

export function removeMeme(conf, idOrN) {
  const all = loadMeta(conf)
  const idx = all.list.findIndex(m => m.id === idOrN)
  if (idx < 0) return false
  try { fs.unlinkSync(path.join(memeDir(conf), all.list[idx].file)) } catch { }
  all.list.splice(idx, 1)
  saveMeta(conf, all)
  return true
}

/**
 * 按描述挑一张最贴的表情包（caption/emotion/tags 关键词匹配）。
 * @param {string} avoidId  刚发过的一张，随机兜底时避开（斗图别连发同图）
 * @returns {object|null} 命中的 meme 元数据
 */
export function findMeme(conf, query, avoidId = "") {
  const list = loadMeta(conf).list
  if (!list.length) return null
  const pool = list.length > 1 && avoidId ? list.filter(m => m.id !== avoidId) : list
  const q = new Set(tokens(query))
  if (!q.size) {
    // 没给描述就随机来一张，斗图嘛
    return pool[Math.floor(Math.random() * pool.length)]
  }
  let best = null, bestScore = 0
  for (const m of pool) {
    const bag = new Set([...tokens(m.caption || ""), ...tokens(m.emotion || ""), ...(m.tags || []).flatMap(t => tokens(t))])
    let hit = 0
    for (const t of bag) if (q.has(t)) hit++
    if (hit > bestScore) { bestScore = hit; best = m }
  }
  return bestScore > 0 ? best : pool[Math.floor(Math.random() * pool.length)]
}

export function memeFile(conf, m) {
  return path.join(memeDir(conf), m.file)
}

export function markUsed(conf, m) {
  m.uses = (m.uses || 0) + 1
  const all = loadMeta(conf)
  const it = all.list.find(x => x.id === m.id)
  if (it) { it.uses = m.uses; saveMeta(conf, all) }
}

/* ------------------------------------------------------------ 制作 */

/**
 * 配字表情包的 HTML。经典样式：大字白底黑边，压在图上下。
 * 文字过长自动换行缩小。
 */
export function memeHtml(imgSrc, top, bottom) {
  const capStyle = `
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
    font-weight: 900; color: #fff; text-align: center;
    -webkit-text-stroke: 3px #000; paint-order: stroke fill;
    letter-spacing: 2px; line-height: 1.15; padding: 6px 14px;
    font-size: 44px; text-transform: none; word-break: break-all;`
  const t = String(top || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const b = String(bottom || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const tBlock = t ? `<div style="${capStyle} font-size:${t.length > 12 ? 34 : 44}px">${t}</div>` : ""
  const bBlock = b ? `<div style="${capStyle} font-size:${b.length > 12 ? 34 : 44}px">${b}</div>` : ""
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background: transparent; }
    #wrap { display:inline-block; position:relative; }
    #wrap img { display:block; max-width:640px; }
    .cap { position:absolute; left:0; right:0; }
    .cap.top { top:8px; } .cap.bottom { bottom:8px; }
  </style></head><body>
  <div id="wrap">
    <img src="${imgSrc}">
    ${t ? `<div class="cap top">${tBlock}</div>` : ""}
    ${b ? `<div class="cap bottom">${bBlock}</div>` : ""}
  </div></body></html>`
}

/**
 * 渲染配字表情包。imgSrc 支持 file:/// 本地路径（云崽渲染器能读本机文件）。
 * @returns {Promise<any|null>} segment 图片段
 */
export async function renderMeme(imgSrc, top, bottom) {
  if (typeof globalThis.segment?.image !== "function") return null
  try {
    const { default: puppeteer } = await import("../../../lib/puppeteer/puppeteer.js")
    const img = await puppeteer.screenshot("miao-wu/meme", { html: memeHtml(imgSrc, top, bottom) })
    return img || null
  } catch (e) {
    log().warn?.(`[miao-wu] 表情包渲染失败：${e.message}`)
    return null
  }
}

/** 最近一张可用底图：画过的图 / 收藏的图，按修改时间取新 */
export function latestBaseImage(conf) {
  const drawDir = path.join(dataDir(conf), "draw")
  let newest = { t: 0, file: "" }
  try {
    for (const f of fs.readdirSync(drawDir)) {
      if (!/\.(png|jpg|jpeg)$/i.test(f)) continue
      const st = fs.statSync(path.join(drawDir, f))
      if (st.mtimeMs > newest.t) newest = { t: st.mtimeMs, file: path.join(drawDir, f) }
    }
  } catch { }
  if (newest.t) return newest.file
  const mem = listMemes(conf)
  if (mem.length) return memeFile(conf, mem[mem.length - 1])
  return ""
}
