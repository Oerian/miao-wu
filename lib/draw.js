/**
 * 绘图辅助
 *
 * 三种意图：
 *   new     —— 「画个猫耳少女」从零画
 *   refine  —— 「猫耳，棕发」「改成棕发」在上一张基础上改
 *   query   —— 「还有多久出图」问进度（走真实状态，不经过模型）
 *
 * 出图走 comfy-bridge 的 A1111 兼容接口（/sdapi/v1/txt2img）。
 */
import fs from "node:fs"
import path from "node:path"
import { PLUGIN_DIR, resolve } from "./config.js"
import { chat, chatJSON, extractJSON } from "./llm.js"

const log = () => globalThis.logger || console

/* ============================================================ 意图识别 */

/** 比喻/引申用法，不是真要画图 */
const NOT_DRAW = /^(?:画圈|画饼|画押|画符|画重点|画笔|画出|画了|画过|画完|画好|画风|画上|画下|画在)/

const DRAW_RE = [
  /^(?:画图|绘图|出图|生成图|来张图|来一张图)[\s:：,，]*([\s\S]+)$/,
  /^(?:帮我|给我|麻烦你?)(?:画|生成|出)[\s:：,，]*(?:一[张幅个]|[张幅个])?[\s:：,，]*([\s\S]+)$/,
  /^画(?:一[张幅个]|[张幅个])?[\s:：,，]*([\s\S]+)$/,
]

/** 光秃秃的"再来一张" */
const REFINE_SURE_RE = /^(?:再来一张|再画一张|重新画|重画|换一张|另一张|换个角度|换个姿势)[！!。.…~\s]*$/

/** 带参数的改图动词（参数里必须有外观词才认） */
const REFINE_ARG_RE = [
  { kind: "replace", re: /^(?:把|给|帮我把)?(.{0,16}?)(?:改成|换成|改作|变成|改为)(.{1,16})$/ },
  { kind: "add", re: /^(?:再加|加上|加个|加一个|添个|添上|多加点|来点|要个)(.{1,16})$/ },
  { kind: "remove", re: /^(?:去掉|删了|删掉|不要|别要|拿掉|取消)(.{1,16})$/ },
  { kind: "more", re: /^(?:画得?更|再)(.{1,16})$/ },
]

/** 这些词不是"画上某个特征"，别当成改图 */
const NOT_ATTR_ARG = /^(?:这个|那个|这些|那些|这样|那样|它|他|她|点|些|吧|啊|呢|吗)$/

const DENY_RE = /^(?:明明)?(?:就?没有|没画|哪有了?|哪里有|没有啊?|糊弄我|骗人|你骗我)[！!。.…~\s]*$/

const QUERY_RE = [
  /(?:还|要|得)?(?:多久|多长时间)(?:才能|才|会)?(?:出图|画好|画完|好|出来)/,
  /(?:画|画图|出图|图)(?:好|完)了(?:吗|没|么|没有)/,
  /(?:出图|画)了(?:吗|没|么)/,
  /(?:图|画)呢[？?]?$/,
  /画(?:到|得)哪(?:了|儿)/,
  /(?:怎么|为何)(?:还)?(?:没|不)(?:出图|画|动|出)/,
  // 「还有多久」「还要多久」—— 手上正有一张在画的时候，问的就是它
  /^(?:还要|还有|要)?多久[啊呢吗呀]?$/,
]

