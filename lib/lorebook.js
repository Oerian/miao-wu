/**
 * 世界书（Lorebook）
 *
 * 两个来源合并：
 *   1. 角色卡内嵌的 character_book（酒馆卡自带）
 *   2. config/lorebooks/ 下的独立文件（.json / .yaml / .md front-matter）
 *
 * 触发方式：
 *   - constant: true  → 无条件注入（世界基底设定）
 *   - keys 命中当前消息或最近几轮对话 → 注入
 */
import fs from "node:fs"
import path from "node:path"
import yaml from "yaml"
import { resolve } from "./config.js"

const log = () => globalThis.logger || console

function normalizeEntry(raw, i, prefix) {
  return {
    id: raw.id || `${prefix}-${i}`,
    keys: Array.isArray(raw.keys) ? raw.keys.map(String).filter(Boolean) : [],
    /** 副关键词（酒馆 selective：主关键词命中后，副关键词也命中才算） */
    secondaryKeys: Array.isArray(raw.secondary_keys ?? raw.secondaryKeys ?? raw.keysecondary)
      ? (raw.secondary_keys ?? raw.secondaryKeys ?? raw.keysecondary).map(String).filter(Boolean)
      : [],
    content: String(raw.content || "").trim(),
    enabled: raw.enabled !== false,
    constant: !!raw.constant,
    order: Number(raw.order ?? raw.insertion_order ?? 100),
    /** 触发概率 0~100（酒馆 probability），默认必触发 */
    probability: clampPct(raw.probability ?? raw.triggerProbability),
    comment: String(raw.comment || raw.name || ""),
    /** 只在提到这些角色时生效（可选） */
    forCharacters: Array.isArray(raw.forCharacters) ? raw.forCharacters.map(String) : [],
  }
}

function clampPct(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 100
  return Math.max(0, Math.min(100, n))
}

/** 读一个世界书文件 */
function readBookFile(file) {
  const ext = String(file).split(".").pop().toLowerCase()
  let data = null
  try {
    const text = fs.readFileSync(file, "utf-8")
    if (ext === "json") {
      data = JSON.parse(text)
    } else if (ext === "yaml" || ext === "yml") {
      data = yaml.parse(text)
    } else if (ext === "md" || ext === "markdown") {
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      if (!m) return []
      data = yaml.parse(m[1])
    }
  } catch (e) {
    log().warn?.(`[miao-wu] 世界书 ${path.basename(file)} 解析失败：${e.message}`)
    return []
  }
  if (!data) return []

  // 兼容三种写法：{entries:[...]} / {条目:{...}} / 直接数组
  let arr = []
  if (Array.isArray(data)) arr = data
  else if (Array.isArray(data.entries)) arr = data.entries
  else if (data.entries && typeof data.entries === "object") arr = Object.values(data.entries)

  const prefix = path.basename(file, path.extname(file))
  return arr.map((e, i) => normalizeEntry(e, i, prefix)).filter(e => e.content)
}

let bookCache = { at: 0, dir: "", entries: [] }

/** 扫 lorebooks 目录，全部条目拍平 */
export function loadLorebookFiles(conf, force = false) {
  const dir = resolve(conf?.lorebook?.dir || "config/lorebooks")
  const now = Date.now()
  if (!force && bookCache.entries.length && bookCache.dir === dir && now - bookCache.at < 15000) {
    return bookCache.entries
  }
  const out = []
  let ents = []
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    bookCache = { at: now, dir, entries: [] }
    return []
  }
  for (const e of ents) {
    if (e.name.startsWith(".") || e.isDirectory()) continue
    if (!/\.(json|ya?ml|md|markdown)$/i.test(e.name)) continue
    out.push(...readBookFile(path.join(dir, e.name)))
  }
  bookCache = { at: now, dir, entries: out }
  return out
}

/** 合并角色卡内嵌条目 + 独立文件条目 */
export function collectEntries(conf, card) {
  const fromCard = (card?.lorebook?.entries || []).map((e, i) => normalizeEntry(e, i, `card-${card.id || "x"}`))
  const fromFiles = loadLorebookFiles(conf)

  // 独立文件里如果标了 forCharacters，只给指定角色用
  const cid = card?.id || ""
  const filtered = fromFiles.filter(e => !e.forCharacters.length || e.forCharacters.includes(cid))

  const all = [...fromCard, ...filtered].filter(e => e.enabled && e.content)
  return all.sort((a, b) => a.order - b.order)
}

/**
 * 挑出这次要注入的条目。
 *
 * 规则对齐酒馆 World Info：
 *   - constant            无条件注入
 *   - keys                主关键词命中（扫用户这句话 + 最近 scanDepth 条消息）
 *   - secondaryKeys       有副关键词时，副关键词也得命中（AND ANY）
 *   - probability         概率触发，默认 100
 *   - 递归扫描            命中条目的内容也参与下一轮关键词匹配（可带出新条目）
 *
 * @param {object} conf
 * @param {object} card   当前角色卡
 * @param {string} text   用户这句话
 * @param {string} recent 最近几轮对话（拼成一段），用来提高命中率
 * @returns {{text: string, hits: string[]}}
 */
export function selectLore(conf, card, text, recent = "") {
  if (conf?.lorebook?.enabled === false) return { text: "", hits: [] }
  const entries = collectEntries(conf, card)
  if (!entries.length) return { text: "", hits: [] }

  const rounds = conf?.lorebook?.recursion === false ? 1 : 2
  const hits = []
  const hitIds = new Set()

  let hay = `${text}\n${recent}`.toLowerCase()
  for (let round = 0; round < rounds; round++) {
    let gained = false
    for (const e of entries) {
      if (hitIds.has(e.id) || e.constant) continue
      if (!e.keys.length) continue
      const primary = e.keys.some(k => k && hay.includes(k.toLowerCase()))
      if (!primary) continue
      // 有副关键词就得副关键词也命中（任一）
      if (e.secondaryKeys.length && !e.secondaryKeys.some(k => k && hay.includes(k.toLowerCase()))) continue
      hitIds.add(e.id)
      gained = true
    }
    if (!gained || round === rounds - 1) break
    // 把命中的内容并进 haystack，让条目带出条目
    hay += "\n" + entries.filter(e => hitIds.has(e.id)).map(e => e.content).join("\n").toLowerCase()
  }

  for (const e of entries) {
    if (hitIds.has(e.id) || e.constant) {
      // 概率门槛：constant 也受概率管（酒馆行为），100 = 必过
      if (e.probability < 100 && Math.random() * 100 >= e.probability) continue
      hits.push(e)
    }
  }

  const maxEntries = Number(conf?.lorebook?.maxEntries ?? 6)
  const maxChars = Number(conf?.lorebook?.maxChars ?? 1200)
  const picked = hits.slice(0, maxEntries)

  let body = ""
  for (const e of picked) {
    const chunk = e.comment ? `- ${e.comment}：${e.content}` : `- ${e.content}`
    if ([...(body + chunk)].length > maxChars) break
    body += (body ? "\n" : "") + chunk
  }
  return {
    text: body,
    hits: picked.map(e => e.comment || e.keys.slice(0, 2).join("/") || e.id),
  }
}

export function dropLoreCache() {
  bookCache = { at: 0, dir: "", entries: [] }
}
