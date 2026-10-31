/**
 * 活人感：分句发送 + 打字延迟
 *
 * 一条消息拆成 1~3 段，中间插随机停顿，
 * 发之前按字数估一个"打字时间"，看起来像是真的在敲。
 */
import { sleep, rand, charLen } from "./util.js"

const OPEN = "（(【「“"
const CLOSE = "）)】」”"

/**
 * 按标点切句。括号/引号内的标点不切。
 * @returns {string[]}
 */
export function splitSegments(text, cfg = {}) {
  const src = String(text || "").trim()
  if (!src) return []

  const maxSeg = Math.max(1, Number(cfg.maxSegments ?? 3))
  if (maxSeg === 1 || charLen(src) < 24) return [src]

  const chars = [...(cfg.splitChars || ["。", "！", "？", "～", "…", "\n"])]
  const out = []
  let buf = ""
  let depth = 0

  for (const ch of src) {
    if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1)

    buf += ch

    const isSep = chars.includes(ch) && depth === 0
    if (isSep) {
      // 连续标点算一个（"！！！""……"）
      out.push(buf)
      buf = ""
    }
  }
  if (buf.trim()) out.push(buf)

  let segs = out.map(s => s.trim()).filter(Boolean)
  if (segs.length <= 1) return [src]

  // 太碎的段（<4 字）并到下一段，没下一段就并到上一段
  const merged = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (charLen(s) < 4 && merged.length && charLen(merged[merged.length - 1]) < 30) {
      merged[merged.length - 1] += s
    } else if (charLen(s) < 4 && i + 1 < segs.length) {
      segs[i + 1] = s + segs[i + 1]
    } else {
      merged.push(s)
    }
  }

  // 超出上限：剩下的并进最后一段
  if (merged.length > maxSeg) {
    const head = merged.slice(0, maxSeg - 1)
    const tail = merged.slice(maxSeg - 1).join("")
    return [...head, tail]
  }
  return merged
}

/**
 * 逐段发出去。
 * @param {(msg: string) => Promise<any>} send
 * @param {string} text
 * @param {object} cfg humanize 配置
 */
export async function sendHuman(send, text, cfg = {}) {
  const segs = splitSegments(text, cfg)
  if (!segs.length) return

  const gap = cfg.segmentGap || [350, 1100]

  for (let i = 0; i < segs.length; i++) {
    if (i > 0) await sleep(rand(gap[0] ?? 350, gap[1] ?? 1100))
    await send(segs[i])
  }
}

/** 看一眼消息之前的"已读"延迟 */
export async function readDelay(cfg = {}) {
  const d = cfg.readDelay || [300, 1500]
  await sleep(rand(d[0] ?? 300, d[1] ?? 1500))
}
