/**
 * 角色卡系统
 *
 * 支持三种格式，统一归一化成同一个内部结构：
 *   1. Markdown + YAML front-matter（自己写的，最好改）
 *   2. SillyTavern V2 JSON（spec: "chara_card_v2"，生态里到处都是）
 *   3. PNG 角色卡（tEXt / iTXt chunk 里的 "chara" 字段，base64 JSON）
 *
 * 另外支持 extends 继承：子卡只写差异，公共设定放父卡。
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import yaml from "yaml"
import { PLUGIN_DIR, resolve } from "./config.js"

const log = () => globalThis.logger || console

/** 统一结构 */
function blankCard() {
  return {
    id: "",
    name: "",
    avatar: "",
    file: "",
    format: "unknown",
    description: "",
    personality: "",
    scenario: "",
    firstMes: "",
    mesExample: "",
    systemPrompt: "",
    postHistory: "",
    creatorNotes: "",
    // 这几项单独存，不跟 description 混在一起 —— 否则子卡一覆盖 description
    // 继承来的说话方式/习惯/画图认知就全丢了
    styleExtra: "",
    relExtra: "",
    habitExtra: "",
    drawExtra: "",
    tags: [],
    greetingPool: [],
    lorebook: { entries: [] },
    meta: {},
    extends: "",
  }
}

/* ------------------------------------------------------------ Markdown 卡 */

/** 中文小标题 → 内部字段。认不出来的一律并进 description */
const SECTION_MAP = [
  { re: /^(你是谁|角色|简介|人物|设定|身份)$/, field: "description" },
  { re: /^(性格|个性|性情)$/, field: "personality" },
  { re: /^(场景|情境|世界观|背景)$/, field: "scenario" },
  { re: /^(示例对话|对话示例|例句|样例)$/, field: "mesExample" },
  { re: /^(说话方式|语气|口癖|表达|说话风格)$/, field: "styleExtra" },
  { re: /^(系统|系统提示|规则|约束|硬性约束)$/, field: "systemPrompt" },
  { re: /^(关于画图|绘图|画图)$/, field: "drawExtra" },
  { re: /^(你和主人的关系|关系|关系设定)$/, field: "relExtra" },
  { re: /^(小习惯|习惯|癖好)$/, field: "habitExtra" },
]

/** 把正文按 ## 切成小节 */
function splitSections(body) {
  const lines = String(body || "").split(/\r?\n/)
  const out = []
  let cur = { title: "", lines: [] }
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (m) {
      if (cur.title || cur.lines.some(l => l.trim())) out.push(cur)
      cur = { title: m[1].trim(), lines: [] }
    } else {
      cur.lines.push(line)
    }
  }
  if (cur.title || cur.lines.some(l => l.trim())) out.push(cur)
  return out
}

