/**
 * 酒馆助手等价层
 *
 * SillyTavern 的「酒馆助手」(Tavern Helper / JS-Slash-Runner) 在浏览器里能跑
 * JS、渲染 HTML、操作变量。QQ 是纯文本 + 图片通道，等价映射如下：
 *
 *   ST 的能力            →  QQ 里怎么做
 *   ─────────────────────────────────────────────────────────
 *   正则脚本 (Regex)      →  角色卡 front-matter 里写 regex: 规则，
 *                           对模型输入/输出做查找替换（同 ST Regex 扩展）
 *   HTML 状态栏渲染       →  角色卡写 statebar: HTML 模板，
 *                           用云崽 puppeteer 渲染成图片发送
 *   变量系统 (get/setvar) →  模型嵌 [[变量:好感度=+1]] 标记记状态，
 *                           模板里用 {{var:好感度}} 读
 *   快捷按钮 (QuickReply) →  模型嵌 [[选项:A|B|C]]，用户回数字即可选
 *   宏 ({{user}} 等)      →  {{char}} {{user}} {{nick}} {{date}} {{time}}
 *                           {{random:a|b|c}} {{var:名字}}
 *
 * 安全边界：故意**不做**任意 JS 执行 —— QQ 端没有浏览器沙箱，
 * 正则规则限长限次，宏是纯字符串替换，没有 eval。
 */
import path from "node:path"
import * as mem from "./memory.js"
import { PLUGIN_DIR } from "./config.js"

const log = () => globalThis.logger || console

const VARS_KEY = "tavernVars"
const OPTIONS_KEY = "tavernOptions"

/* ------------------------------------------------------------ 正则脚本 */

/**
 * 应用角色卡里定义的正则规则。
 * 卡片 front-matter：
 *   regex:
 *     - find: "<think>[\\s\\S]*?</think>"
 *       replace: ""
 *       flags: g          # 可选，默认 g
 *       target: output    # 可选 output / input / both，默认 output
 * @returns {string} 处理后的文本；规则坏了就跳过，绝不抛错
 */
export function applyRegexRules(card, text, target = "output") {
  const rules = Array.isArray(card?.regex) ? card.regex : []
  let out = String(text ?? "")
  for (const rule of rules) {
    if (!rule || typeof rule.find !== "string" || !rule.find) continue
    if (rule.find.length > 500) continue // 太长的大概率是写错了，防 ReDoS
    const t = String(rule.target || "output")
    if (t !== "both" && t !== target) continue
    try {
      const re = new RegExp(rule.find, rule.flags ?? "g")
      out = out.replace(re, String(rule.replace ?? ""))
    } catch (e) {
      log().warn?.(`[miao-wu] 角色卡正则规则跳过（${e.message.slice(0, 60)}）`)
    }
  }
  return out
}

/* ------------------------------------------------------------ 宏 */

/**
 * 展开模板宏。ctx: { char, user, nick, vars }
 * 纯字符串替换，{{ 里写什么都只当文本，不执行。
 */
export function expandMacros(text, ctx = {}) {
  let out = String(text ?? "")
  const now = new Date()
  const reps = [
    [/\{\{\s*char\s*\}\}/g, String(ctx.char || "她")],
    [/\{\{\s*user\s*\}\}/g, String(ctx.user || "主人")],
    [/\{\{\s*(nick|nickname)\s*\}\}/g, String(ctx.nick || ctx.user || "主人")],
    [/\{\{\s*date\s*\}\}/g, `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`],
    [/\{\{\s*time\s*\}\}/g, now.toLocaleTimeString("zh-CN", { hour12: false })],
    [/\{\{\s*weekday\s*\}\}/g, "日一二三四五六"[now.getDay()]],
  ]
  for (const [re, val] of reps) out = out.replace(re, val)

  // {{random:a|b|c}} / {{pick:a|b|c}}
  out = out.replace(/\{\{\s*(?:random|pick)\s*[:：]([^}]{1,200})\}\}/g, (_m, list) => {
    const items = String(list).split(/[|｜]/).map(s => s.trim()).filter(Boolean)
    return items.length ? items[Math.floor(Math.random() * items.length)] : ""
  })

  // {{var:名字}}
  const vars = ctx.vars || {}
  out = out.replace(/\{\{\s*var\s*[:：]\s*([^}]{1,60}?)\s*\}\}/g, (_m, name) => {
    const v = vars[String(name).trim()]
    return v === undefined ? "" : String(v)
  })
  return out
}

/* ------------------------------------------------------------ 变量标记 */

/**
 * 从模型输出里剥 [[变量:名=值]]（值支持相对 +/-）并应用到存档。
 * @returns {{ text: string, changed: string[] }}
 */
