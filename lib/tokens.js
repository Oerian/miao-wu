/**
 * 上下文窗口估算
 *
 * 为什么需要它：
 *   16 轮对话对 8k 窗口的本地小模型已经爆了，对 Gemini 却连零头都不到。
 *   按"轮数"一个阈值管所有模型是错的，得按 token 占比算。
 *
 * 这里是**估算**，不是精确分词：
 *   中文 1 字 ≈ 1 token（GBK 系模型略少，Gemini/Claude 略多，取偏保守的一方）
 *   英文 4 字符 ≈ 1 token
 *   每条消息再加 4 token 结构开销
 *
 * 宁可高估 —— 高估只是提醒得早一点，低估会直接报 context length exceeded。
 */
import { charLen } from "./util.js"

/** 常见模型的上下文窗口（token）。用户可以在 providers 里用 contextTokens 覆盖 */
const KNOWN = [
  [/gemini-.*(pro|ultra)/i, 1_000_000],
  [/gemini/i, 1_000_000],
  [/claude/i, 200_000],
  [/gpt-4\.1|gpt-4o|gpt-4-turbo/i, 128_000],
  [/gpt-4/i, 8_192],
  [/gpt-3\.5/i, 16_385],
  [/o1|o3|o4/i, 200_000],
  [/deepseek/i, 64_000],
  [/qwen(2\.5|3)?[-_ ]?(72b|32b|14b|7b)?/i, 32_768],
  [/llama[-_ ]?3\.[1-3]/i, 128_000],
  [/llama/i, 8_192],
  [/mistral|mixtral/i, 32_768],
  [/glm-4/i, 128_000],
  [/moonshot|kimi/i, 128_000],
]

/**
 * 一个字符值多少 token。
 * CJK / 全角标点按 1，其余按 0.28（≈ 3.6 字符 1 token）。
 */
function charWeight(ch) {
  const c = ch.codePointAt(0)
  if (
    (c >= 0x4e00 && c <= 0x9fff) || // 汉字
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x3000 && c <= 0x303f) || // 中文标点
    (c >= 0xff00 && c <= 0xffef) || // 全角
    (c >= 0xac00 && c <= 0xd7af) // 韩文
  ) {
    return 1
  }
  return 0.28
}

/** 估算一段文本的 token 数 */
export function estimateTokens(text) {
  const s = String(text || "")
  if (!s) return 0
  let w = 0
  for (const ch of s) w += charWeight(ch)
  return Math.ceil(w) + 2
}

/** 估算 messages 数组的总 token（含结构开销） */
export function estimateMessages(messages = []) {
  let n = 0
  for (const m of messages) n += estimateTokens(m?.content) + 4
  return n + 3
}

/** 按模型名猜窗口多大 */
export function guessWindow(model = "", type = "openai", conf = {}) {
  const m = String(model || "")
  for (const [re, n] of KNOWN) if (re.test(m)) return n
  if (String(type).toLowerCase() === "ollama") return Number(conf.numCtx || 8192)
  return 8192
}

/**
 * 这个后端实际能用的窗口。
 * 优先 provider.contextTokens，其次猜。
 */
export function windowOf(prov) {
  if (!prov) return 8192
  const explicit = Number(prov.contextTokens)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return guessWindow(prov.model, prov.type, prov)
}

/**
 * 算一次调用会吃掉多少窗口。
 *
 * @param {object} conf
 * @param {object} prov   provider
 * @param {Array}  messages  即将发出去的 messages
 * @returns {{used:number, limit:number, ratio:number, left:number, level:"ok"|"warn"|"high"|"over"}}
 */
export function usageOf(conf, prov, messages) {
  const limit = windowOf(prov)
  // 给输出留位置，否则刚好卡满时模型没地方写
  const reserve = Number(conf?.chat?.maxTokens ?? 400) || 400
  const used = estimateMessages(messages)
  const usable = Math.max(1, limit - reserve)
  const ratio = used / usable
  const level = ratio >= 1 ? "over" : ratio >= 0.9 ? "high" : ratio >= Number(conf?.compress?.warnRatio ?? 0.75) ? "warn" : "ok"
  return { used, limit, ratio, left: Math.max(0, usable - used), level }
}

/** 人类可读：「1.2k / 32k（4%）」 */
export function fmtUsage(u) {
  const k = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
  return `${k(u.used)} / ${k(u.limit)}（${Math.round(u.ratio * 100)}%）`
}

/**
 * 粗估"还能聊几轮"。
 * 一轮 ≈ 用户一句 + 她一句，按当前平均长度算。
 */
export function turnsLeft(u, avgTurnTokens) {
  if (!avgTurnTokens || avgTurnTokens <= 0) return Infinity
  return Math.floor(u.left / avgTurnTokens)
}

export { charLen }