/** 剥掉给人看的注释行（单个 # 开头） */
function stripHumanComments(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(l => !/^#\s/.test(l) && !/^#\s*$/.test(l))
    .join("\n")
}

function parseMarkdownCard(text, id) {
  const card = blankCard()
  card.format = "markdown"
  card.id = id

  let body = String(text || "")
  let fm = {}
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (m) {
    try {
      fm = yaml.parse(m[1]) || {}
    } catch (e) {
      log().warn?.(`[miao-wu] 角色卡 ${id} 的 front-matter 解析失败：${e.message}`)
    }
    body = body.slice(m[0].length)
  }
  body = stripHumanComments(body)

  // front-matter 里的结构化字段优先
  if (fm.name) card.name = String(fm.name)
  if (fm.avatar) card.avatar = String(fm.avatar)
  if (fm.extends) card.extends = String(fm.extends)
  if (fm.description) card.description = String(fm.description)
  if (fm.personality) card.personality = String(fm.personality)
  if (fm.scenario) card.scenario = String(fm.scenario)
  if (fm.first_mes || fm.firstMes) card.firstMes = String(fm.first_mes || fm.firstMes)
  if (fm.mes_example || fm.mesExample) card.mesExample = String(fm.mes_example || fm.mesExample)
  if (fm.system_prompt || fm.systemPrompt) card.systemPrompt = String(fm.system_prompt || fm.systemPrompt)
  if (fm.post_history || fm.postHistory) card.postHistory = String(fm.post_history || fm.postHistory)
  if (fm.creator_notes || fm.creatorNotes) card.creatorNotes = String(fm.creator_notes || fm.creatorNotes)
  if (Array.isArray(fm.tags)) card.tags = fm.tags.map(String)
  if (Array.isArray(fm.greetings)) card.greetingPool = fm.greetings.map(String)
  if (fm.tagline) card.meta.tagline = String(fm.tagline)

  // 正文按小节映射
  const sections = splitSections(body)
  const extras = []
  const exFields = { styleExtra: [], relExtra: [], habitExtra: [], drawExtra: [] }

  for (const s of sections) {
    const content = s.lines.join("\n").trim()
    if (!content) continue
    if (!s.title) {
      extras.push(content)
      continue
    }
    const hit = SECTION_MAP.find(x => x.re.test(s.title))
    if (!hit) {
      // 认不出来的小节，带标题一起并进 description，别丢
      extras.push(`【${s.title}】\n${content}`)
      continue
    }
    if (hit.field in exFields) {
      exFields[hit.field].push(content)
    } else if (hit.field === "mesExample") {
      card.mesExample = card.mesExample ? card.mesExample + "\n\n" + content : content
    } else {
      card[hit.field] = card[hit.field] ? card[hit.field] + "\n\n" + content : content
    }
  }
  for (const [k, arr] of Object.entries(exFields)) {
    if (arr.length) card[k] = arr.join("\n\n")
  }

  if (extras.length) {
    const extra = extras.join("\n\n")
    card.description = card.description ? card.description + "\n\n" + extra : extra
  }
  if (!card.description && body.trim()) card.description = body.trim()
  if (!card.name) card.name = id
  return card
}

/* --------------------------------------------------- SillyTavern V2 JSON */

function parseV2(json, id) {
  const card = blankCard()
  card.format = "sillytavern_v2"
  card.id = id

  const d = json?.data || json || {}
  card.name = String(d.name || json.name || id)
  card.description = String(d.description || "")
  card.personality = String(d.personality || "")
  card.scenario = String(d.scenario || "")
  card.firstMes = String(d.first_mes || d.firstMes || "")
  card.mesExample = String(d.mes_example || d.mesExample || "")
  card.systemPrompt = String(d.system_prompt || d.systemPrompt || "")
  card.postHistory = String(d.post_history_instructions || d.postHistoryInstructions || "")
  card.creatorNotes = String(d.creator_notes || d.creatorNotes || "")
  card.tags = Array.isArray(d.tags) ? d.tags.map(String) : []
  card.greetingPool = Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(String) : []
  if (d.avatar && /^(https?:\/\/|data:)/.test(String(d.avatar))) card.avatar = String(d.avatar)
  card.meta.spec = json.spec || "chara_card_v2"
  card.meta.specVersion = json.spec_version || ""
  card.meta.creator = d.creator || ""
  card.meta.version = d.character_version || ""

  // 内嵌世界书
  const book = d.character_book
  if (book?.entries?.length) {
    card.lorebook.entries = book.entries.map((e, i) => ({
      id: `${id}-book-${i}`,
      keys: Array.isArray(e.keys) ? e.keys.map(String) : [],
      content: String(e.content || ""),
      enabled: e.enabled !== false,
      constant: !!e.constant,
      order: Number(e.insertion_order ?? e.order ?? 100),
      comment: String(e.comment || e.name || ""),
    }))
  }
  return card
}

/* -------------------------------------------------------------- PNG 卡 */

/**
 * 从 PNG buffer 里抠出 "chara" 字段。
 * PNG 结构：8 字节签名 + 若干 (length:u32, type:4, data, crc:u32)
 */
export function readCharaFromPNG(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null

  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString("latin1")
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd + 4 > buf.length) break

    if (type === "tEXt") {
      const data = buf.subarray(dataStart, dataEnd)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = data.subarray(0, nul).toString("latin1")
        if (keyword === "chara") {
          const b64 = data.subarray(nul + 1).toString("latin1")
          try {
            return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"))
          } catch {
            return null
          }
        }
      }
    } else if (type === "iTXt") {
      // iTXt: keyword\0 compressionFlag(1) compressionMethod(1) langTag\0 translatedKeyword\0 text
      const data = buf.subarray(dataStart, dataEnd)
      const nul = data.indexOf(0)
      if (nul > 0 && data.subarray(0, nul).toString("latin1") === "chara") {
        const flag = data[nul + 1]
        let p = nul + 3
        const z1 = data.indexOf(0, p)
        if (z1 < 0) break
        const z2 = data.indexOf(0, z1 + 1)
        if (z2 < 0) break
        const textBuf = data.subarray(z2 + 1)
        let jsonText
        if (flag === 1) {
          try {
            jsonText = zlib.inflateSync(textBuf).toString("utf-8")
          } catch {
            jsonText = textBuf.toString("utf-8")
          }
        } else {
          jsonText = textBuf.toString("utf-8")
        }
        try {
          return JSON.parse(jsonText)
        } catch {
          return null
        }
      }
    } else if (type === "IEND") {
      break
    }
    off = dataEnd + 4
  }
  return null
}

