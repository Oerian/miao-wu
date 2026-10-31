/**
 * 人设助手
 *
 * 让模型帮你写/改角色卡。产出直接落成 config/characters/ 下的 .md 文件，
 * 写完就能「#喵呜 出场 xxx」用上。
 *
 * 两种用法：
 *   writeCard(brief)                    —— 从一句需求生成完整卡
 *   reviseCard(id, instruction)         —— 在现有卡上改
 */
import fs from "node:fs"
import path from "node:path"
import { characterDir, parseMarkdownCard, loadCharacter, dropCharacterCache } from "./character.js"
import { chat } from "./llm.js"
import { cut } from "./util.js"

const log = () => globalThis.logger || console

/* ------------------------------------------------------------ 模板说明 */

/** 给模型的格式要求。写/改共用 */
const FORMAT_SPEC = `输出格式（**必须严格照这个来**，第一行就是 ---）：

---
id: 英文小写id
name: 中文名
tags: [标签1, 标签2]
greetings:
  - "（动作）开场白一"
  - "（动作）开场白二"
---

## 你是谁

（第二人称"你"。写清身份、长相、住在哪、和对方什么关系。3~5 句，别写成简历。）

## 性格

- 每条一句话，写**具体行为**，不要抽象形容词。
  反例：温柔体贴
  正例：被夸了会嘴硬说"才没有"，但耳朵会红

（3~5 条）

## 说话方式

1. 句子长度：一次一到两句，不超过 40 字
2. 口头禅 / 常用开头：被问在干嘛先回"没干嘛"
3. 什么时候语气会变：生气时省掉语气词，说话硬邦邦
4. 动作怎么写：用（）包住，一次最多一个，小而具体
（4~6 条，必须能照做）

## 你和对方的关系

（怎么认识的、平时怎么相处、有什么默契或旧账。3~5 句。）

## 小习惯

- 挑 5~6 个能演出来的小动作，越具体越好

## 关于画图

（这个角色确实会画画，但要写清楚：只有真的把图发出去了才能说"画好了"；
没出图绝不能编；不能在原图上涂改，要改只能重画一张。）

## 示例对话

格式严格照抄，不要写"她："以外的前缀：

主人：在干嘛
她：（翻了个身）没干嘛啊，就躺着

（**12~15 条**，覆盖：日常问候、被夸、被冷落、撒娇、犯困、吃醋、被摸头、
对方要出门、对方回来、对方难过、深夜。这部分最重要，模型靠它学语气。）`

/* ------------------------------------------------------------ 生成卡 */

const WRITE_SYS = `你是角色卡作者，专门给 AI 角色扮演写人设卡。

## 硬要求
1. 名字你自己取，2~3 个汉字，别太中二、别用生僻字。
2. 句子短。示例对话里每句控制在 40 字内，像微信聊天不像写作文。
3. 示例对话是整张卡最重要的部分 —— 模型靠它学语气，写不好整张卡就废了。
4. 性格要**有缺点**。完美角色最没味道。
5. 绝对不要出现"作为一个AI""有什么可以帮您""首先/其次/总之"这类话。
6. 不要写"温柔""善良""可爱"这种空词，全部换成具体行为。

${FORMAT_SPEC}`

/**
 * 从一句需求生成完整角色卡。
 *
 * @param {string} brief 需求描述，比如"一个怕打雷的猫娘"
 * @param {object} opts  { prov, styleHint }
 * @returns {Promise<{ok:boolean, card?:object, markdown?:string, id?:string, file?:string, msg:string}>}
 */
export async function writeCard(brief, opts = {}) {
  const { prov, styleHint = "" } = opts
  if (!prov?.model) return { ok: false, msg: "没配后端" }

  const user = [
    `需求：${brief}`,
    styleHint ? `\n额外要求：${styleHint}` : "",
    "\n直接输出角色卡本身，不要任何前言、不要 ``` 包裹。",
  ]
    .filter(Boolean)
    .join("\n")

  let raw = ""
  try {
    raw = await chat(
      prov,
      [
        { role: "system", content: WRITE_SYS },
        { role: "user", content: user },
      ],
      { maxTokens: 3000, temperature: 0.95, retries: 2, silent: true },
    )
  } catch (e) {
    return { ok: false, msg: `生成失败：${String(e.message).slice(0, 120)}` }
  }

  const md = normalizeCardMarkdown(raw)
  const card = parseMarkdownCard(md, "tmp")
  if (!card.name || !card.description) {
    return { ok: false, msg: `模型没给出合规的角色卡（name=${card.name || "空"}, description=${card.description ? "有" : "空"}）` }
  }

  const id = slugOf(card.name, md)
  const file = path.join(characterDir(opts.conf || {}), `${id}.md`)
  const existed = fs.existsSync(file)

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, md, "utf-8")
  } catch (e) {
    return { ok: false, msg: `写文件失败：${e.message}` }
  }

  dropCharacterCache()
  return { ok: true, card, markdown: md, id, file, existed, msg: `已写好「${card.name}」` }
}

