/**
 * 提示词组装
 *
 * 分层顺序（越靠前权重越高，越靠后离输出越近）：
 *   1. 核心规则        —— 你不能做什么
 *   2. 角色卡          —— 你是谁
 *   3. 世界书          —— 这个世界的设定（关键词触发）
 *   4. 记忆            —— 你还记得的事
 *   5. 场景            —— 现在几点、多久没说话
 *   --- 对话历史 ---
 *   6. 后置指令        —— 最后再强调一遍（酒馆的 post-history instructions）
 */
import * as mem from "./memory.js"
import { selectLore } from "./lorebook.js"
import { coreRules, sceneBlock, postHistoryBlock } from "./immersion.js"
import { loadCharacter, currentCharacter } from "./character.js"
import { tavernState, cameoBlock } from "./tavern.js"
import { toolsBlock } from "./tools.js"
import { charLen } from "./util.js"

/**
 * 当前该谁在场。
 * 优先级：这次会话里切过的人 > 配置里的默认 > 目录里第一张卡
 *
 * @returns {Promise<{card: object|null, cast: object|null}>}
 */
export async function currentCard(conf, qq) {
  const cast = await mem.getCast(conf, qq)
  if (cast?.current) {
    const c = loadCharacter(conf, cast.current)
    if (c) return { card: c, cast }
    // 卡被删了 → 回落到默认，但保留 shift 记录
  }
  return { card: currentCharacter(conf), cast: cast || null }
}

/* --------------------------------------------------------- 角色卡正文 */

function section(title, body) {
  const t = String(body || "").trim()
  if (!t) return ""
  return `## ${title}\n${t}`
}

/** 把角色卡拼成给模型看的一段 */
export function cardBlock(card) {
  if (!card) return ""
  const parts = [
    section("你是谁", card.description),
    section("性格", card.personality),
    section("你和对方的关系", card.relExtra),
    section("说话方式", card.styleExtra),
    section("小习惯", card.habitExtra),
    section("关于画图", card.drawExtra),
    section("场景设定", card.scenario),
    section("你说话的样子（模仿这个语气，别照抄内容）", card.mesExample),
    section("额外规则", card.systemPrompt),
  ].filter(Boolean)
  return parts.join("\n\n")
}

/* ------------------------------------------------------------- 交接 */

/**
 * 出场人物转换时的交接说明。
 *
 * 关键点：新角色**知道**刚才发生了什么（记忆共享），
 * 但要明白"那不是我"，不能把前任的事当成自己干的 —— 否则人设就崩了。
 */
