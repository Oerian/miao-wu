/**
 * 上下文压缩
 *
 * 什么时候压，三种策略（compress.mode）：
 *   remind —— 到线只提醒你，等你说「#喵呜 压缩」才真压（默认）
 *   auto   —— 到线自动压
 *   manual —— 一句都不提，全凭你发命令
 *
 * 为什么默认不自动压：
 *   摘要是**有损**的。模型给的摘要会把语气、口头禅、火气都磨平，
 *   压完再聊，她往往"变客气了" —— 就是常说的角色变质。
 *   而什么时候该压，取决于你这轮用的是哪个模型（8k 还是 1M），
 *   这件事交给阈值判断不如交给你判断。
 *
 * 真要压的时候，这里也尽量救：摘要 prompt 里专门留一节"她是谁、怎么说话"。
 */
import { chat } from "./llm.js"
import * as mem from "./memory.js"
import { estimateMessages, usageOf, fmtUsage, turnsLeft, windowOf } from "./tokens.js"
import { charLen } from "./util.js"

const log = () => globalThis.logger || console

/** 最近一次的实测占用（generate 里写，命令和提醒读） */
const lastUsage = new Map()

export function recordUsage(qq, usage) {
  if (qq) lastUsage.set(String(qq), usage)
}

function transcriptOf(msgs) {
  return msgs
    .map(m => `${m.role === "user" ? "主人" : "她"}：${String(m.content).replace(/\n/g, " ")}`)
    .join("\n")
}

/** 当前模式（兼容老配置里只有 enabled 的情况） */
export function compressMode(conf) {
  const c = conf?.compress || {}
  if (c.enabled === false) return "manual"
  const m = String(c.mode || "").toLowerCase()
  if (m === "auto" || m === "remind" || m === "manual") return m
  // 老配置没写 mode：保持原来的自动行为，免得升级后突然不压了
  return "auto"
}

/* ------------------------------------------------------------ 摘要 */

function summarySystem(conf, card, maxChars) {
  const herName = card?.name || "她"
  const keepChar = conf?.compress?.keepCharacter !== false
  const style = keepChar
    ? [
        card?.personality ? `- 她的性格：${String(card.personality).slice(0, 200)}` : "",
        card?.styleExtra ? `- 她说话的样子：${String(card.styleExtra).slice(0, 200)}` : "",
        card?.habitExtra ? `- 她的小习惯：${String(card.habitExtra).slice(0, 120)}` : "",
      ].filter(Boolean)
    : []

  const lines = [
    `你在给一段角色扮演对话做长期记忆摘要，供之后接着聊时参考。`,
    `主角是「${herName}」，对方是"主人"。`,
    "",
    "## 必须保住的信息",
    "1. 主人自己说过的**事实**：名字、年龄、工作、住哪、家人、身体状况、作息",
    "2. 主人的**喜好和雷点**：喜欢什么、讨厌什么、怕什么",
    "3. 双方说过的**约定和承诺**（尤其是带「下次」「以后」「明天」的）",
    "4. **情绪转折点**：吵架、和好、撒娇、被冷落、表白、难过",
    "5. **未完成的事**：说到一半的话题、答应要做的事",
    `6. 「${herName}」明确表达过的**立场和态度**`,
  ]
  if (keepChar) lines.push("7. 她在这段对话里的**语气变化**（一开始什么样、后来变成什么样）")

  lines.push(
    "",
    "## 必须丢掉的",
    "- 寒暄、重复的问答、纯语气词、动作描写",
    "- 你自己编的内容（对话里没出现的，一律不许写）",
  )

  if (keepChar && style.length) {
    // 这些不进摘要，只是让摘要模型知道"哪些东西不能压没"
    lines.push("", "## 她是谁（作为背景参考，别原样抄进摘要）", ...style)
  }

  lines.push(
    "",
    "## 写法",
    "- 第三人称陈述句，像备忘录，不要写成剧本",
    "- 一条一行，前面加 · ",
    `- 总长不超过 ${maxChars} 字`,
    "- 直接输出摘要正文，不要任何前言后语、不要 markdown 标题",
  )
  return lines.join("\n")
}

/**
 * 真正执行压缩。
 * @returns {Promise<null | {compressed:number, summary:string, summaryTurns:number}>}
 */