const ATTR_WORDS = [
  "黑皮", "白皮", "小麦色", "古铜", "深色", "浅色", "渐变",
  "黑", "白", "红", "蓝", "棕", "金", "银", "粉", "紫", "绿", "灰", "橙", "青", "黄",
  "双马尾", "麻花辫", "丸子头", "齐刘海", "狼尾", "长发", "短发", "中长", "马尾", "卷发",
  "直发", "呆毛", "刘海", "盘发", "散发", "波浪",
  "异色瞳", "竖瞳", "猫瞳", "红眼", "蓝眼", "金瞳", "眼睛", "瞳孔", "眼眸", "瞳色", "发色", "肤色",
  "恶魔角", "猫耳", "兽耳", "狐耳", "兔耳", "尾巴", "翅膀", "虎牙", "尖牙", "触角", "犄角",
  "平胸", "巨乳", "大胸", "正太", "萝莉", "少女", "少年", "成年", "成熟", "男娘", "伪娘",
  "高个", "瘦", "肌肉", "腿",
  "卫衣", "短裙", "长裙", "裙子", "校服", "礼服", "和服", "泳装", "睡衣", "外套", "短裤",
  "裤子", "衬衫", "毛衣", "围裙", "丝袜", "靴子", "帽子", "围巾", "项圈", "手套", "袜子",
  "眼镜", "耳环", "发卡", "领带", "斗篷", "披风",
  "写实", "二次元", "赛博", "古风", "吉卜力", "水墨", "厚涂", "油画", "像素", "q版", "chibi",
  "海边", "森林", "教室", "图书馆", "街道", "夜景", "樱花", "夕阳", "黄昏", "室内", "室外",
  "床上", "窗边", "屋顶", "雨", "雪",
  "微笑", "害羞", "睡觉", "看书", "发呆", "转身", "回头", "可爱", "好看",
  "坐", "站", "躺", "跑", "跳", "笑", "哭", "抱",
]

function hasAttr(s) {
  const low = String(s || "").toLowerCase()
  return ATTR_WORDS.some(w => low.includes(w.toLowerCase()))
}

/** 「琥珀色」「亚麻色」这类词表里没列的颜色，也算命中 */
const COLORISH = /^[\u4e00-\u9fa5A-Za-z]{1,3}色$/

/** 命中几个属性词（不挑位置，只数个数） */
function countAttrs(s) {
  const sorted = [...ATTR_WORDS].sort((a, b) => b.length - a.length)
  let rest = String(s || "").toLowerCase()
  let n = 0
  for (const w of sorted) {
    const lw = w.toLowerCase()
    if (rest.includes(lw)) {
      rest = rest.split(lw).join(" ")
      n++
    }
  }
  for (const tok of rest.split(/[\s,，、\/]+/)) {
    if (COLORISH.test(tok)) n++
  }
  return n
}

/** 整句是不是"纯属性枚举"：把命中的词抠掉后剩不下几个字 */
function looksLikeAttrs(seg) {
  const parts = String(seg).split(/[,，、\s\/]+/).map(s => s.trim()).filter(Boolean)
  if (!parts.length || parts.length > 5) return false
  let hits = 0
  const sorted = [...ATTR_WORDS].sort((a, b) => b.length - a.length)
  for (const p of parts) {
    if ([...p].length > 8) return false
    let rest = p.toLowerCase()
    for (const w of sorted) {
      const lw = w.toLowerCase()
      if (rest.includes(lw)) {
        rest = rest.split(lw).join("")
        hits++
      }
    }
    rest = rest.replace(/[的色发头子们个啊呀喵]/g, "")
    if ([...rest].length > 1) return false
  }
  // 一个属性词都没命中，就只是随口一句话 ——
  // 之前这里只按"剩不下几个字"判，结果「喂」「嗯」「…」全被当成属性枚举去重画
  return hits > 0
}

/**
 * @param {string} text
 * @param {object} ctx { hasLastPlan, planAgeMs, drawing, maxAgeMs }
 */