function handoverBlock(prevCast, card, ctx) {
  if (!prevCast?.current || prevCast.current === card?.id) return ""
  const prevName = prevCast.name || prevCast.current
  const recent = ctx
    .slice(-8)
    .map(m => `${m.role === "user" ? "主人" : prevName}：${String(m.content).replace(/\n/g, " ")}`)
    .join("\n")

  return [
    "## 出场交接（重要）",
    `刚才在场的是「${prevName}」，现在换成你了。`,
    `你知道他们聊了什么（下面是记录），但那些是${prevName}干的，不是你。`,
    `你要用自己的身份和态度接话，不要假装刚才一直是你在说话。`,
    recent ? `\n他们刚才聊的：\n${recent}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/* --------------------------------------------------------- system 组装 */

/**
 * @param {object} conf
 * @param {string} qq
 * @param {object} card
 * @param {object} opts { nickname, idleMin, userText, prevCast }
 * @returns {Promise<{system: string, loreHits: string[]}>}
 */
export async function composeSystem(conf, qq, card, opts = {}) {
  const { nickname = "主人", idleMin = -1, userText = "", prevCast = null } = opts
  const parts = []

  // 1. 核心规则
  if (conf?.immersion?.enabled !== false) {
    parts.push(coreRules(conf, card))
  }

  // 2. 角色卡
  const cb = cardBlock(card)
  if (cb) parts.push(cb)

  // 3. 酒馆状态：对方是谁 / 临时场景 / 同场角色
  const tv = await tavernState(conf, qq)
  if (tv.userPersona) {
    parts.push(`## 对方是谁（这是他给自己定的人设，按这个看待他）\n${tv.userPersona}`)
  }
  if (tv.cameo.length) {
    const others = tv.cameo.map(id => loadCharacter(conf, id)).filter(Boolean)
    const block = cameoBlock(others)
    if (block) parts.push(block)
  }

  // 4. 世界书
  const ctx = await mem.loadCtx(conf, qq)
  const recent = ctx
    .slice(-6)
    .map(m => m.content)
    .join("\n")
  const lore = selectLore(conf, card, userText, recent)
  if (lore.text) {
    parts.push(`## 这个世界的设定（自然带入，别当成资料朗读）\n${lore.text}`)
  }

  // 5. 记忆
  if (conf?.memory?.enabled !== false) {
    const sum = await mem.getSummary(conf, qq)
    if (sum.text) parts.push(`## 你还记得的事（更早发生的）\n${sum.text}`)

    // 软召回：最近的 + 和这句话相关的，合在一起给（去重，按时间排好）
    const [rec, rel] = await Promise.all([
      mem.recentEpisodes(conf, qq, 4),
      mem.recallEpisodes(conf, qq, userText || "", 5),
    ])
    const seen = new Set()
    const eps = [...rel, ...rec].filter(e => {
      const key = e.text
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (eps.length) {
      const body = eps.map(e => `· ${e.text}`).join("\n")
      parts.push(`## 你记得的事\n${body}`)
    }

    const facts = await mem.factsLine(conf, qq)
    if (facts) parts.push(`## 关于他\n${facts}`)
  }

  // 6. 临时场景（比角色卡里的常驻设定更近，覆盖它）
  if (tv.scene) {
    parts.push(`## 此刻的场景（优先于上面的常驻设定）\n${tv.scene}`)
  }

  // 7. 交接（只在刚换过人时出现）
  if (conf?.cast?.handover !== false && prevCast) {
    const hb = handoverBlock(prevCast, card, ctx)
    if (hb) parts.push(hb)
  }

  // 8. 场景
  parts.push(sceneBlock(conf, card, { nickname, idleMin }))

  return { system: parts.filter(Boolean).join("\n\n"), loreHits: lore.hits }
}

/* --------------------------------------------------------- 主动开口 */

const PROACTIVE_STYLE = {
  life: "说一件你此刻正在做的小事（在吃/在躺/在洗头，具体一点）",
  ask: "问他一件关于他的小事，好奇地、随口地",
  miss: "表达一点点想他，但别腻，一句就收",
  tease: "拿他开个玩笑，吐槽一下，别真骂人",
  auto: "像随手发一条消息那样说点什么",
}

/**
 * 主动发言的指令。全部可配：
 *   style      语气类型
 *   topics     话题池（随机挑一个当引子）
 *   mentionTime 把"现在几点"带进去
 *   emoji      允不允许用表情
 */
export function proactiveInstruction(conf, { now = new Date() } = {}) {
  const pc = conf?.proactive || {}
  const style = String(pc.style || "auto")
  const want = PROACTIVE_STYLE[style] ? style : "auto"
  const topics = Array.isArray(pc.topics) ? pc.topics.filter(Boolean) : []
  const topic = topics.length ? topics[Math.floor(Math.random() * topics.length)] : ""

  const h = now.getHours()
  const part = h < 5 ? "凌晨" : h < 8 ? "清早" : h < 11 ? "上午" : h < 13 ? "中午" : h < 17 ? "下午" : h < 19 ? "傍晚" : h < 23 ? "晚上" : "深夜"

  const lines = [
    "（他没说话，你自己开口。别问「在吗」，别说「我没事」，就像平时突然想说话那样发一句。）",
    `- 方式：${PROACTIVE_STYLE[want]}`,
  ]
  if (topic) lines.push(`- 可以聊到这个：${topic}`)
  if (pc.mentionTime !== false) lines.push(`- 现在是${part}${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}，可以自然带到时间（这么晚还不睡 / 这个点还在忙）`)
  else lines.push("- 不要提时间")
  lines.push(pc.emoji === true ? "- 可以用 1 个表情" : "- 不要用表情符号")
  lines.push("- 只发 1 句，别连着发三条")
  return lines.join("\n")
}

/* ----------------------------------------------------------- messages */

/**
 * 拼出完整 messages，可直接喂给 llm.chat()
 *
 * @param {object} conf
 * @param {string} qq
 * @param {object} card
 * @param {string} userText  用户这句话（mode=proactive 时忽略）
 * @param {object} opts { nickname, idleMin, mode: "chat"|"proactive", prevCast }
 */
export async function buildMessages(conf, qq, card, userText, opts = {}) {
  const mode = opts.mode || "chat"
  const { system, loreHits } = await composeSystem(conf, qq, card, { ...opts, userText })

  const ctx = await mem.loadCtx(conf, qq)
  const messages = [{ role: "system", content: system }]

  const maxTurns = Number(conf?.chat?.maxTurns ?? 12)
  for (const m of ctx.slice(-maxTurns * 2)) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.content })
    }
  }

  messages.push({
    role: "user",
    content: mode === "chat" ? userText : proactiveInstruction(conf),
  })

  // 工具说明：让她知道能画画/发语音，自己决定什么时候用
  if (mode === "chat" && conf?.tools?.enabled !== false) {
    const tb = toolsBlock(conf)
    if (tb) messages.push({ role: "system", content: tb })
  }

  // 后置指令放最后，权重最高
  if (conf?.immersion?.enabled !== false && conf?.immersion?.postHistory !== false) {
    messages.push({ role: "system", content: postHistoryBlock(conf, card, opts.momentNote || "") })
  }

  return { messages, loreHits, systemChars: charLen(system) }
}
