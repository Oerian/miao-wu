/**
 * 时钟：真实时间 / 节日 / 定时器 / 到点提醒
 *
 * 三件事：
 *   1. 把"现在几点、今天几号"塞进提示词 —— 她不该在凌晨三点问你要不要吃早饭
 *   2. 自然语言定时器 —— 「提醒我 30分钟后 该吃药了」「每天 7:30 叫我起床」
 *   3. 到点主动发消息 —— 由 index.js 的每分钟 tick 驱动
 *
 * 存储走 memory.js 的 kv（Redis + 文件双写），跟着存档隔离。
 * 定时器故意**不跟存档隔离** —— 提醒是"现实世界"的事，
 * 换存档不该把闹钟弄丢；所以固定用 default 存档的 key 空间。
 */
import * as mem from "./memory.js"
import { sanitizeProfile } from "./memory.js"
import { charLen } from "./util.js"

const log = () => globalThis.logger || console

const K_REMIND = qq => `miaowu:remind:${qq}`
const WEEK = ["日", "一", "二", "三", "四", "五", "六"]

/* ------------------------------------------------------------ 现在几点 */

function tzDate(conf, d = new Date()) {
  const tz = String(conf?.clock?.timezone || "").trim()
  if (!tz) return d
  try {
    // 用 toLocaleString 拿到目标时区的地方时，再构造回来
    const s = d.toLocaleString("sv-SE", { timeZone: tz })
    return new Date(s.replace(" ", "T"))
  } catch {
    return d
  }
}

/** 一天里的说法 */
export function dayPart(h) {
  if (h < 5) return "凌晨"
  if (h < 8) return "清早"
  if (h < 11) return "上午"
  if (h < 13) return "中午"
  if (h < 17) return "下午"
  if (h < 19) return "傍晚"
  if (h < 23) return "晚上"
  return "深夜"
}

/** 农历（用 Intl 的中国历，可靠，不用查表） */
function lunarOf(d) {
  try {
    const fmt = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "long", day: "numeric" })
    // 输出形如「九月初一」
    return fmt.format(d)
  } catch {
    return ""
  }
}

/** 公历节日 + 农历节日 + 节气（只做认得出的，不硬凑） */
export function festivalOf(d) {
  const m = d.getMonth() + 1
  const day = d.getDate()

  const solar = {
    "1-1": "元旦",
    "2-14": "情人节",
    "3-8": "妇女节",
    "4-1": "愚人节",
    "5-1": "劳动节",
    "5-4": "青年节",
    "6-1": "儿童节",
    "7-1": "建党节",
    "8-1": "建军节",
    "9-10": "教师节",
    "10-1": "国庆节",
    "12-24": "平安夜",
    "12-25": "圣诞节",
    "12-31": "跨年夜",
  }
  if (solar[`${m}-${day}`]) return solar[`${m}-${day}`]

  // 母亲节：5 月第二个周日；父亲节：6 月第三个周日
  const w = d.getDay()
  if (m === 5 && w === 0 && day >= 8 && day <= 14) return "母亲节"
  if (m === 6 && w === 0 && day >= 15 && day <= 21) return "父亲节"
  if (m === 11 && w === 4 && day >= 22 && day <= 28) return "感恩节"

  // 农历
  const lu = lunarOf(d)
  const lunarMap = { 正月初一: "春节", 正月十五: "元宵节", 五月初五: "端午节", 七月初七: "七夕", 八月十五: "中秋节", 九月初九: "重阳节", 十二月初八: "腊八", 腊月廿三: "小年" }
  for (const [k, v] of Object.entries(lunarMap)) if (lu.startsWith(k) || lu === k) return v

  // 除夕：农历腊月最后一天（用"明天是正月初一"反推）
  try {
    const tmr = new Date(d.getTime() + 86400000)
    if (lunarOf(tmr) === "正月初一") return "除夕"
  } catch {}

  return ""
}

/** 「2026年10月29日 周四 上午 10:42」 */
export function clockText(conf, d = new Date()) {
  const t = tzDate(conf, d)
  const hh = String(t.getHours()).padStart(2, "0")
  const mm = String(t.getMinutes()).padStart(2, "0")
  const date = `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`
  const wk = `周${WEEK[t.getDay()]}`
  if (conf?.clock?.showDate === false) return `${dayPart(t.getHours())} ${hh}:${mm}`
  return `${date} ${wk} ${dayPart(t.getHours())} ${hh}:${mm}`
}

