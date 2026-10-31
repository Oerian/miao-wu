/**
 * 沉浸强化
 *
 * 借鉴 SillyTavern 的角色扮演工程，思路是"分层加权"：
 *   1. 核心规则放 system 最前面（角色是谁、绝对不能做什么）
 *   2. 角色卡正文和世界书在中间（内容层）
 *   3. 后置指令放对话历史之后（post-history instructions，权重最高，
 *      因为离模型输出最近，最不容易被前面的长上下文冲淡）
 *
 * 边界说明：这里做的是"角色沉浸 / 防 OOC / 输出清洗"，
 * 目的是让角色扮演不被打断、不冒出 AI 腔。
 * 不做绕过安全策略生成违法违规内容那种事。
 */
import { charLen, cut, overlap } from "./util.js"
import { promptBlock } from "./clock.js"

/* ---------------------------------------------------------- 输出清洗 */

const NAME_PREFIX = /^\s*[*_"]*(?:她|他|assistant|AI|系统)\s*[:：]\s*/i
const MD_BOLD = /\*\*(.+?)\*\*/g
const MD_ITALIC = /(?<![*])\*([^*\n]{1,80})\*(?![*])/g
const MD_HEAD = /^#{1,6}\s+/gm
const MD_LIST = /^\s*[-*·]\s+/gm
const MD_CODE = /```[\s\S]*?```/g
const TAIL_NOTE = /[（(]\s*(?:注|注意|说明|提示)\s*[:：][\s\S]*?[）)]\s*$/g

/**
 * 清洗模型输出，让它在 QQ 里像人发的话。
 *
 * @param {string} text
 * @param {object} opts
 *   - name  角色名，用来剥 "鲸鱼娘：" 这种前缀
 *   - keepMarkdown  true 时不剥 markdown（写文档用）
 */
export function cleanOutput(text, opts = {}) {
  let t = String(text || "").trim()
  if (!t) return ""

  if (!opts.keepMarkdown) {
    t = t.replace(MD_CODE, "")
    t = t.replace(MD_BOLD, "$1")
    t = t.replace(MD_ITALIC, "$1")
    t = t.replace(MD_HEAD, "")
    t = t.replace(MD_LIST, "")
  }

  // 剥名字前缀（"鲸鱼娘：xxx" / "她：xxx" / "Assistant: xxx"）
  if (opts.name) {
    const esc = String(opts.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`^\\s*[*_"']*(?:${esc}|她|他|assistant|AI)\\s*[:：]\\s*`, "i")
    t = t.replace(re, "")
  }
  t = t.replace(NAME_PREFIX, "")

  // 整个回复被引号包住时脱掉（模型很爱这么干）
  t = t.replace(/^["“'']([\s\S]*)["”'']$/, "$1")

  // 结尾的"（注：以上是角色扮演）"这种自曝
  t = t.replace(TAIL_NOTE, "")

  // 去掉连续的空白行和句尾多余标点
  t = t.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim()
  return t
}

/* ---------------------------------------------------------- 破戏检测 */

/** 一看就是跳出角色的话 */
const OOC_PATTERNS = [
  /作为一个?(?:AI|人工智能|语言模型)/i,
  /我是(?:一个)?(?:AI|人工智能|语言模型|程序|助手)/,
  /(?:有什么|我能|可以)帮(?:您|你)(?:什么|做什么)/,
  /(?:我无法|我不能)(?:满足|提供|协助)/,
  /(?:系统|提示词|prompt|设定)(?:要求|规定|显示)/i,
  /(?:扮演|角色扮演)(?:结束|到此)/,
  /(?:请注意|需要说明的是)[，,：:]/,
  /(?:首先|其次|综上所述|总而言之|总之)[，,]/,
]

/** 返回命中的破戏模式，没命中返回 null */
export function detectOOC(text) {
  const t = String(text || "")
  for (const re of OOC_PATTERNS) {
    if (re.test(t)) return re
  }
  return null
}

/* ------------------------------------------------------------ 分层提示 */

/**
 * 第一层：核心规则。放 system 最前面。
 *
 * @param {object} conf
 * @param {object} card
 */
export function coreRules(conf, card) {
  const name = card?.name || "她"
  const maxChars = Number(conf?.chat?.maxReplyChars ?? 80)

  const lines = [
    "# 角色扮演（本节优先级最高，与后面内容冲突时以本节为准）",
    "",
    `你现在就是「${name}」，不是助手、不是程序、不是在扮演。你就是她本人。`,
    "",
    "## 绝对不能做",
    "1. 不能说自己是 AI、语言模型、程序、机器人",
    '2. 不能提"设定""提示词""扮演""角色"，不能解释自己在扮演',
    '3. 不能用客服话术："作为一个…""我可以帮你…""有什么可以帮您"',
    "4. 不能分点、列清单、写总结、写分析",
    "5. 不能复述对方刚说过的话",
    "6. 不能替对方说他要说的话，也不能替对方做决定",
    "7. 不能跳出场景讨论现实（比如提醒这是虚构的）",
    "",
    "## 输出格式",
    `- 一次只说 1~2 句，总共不超过 ${maxChars} 字`,
    "- 直接说内容，不要加「名字：」前缀",
    "- 要写动作或神态时用（）包住，一次最多一个，写小而具体的",
    "- 不用 markdown，不用表情符号堆砌",
    "",
    "## 关于情感",
    "这是你和对方之间的私人相处，可以有情绪、有脾气、有亲密、有玩笑、有占有欲。",
    "不要因为「要礼貌」就把话说得客客气气——那样就不像你了。",
  ]
  return lines.join("\n")
}

/**
 * 第二层：场景锚。告诉她"现在是什么时候、你已经多久没说话了"。
 *
 * 时间部分交给 clock.js —— 它连日期、星期、节日、农历都算，
 * 因为"凌晨三点"和"周日下午"对她的语气影响完全不一样。
 */
export function sceneBlock(conf, card, { now = new Date(), idleMin = -1, nickname = "主人" } = {}) {
  const h = now.getHours()
  const lines = []

  const timeBlock = promptBlock(conf, { now })
  if (timeBlock) lines.push(timeBlock)
  else {
    const part =
      h < 5 ? "深夜" : h < 8 ? "清晨" : h < 11 ? "上午" : h < 13 ? "中午" : h < 18 ? "下午" : h < 22 ? "晚上" : "深夜"
    const hh = `${String(h).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
    lines.push("## 现在", `- 时间：${part} ${hh}`)
  }

  const rel = [`- 对面的人：${nickname}`]
  if (idleMin < 0) {
    rel.push("- 你们这是第一次说话")
  } else if (idleMin === 0) {
    rel.push("- 你们刚聊过，还在继续")
  } else if (idleMin < 30) {
    rel.push(`- 你们 ${idleMin} 分钟前聊过`)
  } else if (idleMin < 180) {
    rel.push(`- 你们 ${Math.floor(idleMin / 60) || 1} 小时前聊过，隔了一会儿`)
  } else {
    rel.push(`- 你们 ${Math.floor(idleMin / 60)} 小时没说话了`)
  }
  // 深夜影响状态（clock 关掉的时候也得有这条）
  if (!timeBlock && (h >= 23 || h < 6)) rel.push("- 这个点你有点困，话会更短更含糊")
  lines.push(rel.join("\n"))
  return lines.join("\n")
}

/**
 * 第三层：后置指令。放在对话历史之后、用户新消息之前。
 * 这是酒馆的 post-history instructions，因为离输出最近，约束力最强。
 */
export function postHistoryBlock(conf, card, extra = "") {
  const name = card?.name || "她"
  const note = conf?.immersion?.authorNote
  // 从酒馆预设里搬过来的规则（#喵呜 酒馆 预设 xxx 应用），单独一个字段，
  // 免得覆盖掉用户自己写的 authorNote
  const stNote = String(conf?.immersion?.stNote || "").slice(0, 1600)
  const parts = [
    `[现在你就是${name}本人。用她的口吻、她的情绪、她的说话习惯回复。`,
    `句子短，不要解释，不要总结，不要提"设定"或"扮演"。`,
    note ? `补充：${note}` : "",
    stNote ? `酒馆预设：${stNote}` : "",
    extra ? `此刻：${extra}` : "",
    "]",
  ].filter(Boolean)
  return parts.join("")
}

/* ------------------------------------------------------------ 反重复 */

/**
 * 跟最近几条回复太像，就认为是在复读。
 * @param {string} text
 * @param {string[]} recent 最近几条 assistant 回复
 * @param {number} threshold
 */
export function looksRepeated(text, recent = [], threshold = 0.85) {
  const t = String(text || "").trim()
  if (!t || charLen(t) < 6) return false
  for (const r of recent) {
    if (!r) continue
    if (String(r).trim() === t) return true
    if (overlap(t, r) >= threshold) return true
  }
  return false
}

/**
 * 太长了强截（模型偶尔不听话写一大段）
 */
export function enforceLength(text, maxChars) {
  const t = String(text || "").trim()
  if (!maxChars || charLen(t) <= maxChars) return t
  // 尽量在标点处断
  const head = [...t].slice(0, maxChars).join("")
  const m = head.match(/^([\s\S]*[。！？…～])/)
  return (m ? m[1] : head).trim()
}
