/**
 * 酒馆式交互
 *
 * 把 SillyTavern 那套体验搬到 QQ 里：
 *   - 开场白     角色卡有 first_mes / alternate_greetings，换人时自动开场
 *   - 场景锚     临时设定（"现在是下雨天，在便利店门口"），不改角色卡
 *   - 我是谁     用户人设（"我是他的同事，25岁"），注入 system
 *   - 同场角色   另一个角色"在场"，主角色会提到她
 *
 * 这些是可变的临时状态，都存在 facts 的内部键里（带 __ 前缀），
 * 不会污染"关于他"那段。
 */
import * as mem from "./memory.js"
import { pick } from "./util.js"

/* ------------------------------------------------------------ 开场白 */

/**
 * 取一句开场白。有 first_mes 用 first_mes，也支持 alternate_greetings 随机。
 * @returns {string} 没有就返回空串
 */
export function openingFor(card) {
  if (!card) return ""
  const pool = [card.firstMes, ...(card.greetingPool || [])].filter(s => s && String(s).trim())
  if (!pool.length) return ""
  // 只有一条就直接用；有多条轮流挑，避免每次开新档都同一句
  return pool.length === 1 ? String(pool[0]).trim() : pick(pool)
}

/* ------------------------------------------------------------ 临时场景 */

export const SCENE_KEY = "scene"
export const USER_KEY = "userPersona"
export const CAMEO_KEY = "cameo"

export async function getScene(conf, qq) {
  return mem.getHidden(conf, qq, SCENE_KEY)
}

export async function setScene(conf, qq, text) {
  return mem.setHidden(conf, qq, SCENE_KEY, String(text || "").trim())
}

export async function clearScene(conf, qq) {
  return mem.setHidden(conf, qq, SCENE_KEY, "")
}

/* ------------------------------------------------------------ 我是谁 */

export async function getUserPersona(conf, qq) {
  return mem.getHidden(conf, qq, USER_KEY)
}

export async function setUserPersona(conf, qq, text) {
  return mem.setHidden(conf, qq, USER_KEY, String(text || "").trim())
}

export async function clearUserPersona(conf, qq) {
  return mem.setHidden(conf, qq, USER_KEY, "")
}

/* ------------------------------------------------------------ 同场角色 */

/** @returns {string[]} 角色 id 列表 */
export async function getCameo(conf, qq) {
  const raw = await mem.getHidden(conf, qq, CAMEO_KEY)
  if (!raw) return []
  return String(raw)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

export async function setCameo(conf, qq, ids) {
  const list = Array.isArray(ids) ? ids : String(ids || "").split(/[,，\s]+/)
  const clean = list.map(s => String(s).trim()).filter(Boolean)
  return mem.setHidden(conf, qq, CAMEO_KEY, clean.join(","))
}

export async function clearCameo(conf, qq) {
  return mem.setHidden(conf, qq, CAMEO_KEY, "")
}

/* ------------------------------------------------- 同场角色的人设摘要 */

/**
 * 把"在场其他人"压成一小段，注入 system 让主角色知道有谁在。
 * 只给名字 + 一两句特征，给多了会把主角色的注意力抢走。
 */
export function cameoBlock(cards) {
  const list = (cards || []).filter(Boolean)
  if (!list.length) return ""
  const lines = list.map(c => {
    const brief = String(c.description || c.personality || "")
      .replace(/\s+/g, " ")
      .slice(0, 80)
    return `- ${c.name}：${brief}`
  })
  return [
    "## 现在还有谁在",
    ...lines,
    "",
    "她们也在场，你可以提到她们、让她们说话，但**你的回复主体仍然是你自己**，",
    "不要替她们长篇代述，也不要变成旁白。",
  ].join("\n")
}

/* ------------------------------------------------------------ 状态摘要 */

export async function tavernState(conf, qq) {
  const [scene, user, cameo] = await Promise.all([
    getScene(conf, qq),
    getUserPersona(conf, qq),
    getCameo(conf, qq),
  ])
  return { scene, userPersona: user, cameo }
}