/**
 * 注入提示词的那一段。
 * 不是干巴巴报时 —— 要告诉她"这个时间意味着什么"。
 */
export function promptBlock(conf, { now = new Date(), lastUserAt = 0 } = {}) {
  if (conf?.clock?.enabled === false) return ""
  const t = tzDate(conf, now)
  const h = t.getHours()
  const hh = String(h).padStart(2, "0")
  const mm = String(t.getMinutes()).padStart(2, "0")
  const fest = conf?.clock?.showFestival !== false ? festivalOf(t) : ""

  const lines = [`## 现在（真实世界的时间）`]
  if (conf?.clock?.showDate !== false) {
    lines.push(`- ${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日 周${WEEK[t.getDay()]}${fest ? ` · ${fest}` : ""}`)
  } else if (fest) {
    lines.push(`- 今天是${fest}`)
  }
  lines.push(`- ${dayPart(h)} ${hh}:${mm}`)

  // 时间对情绪的影响
  if (h >= 0 && h < 5) lines.push("- 这个点正常人都在睡，你该是困的、语气含糊，不该精神抖擞")
  else if (h < 7) lines.push("- 天刚亮，你可能还没完全醒")
  else if (h >= 23) lines.push("- 很晚了，你有点撑不住，话会更短")
  else if (h >= 12 && h < 13) lines.push("- 中午，可能正在吃饭")
  else if (h >= 18 && h < 20) lines.push("- 晚饭时间")

  if (fest) lines.push(`- 今天是${fest}，你心里知道这回事，可以自然带到，但别一本正经地祝节日快乐`)
  if (lastUserAt) {
    const gapMin = Math.floor((now.getTime() - lastUserAt) / 60000)
    if (gapMin >= 60 * 20) lines.push(`- 你们上一次说话是 ${Math.floor(gapMin / 1440)} 天前`)
  }
  lines.push("- 这些是你知道的背景，不要主动报时间，也不要说「根据系统时间」")
  return lines.join("\n")
}

/* ------------------------------------------------------------ 解析时间 */

const CN_NUM = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }

function num(s) {
  const t = String(s || "").trim()
  if (/^\d+$/.test(t)) return Number(t)
  if (CN_NUM[t] != null) return CN_NUM[t]
  // 二十五 / 三十
  const m = t.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/)
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0)
  return NaN
}

/**
 * 解析"什么时候"。
 *
 * 支持：
 *   30分钟 / 半小时 / 2小时 / 90秒        → 相对
 *   8点 / 20:30 / 晚上8点 / 明早7点       → 绝对
 *   明天 / 后天 / 三天后 + 时间            → 相对日
 *   每天7:30                              → 每天重复
 *
 * @returns {{ok:boolean, at?:number, repeat?:string, rest?:string, msg?:string}}
 */