export async function applyVarTags(conf, qq, text) {
  const tags = []
  const clean = String(text ?? "").replace(/\[\[\s*变量\s*[:：]\s*([^\]]{1,80}?)\s*\]\]/g, (_m, body) => {
    tags.push(String(body).trim())
    return ""
  })
  if (!tags.length) return { text: clean, changed: [] }

  const vars = await getVars(conf, qq)
  const changed = []
  for (const tag of tags) {
    const m = tag.match(/^([^=＋+\-]{1,30})\s*=\s*(.+)$/)
    if (!m) continue
    const name = m[1].trim()
    let val = m[2].trim()
    const rel = val.match(/^([＋+\-])\s*(-?\d+(?:\.\d+)?)$/)
    if (rel && typeof vars[name] === "number") {
      const sign = rel[1] === "-" || rel[1] === "－" ? -1 : 1
      vars[name] = Math.round((vars[name] + sign * Number(rel[2])) * 100) / 100
    } else if (rel && vars[name] === undefined) {
      vars[name] = Number(rel[2]) || 0 // 没有就从0起算
    } else {
      vars[name] = val
    }
    changed.push(`${name}=${vars[name]}`)
  }
  if (changed.length) await mem.setHidden(conf, qq, VARS_KEY, JSON.stringify(vars))
  return { text: clean, changed }
}

export async function getVars(conf, qq) {
  const raw = await mem.getHidden(conf, qq, VARS_KEY)
  if (!raw) return {}
  try { return JSON.parse(raw) || {} } catch { return {} }
}

/* ------------------------------------------------------------ 快捷选项 */

/**
 * 剥 [[选项:A|B|C]]，返回选项列表。
 */
export function parseOptions(text) {
  let options = []
  const clean = String(text ?? "").replace(/\[\[\s*选项\s*[:：]\s*([^\]]{1,300}?)\s*\]\]/g, (_m, body) => {
    options = String(body).split(/[|｜]/).map(s => s.trim()).filter(Boolean).slice(0, 6)
    return ""
  })
  return { text: clean, options }
}

export async function saveOptions(conf, qq, options) {
  if (options?.length) await mem.setHidden(conf, qq, OPTIONS_KEY, JSON.stringify(options))
}

/**
 * 用户回了数字 → 取出对应选项文本；没有挂起选项或不是数字就返回 null。
 * 取完即清空（一次性）。
 */
export async function takeOption(conf, qq, body) {
  const raw = await mem.getHidden(conf, qq, OPTIONS_KEY)
  if (!raw) return null
  const list = (() => { try { return JSON.parse(raw) || [] } catch { return [] } })()
  if (!list.length || !/^[1-9]\d?$/.test(String(body).trim())) return null
  const idx = Number(String(body).trim()) - 1
  if (idx >= list.length) return null
  await mem.setHidden(conf, qq, OPTIONS_KEY, "")
  return list[idx]
}

/* ------------------------------------------------------------ 状态栏 */

/**
 * 生成状态栏 HTML（卡片 statebar 字段 + 宏展开）。
 * @returns {string|null} 没配状态栏就 null
 */
export function statebarHtml(card, ctx = {}) {
  const html = card?.statebar || card?.状态栏
  if (!html || typeof html !== "string") return null
  return expandMacros(html, { ...ctx, vars: ctx.vars || {} })
}

/** QQ 表情名 → face id（常用子集，卡外名字忽略） */
const FACE_IDS = {
  微笑: 1, 撇嘴: 2, 发呆: 4, 得意: 5, 流泪: 6, 害羞: 7, 睡: 9, 大哭: 10,
  尴尬: 11, 发怒: 12, 调皮: 13, 呲牙: 14, 惊讶: 15, 难过: 17, 囧: 18, 委屈: 20,
  酷: 21, 偷笑: 28, 可爱: 30, 白眼: 33, 饿: 36, 累: 39, 汗: 40, 高兴: 43,
  惊恐: 46, 悠闲: 49, 偷听: 51, 无聊: 52, 抱抱: 56, 亲亲: 57, 鼓掌: 62,
  生气: 63, 期待: 69, 爱心: 66, 心碎: 67, 赞: 76, 握手: 74, OK: 81, 转圈: 98,
}

/** 解析 [[表情:名字]] → face id；解析不了返回 null */
export function parseFaceTag(text) {
  const m = String(text ?? "").match(/\[\[\s*表情\s*[:：]\s*([^\]]{1,12}?)\s*\]\]/)
  if (!m) return null
  const id = FACE_IDS[m[1]] ?? (/^\d{1,3}$/.test(m[1]) ? Number(m[1]) : null)
  return id ?? null
}

/** 剥掉 [[表情:…]] 标记（发完表情后的正文清理） */
export function stripFaceTag(text) {
  return String(text ?? "").replace(/\[\[\s*表情\s*[:：]\s*[^\]]{1,12}\s*\]\]/g, "").trim()
}

/* ------------------------------------------------------------ 状态栏渲染 */

/**
 * 把状态栏 HTML 渲染成图片（云崽 puppeteer）。
 * 模板是静态壳子，卡片 HTML 通过 {{@ html}} 原样注入 —— 数据值不会被
 * 二次模板编译，卡里写 {{ }} 也只是普通文本。
 * @returns {Promise<any|null>} segment 图片段；渲染器不在就 null
 */
export async function renderStatebar(html) {
  if (typeof globalThis.segment?.image !== "function") return null
  try {
    const { default: puppeteer } = await import("../../../lib/puppeteer/puppeteer.js")
    const img = await puppeteer.screenshot("miao-wu/statebar", {
      tplFile: path.join(PLUGIN_DIR, "resources", "statebar", "statebar.html"),
      // 渲染器对带斜杠的 name 不会建深层目录，必须给平铺 saveId
      saveId: "statebar",
      html: String(html || ""),
    })
    return img || null
  } catch (e) {
    log().warn?.(`[miao-wu] 状态栏渲染失败：${e.message}`)
    return null
  }
}
