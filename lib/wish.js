/**
 * 需求清单 —— 让她自己开口要东西
 *
 * 她画画时发现缺一个合适的 LoRA、斗图时发现表情包库里没货，
 * 都可以用 [[需求:…]] 标记说出来。插件做三件事：
 *   1. 落盘到 data/wishes.jsonl（断电也不丢）
 *   2. 私聊主人提醒一声
 *   3. 冷却期内不重复提（防刷屏，也不能天天要东西）
 *
 * 主人用「#喵呜 需求」看清单，「#喵呜 需求 清」清空。
 */
import fs from "node:fs"
import path from "node:path"
import { dataDir } from "./config.js"

const log = () => globalThis.logger || console

function wishFile(conf) {
  return path.join(dataDir(conf), "wishes.jsonl")
}

/** 读 masterQQ（跟 webui.js 同一套兜底逻辑） */
function masterOf() {
  const pick0 = v => (Array.isArray(v) ? v[0] : v) || ""
  let master = pick0(globalThis.cfg?.masterQQ)
  if (!master) {
    try {
      const mod = (globalThis.Bot?.cfg ?? {}) || {}
      master = pick0(mod.masterQQ)
    } catch {}
  }
  return String(master || "")
}

/**
 * 记一条需求。
 * @returns {{ ok: boolean, waitMin?: number }} ok=false 表示还在冷却里
 */
export function recordWish(conf, qq, text) {
  const t = String(text || "").trim().slice(0, 120)
  if (!t) return { ok: false, waitMin: 0 }

  const file = wishFile(conf)
  const cooldownMs = Number(conf.draw?.wishCooldownMin ?? 360) * 60000

  // 冷却：看她上一条需求是什么时候提的
  try {
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const w = JSON.parse(lines[i])
        if (w.qq === String(qq)) {
          const wait = cooldownMs - (Date.now() - Number(w.at || 0))
          if (wait > 0) return { ok: false, waitMin: Math.ceil(wait / 60000) }
          break
        }
      } catch {}
    }
  } catch {}

  const wish = { at: Date.now(), qq: String(qq), text: t }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(wish) + "\n", "utf-8")
  } catch (e) {
    log().warn?.(`[miao-wu] 写需求清单失败：${e.message}`)
  }
  return { ok: true }
}

/** 需求清单（新的在前），max 条数兜底防炸屏 */
export function listWishes(conf, max = 20) {
  let lines = []
  try {
    lines = fs.readFileSync(wishFile(conf), "utf-8").trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
  const out = []
  for (const line of lines) {
    try {
      const w = JSON.parse(line)
      if (w?.text) out.push(w)
    } catch {}
  }
  return out.slice(-max).reverse()
}

/** 清空 */
export function clearWishes(conf) {
  try {
    fs.unlinkSync(wishFile(conf))
  } catch {}
}

/**
 * 私聊主人提醒。失败只写日志，不影响她正常说话。
 */
export async function notifyMaster(conf, text) {
  const master = masterOf()
  if (!master) return false
  try {
    const bot = globalThis.Bot
    if (!bot?.pickUser) return false
    await bot.pickUser(master).sendMsg(text)
    return true
  } catch (e) {
    log().warn?.(`[miao-wu] 通知主人失败：${e.message}`)
    return false
  }
}