export function parseWhen(input, now = new Date()) {
  const raw = String(input || "").trim()
  if (!raw) return { ok: false, msg: "没说什么时候" }

  // 每天 / 每周
  let repeat = ""
  let body = raw
  const repM = body.match(/^(每天|每日|天天|每周[一二三四五六日天]?)\s*/)
  if (repM) {
    repeat = /每(天|日)|天天/.test(repM[1]) ? "daily" : `weekly:${repM[1].replace("每周", "")}`
    body = body.slice(repM[0].length).trim()
  }

  // 相对时长
  const rel = body.match(/^(\d+|[零一两二三四五六七八九十]+)?\s*(秒钟?|分钟?|小时|钟头|个?半(?:小时|钟头))/)
  if (rel) {
    let n
    let unit
    if (/半/.test(rel[2])) {
      n = 0.5
      unit = "hour"
    } else {
      n = num(rel[1] || "1")
      unit = /秒/.test(rel[2]) ? "sec" : /小时|钟头/.test(rel[2]) ? "hour" : "min"
    }
    if (!Number.isFinite(n)) return { ok: false, msg: "时间数字没看懂" }
    const ms = n * (unit === "sec" ? 1000 : unit === "hour" ? 3600000 : 60000)
    if (ms < 3000) return { ok: false, msg: "太短了，至少 3 秒" }
    return {
      ok: true,
      at: now.getTime() + ms,
      repeat: repeat === "daily" ? "" : repeat, // "每天30分钟后"没意义，忽略
      rest: body.slice(rel[0].length).replace(/^(后|以后|之后|后提醒我?|提醒我?)\s*/, "").trim(),
    }
  }

  // 相对日 + 时间
  let dayOffset = 0
  const dayM = body.match(/^(今天|今晚|今早|明天|明早|明晚|后天|大后天)\s*/)
  if (dayM) {
    const w = dayM[1]
    dayOffset = /后天/.test(w) ? 2 : /大后天/.test(w) ? 3 : /明天|明早|明晚/.test(w) ? 1 : 0
    body = body.slice(dayM[0].length).trim()
  }

  // N 天后
  const nDayM = body.match(/^(\d+|[一二两三四五六七八九十]+)\s*天(后|以后|之后)?\s*/)
  if (nDayM) {
    dayOffset = num(nDayM[1])
    body = body.slice(nDayM[0].length).trim()
  }

  // 绝对时间：8点 / 20:30 / 晚上八点半
  const absM = body.match(/(凌晨|清早|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:[:：点时])\s*(\d{1,2}|[一二三四五六七八九十]{1,3}|半)?\s*分?/)
  if (absM) {
    const mark = absM[1] || ""
    let h = num(absM[2])
    let m = absM[3] === "半" ? 30 : absM[3] ? num(absM[3]) : 0
    if (!Number.isFinite(h) || h > 24) return { ok: false, msg: "小时数不对" }
    if (!Number.isFinite(m) || m > 59) return { ok: false, msg: "分钟数不对" }

    if (/下午|傍晚|晚上|夜里/.test(mark) && h < 12) h += 12
    if (/中午/.test(mark) && h < 11) h += 12
    if (!mark && h <= 7) h += 12 // 说"7点"通常是晚上 7 点

    const d = new Date(now)
    d.setDate(d.getDate() + dayOffset)
    d.setHours(h, m, 0, 0)
    if (!dayOffset && d.getTime() <= now.getTime()) {
      // 今天这个点已经过了 → 顺延到明天
      d.setDate(d.getDate() + 1)
    }
    if (repeat === "daily") {
      // 每天：保留时:分，日期不重要
      const base = new Date(now)
      base.setHours(h, m, 0, 0)
      if (base.getTime() <= now.getTime()) base.setDate(base.getDate() + 1)
      return { ok: true, at: base.getTime(), repeat: "daily", h, m, rest: body.slice(absM[0].length).trim() }
    }
    return { ok: true, at: d.getTime(), repeat, rest: body.slice(absM[0].length).trim() }
  }

  return { ok: false, msg: "没认出时间，试试「30分钟」「明天8点」「20:30」" }
}

/* ------------------------------------------------------------ 存取 */

