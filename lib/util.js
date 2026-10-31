/**
 * 通用工具
 */

export const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms | 0)))

export function rand(min, max) {
  return Math.floor(Math.random() * (Math.max(min, max) - Math.min(min, max) + 1)) + Math.min(min, max)
}

export function pick(arr) {
  if (!Array.isArray(arr) || !arr.length) return undefined
  return arr[Math.floor(Math.random() * arr.length)]
}

export function clamp(n, min, max, def) {
  const v = Number(n)
  if (!Number.isFinite(v)) return def
  return Math.max(min, Math.min(max, v))
}

export function clampInt(n, min, max, def) {
  return Math.round(clamp(n, min, max, def))
}

/** 按"字"算长度（emoji / 汉字都算 1） */
export function charLen(s) {
  return [...String(s || "")].length
}

/** 截断到 n 个字 */
export function cut(s, n) {
  const a = [...String(s || "")]
  return a.length > n ? a.slice(0, n).join("") : a.join("")
}

/** 今天 YYYYMMDD / 时间戳 */
export function ymd(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
}

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

/** 相对时间描述：刚刚 / 3 分钟前 / 2 小时前 / 昨天 */
export function ago(ts) {
  if (!ts) return "很久以前"
  const ms = Date.now() - ts
  if (ms < 60_000) return "刚刚"
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return "昨天"
  if (d < 30) return `${d} 天前`
  return `${Math.floor(d / 30)} 个月前`
}

/** 去掉 CQ 码残留，拿纯文本 */
export function plainText(msg) {
  return String(msg || "")
    .replace(/\[CQ:[^\]]*\]/g, "")
    .trim()
}

/**
 * 原子写文件（先写临时文件再 rename），避免写一半被读到半截
 */
export async function writeFileAtomic(file, content) {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, content, "utf-8")
  await fs.rename(tmp, file)
}

/** 简易关键词打分：中文按 2-gram，英文按词 */
export function tokens(s) {
  const t = String(s || "").toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z0-9_]{2,}/g) || []) out.add(w)
  const cn = t.replace(/[^\u4e00-\u9fa5]/g, "")
  for (let i = 0; i < cn.length - 1; i++) out.add(cn.slice(i, i + 2))
  return out
}

/** 两段文本的重合度 0~1 */
export function overlap(a, b) {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / Math.min(A.size, B.size)
}