export function detectDrawIntent(text, ctx = {}) {
  const t = String(text || "").trim()
  const none = { isDraw: false, mode: null, subject: "" }
  if (!t || [...t].length > 200) return none

  const fresh = !!ctx.hasLastPlan && (ctx.planAgeMs ?? 0) <= (ctx.maxAgeMs ?? 30 * 60000)
  const busy = !!ctx.drawing

  if (/^画画/.test(t) && !/^画画[\s:：,，]/.test(t)) return none

  /*
   * 顺序讲究（踩过的坑）：
   *  - 「画好了吗」要 query 优先，否则被 NOT_DRAW 的「画好」当叙述挡掉
   *  - 「画得更可爱」要改图优先，否则 DRAW_RE 的 ^画 当新画
   */

  // 1. 问状态（标点先去掉，「我！的！画！呢！」也算在问）
  const q = t.replace(/[！!。.…~～\s]+/g, "")
  if ((fresh || busy) && [...t].length <= 24 && QUERY_RE.some(re => re.test(q))) {
    return { isDraw: true, mode: "query", subject: t }
  }

  // 2. 改图
  if (fresh) {
    if (DENY_RE.test(t)) return { isDraw: true, mode: "refine", subject: t, instruction: "按上次的要求重新画一张" }
    if (REFINE_SURE_RE.test(t)) return { isDraw: true, mode: "refine", subject: t, instruction: "按上次的要求再画一张" }
    for (const { kind, re } of REFINE_ARG_RE) {
      const m = t.match(re)
      if (!m) continue
      const args = m.slice(1).filter(Boolean).join(" ")
      // 「去掉项链」「删了围巾」这类：被删的东西不一定是外观词表里的，
      // 只要是个短名词就认（但不能是「这个」「那个」这种指代）
      const bare = args.trim().replace(/[了吧啊呀嘛哦呢]+$/, "")
      const loose =
        kind === "remove" &&
        [...bare].length <= 8 &&
        !/[？?]/.test(bare) &&
        !NOT_ATTR_ARG.test(bare)
      if (!loose && !hasAttr(args)) continue
      return { isDraw: true, mode: "refine", subject: t, instruction: t }
    }
  }

  if (NOT_DRAW.test(t)) return none

  // 3. 新画
  for (const re of DRAW_RE) {
    const m = t.match(re)
    if (m && m[1] && m[1].trim()) {
      const subject = m[1].trim()
      if (/^(了|过|完|到|得|成)/.test(subject)) continue
      return { isDraw: true, mode: "new", subject }
    }
  }

  // 4. 纯属性枚举
  //    老实说"白发，红眼"是一种，喊"白发！琥珀色瞳孔！我愤怒！"又是另一种 ——
  //    后面这种带情绪，但真的是在提要求，不能当闲聊放过去（用户为这个生过气）。
  if (fresh && [...t].length <= 30 && !/[？?]/.test(t)) {
    if (looksLikeAttrs(t)) return { isDraw: true, mode: "refine", subject: t, instruction: t }
    if (countAttrs(t) >= 2) {
      return { isDraw: true, mode: "refine", subject: t, instruction: t.replace(/[！!]+/g, "，") }
    }
  }

  return none
}

/* ============================================================ LoRA 扫描 */

let loraCache = { at: 0, list: [] }

export function listLoras(drawCfg, force = false) {
  const now = Date.now()
  if (!force && loraCache.list.length && now - loraCache.at < 60000) return loraCache.list
  const root = resolve(drawCfg?.loraDir || "")
  if (!root || !fs.existsSync(root)) return []

  const out = []
  const walk = (dir, prefix = "") => {
    let ents = []
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel)
        continue
      }
      if (!/\.(safetensors|ckpt|pt)$/i.test(e.name)) continue
      out.push({
        name: e.name.replace(/\.(safetensors|ckpt|pt)$/i, ""),
        rel,
        dir: prefix || "根目录",
      })
    }
  }
  walk(root)
  loraCache = { at: now, list: out }
  return out
}

function loraBrief(drawCfg) {
  const list = listLoras(drawCfg)
  if (!list.length) return "（当前没有任何 LoRA，lora 字段给空数组）"
  const byDir = {}
  for (const l of list) (byDir[l.dir] ||= []).push(l.name)
  return Object.entries(byDir).map(([d, ns]) => `- ${d}：${ns.join("、")}`).join("\n")
}

/* ============================================================ 知识库 */

let kbCache = { mtime: 0, text: "" }