/* ---------------------------------------------------------- 继承合并 */

/** 子卡里以 + 开头的字段表示"追加到父卡"，否则整体覆盖 */
function mergeCard(parent, child) {
  const out = { ...parent, ...child }
  const appendable = [
    "description",
    "personality",
    "scenario",
    "mesExample",
    "systemPrompt",
    "styleExtra",
    "relExtra",
    "habitExtra",
    "drawExtra",
  ]
  for (const key of appendable) {
    const cv = child[key]
    const pv = parent[key]
    if (typeof cv === "string" && cv.trimStart().startsWith("+") && pv) {
      out[key] = `${pv}\n\n${cv.trimStart().slice(1).trim()}`
    } else if (!cv && pv) {
      out[key] = pv
    }
  }
  // 世界书合并：父的先，子的后
  const entries = [...(parent.lorebook?.entries || []), ...(child.lorebook?.entries || [])]
  out.lorebook = { entries }
  // 标签合并去重
  out.tags = [...new Set([...(parent.tags || []), ...(child.tags || [])])]
  // 问候池：子有就用自己的
  if (!child.greetingPool?.length) out.greetingPool = parent.greetingPool || []
  return out
}

/* ---------------------------------------------------------- 目录与加载 */

export function characterDir(conf) {
  return resolve(conf?.cast?.dir || "config/characters")
}

/**
 * 扫描角色目录，返回 [{ id, name, file, format, dir }]
 * 优先级：目录形式 > .json > .md > .png
 */