async function doCompress(conf, qq, prov, card, { force = false } = {}) {
  if (!prov?.model) return null

  const trigger = force ? Number(conf?.compress?.keepTurns ?? 8) : Number(conf?.compress?.triggerTurns ?? 16)
  const keepTurns = Number(conf?.compress?.keepTurns ?? 8)
  const maxChars = Number(conf?.compress?.maxSummaryChars ?? 600)

  const ctx = await mem.loadCtx(conf, qq)
  const turns = Math.floor(ctx.length / 2)
  if (turns <= trigger) return null

  const dropTurns = turns - keepTurns
  if (dropTurns < 2) return null

  const dropMsgs = ctx.slice(0, dropTurns * 2)
  const old = await mem.getSummary(conf, qq)
  const herName = card?.name || "她"

  const sys = summarySystem(conf, card, maxChars)
  const user = [
    old.text ? `## 更早的事（已有摘要，需要合并进来）\n${old.text}\n` : "",
    `## 需要并入的新对话\n${transcriptOf(dropMsgs)}`,
  ]
    .filter(Boolean)
    .join("\n")

  let summary = ""
  try {
    summary = await chat(
      prov,
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { maxTokens: 900, temperature: 0.4, retries: 2, silent: true },
    )
  } catch (e) {
    // 摘要失败不能丢原文 —— 直接放弃这次压缩，下轮再试
    log().warn?.(`[miao-wu] 上下文压缩失败，保留原文：${String(e.message).slice(0, 120)}`)
    return null
  }

  summary = String(summary || "").trim()
  if (!summary) return null
  if ([...summary].length > maxChars * 1.5) summary = [...summary].slice(0, Math.floor(maxChars * 1.5)).join("")

  await mem.setSummary(conf, qq, summary, (old.turns || 0) + dropTurns)
  await mem.dropOldest(conf, qq, dropTurns * 2)

  log().mark?.(
    `[miao-wu] 上下文压缩：${turns} 轮 → 保留 ${keepTurns} 轮，压掉 ${dropTurns} 轮（摘要 ${[...summary].length} 字）`,
  )
  // 压完占用变了，缓存作废
  lastUsage.delete(String(qq))
  return { compressed: dropTurns, summary, summaryTurns: (old.turns || 0) + dropTurns, herName }
}

/** 自动模式下的例行检查：不改就返回 null */
export async function maybeCompress(conf, qq, prov, card) {
  if (compressMode(conf) !== "auto") return null
  return doCompress(conf, qq, prov, card, { force: false })
}

/** 手动触发（命令用）：强制把除最近 keep 轮以外的都压掉 */
export async function forceCompress(conf, qq, prov, card) {
  const ctx = await mem.loadCtx(conf, qq)
  const turns = Math.floor(ctx.length / 2)
  const keepTurns = Number(conf?.compress?.keepTurns ?? 8)
  if (turns <= keepTurns + 1) {
    return { ok: false, msg: `现在只有 ${turns} 轮，比保留数 ${keepTurns} 多不了几轮，不值得压` }
  }
  const r = await doCompress({ ...conf, compress: { ...conf.compress, enabled: true } }, qq, prov, card, { force: true })
  if (!r) return { ok: false, msg: "压缩没成功（模型没返回可用的摘要），原文还在" }
  return { ok: true, msg: `压掉 ${r.compressed} 轮，摘要 ${[...r.summary].length} 字`, summary: r.summary }
}

/* ------------------------------------------------------- 压力检查 */

/**
 * 算这次会话的上下文压力。
 *
 * @param {object} conf
 * @param {string} qq
 * @param {object} prov
 * @param {object} opts { systemChars }  没实测值时用它兜底
 * @returns {Promise<object>} {turns, keepTurns, trigger, usage, mode, action, turnsLeft, avgTurnTokens}
 */