export function loadKnowledge(drawCfg) {
  const p = drawCfg?.knowledgeFile || "config/draw-knowledge.md"
  const file = resolve(p)
  try {
    const st = fs.statSync(file)
    if (st.mtimeMs === kbCache.mtime) return kbCache.text
    const text = fs.readFileSync(file, "utf-8")
    kbCache = { mtime: st.mtimeMs, text }
    return text
  } catch (e) {
    log().warn?.(`[miao-wu] 读绘图知识库失败：${e.message}`)
    return kbCache.text || ""
  }
}

/* ============================================================ 出方案 */

function clampInt(v, min, max, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.round(n)))
}
function clampNum(v, min, max, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

function normalizePlan(plan) {
  const p = {
    positive: String(plan?.positive || "").trim(),
    negative: String(plan?.negative || "").trim(),
    width: clampInt(plan?.width, 512, 1536, 832),
    height: clampInt(plan?.height, 512, 1536, 1216),
    steps: clampInt(plan?.steps, 12, 40, 28),
    cfg: clampNum(plan?.cfg, 4, 8, 7),
    lora: Array.isArray(plan?.lora) ? plan.lora.filter(x => x?.name) : [],
    say: String(plan?.say || "").slice(0, 60),
    after: String(plan?.after || "").slice(0, 60),
  }
  if (!p.positive) throw new Error("模型给出的正向提示词是空的")
  return p
}

/** 逐字段正则捞（JSON 被截断时的兜底） */
export function salvageFields(text) {
  const src = String(text || "")
  if (!src.includes('"positive"')) return null
  const grabStr = key => {
    const i = src.indexOf(`"${key}"`)
    if (i < 0) return undefined
    const j = src.indexOf(":", i)
    if (j < 0) return undefined
    let k = src.indexOf('"', j + 1)
    if (k < 0) return undefined
    let out = ""
    for (let p = k + 1; p < src.length; p++) {
      if (src[p] === "\\") {
        out += src[p + 1] ?? ""
        p++
        continue
      }
      if (src[p] === '"') break
      out += src[p]
    }
    return out
  }
  const grabNum = key => {
    const m = src.match(new RegExp(`"${key}"\\s*:\\s*(-?[\\d.]+)`))
    return m ? Number(m[1]) : undefined
  }
  const positive = grabStr("positive")
  if (!positive) return null
  const lora = []
  const sec = src.match(/"lora"\s*:\s*(\[[\s\S]*?\])\s*[,}]/)
  if (sec) {
    for (const chunk of String(sec[1] || "").split("}")) {
      const nm = chunk.match(/"name"\s*:\s*"([^"]+)"/)
      if (!nm) continue
      const wt = chunk.match(/"weight"\s*:\s*(-?[\d.]+)/)
      lora.push({ name: nm[1], weight: wt ? Number(wt[1]) : 0.75 })
    }
  }
  return { positive, negative: grabStr("negative"), width: grabNum("width"), height: grabNum("height"), steps: grabNum("steps"), cfg: grabNum("cfg"), lora, say: grabStr("say"), after: grabStr("after") }
}

/** 从零出方案 */
export async function planDraw(subject, { prov, drawCfg, personaHint = "" }) {
  const sys = [
    loadKnowledge(drawCfg),
    "",
    "---",
    "## 本次可用的 LoRA",
    loraBrief(drawCfg),
    "",
    personaHint ? `## 说话风格\n${personaHint}` : "",
    "",
    `现在要画：**${subject}**`,
    "按知识库最后一节的 JSON 格式输出。",
  ].filter(Boolean).join("\n")

  const raw = await chat(prov, [
    { role: "system", content: sys },
    { role: "user", content: subject },
  ], { maxTokens: 1600, temperature: 0.9, silent: true })

  let plan = extractJSON(raw) || salvageFields(raw)
  if (!plan) throw new Error(`JSON 解析失败 · 共 ${raw.length} 字符 · 结尾 ${JSON.stringify(String(raw).slice(-70))}`)
  return normalizePlan(plan)
}

/**
 * 在上一张基础上改。
 *
 * 必须把上一张完整 tag 交给模型，并强调"没提到的别动、替换要删旧的"，
 * 否则模型会从零重画，原内容全丢。
 */