export function listCharacters(conf, force = false) {
  const now = Date.now()
  if (!force && lsCache.list.length && now - lsCache.at < 30000) return lsCache.list

  const root = characterDir(conf)
  const out = []
  const seen = new Map()

  const push = (id, item, prio) => {
    const old = seen.get(id)
    if (!old || prio > old.prio) seen.set(id, { ...item, prio })
  }

  let ents = []
  try {
    ents = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }

  for (const e of ents) {
    // 下划线开头是模板，只能被 extends 引用，不进出场列表
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      for (const cand of ["card.md", "card.json", "card.png", `${e.name}.md`, `${e.name}.json`, `${e.name}.png`]) {
        const f = path.join(full, cand)
        if (fs.existsSync(f)) {
          push(e.name, { id: e.name, name: e.name, file: f, format: extOf(f), dir: true }, 3)
          break
        }
      }
      continue
    }
    const mm = e.name.match(/^(.+)\.(md|markdown|json|png)$/i)
    if (!mm) continue
    const id = mm[1]
    const ext = mm[2].toLowerCase()
    const prio = ext === "json" ? 2 : ext === "md" || ext === "markdown" ? 2 : 1
    push(id, { id, name: id, file: full, format: ext, dir: false }, prio)
  }

  const list = [...seen.values()].map(({ prio, ...rest }) => rest)

  // 先落缓存再补名字 —— loadCharacter 内部会调用本函数，
  // 不先设好缓存就是无限递归。
  lsCache = { at: now, list }
  for (const it of list) {
    const hit = cardCache.get(it.id)
    if (hit) {
      it.name = hit.card.name || it.id
      continue
    }
    try {
      const c = loadCharacter(conf, it.id, { skipExtends: true })
      if (c?.name) it.name = c.name
    } catch {}
  }
  return list
}

let lsCache = { at: 0, list: [] }

function extOf(f) {
  const m = String(f).match(/\.(md|markdown|json|png)$/i)
  return m ? m[1].toLowerCase() : "unknown"
}

function readRawCard(file, id) {
  const ext = extOf(file)
  if (ext === "json") {
    const json = JSON.parse(fs.readFileSync(file, "utf-8"))
    return parseV2(json, id)
  }
  if (ext === "png") {
    const buf = fs.readFileSync(file)
    const json = readCharaFromPNG(buf)
    if (!json) throw new Error(`${path.basename(file)} 里没有 chara 数据，可能不是角色卡 PNG`)
    const card = parseV2(json, id)
    card.format = "png"
    card.meta.pngFile = file
    return card
  }
  return parseMarkdownCard(fs.readFileSync(file, "utf-8"), id)
}

const cardCache = new Map()

/**
 * 找一张卡的文件信息。
 * 先查目录列表，查不到就直接按命名约定探测 ——
 * 因为 _ 开头的模板卡不在列表里，但 extends 要能引用到它们。
 */
function findCardMeta(conf, id) {
  // 路径安全：id 拼进文件路径，绝不能带分隔符或 ..
  if (typeof id !== "string" || !id || id.length > 80 || /[/\\]|\.\./.test(id)) return null
  const hit = listCharacters(conf).find(x => x.id === id)
  if (hit) return hit

  const root = characterDir(conf)
  const candidates = [
    [`${id}.md`, "md"],
    [`${id}.markdown`, "markdown"],
    [`${id}.json`, "json"],
    [`${id}.png`, "png"],
    [`${id}/card.md`, "md"],
    [`${id}/card.json`, "json"],
    [`${id}/card.png`, "png"],
  ]
  for (const [cand, fmt] of candidates) {
    const f = path.join(root, cand)
    if (fs.existsSync(f)) return { id, name: id, file: f, format: fmt, dir: cand.includes("/") }
  }
  return null
}

/**
 * 加载一个角色，自动解析 extends 链。
 * @param {object} conf
 * @param {string} id   角色 id（文件名去扩展名 / 目录名）
 */