export async function pressure(conf, qq, prov, opts = {}) {
  const ctx = await mem.loadCtx(conf, qq)
  const turns = Math.floor(ctx.length / 2)
  const keepTurns = Number(conf?.compress?.keepTurns ?? 8)
  const trigger = Number(conf?.compress?.triggerTurns ?? 16)

  // 有实测就用实测（generate 刚跑过），没有就按上下文+system 估
  let usage = lastUsage.get(String(qq))
  if (!usage) {
    const pseudo = [{ role: "system", content: "x".repeat(opts.systemChars || 1200) }, ...ctx]
    usage = usageOf(conf, prov, pseudo)
  }

  // 一轮平均多少 token：用现有对话估
  const ctxTokens = ctx.reduce((n, m) => n + charLen(m.content) + 4, 0)
  const avgTurnTokens = turns > 0 ? Math.max(24, Math.round(ctxTokens / turns)) : 90

  const mode = compressMode(conf)
  // 轮数触发只在一个窗口用掉一半之后才算数。
  // 否则 1M 窗口的模型每 16 轮就被念叨一次"脑子装满了"，纯属骚扰 ——
  // 而真正的满，是 ratio 说的。
  const turnsFloor = Number(conf?.compress?.turnsFloorRatio ?? 0.5)
  const turnsHit = turns > trigger
  const byTurns = turnsHit && usage.ratio >= turnsFloor
  const byRatio = usage.ratio >= Number(conf?.compress?.warnRatio ?? 0.75)

  let action = "none"
  if (usage.level === "over") action = "over"
  else if (mode === "auto" && byTurns) action = "compress"
  else if (mode === "remind" && (byTurns || byRatio)) action = "remind"
  else if (mode === "remind" && usage.level === "high") action = "remind"

  return {
    turns,
    keepTurns,
    trigger,
    mode,
    usage,
    action,
    canCompress: turns > keepTurns + 1,
    byTurns,
    byRatio,
    // 轮数到了、但窗口还空 —— 故意不提醒，报告里要说清为什么
    turnsMuted: turnsHit && !byTurns,
    avgTurnTokens,
    left: turnsLeft(usage, avgTurnTokens),
  }
}

/** 「#喵呜 上下文」用的一屏报告 */
export async function contextReport(conf, qq, prov, opts = {}) {
  const p = await pressure(conf, qq, prov, opts)
  const modeText = { auto: "自动压", remind: "到线提醒（不自动压）", manual: "只手动" }[p.mode] || p.mode
  // 一万多轮这种数字写出来像开玩笑，换个量级
  const leftText =
    !Number.isFinite(p.left) || p.left <= 0
      ? ""
      : p.left > 9999
        ? `约 ${(p.left / 10000).toFixed(1)} 万轮`
        : `约 ${p.left} 轮`
  const lines = [
    `上下文：${fmtUsage(p.usage)}`,
    `窗口：${p.usage.limit} token（${prov?.model || "?"}${Number(prov?.contextTokens) ? " · 手动指定" : " · 按模型名推算"}）`,
    `存量：${p.turns} 轮原文${p.canCompress ? `，压完保留 ${p.keepTurns} 轮` : ""}`,
    `策略：${modeText} · 触发线 ${p.trigger} 轮 / ${Math.round((conf?.compress?.warnRatio ?? 0.75) * 100)}%`,
    leftText ? `还能聊：${leftText}（按每轮 ${p.avgTurnTokens} token 估）` : "",
    p.turnsMuted ? `（${p.turns} 轮已经过了 ${p.trigger} 轮的线，但窗口才用 ${Math.round(p.usage.ratio * 100)}%，这么空就不提醒你了）` : "",
    "",
    p.usage.level === "over"
      ? "已经超了，下一句大概率直接报错 —— 先发「#喵呜 压缩」。"
      : p.action === "remind"
        ? "到线了。想保住人设就自己挑时机发「#喵呜 压缩」；压完她会稍微「淡」一点，这是有损的代价。"
        : p.usage.level === "high"
          ? "快到顶了，建议这一两轮内压一次。"
          : "还宽裕，先不用管。",
    "",
    "手动压：#喵呜 压缩",
    "换策略：config.yaml 的 compress.mode（auto / remind / manual）",
  ].filter(Boolean)
  return lines.join("\n")
}

/** 给提醒句用的短句 */
export function remindLine(p, card) {
  const name = card?.name || "她"
  const pct = Math.round(p.usage.ratio * 100)
  if (p.usage.level === "over") {
    return `（${name}说的）…脑子快装不下了（上下文 ${pct}%），你再不让我理一理，下一句我就要断片了。发「#喵呜 压缩」。`
  }
  return `（小声）…我们说了 ${p.turns} 轮了，脑子里塞得有点满（${pct}%）。要我压一压吗？发「#喵呜 压缩」就行 —— 不压也行，就是再聊下去会开始丢细节。`
}

export { windowOf, estimateMessages, fmtUsage }