function nextDaily(ts, h, m) {
  const d = new Date(ts)
  d.setDate(d.getDate() + 1)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

export async function listReminders(conf, qq) {
  const arr = await mem.kvLoad(conf, K_REMIND(qq))
  return Array.isArray(arr) ? arr : []
}

async function saveReminders(conf, qq, arr) {
  // 按触发时间排，最多留 maxPending 个未触发的
  const max = Number(conf?.clock?.maxPending ?? 20)
  const sorted = [...arr].sort((a, b) => a.at - b.at)
  const pending = sorted.filter(r => !r.done)
  const done = sorted.filter(r => r.done).slice(-10)
  const trimmed = [...pending.slice(0, max), ...done].sort((a, b) => a.at - b.at)
  await mem.kvSave(conf, K_REMIND(qq), trimmed)
  return trimmed
}

/**
 * 加一个定时器。
 * @returns {Promise<{ok:boolean, msg:string, item?:object}>}
 */
export async function addReminder(conf, qq, { at, text, repeat = "", h = 0, m = 0, raw = "" }) {
  if (conf?.clock?.reminds === false) return { ok: false, msg: "定时器关着（config.yaml 的 clock.reminds）" }
  if (!text) return { ok: false, msg: "没说提醒什么事" }
  const list = await listReminders(conf, qq)
  const max = Number(conf?.clock?.maxPending ?? 20)
  if (list.filter(r => !r.done).length >= max) {
    return { ok: false, msg: `已经挂了 ${max} 个了，先清掉几个（#喵呜 提醒 列表）` }
  }
  const item = {
    id: Math.random().toString(36).slice(2, 8),
    at: Number(at) || Date.now() + 60000,
    text: String(text).slice(0, 200),
    repeat: repeat || "",
    h: repeat === "daily" ? Number(h) || 0 : 0,
    m: repeat === "daily" ? Number(m) || 0 : 0,
    raw: String(raw || "").slice(0, 120),
    createdAt: Date.now(),
    done: false,
    firedAt: 0,
  }
  await saveReminders(conf, qq, [...list, item])
  return { ok: true, msg: `记下了：${fmtAt(item.at)}${item.repeat === "daily" ? "（每天）" : ""} · ${item.text}`, item }
}

export async function cancelReminder(conf, qq, id) {
  const list = await listReminders(conf, qq)
  const key = String(id || "").trim()
  const idx = list.findIndex(r => r.id === key || String(list.indexOf(r) + 1) === key)
  if (idx < 0) return { ok: false, msg: `没有编号「${key}」的提醒（发「#喵呜 提醒 列表」看看）` }
  const [gone] = list.splice(idx, 1)
  await saveReminders(conf, qq, list)
  return { ok: true, msg: `取消了：${fmtAt(gone.at)} · ${gone.text}` }
}

export async function clearReminders(conf, qq) {
  const list = await listReminders(conf, qq)
  const n = list.filter(r => !r.done).length
  await saveReminders(conf, qq, [])
  return { ok: true, msg: n ? `清掉了 ${n} 个提醒` : "本来就没有提醒" }
}

/** 到点该发的（跨用户） */
export async function dueAll(conf, now = Date.now()) {
  const out = []
  for (const qq of await mem.allUsers(conf)) {
    const list = await listReminders(conf, qq)
    const due = list.filter(r => !r.done && r.at <= now)
    if (!due.length) continue
    for (const r of due) {
      out.push({ qq, ...r })
      r.done = r.repeat ? false : true
      r.firedAt = now
      if (r.repeat === "daily") {
        r.at = nextDaily(r.at, r.h, r.m)
        // 万一是很久之前的（关机了几天），直接推到未来
        while (r.at <= now) r.at = nextDaily(r.at, r.h, r.m)
      }
    }
    await saveReminders(conf, qq, list)
  }
  return out
}

/* ------------------------------------------------------------ 展示 */

export function fmtAt(ts, now = Date.now()) {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const today = new Date(now)
  const sameDay = d.toDateString() === today.toDateString()
  const tmr = new Date(now + 86400000).toDateString() === d.toDateString()
  const left = ts - now
  const rel =
    left <= 0 ? "已到" : left < 60000 ? `${Math.ceil(left / 1000)} 秒后` : left < 3600000 ? `${Math.round(left / 60000)} 分钟后` : left < 86400000 ? `${(left / 3600000).toFixed(1)} 小时后` : `${Math.round(left / 86400000)} 天后`
  if (sameDay) return `今天 ${hh}:${mm}（${rel}）`
  if (tmr) return `明天 ${hh}:${mm}（${rel}）`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}（${rel}）`
}

export function renderList(conf, list, now = Date.now()) {
  const pending = list.filter(r => !r.done)
  if (!pending.length) return "现在没有挂着的提醒。\n\n加一个：#喵呜 提醒 30分钟 该吃药了\n定时：#喵呜 提醒 每天7:30 起床"
  return pending
    .map((r, i) => `${i + 1}. ${fmtAt(r.at, now)}${r.repeat === "daily" ? " 每天" : ""} · ${r.text}${r.id ? `　[${r.id}]` : ""}`)
    .join("\n")
}

/** 到点那句话（角色口吻） */
export function fireText(conf, card, item, now = Date.now()) {
  const late = Math.max(0, Math.floor((now - item.at) / 60000))
  const lateText = late >= 2 ? `（晚了 ${late} 分钟，刚才在忙）` : ""
  if (conf?.clock?.inCharacter === false) {
    return `${lateText}⏰ ${item.text}`
  }
  const n = card?.name || "她"
  return `${lateText}（${n}戳了戳你）…你说的那个，时间到了。${item.text}`
}

export { charLen, sanitizeProfile }