export function loadCharacter(conf, id, opts = {}) {
  if (!id) return null

  const hit = cardCache.get(id)
  if (hit && Date.now() - hit.at < 10000) return hit.card

  const meta = findCardMeta(conf, id)
  if (!meta) return null

  let card
  try {
    card = readRawCard(meta.file, id)
  } catch (e) {
    log().error?.(`[miao-wu] 读角色卡 ${id} 失败：${e.message}`)
    return null
  }

  // 解析继承链（最多 5 层，防环）
  if (!opts.skipExtends && card.extends) {
    const chain = []
    let cur = card
    const visited = new Set([id])
    while (cur.extends && chain.length < 5) {
      if (visited.has(cur.extends)) {
        log().warn?.(`[miao-wu] 角色卡 ${id} 的 extends 出现循环：${cur.extends}`)
        break
      }
      visited.add(cur.extends)
      const parent = loadCharacter(conf, cur.extends, { skipExtends: false })
      if (!parent) {
        log().warn?.(`[miao-wu] 角色卡 ${id} 找不到父卡 ${cur.extends}`)
        break
      }
      chain.unshift(parent)
      cur = parent
    }
    for (const p of chain) card = mergeCard(p, card)
    card.meta.inheritedFrom = chain.map(c => c.id)
  }

  if (!card.name) card.name = id
  if (!card.avatar) card.avatar = tryFindAvatar(conf, id, meta.file)
  // 只有完整加载（含继承）才进缓存。
  // listCharacters 会用 skipExtends 读名字，如果那时也写缓存，
  // 后面正经加载就会拿到"没继承"的残废版本。
  if (!opts.skipExtends) cardCache.set(id, { at: Date.now(), card })
  return card
}

/** 目录形式可以放 avatar.png / avatar.jpg */
function tryFindAvatar(conf, id, cardFile) {
  const root = characterDir(conf)
  const dir = path.dirname(cardFile)
  for (const f of ["avatar.png", "avatar.jpg", "avatar.webp"]) {
    const p = path.join(dir, f)
    if (fs.existsSync(p)) return p
  }
  // png 卡本身就是头像
  if (extOf(cardFile) === "png") return cardFile
  for (const f of [`${id}.png`, `${path.basename(dir)}.png`]) {
    const p = path.join(root, f)
    if (fs.existsSync(p)) return p
  }
  return ""
}

export function dropCharacterCache() {
  cardCache.clear()
  lsCache = { at: 0, list: [] }
}

/** 当前出场角色。配置里的 default 不在就退回第一个 */
export function currentCharacter(conf) {
  const wanted = conf?.cast?.default
  if (wanted) {
    const c = loadCharacter(conf, wanted)
    if (c) return c
  }
  const list = listCharacters(conf)
  if (!list.length) return null
  return loadCharacter(conf, list[0].id)
}

/**
 * 导入一个角色卡文件到 characters 目录。
 * @returns {{ok: boolean, id?: string, msg: string}}
 */
export function importCharacter(conf, srcPath) {
  const root = characterDir(conf)
  fs.mkdirSync(root, { recursive: true })

  if (!fs.existsSync(srcPath)) return { ok: false, msg: `文件不存在：${srcPath}` }
  const ext = extOf(srcPath)
  if (!["json", "png", "md", "markdown"].includes(ext)) {
    return { ok: false, msg: `不支持的格式 .${ext}，只收 md / json / png` }
  }

  // 先试解析，确认是能用的卡
  let id = path.basename(srcPath).replace(/\.[^.]+$/, "")
  let card
  try {
    card = readRawCard(srcPath, id)
  } catch (e) {
    return { ok: false, msg: `解析失败：${e.message}` }
  }
  if (!card?.name && !card?.description) return { ok: false, msg: "这个文件里没有可用的角色数据" }

  // 用角色名做 id，重名加序号
  const base = (card.name || id).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40)
  let finalId = base
  let n = 2
  while (listCharacters(conf, true).some(x => x.id === finalId)) {
    finalId = `${base}_${n++}`
    if (n > 99) break
  }

  // 目录形式存放：card.ext + avatar
  const dir = path.join(root, finalId)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `card.${ext === "markdown" ? "md" : ext}`)
  fs.copyFileSync(srcPath, target)
  if (ext === "png") fs.copyFileSync(srcPath, path.join(dir, "avatar.png"))

  dropCharacterCache()
  return { ok: true, id: finalId, msg: `已导入「${card.name || finalId}」` }
}

export { parseMarkdownCard, parseV2, mergeCard, readRawCard }