/* ------------------------------------------------------------ 改卡 */

const REVISE_SYS = `你是角色卡编辑。用户给你一张现有的角色卡和修改要求。

## 规则
1. **只改用户提到的部分**，没提到的段落保持原样，连顺序都别动。
2. 保持原有的 Markdown 结构和 front-matter 字段。
3. 如果要求是"改语气"，就只动「说话方式」和「示例对话」，别动性格。
4. 输出**完整的新卡**，不是差异片段。
5. 不要前言后语，不要 \`\`\` 包裹，第一行就是 ---。`

/**
 * 在现有卡上改。
 *
 * @param {string} id 角色 id
 * @param {string} instruction 改什么
 * @param {object} opts { prov, conf }
 */
export async function reviseCard(id, instruction, opts = {}) {
  const { prov, conf } = opts
  if (!prov?.model) return { ok: false, msg: "没配后端" }

  const target = cardFileOf(conf, id)
  if (!target) return { ok: false, msg: `找不到角色卡「${id}」` }

  const before = fs.readFileSync(target, "utf-8")

  let raw = ""
  try {
    raw = await chat(
      prov,
      [
        { role: "system", content: REVISE_SYS },
        { role: "user", content: `## 现有角色卡\n${before}\n\n## 修改要求\n${instruction}` },
      ],
      { maxTokens: 3000, temperature: 0.9, retries: 2, silent: true },
    )
  } catch (e) {
    return { ok: false, msg: `改写失败：${String(e.message).slice(0, 120)}` }
  }

  const md = normalizeCardMarkdown(raw)
  const card = parseMarkdownCard(md, id)
  if (!card.name || !card.description) {
    return { ok: false, msg: "模型输出的卡不合规，原文件没动" }
  }

  // 先备份，改坏了能回滚
  const bak = `${target}.bak-${Date.now()}`
  try {
    fs.writeFileSync(bak, before, "utf-8")
    fs.writeFileSync(target, md, "utf-8")
  } catch (e) {
    return { ok: false, msg: `写文件失败：${e.message}（原文还在）` }
  }

  dropCharacterCache()
  return {
    ok: true,
    card,
    markdown: md,
    file: target,
    backup: bak,
    msg: `「${card.name}」改好了（旧版备份在 ${path.basename(bak)}）`,
  }
}

/* ------------------------------------------------------------ 工具 */

/** 找到角色卡的实体文件路径 */
export function cardFileOf(conf, id) {
  const root = characterDir(conf || {})
  const cands = [`${id}.md`, `${id}.markdown`, `${id}.json`, `${id}.png`, `${id}/card.md`, `${id}/card.json`, `${id}/card.png`]
  for (const c of cands) {
    const f = path.join(root, c)
    if (fs.existsSync(f)) return f
  }
  // 也允许按 name 找
  const c = loadCharacter(conf, id)
  if (c?.file) return c.file
  return ""
}

/**
 * 把模型输出洗成一张干净的卡：
 * 去掉 ``` 包裹、去掉前面的废话、保证以 --- 开头。
 */
export function normalizeCardMarkdown(raw) {
  let t = String(raw || "").trim()

  // 去掉 ```markdown ... ```
  const fence = t.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()

  // 从第一个 --- 开始
  const a = t.indexOf("---")
  if (a > 0) t = t.slice(a)
  // 没有 front-matter 就补一个空的，至少能解析
  if (!t.startsWith("---")) t = `---\nid: tmp\nname: 未命名\n---\n\n${t}`

  // 结尾多余的 */}
  return t.replace(/\s+$/, "") + "\n"
}

/** 从名字推一个安全的 id */
export function slugOf(name, md = "") {
  // front-matter 里给了 id 就用它
  const m = String(md).match(/^---\s*\n([\s\S]*?)\n---/)
  if (m) {
    const idm = m[1].match(/^id:\s*(.+)$/m)
    if (idm) {
      const v = idm[1].trim().replace(/^["']|["']$/g, "")
      if (/^[\w-]{1,40}$/.test(v) && v !== "tmp") return v
    }
  }
  // 否则用名字的拼音/英文，中文直接转成安全串
  const base = String(name || "char")
    .replace(/[^\w\u4e00-\u9fa5-]/g, "")
    .slice(0, 24)
  return base || `char_${Date.now().toString(36)}`
}

/** 给 QQ 看的预览（截断，别把整张卡糊上去） */
export function previewOf(markdown, maxChars = 700) {
  return cut(markdown, maxChars)
}