export async function planRefine(prev, instruction, { prov, drawCfg, personaHint = "" }) {
  const sys = [
    loadKnowledge(drawCfg),
    "",
    "---",
    "",
    "## 上一次的方案（对方已经看过这张图）",
    "```",
    `positive: ${prev.positive}`,
    `negative: ${prev.negative}`,
    `尺寸: ${prev.width}x${prev.height}  steps=${prev.steps}  cfg=${prev.cfg}`,
    prev.lora?.length ? `lora: ${JSON.stringify(prev.lora)}` : "lora: 无",
    "```",
    "",
    "## 规则（违反就画错了）",
    "1. 在上一张的 tag 基础上改，**只动对方提到的地方**。",
    "2. 没提到的 tag 全部原样保留，顺序也别改。",
    "3. **替换类改动必须删掉旧 tag，不能叠加**：",
    "   - 说「改棕发」→ 把 `white hair` 换成 `brown hair`，不能两个都留",
    "   - 说「改成黑皮」→ 把原肤色 tag 换成 `dark skin`",
    "4. 新增类直接加在合适位置（`cat ears` 放在头部特征附近）。",
    "5. 尺寸、步数、cfg 除非明确要求，否则保持不变。",
    "6. 输出**完整 JSON**，不是差值。",
    "",
    personaHint ? `## 说话风格\n${personaHint}` : "",
    "",
    `## 这次的要求\n**${instruction}**`,
    "",
    "按知识库最后一节的 JSON 格式输出完整方案。",
  ].filter(Boolean).join("\n")

  const raw = await chat(prov, [
    { role: "system", content: sys },
    { role: "user", content: instruction },
  ], { maxTokens: 1600, temperature: 0.9, silent: true })

  let plan = extractJSON(raw) || salvageFields(raw)
  if (!plan) throw new Error(`JSON 解析失败 · 共 ${raw.length} 字符 · 结尾 ${JSON.stringify(String(raw).slice(-70))}`)
  return normalizePlan(plan)
}

/* ============================================================ 出图 */

export async function renderImage(plan, drawCfg) {
  const base = String(drawCfg?.bridgeUrl || "http://127.0.0.1:7860").replace(/\/+$/, "")
  const timeout = Number(drawCfg?.timeoutMs || 300000)

  let positive = plan.positive
  const loras = (plan.lora || [])
    .map(l => `<lora:${String(l.name).replace(/\.safetensors$/i, "")}:${Number(l.weight) || 0.8}>`)
    .join(", ")
  if (loras) positive = `${loras}, ${positive}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  const t0 = Date.now()
  let data
  try {
    const res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: positive,
        negative_prompt: plan.negative || "",
        steps: plan.steps,
        cfg_scale: plan.cfg,
        width: plan.width,
        height: plan.height,
        batch_size: 1,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`绘图服务返回 ${res.status}：${(await res.text()).slice(0, 160)}`)
    data = await res.json()
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`出图超时（${Math.round(timeout / 1000)} 秒）`)
    throw e
  } finally {
    clearTimeout(timer)
  }

  const imgs = data?.images || []
  if (!imgs.length) throw new Error("绘图服务没有返回图片")

  const raw = String(imgs[0])
  if (!raw.startsWith("data:image") && raw.length < 5000) {
    return { file: raw, ms: Date.now() - t0 }
  }

  const buf = Buffer.from(raw.split(",", 2)[1] || raw, "base64")
  const saveDir = resolve(drawCfg?.saveDir || "data/draw")
  fs.mkdirSync(saveDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const file = path.join(saveDir, `mw-${stamp}.png`)
  fs.writeFileSync(file, buf)

  log().mark?.(`[miao-wu] 出图完成 ${Math.round((Date.now() - t0) / 1000)}s -> ${path.basename(file)}`)
  return { file, ms: Date.now() - t0 }
}

export async function bridgeAlive(drawCfg) {
  const base = String(drawCfg?.bridgeUrl || "http://127.0.0.1:7860").replace(/\/+$/, "")
  try {
    const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) })
    return r.status < 500
  } catch {
    return false
  }
}
