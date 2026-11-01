/**
 * 喵呜插件 · 入口
 *
 * 一个角色扮演型云崽插件：
 *   - 多后端 API 对话（OpenAI 兼容 / Ollama / Gemini）
 *   - 角色卡（Markdown / 酒馆 V2 JSON / PNG）与人设切换
 *   - 出场人物转换，记忆共享不断档
 *   - 分层记忆 + 上下文压缩
 *   - 世界书关键词注入
 *   - 沉浸强化（防 OOC / 后置指令 / 输出清洗）
 *   - 绘图辅助（新画 / 改图 / 问进度）
 */
import plugin from "../../lib/plugins/plugin.js"
import cfg from "../../lib/config/config.js"
import path from "node:path"
import fs from "node:fs"

import { loadConfig, patchConfig, providerOf, PLUGIN_DIR, DEFAULTS } from "./lib/config.js"
import { chat, ping, LLMError } from "./lib/llm.js"
import { buildMessages, currentCard, cardBlock } from "./lib/persona.js"
import { cleanOutput, detectOOC, looksRepeated, enforceLength } from "./lib/immersion.js"
import * as mem from "./lib/memory.js"
import * as tavern from "./lib/tavern.js"
import { maybeCompress, forceCompress, pressure, contextReport, remindLine, recordUsage, compressMode } from "./lib/compress.js"
import * as clock from "./lib/clock.js"
import * as tts from "./lib/tts.js"
import { probeAll, healthText, autoFix, summaryLine } from "./lib/probe.js"
import { usageOf, fmtUsage } from "./lib/tokens.js"
import {
  listCharacters,
  loadCharacter,
  importCharacter,
  currentCharacter,
  characterDir,
  dropCharacterCache,
} from "./lib/character.js"
import { writeCard, reviseCard, previewOf, cardFileOf } from "./lib/persona-writer.js"
import { buildHelpData, helpImage } from "./lib/helpcard.js"
import * as st from "./lib/st.js"
import { startWebUI } from "./lib/webui.js"
import { dropLoreCache } from "./lib/lorebook.js"
import { sendHuman, readDelay } from "./lib/reply.js"
import { detectDrawIntent, planDraw, planRefine, renderImage, bridgeAlive, listLoras } from "./lib/draw.js"
import { parseToolCalls, runToolCalls } from "./lib/tools.js"
import { listWishes, clearWishes } from "./lib/wish.js"
import * as tavernext from "./lib/tavernext.js"
import * as meme from "./lib/meme.js"
import { sleep, rand, plainText, cut, charLen, ago, pick } from "./lib/util.js"

const TAG = "[喵呜]"

/** 「换」（swipe）的版本历史，按 QQ 存在 hidden 里 */
const SWIPES_KEY = "swipes"

/** 惰性代理：logger 可能比插件初始化得晚，不能直接缓存 */
const log = {
  info: (...a) => (globalThis.logger || console).info?.(...a),
  warn: (...a) => (globalThis.logger || console).warn?.(...a),
  error: (...a) => (globalThis.logger || console).error?.(...a),
  mark: (...a) => (globalThis.logger || console).mark?.(...a),
  debug: (...a) => (globalThis.logger || console).debug?.(...a),
}

/* ============================================================ 运行态 */

/** 每个用户一把锁，防连发串台 */
const locks = new Map()
/** 正在画的图：qq -> { subject, mode, t0 } */
const drawing = new Map()
/** 临时闭嘴 */
let muted = false
/** 启动自检只跑一次（云崽每条消息都 new 一个实例） */
let bootChecked = false
/** 主动发言节流 */
let lastProactive = 0

/* ============================================================ 小工具 */

function isAllowed(e, conf) {
  const qq = String(e.user_id)
  const s = conf.scope || {}
  if ((s.blacklist || []).map(String).includes(qq)) return false
  if (e.isMaster) return true
  // 白名单优先于 masterOnly —— 不然「只服务主人」这个开关会把放进来的人一起挡掉
  if ((s.whitelist || []).map(String).includes(qq)) return true
  if (s.masterOnly !== false) return false
  const wl = (s.whitelist || []).map(String)
  return wl.length === 0 || wl.includes(qq)
}

/** 私聊发口令就能进来 */
function unlockKeyOf(conf) {
  const k = String(conf?.scope?.unlockKey ?? "喵呜").trim()
  return k
}

/** 只有主人能用的命令（改的是全局的东西） */
const ADMIN_ACTS = new Set(
  [
    "重载", "角色", "列表", "出场", "换人", "导入", "人设", "写人设", "造人设", "改人设",
    "状态", "酒馆", "st", "lora", "体检", "自检", "check", "语音", "tts", "主动", "说",
    "测试", "探活", "调试", "关", "开", "密钥", "可用者", "白名单",
    "导出", "存进酒馆", "世界书", "预设", "同场",
  ].map(s => s.toLowerCase())
)

/** 这句话是不是口令本身（「喵呜」「#喵呜」都算，前后空白忽略） */
function isUnlockWord(text, conf) {
  if (conf?.scope?.unlockEnabled === false) return false
  const key = unlockKeyOf(conf)
  if (!key) return false
  const t = String(text || "").replace(/^#/, "").trim()
  return t === key
}

function nickOf(e) {
  return e.sender?.card || e.sender?.nickname || e.nickname || "主人"
}

function masterQQ() {
  const m = cfg.masterQQ || []
  const arr = Array.isArray(m) ? m : [m]
  return arr.filter(Boolean).map(String)
}

/** 取后端：绘图/摘要可能用不同的 */
function provFor(conf, key) {
  const name = key || conf.active
  const p = providerOf(conf, name)
  if (!p) throw new LLMError(`找不到后端 ${name}，检查 config.yaml 的 providers`, name)
  return p
}

/**
 * 按 id 或名字找角色卡。
 * 用户嘴里说的是「栗子」不是「lizi」，所以两种都得认。
 */
function resolveCard(conf, key) {
  const k = String(key || "").trim()
  if (!k) return null
  const direct = loadCharacter(conf, k)
  if (direct) return direct
  const list = listCharacters(conf, true)
  const hit = list.find(c => c.name === k) || list.find(c => c.name.includes(k) || k.includes(c.name))
  return hit ? loadCharacter(conf, hit.id) : null
}

/** 人设提示，给绘图时说的话用 */
function voiceHint(card) {
  const name = card?.name || "她"
  return `说话的是${name}：句子很短（不超过 20 字）、口语化、有点小情绪，可以带一个（）包起来的小动作。不要像客服。`
}

/**
 * 演一场开场白：发出去，并当成她真的说过这句记进上下文。
 *
 * 这一步很关键 —— 只发不记的话，下一句她就"忘了自己刚刚怎么开场的"，
 * 接话会接得很突兀。
 *
 * @returns {Promise<boolean>} 有没有真的发出去
 */
async function playOpening(e, conf, card, { force = false } = {}) {
  const tc = conf.tavern || {}
  if (!force && tc.autoOpening === false) return false

  const raw = tavern.openingFor(card)
  if (!raw) return false

  const qq = String(e.user_id)
  const text = cut(cleanOutput(raw, { name: card?.name }), tc.openingMaxChars ?? 220)
  if (!text) return false

  const [from, to] = tc.openingDelay || [600, 1500]
  await sleep(rand(from, to))
  await sendHuman(m => e.reply(m), text, conf.humanize || {})

  await mem.pushAssistant(conf, qq, text)
  await mem.touchLast(conf, qq)
  log.mark(`${TAG} 开场（${card?.name || "?"}）-> ${text.replace(/\n/g, " / ")}`)
  return true
}

/* ============================================================ 生成一句 */

/**
 * 调模型拿一句回复，带反重复和破戏重试。
 */
async function generate(conf, e, qq, card, userText, mode = "chat", genOpts = {}) {
  const prov = provFor(conf)
  const idle = await mem.idleMinutes(conf, qq)
  const cast = await mem.getCast(conf, qq)

  const { messages, loreHits, systemChars } = await buildMessages(conf, qq, card, userText, {
    nickname: nickOf(e),
    idleMin: idle,
    mode,
    prevCast: cast,
    ...genOpts,
  })

  // 记下这次到底吃了多少窗口 —— 后面提醒、状态、WebUI 都用这个实测值
  const usage = usageOf(conf, prov, messages)
  recordUsage(qq, usage)

  if (conf.debug) {
    log.info(`${TAG} ---- prompt (${prov.__name}/${prov.model}) ${systemChars} 字 system · 上下文 ${fmtUsage(usage)} ----`)
    for (const m of messages) log.info(`${TAG} [${m.role}] ${cut(m.content, 300)}`)
  }

  // 最近几条自己的回复，用来判重
  const ctx = await mem.loadCtx(conf, qq)
  const recentSelf = ctx.filter(m => m.role === "assistant").slice(-3).map(m => m.content)

  let out = ""
  let ooc = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now()
    out = await chat(prov, messages, {
      maxTokens: conf.chat?.maxTokens ?? 400,
      temperature: conf.chat?.temperature ?? 1.0,
      retries: 2,
    })
    out = cleanOutput(out, { name: card?.name })
    out = enforceLength(out, conf.chat?.maxReplyChars ?? 80)

    const rep = conf.immersion?.antiRepeat !== false && looksRepeated(out, recentSelf, conf.immersion?.repeatThreshold ?? 0.85)
    ooc = detectOOC(out)

    log.info(`${TAG} ${prov.__name}/${prov.model} ${Date.now() - t0}ms ${charLen(out)}字${rep ? " [重复]" : ""}${ooc ? " [破戏]" : ""} -> ${out.replace(/\n/g, " / ")}`)

    if (!rep && !ooc) break
    if (attempt === 1) break
    // 重来一次，把问题明说
    messages.push({
      role: "system",
      content: rep
        ? "[你刚才说的和之前几乎一样。换个说法，别重复。]"
        : "[不要跳出角色，不要说自己是AI或助手，用角色身份自然回一句。]",
    })
  }

  if (loreHits.length) log.debug?.(`${TAG} 世界书命中：${loreHits.join(", ")}`)
  return out
}

/* ============================================================ 聊天流程 */

async function respond(conf, e, userText, opts = {}) {
  const qq = String(e.user_id)
  const hz = conf.humanize || {}

  const { card } = await currentCard(conf, qq)
  if (!card) {
    return e.reply(
      `还没装角色卡。\n把角色卡放进：\n${characterDir(conf)}\n支持 .md / .json（酒馆V2）/ .png\n放好后发「#喵呜 角色」看看认出来了没。`,
    )
  }

  // 卡片正则（输入侧）：卡作者定义的用户消息预处理规则
  userText = tavernext.applyRegexRules(card, userText, "input")

  // 这个存档还一句话都没说过 → 先让她自己开口（酒馆的 first_mes）
  if (!opts.noOpening) {
    const hist = await mem.loadCtx(conf, qq)
    if (!hist.length) {
      try {
        await playOpening(e, conf, card)
      } catch (err) {
        log.debug?.(`${TAG} 开场白跳过：${err.message}`)
      }
    }
  }

  await readDelay(hz)

  let out
  try {
    out = await generate(conf, e, qq, card, userText, "chat")
  } catch (err) {
    log.error(`${TAG} 生成失败: ${err.stack || err}`)
    return e.reply(`（卡住了）${String(err.message).slice(0, 100)}`)
  }
  if (!out) return

  await finalizeReply(conf, e, qq, card, userText, out, { drawOnce: opts.drawOnce })

  // 上下文压力：auto 才自动压，remind 只提醒（不阻塞回复）
  pressureSoon(e, conf, qq, card)
}

/**
 * 发送管线：工具标记 → 卡正则 → 变量 → 宏 → 选项 → 表情 → 文字/语音 →
 * 记档 → 工具执行 → （可选）状态栏。
 *
 * respond / 换（swipe）/ 继续（continue）共用这一条链 —— 保证不管从哪个
 * 入口生成的话，处理和记档的方式都一模一样。
 *
 * @returns {Promise<string>} 真正发出去的正文（swipe 版本历史存它）
 */
async function finalizeReply(conf, e, qq, card, userText, rawOut, opts = {}) {
  const hz = conf.humanize || {}
  let out = rawOut

  // 工具标记：模型自己决定画画/发语音。剥掉标记，剩下的当正文发。
  const toolCalls = { calls: [] }
  if (conf.tools?.enabled !== false) {
    const parsed = parseToolCalls(out)
    out = parsed.text
    toolCalls.calls = parsed.calls
    if (!out && parsed.calls.length) {
      // 纯表情包回复（斗图）允许不说话；画画才需要一句过渡
      const imgOnly = parsed.calls.every(c => c.name === "sticker" || c.name === "meme")
      if (!imgOnly) {
        out = parsed.calls.some(c => c.name === "draw" || c.name === "drawRefine") ? "等我一下——" : "…"
      }
    }
  }
  if (!out) return ""

  /* ---- 酒馆助手等价层：卡正则 → 变量 → 宏 → 快捷选项 → 表情 ---- */
  out = tavernext.applyRegexRules(card, out, "output")
  const vt = await tavernext.applyVarTags(conf, qq, out)
  out = vt.text
  if (vt.changed.length) log.mark(`${TAG} 变量更新：${vt.changed.join(" ")}`)
  out = tavernext.expandMacros(out, {
    char: card?.name,
    user: "主人",
    nick: nickOf(e),
    vars: await tavernext.getVars(conf, qq),
  })
  const opt = tavernext.parseOptions(out)
  out = opt.text
  if (opt.options.length) {
    await tavernext.saveOptions(conf, qq, opt.options)
    out = `${out}\n（回复数字 1-${opt.options.length} 选一个）`
  }
  const faceId = tavernext.parseFaceTag(out)
  if (faceId) out = tavernext.stripFaceTag(out)
  // 纯动作回复（只斗图/只甩图不说话）是合法的 —— 有动作就继续往下走
  const hasActions = toolCalls.calls.some(c => c.name !== "voice")
  if (!out && !faceId && !hasActions) return ""
  if (!out && faceId) out = "…"

  /* ---- 发出去：文字 / 语音 ---- */
  const wantsVoice = toolCalls.calls.some(c => c.name === "voice")
  const wouldVoice = !!out && (wantsVoice || tts.shouldVoice(conf, out))
  const keepText = conf.tts?.keepText !== false

  if (out && (!wouldVoice || keepText)) {
    await sleep(Math.max(200, charLen(out) * (hz.typingPerChar ?? 55) * 0.35))
    await sendHuman(msg => e.reply(msg), out, hz)
  }

  if (out && wouldVoice) {
    const v = await tts.tryVoice(conf, out)
    if (v.ok) {
      try {
        const seg = globalThis.segment
        await e.reply(seg?.record ? seg.record(v.file) : v.file)
        log.mark(`${TAG} 语音 ${Math.round(v.ms / 1000)}s · ${Math.round((v.bytes || 0) / 1024)}KB`)
      } catch (err) {
        log.warn(`${TAG} 语音发送失败：${err.message}`)
      }
    } else if (!keepText) {
      // 只发语音模式下合成失败 → 兜底把文字发出来，别让他干等
      await sendHuman(msg => e.reply(msg), out, hz)
    }
  }

  // 表情标记：文字（或语音）之后补一个 QQ 表情
  if (faceId && globalThis.segment?.face) {
    try {
      await e.reply(globalThis.segment.face(faceId))
    } catch (err) {
      log.debug?.(`${TAG} 表情发送失败：${err.message}`)
    }
  }

  // 纯动作回复（只甩图不说话）也要记档，不然下一句她会懵
  await mem.pushCtx(conf, qq, userText, out || "（只回了一张图，没说话）")
  await mem.touchLast(conf, qq)
  await mem.resetNoReply(conf, qq)

  // 工具执行：画画 / 表情包（语音在发送阶段已处理）
  const actionCalls = toolCalls.calls.filter(c => c.name !== "voice")
  if (actionCalls.length && opts.drawOnce) {
    const results = await runToolCalls(
      { e, conf, qq, drawOnce: (subject, dopts) => opts.drawOnce(subject, dopts) },
      actionCalls,
    )
    if (results.length) log.mark(`${TAG} 工具执行：${results.join(" ")}`)
  }

  // 状态栏自动渲染（酒馆助手是每楼都渲染；这里按周期发，autoStatebar: 1 = 每轮）
  const every = Number(conf.tavern?.autoStatebar ?? 0)
  if (every >= 1 && out) {
    try {
      const ctx = await mem.loadCtx(conf, qq)
      const turns = Math.ceil(ctx.length / 2)
      if (turns % every === 0) {
        const html = tavernext.statebarHtml(card, {
          char: card?.name,
          user: "主人",
          nick: nickOf(e),
          vars: await tavernext.getVars(conf, qq),
        })
        if (html) {
          const img = await tavernext.renderStatebar(html)
          if (img) await e.reply(img)
        }
      }
    } catch (err) {
      log.debug?.(`${TAG} 状态栏自动渲染跳过：${err.message}`)
    }
  }

  return out
}

/**
 * 上下文压力检查。
 *
 * 这里刻意不做"无脑自动压缩"：
 * 摘要会把她说话的棱角磨掉，压早了角色就变淡了。
 * 所以默认只提醒，什么时候压由你发命令决定。
 */
const pressureBusy = new Set()
const lastRemindAt = new Map()

function pressureSoon(e, conf, qq, card) {
  const mode = compressMode(conf)
  if (mode === "manual") return
  if (pressureBusy.has(qq)) return
  pressureBusy.add(qq)

  ;(async () => {
    try {
      const prov = provFor(conf, conf.compress?.provider || "")
      const p = await pressure(conf, qq, prov)
      if (p.action === "none") return

      if (p.action === "compress") {
        const r = await maybeCompress(conf, qq, prov, card)
        if (r) log.mark(`${TAG} 自动压缩 ${r.compressed} 轮（mode=auto）`)
        return
      }

      // remind / over：按冷却时间提醒，别每轮都念
      const cd = Number(conf.compress?.remindCooldownMin ?? 30) * 60000
      const last = lastRemindAt.get(qq) || 0
      if (Date.now() - last < cd) return
      lastRemindAt.set(qq, Date.now())

      await sleep(400)
      await e.reply(remindLine(p, card))
      log.mark(`${TAG} 上下文提醒 ${fmtUsage(p.usage)}（${p.turns} 轮）`)
    } catch (err) {
      log.debug?.(`${TAG} 压力检查跳过：${err.message}`)
    } finally {
      pressureBusy.delete(qq)
    }
  })()
}

/* ============================================================ 帮助 */

const HELP = [
  "喵呜 · 命令",
  "",
  "  直接说话就是聊天，说「画个XX」就出图，不用加 #",
  "",
  "【角色】",
  "#喵呜 角色          列出所有角色卡",
  "#喵呜 人设 [id]     看某张卡的全文",
  "#喵呜 出场 <id>     换人出场（自动开场白）",
  "#喵呜 开始 [id]     让她重新开场一次",
  "#喵呜 导入 <路径>   导入角色卡（md/json/png）",
  "#喵呜 写人设 <需求> 让 AI 写一张新卡",
  "#喵呜 改人设 <id> <要求>  让 AI 改现有卡",
  "",
  "【酒馆】",
  "#喵呜 场景 <描述>   设临时场景（「场景 清」清掉）",
  "#喵呜 我是 <人设>   你是谁（「我是 清」清掉）",
  "#喵呜 同场 <id...>  让别的角色也在场",
  "#喵呜 换            同一句话换个说法（换 回/前 翻版本）",
  "#喵呜 继续          让她把没说完的话接着说完",
  "#喵呜 重来          撤回上一轮重说",
  "#喵呜 改 <那句话>   改写她刚说的那句",
  "",
  "【记忆】",
  "#喵呜 存档          看所有存档",
  "#喵呜 切档 <名>     切到另一个存档",
  "#喵呜 新建档 <名>   开一段空的",
  "#喵呜 复制档 <旧> <新>  带着进度开分支",
  "#喵呜 删档 <名>     删掉一个存档",
  "#喵呜 记忆          看记住了什么",
  "#喵呜 上下文        看上下文占了多少（按模型算）",
  "#喵呜 压缩          手动压一次（压完语气会淡一点）",
  "#喵呜 忘 [保留]     清记忆（加「保留」保住个人资料）",
  "",
  "【时钟】",
  "#喵呜 现在          几点、周几、什么节日",
  "#喵呜 提醒 30分钟 吃药   到点她来找你",
  "#喵呜 提醒 每天7:30 起床  每天重复",
  "#喵呜 提醒 列表       看 / 取消 / 清空",
  "",
  "【绘图】",
  "#喵呜 画 <描述>     指定描述出图",
  "#喵呜 lora          列出可用 LoRA",
  "#喵呜 需求          看她提的需求清单（「需求 清」清空）",
  "",
  "【其它】",
  "#喵呜 可用者        看谁能用（加/删/清）",
  "#喵呜 密钥 [新口令]  换别人进来的口令",
  "#喵呜 体检          本地服务挨个探一遍",
  "#喵呜 语音 [开/测试] 语音合成",
  "#喵呜 主动 [开/关]   主动发言的设置",
  "#喵呜 说            立刻让她开口",
  "#喵呜 测试 <话>     跳过上下文直测",
  "#喵呜 探活          测后端连通",
  "#喵呜 调试 [关]     开关 prompt 日志",
  "#喵呜 关 / 开       闭嘴 / 说话",
  "#喵呜 重载          改完配置和角色卡后生效",
]

/* ============================================================ 插件 */

export class MiaoWu extends plugin {
  constructor() {
    super({
      name: "喵呜",
      dsc: "角色扮演型对话：角色卡 / 出场转换 / 分层记忆 / 上下文压缩 / 绘图辅助",
      event: "message",
      // 注意云崽的排序方向：orderBy(priority, "asc")，**数字小的先跑**。
      // 所以要比 whale-girl(5200) 小才能接管私聊；同时又比默认 5000 大，
      // 让常规插件先处理自己的命令。
      // 喵呜返回 false 时 whale-girl 还能兜住，算是软切换。
      priority: 5100,
      rule: [{ reg: "^#?喵呜(\\s|$)", fnc: "cmd" }],
    })

    // 云崽基类会把 task.fnc 当字符串存，loader 却是 i.fnc() 直接调，
    // 所以这里必须重设成真函数（参照 genshin/apps/mysNews.js）
    // 每分钟跑一次：定时提醒要准点，主动发言靠内部节流（cronMin）
    this.task = {
      name: "喵呜-心跳",
      cron: "* * * * *",
      fnc: () => this.tick(),
      log: false,
    }

    // 每条消息都会 new 一次实例，自检必须用模块级标志挡住
    if (!bootChecked) {
      bootChecked = true
      try {
        const c = loadConfig()
        const p = providerOf(c)
        const chars = listCharacters(c)
        const cur = currentCharacter(c)
        globalThis.logger?.mark?.(
          `${TAG} 已加载 · 后端 ${p?.__name || "?"}/${p?.model || "?"} · ` +
            `角色 ${cur?.name || "（无）"} · 卡片 ${chars.length} 张 · ` +
            `绘图${c.draw?.enabled ? "开" : "关"} · 压缩${c.compress?.enabled ? "开" : "关"}`,
        )
      } catch (err) {
        globalThis.logger?.warn?.(`${TAG} 启动自检失败: ${err.message}`)
      }

      // 网页控制台：跟着插件一起起来（端口冲突会自动跳过，不影响机器人）
      try {
        startWebUI()
      } catch (err) {
        globalThis.logger?.warn?.(`${TAG} WebUI 没起来: ${err.message}`)
      }
    }
  }

  /* ---------------------------------------------------------- 拦截 */

  async accept(e) {
    const conf = loadConfig()
    if (!conf.enabled || muted) return false

    const isPrivate = !!e.isPrivate
    const isGroup = !!e.isGroup
    if (isPrivate && conf.scope?.private === false) return false
    if (isGroup && conf.scope?.group === false) return false
    if (!isPrivate && !isGroup) return false

    const text = plainText(e.msg)
    if (!text) return false

    // 口令：换成自定义口令之后，那句话不命中 cmd 的规则，这里兜一下
    if (isPrivate && !e.isMaster && !isAllowed(e, conf) && isUnlockWord(text, conf)) {
      this.doUnlock(e, conf).catch(err => log.error(`${TAG} 口令开门出错：${err.stack || err}`))
      return "return"
    }

    // 前缀交给别的插件
    const prefixes = conf.scope?.ignorePrefix || ["#", "/"]
    if (prefixes.some(p => text.startsWith(p))) return false
    // 自己的命令放行给 rule
    if (/^喵呜(\s|$)/.test(text)) return false
    // 群聊：只有被 @ 才接
    if (isGroup && !e.atme) return false
    if (isGroup) {
      const wl = (conf.scope?.groupWhitelist || []).map(String)
      if (wl.length && !wl.includes(String(e.group_id))) return false
    }
    if (!isAllowed(e, conf)) return false

    const body = isGroup ? text.replace(/^@\S+\s*/, "").trim() : text
    if (!body) return false
    if (charLen(body) > (conf.scope?.maxChars ?? 500)) {
      await e.reply("太长了…说重点。")
      return "return"
    }

    /* ---------------- 快捷选项 ---------------- */
    // 她上一句给了 [[选项:A|B|C]]，用户回数字 → 直接换成对应选项文本进聊天
    {
      const picked = await tavernext.takeOption(conf, String(e.user_id), body)
      if (picked) return this.handleChat(e, picked, conf) && "return"
    }

    /* ---------------- 图片 / 表情包 ---------------- */
    {
      const imgs = (e.message || []).filter(m => m.type === "image" && (m.url || m.file))
      if (imgs.length && conf.meme?.enabled !== false) {
        this.handleMemeImages(e, imgs, conf, body).catch(err => log.error(`${TAG} 表情包识别：${err.stack || err}`))
        return "return"
      }
    }

    /* ---------------- 绘图分流 ---------------- */
    if (conf.draw?.enabled) {
      const qq = String(e.user_id)
      const last = await mem.loadLastPlan(conf, qq)
      const di = detectDrawIntent(body, {
        hasLastPlan: !!last,
        planAgeMs: last ? Date.now() - last.createdAt : 0,
        drawing: drawing.has(qq),
        maxAgeMs: (conf.draw?.lastPlanTtlMin ?? 30) * 60000,
      })

      if (di.isDraw) {
        if (di.mode === "query") {
          this.handleDrawQuery(e, conf, last).catch(err => log.error(`${TAG} handleDrawQuery: ${err.stack || err}`))
        } else {
          this.handleDraw(e, di.subject, conf, {
            mode: di.mode,
            instruction: di.instruction || di.subject,
            prev: last,
          }).catch(err => {
            log.error(`${TAG} handleDraw(${di.mode}): ${err.stack || err}`)
            e.reply(`笔滑了一下…（${String(err.message).slice(0, 140)}）`)
          })
        }
        return "return"
      }
    }

    /* ---------------- 普通聊天 ---------------- */
    this.handleChat(e, body, conf).catch(err => log.error(`${TAG} handleChat: ${err.stack || err}`))
    return "return"
  }

  /* ---------------------------------------------------------- 聊天 */

  async handleChat(e, text, conf, opts = {}) {
    const qq = String(e.user_id)
    // 人开口了，主动发言的"连发计数"清零
    try {
      await mem.resetNoReply(conf, qq)
    } catch {}
    let slot = locks.get(qq)
    if (slot?.busy) {
      slot.queue.push(text)
      return
    }
    slot = { busy: true, queue: [] }
    locks.set(qq, slot)

    try {
      let cur = text
      while (cur) {
        await respond(conf, e, cur, {
          ...opts,
          drawOnce: (subject, dopts) => this.handleDraw(e, subject, conf, dopts),
        })
        cur = slot.queue.shift() || ""
        if (cur) await sleep(rand(200, 600))
      }
    } catch (err) {
      log.error(`${TAG} 处理失败: ${err.stack || err}`)
    } finally {
      slot.busy = false
      locks.delete(qq)
    }
  }

  /* ---------------------------------------------------------- 图片/表情包 */

  /**
   * 他发图了：视觉识别（云端优先，本地兜底）→ 表情包自动收藏 →
   * 把识别结果合成文字进聊天，让她自然接话。
   */
  async handleMemeImages(e, imgs, conf, text) {
    const qq = String(e.user_id)
    const prov = provFor(conf)
    const notes = []

    for (const seg of imgs.slice(0, 2)) {
      try {
        const url = seg.url || seg.file
        if (!/^https?:/i.test(url)) continue
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 30000)
        let r
        try {
          r = await fetch(url, { signal: ctrl.signal })
        } finally {
          clearTimeout(timer)
        }
        if (!r.ok) continue
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length < 1000 || buf.length > 12 * 1024 * 1024) continue
        const mime = r.headers.get("content-type") || "image/png"

        const v = await meme.visionDescribe(conf, buf, mime, prov)
        if (!v) {
          notes.push("[他发了一张图，没看出来是什么]")
          continue
        }
        let collected = ""
        if (v.type === "表情包" && conf.meme?.autoCollect !== false) {
          const r2 = meme.addMeme(conf, buf, { ...v, from: nickOf(e) }, mime)
          if (r2.ok) collected = "，这张已经悄悄收进我的表情包库了"
        }
        if (v.type === "表情包") {
          notes.push(
            `[他甩来一张表情包：${v.caption}（情绪：${v.emotion || "不好说"}）${collected}]` +
            "（这是斗图。你可以接话，也可以只回一张表情包不说话 —— 用 [[发表情:…]]，正文留空即可）",
          )
        } else {
          notes.push(`[他发了一张${v.type === "截图" ? "截图" : "图"}：${v.caption}（情绪：${v.emotion || "不好说"}）${collected}]`)
        }
      } catch (err) {
        log.warn(`${TAG} 图片处理失败：${err.message}`)
      }
    }

    if (!notes.length) {
      return text ? this.handleChat(e, text, conf) : undefined
    }
    const say = [text, ...notes].filter(Boolean).join("\n")
    return this.handleChat(e, say, conf)
  }

  /* ---------------------------------------------------------- 绘图 */

  async handleDraw(e, subject, conf, opts = {}) {
    const qq = String(e.user_id)
    const dc = conf.draw || {}
    const { mode = "new", instruction = "", prev = null } = opts

    const job = drawing.get(qq)
    if (job) {
      return e.reply(`（头也不抬）上一张才画了 ${Math.round((Date.now() - job.t0) / 1000)} 秒…等会儿。`)
    }

    if (!(await bridgeAlive(dc))) {
      return e.reply("画笔找不到…（绘图服务没开，先启动 ComfyUI 那边）")
    }

    const { card } = await currentCard(conf, qq)
    const useRefine = mode === "refine" && !!prev?.positive
    const t0 = Date.now()
    drawing.set(qq, { subject, mode: useRefine ? "refine" : "new", t0 })

    try {
      await sleep(rand(400, 900))
      const prov = provFor(conf, dc.provider || "")
      const hint = voiceHint(card)

      let plan
      if (useRefine) {
        plan = await planRefine(prev, instruction, { prov, drawCfg: dc, personaHint: hint })
        log.mark(`${TAG} 改图方案 [${prov.__name}] ${Date.now() - t0}ms（基于 ${Math.round((Date.now() - prev.createdAt) / 1000)}s 前那张）`)
      } else {
        if (mode === "refine") log.warn(`${TAG} 找不到上一张，按新图处理`)
        plan = await planDraw(subject, { prov, drawCfg: dc, personaHint: hint })
        log.mark(`${TAG} 绘图方案 [${prov.__name}] ${Date.now() - t0}ms`)
      }

      log.info(`${TAG} positive: ${plan.positive.slice(0, 200)}`)
      log.info(`${TAG} ${plan.width}x${plan.height} steps=${plan.steps} cfg=${plan.cfg} lora=${JSON.stringify(plan.lora)}`)

      if (dc.narrate !== false && plan.say) await e.reply(plan.say)

      const { file, ms } = await renderImage(plan, dc)

      const seg = globalThis.segment
      await e.reply(seg?.image ? seg.image(file) : file)

      // subject 只存"这一次要什么"：早先写成 `${prev.subject} → ${instruction}`，
      // 改几次就滚成 "… → 换角度 → 喂"，后面再也读不懂
      await mem.saveLastPlan(conf, qq, plan, useRefine ? instruction : subject)

      if (dc.narrate !== false && plan.after) {
        await sleep(rand(300, 800))
        await e.reply(plan.after)
      }

      const note = useRefine ? `（让你改：${instruction}）` : `画${subject}`
      await mem.pushCtx(conf, qq, note, `${plan.after || "画好了"}（已发出图片）`)
      await mem.touchLast(conf, qq)

      log.mark(`${TAG} 一张图 ${Math.round((Date.now() - t0) / 1000)}s（出图 ${Math.round(ms / 1000)}s）`)
    } finally {
      drawing.delete(qq)
    }
  }

  /**
   * 回答"还有多久"。故意不经过模型 —— 进度必须报真实状态，
   * 让模型自己编就会又出现"已经画好了啊，喏就在这"。
   */
  async handleDrawQuery(e, conf, last) {
    const qq = String(e.user_id)
    const job = drawing.get(qq)
    if (job) {
      const sec = Math.round((Date.now() - job.t0) / 1000)
      return e.reply(`（手上还沾着颜料）${sec} 秒了…再等 ${Math.max(3, 38 - sec)} 秒左右。`)
    }
    if (last?.createdAt) {
      return e.reply(`（指了指屏幕）${ago(last.createdAt)}就画好了啊，往上翻。`)
    }
    return e.reply("画什么？你还没说呢。")
  }

  /* ---------------------------------------------------------- 心跳 */

  /** 每分钟跑一次：先处理定时提醒（要准点），再看要不要主动说话（内部节流） */
  async tick() {
    const conf = loadConfig()
    if (!conf.enabled || muted) return
    try {
      await this.fireReminders(conf)
    } catch (err) {
      log.error(`${TAG} 定时提醒出错：${err.stack || err}`)
    }
    try {
      await this.proactiveTick(conf)
    } catch (err) {
      log.error(`${TAG} 主动发言出错：${err.stack || err}`)
    }
  }

  /** 到点的提醒，用她自己的口吻发出去 */
  async fireReminders(conf) {
    if (conf.clock?.reminds === false) return
    const due = await clock.dueAll(conf)
    if (!due.length) return

    for (const item of due) {
      const qq = String(item.qq)
      try {
        const friend = Bot.pickFriend(Number(qq) || qq)
        if (!friend) {
          log.warn(`${TAG} 提醒发不出去：找不到 ${qq} 的好友`)
          continue
        }
        const { card } = await currentCard(conf, qq)
        const text = clock.fireText(conf, card, item)
        await friend.sendMsg(text)
        // 记进上下文 —— 不然下一句话她会"忘了自己刚提醒过"
        await mem.pushCtx(conf, qq, "", text)
        log.mark(`${TAG} 提醒 -> ${qq}：${item.text}${item.repeat ? "（下次 " + clock.fmtAt(item.at) + "）" : ""}`)
      } catch (err) {
        log.error(`${TAG} 提醒失败(${qq})：${err.message}`)
      }
    }
  }

  /* ---------------------------------------------------------- 主动发言 */

  async proactiveTick(confIn) {
    const conf = confIn || loadConfig()
    const pc = conf.proactive || {}
    if (!pc.enabled) return

    const now = Date.now()
    if (now - lastProactive < (pc.cronMin ?? 40) * 60000) return

    const d = new Date()
    const h = d.getHours()
    const isWeekend = d.getDay() === 0 || d.getDay() === 6

    // 周末可以单独配时段
    const hours = isWeekend && Array.isArray(pc.weekendHours) && pc.weekendHours.length === 2 ? pc.weekendHours : pc.activeHours || [9, 23]
    const [from, to] = hours
    const inWindow = from <= to ? h >= from && h < to : h >= from || h < to
    if (!inWindow) return
    if (pc.nightQuiet !== false && (h >= 23 || h < 7)) return

    lastProactive = now

    for (const qq of masterQQ()) {
      try {
        const idle = await mem.idleMinutes(conf, qq)
        if (idle < (pc.minIdleMin ?? 120)) continue
        if (idle > (pc.maxIdleMin ?? 720)) continue
        if ((await mem.getProactiveCount(conf, qq)) >= (pc.maxPerDay ?? 3)) continue

        // 连着发了好几条都没人理 → 停下来等他先开口
        const noReply = await mem.getNoReply(conf, qq)
        if (Number(pc.maxNoReply) > 0 && noReply >= Number(pc.maxNoReply)) continue

        if (Math.random() > (pc.chance ?? 0.45)) continue

        const { card } = await currentCard(conf, qq)
        if (!card) continue

        const friend = Bot.pickFriend(Number(qq) || qq)
        if (!friend) continue

        const fakeE = { user_id: qq, isPrivate: true, isMaster: true, sender: { nickname: "主人" }, reply: m => friend.sendMsg(m) }
        const out = await generate(conf, fakeE, qq, card, "", "proactive")
        if (!out) continue

        await sleep(rand(500, 1500))
        await sendHuman(m => friend.sendMsg(m), out, conf.humanize || {})
        await mem.pushCtx(conf, qq, "", out)
        await mem.incProactiveCount(conf, qq)
        const n = await mem.bumpNoReply(conf, qq)
        log.mark(`${TAG} 主动 -> ${qq}: ${out.replace(/\n/g, " / ")}${n > 1 ? `（连续 ${n} 条没回）` : ""}`)
      } catch (err) {
        log.error(`${TAG} 主动发言失败(${qq}): ${err.message}`)
      }
    }
  }

  /* ---------------------------------------------------------- 命令 */

  /* ---------------------------------------------------------- 口令开门 */

  /**
   * 陌生人私聊发了口令。
   * 写进 scope.whitelist 并落盘 —— 重启/重载都不会丢。
   */
  async doUnlock(e, conf) {
    const qq = String(e.user_id)
    const scope = conf.scope || {}
    const wl = (scope.whitelist || []).map(String)

    if ((scope.blacklist || []).map(String).includes(qq)) {
      log.mark(`${TAG} 黑名单里的 ${qq} 想用口令进来，没门`)
      return false
    }
    if (wl.includes(qq)) return false

    const max = Number(scope.maxUsers ?? 20)
    if (wl.length >= max) {
      await e.reply("（摇头）…我记不住这么多人了。让主人先清一清。")
      log.warn(`${TAG} 口令开门失败：白名单已满 ${wl.length}/${max}`)
      return "return"
    }

    const next = [...wl, qq]
    try {
      const p = patchConfig({ scope: { ...scope, whitelist: next } })
      loadConfig(true)
      log.mark(`${TAG} 口令开门：${qq}（${nickOf(e)}）→ 白名单 ${p?.scope?.whitelist?.length ?? next.length} 人`)
    } catch (err) {
      log.error(`${TAG} 写白名单失败：${err.message}`)
      await e.reply("（小声）门锁卡住了…你跟主人说一声吧。")
      return "return"
    }

    await e.reply(
      [
        `（从水里探出半个头）…哦，是${nickOf(e)}啊。`,
        "记住了。要聊天直接说话就行；想看我画画，说「画个……」或者「改成……」。",
      ].join("\n"),
    )

    // 给主人报一声，别让人偷偷溜进来
    if (conf.scope?.unlockNotify !== false) {
      const m = masterQQ()[0]
      if (m) {
        Bot.pickFriend(Number(m) || m)
          ?.sendMsg?.(`[喵呜] ${nickOf(e)}（${qq}）用口令进来了。\n不想留就发「#喵呜 可用者 删 ${qq}」`)
          ?.catch?.(() => {})
      }
    }
    return "return"
  }

  async cmd(e) {
    const conf = loadConfig()
    const raw = plainText(e.msg)
    const sub = raw.replace(/^#?喵呜\s*/, "").trim()

    const qq = String(e.user_id)
    const allowed = e.isMaster || isAllowed(e, conf)

    /*
     * 陌生人：私聊发口令就放进来，别的一律不接。
     * 不接的时候故意不回话 —— 回了反而是给刷屏的人一个"这号活着"的反馈。
     */
    if (!allowed) {
      if (e.isPrivate && isUnlockWord(raw, conf)) return this.doUnlock(e, conf)
      log.mark(`${TAG} 忽略 ${e.isPrivate ? "私聊" : "群聊"} ${qq}（不在名单里）：${String(raw).slice(0, 20)}`)
      return false
    }

    if (!sub) {
      return e.isMaster
        ? this.showStatus(e, conf)
        : e.reply("在。想聊天直接说话就行，想看我画画就说「画个……」")
    }
    if (/^(帮助|help|\?|？)$/i.test(sub)) return this.showHelp(e, conf)

    const [act, ...rest] = sub.split(/\s+/)
    const arg = rest.join(" ").trim()

    // 全局性的开关只留给主人 —— 放进来的人能聊天、能画画，但不能改大家的人设
    if (!e.isMaster && ADMIN_ACTS.has(act.toLowerCase())) {
      return e.reply("这个只有主人能动。你找他说去。")
    }

    switch (act) {
      case "状态":
        return this.showStatus(e, conf)

      case "状态栏": {
        const { card } = await currentCard(conf, qq)
        const html = tavernext.statebarHtml(card, {
          char: card?.name,
          user: "主人",
          nick: nickOf(e),
          vars: await tavernext.getVars(conf, qq),
        })
        if (!html) {
          return e.reply(
            "这张卡没写状态栏。\n卡作者在 front-matter 里加：\nstatebar: |\n  <div>…HTML…</div>\n就能用图片看状态了（{{var:名字}} 会取变量值）。",
          )
        }
        const img = await tavernext.renderStatebar(html)
        if (!img) return e.reply("状态栏渲染失败（渲染器没起？文字状态发「#喵呜 状态」）")
        return e.reply(img)
      }

      case "表情包": {
        if (!arg) {
          const list = meme.listMemes(conf)
          if (!list.length) {
            return e.reply("表情包库还是空的。\n多发点斗图给我，我看着顺眼的会自己收。\n做一张：#喵呜 表情包 做 顶部文字|底部文字")
          }
          const head = `库里 ${list.length} 张（最近 15 张）：`
          const lines = list.slice(-15).map((m, i) => `${list.length - Math.min(15, list.length) + i + 1}. [${m.emotion || "?"}] ${m.caption || m.id}`)
          return e.reply(
            [head, ...lines, "", "做一张：#喵呜 表情包 做 顶部文字|底部文字", e.isMaster ? "删：#喵呜 表情包 删 <编号>" : ""].filter(Boolean).join("\n"),
          )
        }
        const m = arg.match(/^(删|做)\s*([\s\S]+)$/)
        if (!m) return e.reply("用法：#喵呜 表情包 做 顶部|底部 · #喵呜 表情包 删 <编号>")
        const [, op, rest] = m
        if (op === "做") {
          const [top, bottom] = rest.split(/[|｜]/).map(s => s.trim())
          const base = meme.latestBaseImage(conf)
          if (!base) return e.reply("还没有底图 —— 先让我画一张，或者发张图给我。")
          const img = await meme.renderMeme(`file:///${base.replace(/\\/g, "/")}`, top, bottom)
          if (!img) return e.reply("配字失败了…（渲染器没起？）")
          return e.reply(img)
        }
        if (!e.isMaster) return e.reply("删图只有主人能来。")
        const n = Number(rest.trim())
        const list = meme.listMemes(conf)
        const target = list[n - 1] || list.find(x => x.id.startsWith(rest.trim()))
        if (!target) return e.reply(`没找到第 ${rest.trim()} 张。列表序号见 #喵呜 表情包`)
        meme.removeMeme(conf, target.id)
        return e.reply(`删掉了：${target.caption || target.id}`)
      }

      case "可用者":
      case "白名单": {
        const sc = loadConfig().scope || {}
        const wl = (sc.whitelist || []).map(String)
        const masters = masterQQ()
        const key = unlockKeyOf(loadConfig())
        const open = sc.unlockEnabled !== false

        if (!arg) {
          const body = [
            `主人：${masters.join(" / ") || "（没配）"}`,
            `可用者：${wl.length ? wl.map((q, i) => `\n  ${i + 1}. ${q}`).join("") : "（空）"}`,
            `口令：${open ? `私聊发「${key}」自动进来` : "已关闭（scope.unlockEnabled: false）"}`,
            "",
            "加人：#喵呜 可用者 加 123456",
            "踢人：#喵呜 可用者 删 123456",
            "清空：#喵呜 可用者 清",
            `换口令：#喵呜 密钥 新口令`,
          ]
          return e.reply(body.join("\n"))
        }

        const m = arg.match(/^(加|添加|删|删除|踢|清|清空)\s*(\d{5,12})?$/)
        if (!m) return e.reply("用法：#喵呜 可用者 加/删 <QQ> · #喵呜 可用者 清")
        const [, op, target] = m
        let next = [...wl]

        if (/清/.test(op)) {
          if (!wl.length) return e.reply("本来就是空的。")
          next = []
        } else if (/加|添加/.test(op)) {
          if (!target) return e.reply("要加谁？带上 QQ 号。")
          if (masters.includes(target)) return e.reply("那是主人，本来就不用加。")
          if (next.includes(target)) return e.reply(`${target} 已经在名单里了。`)
          if (next.length >= Number(sc.maxUsers ?? 20)) return e.reply(`名单满了（${next.length}）。先删几个。`)
          next.push(target)
        } else {
          if (!target) return e.reply("要删谁？带上 QQ 号。")
          if (!next.includes(target)) return e.reply(`${target} 本来就不在名单里。`)
          next = next.filter(q => q !== target)
        }

        patchConfig({ scope: { ...sc, whitelist: next } })
        loadConfig(true)
        log.mark(`${TAG} 白名单 ${op} ${target || ""} → 现在 ${next.length} 人`)
        return e.reply(
          next.length
            ? `好了。现在能用的：\n${next.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
            : "名单清空了。现在只服务主人。",
        )
      }

      case "密钥":
      case "口令": {
        const sc = loadConfig().scope || {}
        const cur = unlockKeyOf(loadConfig())
        if (!arg) {
          return e.reply(
            [
              `当前口令：「${cur}」`,
              sc.unlockEnabled === false ? "（现在是关着的，发什么都进不来）" : "别人私聊发这两个字就能进来。",
              "",
              "换一个：#喵呜 密钥 新口令",
              "关掉它：#喵呜 密钥 关",
            ].join("\n"),
          )
        }
        if (/^(关|关闭|off)$/i.test(arg)) {
          patchConfig({ scope: { ...sc, unlockEnabled: false } })
          loadConfig(true)
          return e.reply("口令关门了。以后只能你手动加人。")
        }
        const key = arg.replace(/\s+/g, "").slice(0, 12)
        if ([...key].length < 2) return e.reply("口令太短了，两个字以上。")
        patchConfig({ scope: { ...sc, unlockEnabled: true, unlockKey: key } })
        loadConfig(true)
        log.mark(`${TAG} 口令改成「${key}」`)
        return e.reply(`行。以后别人私聊发「${key}」就能进来。`)
      }

      case "重载": {
        loadConfig(true)
        dropCharacterCache()
        dropLoreCache()
        const c2 = loadConfig()
        const p = providerOf(c2)
        const cur = currentCharacter(c2)
        return e.reply(`重载完成。\n后端：${p?.__name} / ${p?.model}\n角色：${cur?.name || "（无）"}\n卡片：${listCharacters(c2, true).length} 张`)
      }

      case "角色":
      case "列表": {
        const list = listCharacters(conf, true)
        if (!list.length) {
          return e.reply(`一张角色卡都没有。\n把卡放进：\n${characterDir(conf)}\n支持 .md / .json（酒馆V2）/ .png`)
        }
        const { card: cur } = await currentCard(conf, qq)
        const body = list.map((c, i) => `${c.id === cur?.id ? "▸" : " "} ${i + 1}. ${c.name}（${c.id}）· ${c.format}`).join("\n")
        return e.reply(`共 ${list.length} 张角色卡：\n\n${body}\n\n发「#喵呜 出场 <id>」切换`).catch(() => e.reply(`共 ${list.length} 张`))
      }

      case "出场":
      case "换人": {
        if (!arg) {
          const list = listCharacters(conf).map(c => c.id)
          return e.reply(`用法：#喵呜 出场 鲸鱼娘\n可选：${list.join(" / ") || "（还没装角色卡）"}`)
        }
        const card = resolveCard(conf, arg)
        if (!card) return e.reply(`没有「${arg}」这张卡。发「#喵呜 角色」看列表`)
        const allowed = (conf.cast?.allowed || []).map(String)
        if (allowed.length && !allowed.includes(card.id)) {
          return e.reply(`「${card.name}」不在允许名单里。可选：${allowed.join(" / ")}`)
        }

        const prev = await mem.getCast(conf, qq)
        await mem.setCast(conf, qq, card.id, card.name)
        patchConfig({ cast: { ...(conf.cast || {}), default: card.id } })

        const lines = [`换人了：现在是「${card.name}」`]
        if (prev?.current && prev.current !== card.id) lines.push(`（刚才还是「${prev.name || prev.current}」）`)
        if (conf.cast?.handover !== false) lines.push("记忆是接着的，她知道刚才聊到哪。")
        await e.reply(lines.join("\n"))

        // 换人立刻演一场她的开场白（酒馆的 first_mes / alternate_greetings）
        if (conf.tavern?.openingOnSwitch !== false) {
          const ok = await playOpening(e, loadConfig(), card, { force: true })
          if (!ok) await e.reply(`（「${card.name}」这张卡没写开场白）`)
        }
        return
      }

      case "导入": {
        if (!arg) return e.reply("用法：#喵呜 导入 C:\\path\\to\\card.png（只认机器人本机路径）")
        const r = importCharacter(conf, arg.replace(/^["'「]|["'」]$/g, ""))
        if (!r.ok) return e.reply(`导入失败：${r.msg}`)
        return e.reply(`${r.msg}\nid：${r.id}\n发「#喵呜 出场 ${r.id}」让她出场`)
      }

      /* ------------------------------------------------ 酒馆 */

      case "开始":
      case "开场": {
        const card = arg ? resolveCard(conf, arg) : (await currentCard(conf, qq)).card
        if (!card) return e.reply(arg ? `没有「${arg}」这张卡。发「#喵呜 角色」看列表` : "还没装角色卡")
        if (arg) {
          await mem.setCast(conf, qq, card.id, card.name)
          patchConfig({ cast: { ...(conf.cast || {}), default: card.id } })
        }
        const ok = await playOpening(e, conf, card, { force: true })
        if (!ok) {
          return e.reply(`「${card.name}」这张卡没写开场白。\n想加就发「#喵呜 改人设 ${card.id} 补两条开场白」`)
        }
        return
      }

      case "场景": {
        if (!arg) {
          const s = await tavern.getScene(conf, qq)
          return e.reply(
            s
              ? `现在的场景：\n${s}\n\n改：#喵呜 场景 下雨的傍晚，便利店门口\n清：#喵呜 场景 清`
              : "没设场景。发「#喵呜 场景 下雨的傍晚，便利店门口」试试 —— 这句会一直生效，直到你换掉。",
          )
        }
        if (/^(清|清掉|取消|关|无|空)$/.test(arg)) {
          await tavern.clearScene(conf, qq)
          return e.reply("场景清掉了，回到角色卡里的常驻设定。")
        }
        await tavern.setScene(conf, qq, arg)
        return e.reply(`场景定在：${cut(arg, 80)}\n（一直有效，直到你换掉或清掉）`)
      }

      case "我是": {
        if (!arg) {
          const u = await tavern.getUserPersona(conf, qq)
          return e.reply(
            u
              ? `你现在的人设：\n${u}\n\n改：#喵呜 我是 他的同事，25岁，话很少\n清：#喵呜 我是 清`
              : "没说你是谁。发「#喵呜 我是 他的同事，25岁，话很少」—— 她会按这个身份看你。",
          )
        }
        if (/^(清|清掉|取消|关|无|空)$/.test(arg)) {
          await tavern.clearUserPersona(conf, qq)
          return e.reply("你的人设清掉了，她按默认的「主人」看你。")
        }
        await tavern.setUserPersona(conf, qq, arg)
        return e.reply(`记住了：她以后按「${cut(arg, 60)}」这个身份看你。`)
      }

      case "同场": {
        const cur = await tavern.getCameo(conf, qq)
        if (!arg) {
          if (!cur.length) {
            return e.reply("现在就她一个人。\n想加别人在场：#喵呜 同场 栗子\n清掉：#喵呜 同场 清")
          }
          const names = cur.map(id => loadCharacter(conf, id)?.name || id)
          return e.reply(`现在在场：${names.join("、")}\n\n改：#喵呜 同场 栗子 樱花\n清：#喵呜 同场 清`)
        }
        if (/^(清|清掉|取消|关|无|空)$/.test(arg)) {
          await tavern.clearCameo(conf, qq)
          return e.reply("其他人退场了，只剩她。")
        }
        const ids = arg
          .split(/[,，、\s]+/)
          .map(s => s.trim())
          .filter(Boolean)
        const cards = ids.map(id => resolveCard(conf, id))
        const bad = ids.filter((id, i) => !cards[i])
        if (bad.length) return e.reply(`没有这些卡：${bad.join(" / ")}\n发「#喵呜 角色」看 id`)
        // 存 id，不存用户输入的名字 —— 后面 assemble 时是按 id 查卡的
        await tavern.setCameo(conf, qq, cards.map(c => c.id))
        const names = cards.map(c => c.name)
        return e.reply(`${names.join("、")} 也进场了。\n（她说话时会把这几个人当在场的人，但不会替她们长篇代述）`)
      }

      /* ------------------------------------------------ 人设 */

      case "人设": {
        const card = arg ? resolveCard(conf, arg) : (await currentCard(conf, qq)).card
        if (!card) return e.reply(arg ? `没有「${arg}」这张卡` : "还没装角色卡")
        const src = card.file && /\.(md|markdown)$/i.test(card.file) ? fs.readFileSync(card.file, "utf-8") : cardBlock(card)
        const head = [
          `「${card.name}」（${card.id}）· ${card.format} · ${charLen(src)} 字`,
          card.meta?.inheritedFrom?.length ? `继承：${card.meta.inheritedFrom.join(" → ")} → 本卡` : "",
          `文件：${card.file ? path.relative(PLUGIN_DIR, card.file) : "?"}`,
          "",
        ].filter(Boolean)
        return e.reply(head.join("\n") + cut(src, 1200))
      }

      case "写人设":
      case "造人设": {
        if (!arg) {
          return e.reply(
            "用法：#喵呜 写人设 一个怕打雷的猫娘，嘴硬心软\n" +
              "　　　#喵呜 写人设 叫小满，修自行车的女孩，说话很冲\n" +
              "\n它会写成一张完整的卡（含 12~15 条示例对话），不满意还能「改人设」。",
          )
        }
        await e.reply("（咬着笔帽翻本子）等我一会儿…这个要写挺久的。")
        const t0 = Date.now()
        const r = await writeCard(arg, { prov: provFor(conf, conf.cast?.writerProvider || ""), conf })
        if (!r.ok) return e.reply(`没写成：${r.msg}`)
        return e.reply(
          [
            `「${r.card.name}」写好了（${r.id}）· ${Math.round((Date.now() - t0) / 1000)}s${r.existed ? " · 覆盖了同名旧卡" : ""}`,
            "",
            previewOf(r.markdown, 700),
            "",
            `不满意：#喵呜 改人设 ${r.id} 说话再懒一点`,
            `满意了：#喵呜 出场 ${r.id}`,
          ].join("\n"),
        )
      }

      case "改人设": {
        const m = arg.match(/^(\S+)\s+([\s\S]+)$/)
        if (!m) return e.reply("用法：#喵呜 改人设 栗子 说话再懒一点，少用感叹号")
        const [, key, instruction] = m
        const target = resolveCard(conf, key)
        const id = target?.id || key
        if (!cardFileOf(conf, id)) return e.reply(`找不到角色卡「${key}」。发「#喵呜 角色」看 id`)
        await e.reply("（翻出那张卡，改…）")
        const r = await reviseCard(id, instruction, { prov: provFor(conf, conf.cast?.writerProvider || ""), conf })
        if (!r.ok) return e.reply(`没改成：${r.msg}`)
        return e.reply(`${r.msg}\n\n${previewOf(r.markdown, 500)}\n\n生效要发「#喵呜 重载」`)
      }

      /* ------------------------------------------------ 存档 */

      case "存档":
      case "存档列表": {
        const now = await mem.getProfile(conf, qq)
        const list = await mem.listProfiles(conf, qq)
        const body = list.map(p => `${p === now ? "▸" : "  "} ${p}`).join("\n")
        return e.reply(
          [
            `当前存档：${now}`,
            "",
            body,
            "",
            "切档：#喵呜 切档 工作",
            "新建：#喵呜 新建档 工作（空的开一段）",
            "复制：#喵呜 复制档 default 分支二（带上当前进度开分支）",
            "删除：#喵呜 删档 分支二",
          ].join("\n"),
        )
      }

      case "切档":
      case "换档": {
        if (!arg) return e.reply("用法：#喵呜 切档 工作（发「#喵呜 存档」看有哪些）")
        const name = mem.sanitizeProfile(arg)
        const list = await mem.listProfiles(conf, qq)
        const now = await mem.getProfile(conf, qq)
        if (now === name) return e.reply(`已经在「${name}」了。`)

        await mem.setProfile(conf, qq, name)
        const ctx = await mem.loadCtx(conf, qq)
        const sum = await mem.getSummary(conf, qq)
        return e.reply(
          [
            `切到存档「${name}」${list.includes(name) ? "" : "（新建的，空的）"}`,
            `记忆：${Math.floor(ctx.length / 2)} 轮${sum.text ? ` + 摘要 ${charLen(sum.text)} 字` : ""}`,
            "角色卡和场景也跟着这个存档走，互不干扰。",
          ].join("\n"),
        )
      }

      case "新建档":
      case "新档": {
        if (!arg) return e.reply("用法：#喵呜 新建档 工作\n（想要带着当前进度开分支，用「#喵呜 复制档」）")
        const name = mem.sanitizeProfile(arg)
        const list = await mem.listProfiles(conf, qq)
        if (list.includes(name)) return e.reply(`「${name}」已经存在了。切过去发「#喵呜 切档 ${name}」，想覆盖就「#喵呜 复制档 <源> ${name}」`)
        await mem.setProfile(conf, qq, name)
        return e.reply(`建好并切到「${name}」了。这是空存档，她什么都不记得。`)
      }

      case "复制档": {
        const [from, to] = arg.split(/\s+/)
        if (!from || !to) return e.reply("用法：#喵呜 复制档 default 分支二")
        const r = await mem.copyProfile(conf, qq, from, to)
        if (!r.ok) return e.reply(r.msg)
        const name = mem.sanitizeProfile(to)
        await mem.setProfile(conf, qq, name)
        return e.reply(`${r.msg}\n现在已经切到「${name}」，接着玩不会影响原存档。`)
      }

      case "删档": {
        if (!arg) return e.reply("用法：#喵呜 删档 分支二")
        const r = await mem.deleteProfile(conf, qq, arg)
        return e.reply(r.msg)
      }

      /* ------------------------------------------------ 改口 */

      case "重来":
      case "撤回": {
        const ctx = await mem.loadCtx(conf, qq)
        if (!ctx.length) return e.reply("还没聊过呢，撤什么。")
        const lastUser = await mem.lastUserText(conf, qq)
        const n = ctx[ctx.length - 1].role === "assistant" ? 2 : 1
        await mem.popLast(conf, qq, n)
        if (!lastUser) return e.reply("上一句不是你说的，不知道重来哪句。")
        await e.reply(`（把刚才那句咽回去）…重来：「${cut(lastUser, 40)}」`)
        return this.handleChat(e, lastUser, conf, { noOpening: true })
      }

      case "改": {
        if (!arg) return e.reply("用法：#喵呜 改 <你想让她刚说的那句>")
        const ok = await mem.setLastAssistant(conf, qq, arg)
        if (!ok) return e.reply("还没有能改的回复。")
        return e.reply(`（记下了）刚才那句就当是：「${cut(arg, 60)}」`)
      }

      /* 换 = 酒馆的 Swipe：同一条消息换个说法，版本都留着可以翻回去 */
      case "换":
      case "swipe": {
        const sub = arg.trim()
        const raw = await mem.getHidden(conf, qq, SWIPES_KEY)
        let sw = (() => { try { return JSON.parse(raw) || null } catch { return null } })()

        // 翻版本：换 回 / 换 前 / 换 <数字>
        if (/^(回|上一版?|back)$/i.test(sub) || /^(前|下一版?|next)$/i.test(sub) || /^\d+$/.test(sub)) {
          if (!sw || !sw.versions?.length) return e.reply("还没有版本记录。先用「#喵呜 换」生成一版。")
          const back = /^(回|上一版?|back)$/i.test(sub)
          const fwd = /^(前|下一版?|next)$/i.test(sub)
          let idx = sw.active ?? sw.versions.length - 1
          if (back) idx--
          else if (fwd) idx++
          else idx = Number(sub) - 1
          if (idx < 0) return e.reply("已经是第一版了。")
          if (idx >= sw.versions.length) return e.reply(`只有 ${sw.versions.length} 版。想再来一版就发「#喵呜 换」。`)
          sw.active = idx
          await mem.setHidden(conf, qq, SWIPES_KEY, JSON.stringify(sw))
          await mem.setLastAssistant(conf, qq, sw.versions[idx])
          return sendHuman(m => e.reply(m), sw.versions[idx], conf.humanize || {})
        }

        // 生成新版：撤掉最后一条回复，同 context 重新生成
        const ctx = await mem.loadCtx(conf, qq)
        const lastMsg = ctx[ctx.length - 1]
        if (!lastMsg || lastMsg.role !== "assistant") return e.reply("我还没回话呢，换什么。")
        if (!sw || sw.versions?.[sw.active] !== lastMsg.content) {
          // 上下文已经变了 / 第一次换 → 从当前这句开始记版本
          sw = { versions: [lastMsg.content], active: 0, userText: await mem.lastUserText(conf, qq) }
        }
        const userText = sw.userText || (await mem.lastUserText(conf, qq))
        if (!userText) return e.reply("找不到你上一句说的什么，换不了。")
        const { card: swCard } = await currentCard(conf, qq)
        if (!swCard) return e.reply("没装角色卡。")
        await mem.popLast(conf, qq, 1)
        let swOut
        try {
          swOut = await generate(conf, e, qq, swCard, userText, "chat")
        } catch (err) {
          log.error(`${TAG} 换一版失败: ${err.stack || err}`)
          return e.reply(`（卡住了）${String(err.message).slice(0, 100)}`)
        }
        if (!swOut) return e.reply("（这版没想好怎么说，再试一次吧）")
        const finalOut = await finalizeReply(conf, e, qq, swCard, userText, swOut, {
          drawOnce: subject => this.handleDraw(e, subject, conf, { mode: "new" }),
        })
        if (finalOut && finalOut !== sw.versions[sw.versions.length - 1]) {
          sw.versions.push(finalOut)
          sw.active = sw.versions.length - 1
          await mem.setHidden(conf, qq, SWIPES_KEY, JSON.stringify(sw))
        }
        return
      }

      /* 继续 = 酒馆的 Continue：把没说完的话接着说完 */
      case "继续":
      case "续": {
        const ctx = await mem.loadCtx(conf, qq)
        const lastMsg = ctx[ctx.length - 1]
        if (!lastMsg) return e.reply("还没聊过呢，续什么。")
        if (lastMsg.role !== "assistant") return e.reply("该你先说了，我再接着说。")
        const lastText = lastMsg.content
        if (/（只回了一张图/.test(lastText)) return e.reply("刚才只发了图，没话可续。")
        const { card: ctCard } = await currentCard(conf, qq)
        if (!ctCard) return e.reply("没装角色卡。")
        await mem.popLast(conf, qq, 1)
        let ctOut
        try {
          ctOut = await generate(conf, e, qq, ctCard, "", "continue", { continueText: lastText })
        } catch (err) {
          log.error(`${TAG} 继续失败: ${err.stack || err}`)
          return e.reply(`（卡住了）${String(err.message).slice(0, 100)}`)
        }
        if (!ctOut) return e.reply("（接不上…再说一次？）")
        // 接在原话后面，记档存合并后的完整一条
        await finalizeReply(conf, e, qq, ctCard, "", lastText + ctOut, {
          drawOnce: subject => this.handleDraw(e, subject, conf, { mode: "new" }),
        })
        return
      }

      case "记忆": {
        const [sum, eps, facts] = await Promise.all([
          mem.getSummary(conf, qq),
          mem.listEpisodes(conf, qq),
          mem.listFacts(conf, qq),
        ])
        const ctx = await mem.loadCtx(conf, qq)
        const lines = [
          `工作记忆：${Math.floor(ctx.length / 2)} 轮`,
          `摘要：${sum.text ? `${charLen(sum.text)} 字（已压 ${sum.turns} 轮）` : "无"}`,
          `事件：${eps.length} 条`,
          `关于你：${Object.keys(facts).length} 项`,
        ]
        if (sum.text) lines.push("", "—— 摘要 ——", cut(sum.text, 400))
        if (eps.length) {
          lines.push("", "—— 最近事件 ——")
          for (const it of eps.slice(-6)) lines.push(`· ${cut(it.text, 60)}`)
        }
        return e.reply(lines.join("\n"))
      }

      case "上下文":
      case "context":
      case "token": {
        const p = provFor(conf, conf.compress?.provider || "")
        return e.reply(await contextReport(conf, qq, p, { systemChars: 1500 }))
      }

      case "压缩": {
        const { card } = await currentCard(conf, qq)
        const p = provFor(conf, conf.compress?.provider || "")
        await e.reply(
          arg === "看"
            ? await contextReport(conf, qq, p, { systemChars: 1500 })
            : "（闭眼想了想，把最前面的事折起来…）",
        )
        if (arg === "看") return
        const r = await forceCompress(conf, qq, p, card)
        return e.reply(r.ok ? `压好了。${r.msg}\n\n（压完语气可能会淡一点，这是有损压缩的代价。发「#喵呜 上下文」看剩下多少。）` : `没压：${r.msg}`)
      }

      /* ------------------------------------------------ 时钟 / 提醒 */

      case "现在":
      case "几点":
      case "时间":
      case "时钟": {
        const list = (await clock.listReminders(conf, qq)).filter(r => !r.done)
        const fest = clock.festivalOf(new Date())
        const h = new Date().getHours()
        return e.reply(
          [
            clock.clockText(conf),
            fest ? `今天是${fest}` : "",
            `时段：${clock.dayPart(h)}${h >= 23 || h < 5 ? "（她这个点该困了）" : ""}`,
            "",
            list.length ? `挂着的提醒：${list.length} 个` : "没挂提醒",
            ...list.slice(0, 5).map((r, i) => `${i + 1}. ${clock.fmtAt(r.at)} · ${r.text}`),
            "",
            "加：#喵呜 提醒 30分钟 该吃药了",
            "看全部：#喵呜 提醒 列表",
          ]
            .filter(Boolean)
            .join("\n"),
        )
      }

      case "提醒":
      case "闹钟":
      case "计时": {
        const sub = arg.trim()
        if (!sub || /^(列表|list|查看|全部)$/.test(sub)) {
          const list = await clock.listReminders(conf, qq)
          return e.reply(
            `现在挂着的：\n\n${clock.renderList(conf, list)}\n\n` +
              "加：#喵呜 提醒 30分钟 该吃药了\n" +
              "定时：#喵呜 提醒 20:30 开会\n" +
              "每天：#喵呜 提醒 每天7:30 叫我\n" +
              "取消：#喵呜 提醒 取消 1（或编号后的那串字母）\n" +
              "全清：#喵呜 提醒 清",
          )
        }
        if (/^(清|清空|全清|取消全部)$/.test(sub)) {
          const r = await clock.clearReminders(conf, qq)
          return e.reply(r.msg)
        }
        if (/^(取消|删|删除|撤回)/.test(sub)) {
          const id = sub.replace(/^(取消|删|删除|撤回)\s*/, "").trim()
          const r = await clock.cancelReminder(conf, qq, id)
          return e.reply(r.msg)
        }

        const w = clock.parseWhen(sub)
        if (!w.ok) {
          return e.reply(
            `时间没认出来（${w.msg}）。\n\n` +
              "#喵呜 提醒 30分钟 该吃药了\n" +
              "#喵呜 提醒 2小时 关火\n" +
              "#喵呜 提醒 20:30 开会\n" +
              "#喵呜 提醒 明天8点 起床\n" +
              "#喵呜 提醒 每天7:30 叫我起来",
          )
        }
        if (!w.rest) return e.reply("时间有了，但没说提醒什么。例：#喵呜 提醒 30分钟 该吃药了")

        const r = await clock.addReminder(conf, qq, {
          at: w.at,
          text: w.rest,
          repeat: w.repeat,
          h: w.h,
          m: w.m,
          raw: sub,
        })
        return e.reply(r.msg + (r.ok ? "\n\n到点她会自己来找你说话。" : ""))
      }

      case "忘":
      case "忘记": {
        const keepFacts = /保留/.test(arg)
        await mem.forgetAll(conf, qq, { keepFacts })
        return e.reply(keepFacts ? "对话和事件清了，关于你的资料留着。" : "全清了。…刚才说什么来着？")
      }

      case "画":
      case "绘图": {
        if (!arg) return e.reply("用法：#喵呜 画 蓝发少女站在海边")
        return this.handleDraw(e, arg, conf, { mode: "new" })
      }

      /* ------------------------------------------------ 本地酒馆 */

      case "酒馆":
      case "st":
        return this.stCmd(e, conf, arg)

      case "lora": {
        const list = listLoras(conf.draw || {}, true)
        if (!list.length) return e.reply("没找到 LoRA。检查 config.yaml 里 draw.loraDir")
        const byDir = {}
        for (const l of list) (byDir[l.dir] ||= []).push(l.name)
        const body = Object.entries(byDir).map(([d, ns]) => `【${d}】${ns.join("、")}`).join("\n\n")
        return e.reply(`共 ${list.length} 个：\n\n${body}`.slice(0, 1500))
      }

      case "需求": {
        const sub = arg.trim()
        if (/^(清|清空|删|clear)$/i.test(sub)) {
          clearWishes(conf)
          return e.reply("需求清单清空了。")
        }
        const list = listWishes(conf)
        if (!list.length) return e.reply("需求清单是空的。她提了需求会记在这里，并私聊提醒你。")
        const body = list
          .map(w => {
            const d = new Date(Number(w.at || 0))
            const t = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
            return `· [${t}] ${w.qq}：${w.text}`
          })
          .join("\n")
        return e.reply(`她提的需求（新的在前，清空发「#喵呜 需求 清」）：\n${body}`.slice(0, 1200))
      }

      /* ------------------------------------------------ 体检 / 语音 / 主动 */

      case "体检":
      case "自检":
      case "check": {
        await e.reply("（翻箱倒柜…）等我挨个看一遍。")
        const rows = await probeAll(conf, true)
        const text = healthText(rows)

        if (/^(修|修复|fix)$/i.test(arg)) {
          const { patch, notes } = await autoFix(conf)
          if (!Object.keys(patch).length) return e.reply(`${text}\n\n没有能自己修的（剩下的要你手动改）`)
          const next = patchConfig(patch)
          return e.reply(`${text}\n\n已修：\n${notes.map(n => `· ${n}`).join("\n")}\n\n（改的是 config.yaml，热加载已生效）`)
        }
        return e.reply(`${text}\n\n能自动修的发「#喵呜 体检 修」`)
      }

      case "语音":
      case "tts": {
        const sub = arg.trim()
        if (/^(开|on)$/i.test(sub) || /^(关|off)$/i.test(sub)) {
          const on = /^(开|on)$/i.test(sub)
          const st = await tts.ttsStatus(conf)
          if (on && !st.online) {
            return e.reply(
              "语音服务没起来，先把它开起来：\n\n" +
                "cd \"<GPT-SoVITS 目录>\"\n" +
                "python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml\n\n" +
                "起来后再发「#喵呜 语音 开」。\n" +
                "（详细配置：config.yaml 的 tts 段）",
            )
          }
          patchConfig({ tts: { ...conf.tts, enabled: on } })
          return e.reply(on ? "语音开了。她偶尔会直接发语音过来（概率在 tts.chance）。" : "语音关了，回到纯文字。")
        }
        if (/^(测试|试|test)$/i.test(sub)) {
          await e.reply("（清了清嗓子…）")
          const r = await tts.synthesize(conf, "嗯…听得到吗？这是我现在的声音。")
          if (!r.ok) return e.reply(`没合成出来：${r.msg}`)
          const seg = globalThis.segment
          return e.reply(seg?.record ? seg.record(r.file) : r.file)
        }
        if (/^(清|清理)$/i.test(sub)) {
          const n = await tts.cleanup(3)
          return e.reply(`清掉了 ${n} 个三天前的语音文件`)
        }
        const st = await tts.ttsStatus(conf)
        return e.reply(
          [
            `语音：${st.enabled ? "开" : "关"} · ${st.engine}`,
            `服务：${st.online ? "在线" : "没连上"} ${st.url}`,
            `参考音频：${st.refOk ? st.refAudio : "没配（config.yaml 的 tts.refAudio）"}`,
            `发送策略：${conf.tts?.mode || "sometimes"}${conf.tts?.mode === "sometimes" ? ` · 概率 ${Math.round((conf.tts?.chance ?? 0.25) * 100)}%` : ""}`,
            st.msg ? `\n${st.msg}` : "",
            "",
            "开 / 关：#喵呜 语音 开",
            "试听：#喵呜 语音 测试",
          ]
            .filter(Boolean)
            .join("\n"),
        )
      }

      case "主动": {
        const sub = arg.trim()
        const pc = conf.proactive || {}
        if (/^(开|on)$/i.test(sub) || /^(关|off)$/i.test(sub)) {
          const on = /^(开|on)$/i.test(sub)
          patchConfig({ proactive: { ...pc, enabled: on } })
          return e.reply(on ? `主动发言开了。时段 ${pc.activeHours?.[0]}:00-${pc.activeHours?.[1]}:00，每天最多 ${pc.maxPerDay} 次。` : "主动发言关了，以后只有你说话她才回。")
        }
        return e.reply(
          [
            `主动发言：${pc.enabled ? "开" : "关"}`,
            `时段：${pc.activeHours?.[0]}:00-${pc.activeHours?.[1]}:00${Array.isArray(pc.weekendHours) && pc.weekendHours.length === 2 ? ` · 周末 ${pc.weekendHours[0]}:00-${pc.weekendHours[1]}:00` : ""}`,
            `间隔：至少 ${pc.minIdleMin} 分钟没聊 · 最多 ${pc.maxIdleMin} 分钟（更久就不打扰了）`,
            `频率：每 ${pc.cronMin} 分钟掷一次骰子，命中率 ${Math.round((pc.chance ?? 0.45) * 100)}%，每天最多 ${pc.maxPerDay} 次`,
            `语气：${pc.style || "auto"}${Array.isArray(pc.topics) && pc.topics.length ? ` · 话题池 ${pc.topics.length} 条` : ""}`,
            `连发上限：${Number(pc.maxNoReply) > 0 ? `${pc.maxNoReply} 条没回就停` : "不限"}`,
            `深夜静音：${pc.nightQuiet !== false ? "开（23:00-07:00 不发）" : "关"}`,
            "",
            "开关：#喵呜 主动 开 / 关",
            "细节都在 config.yaml 的 proactive 段",
          ].join("\n"),
        )
      }

      case "说": {
        const { card } = await currentCard(conf, qq)
        if (!card) return e.reply("还没装角色卡")
        const out = await generate(conf, e, qq, card, "", "proactive")
        await mem.pushCtx(conf, qq, "", out)
        return sendHuman(m => e.reply(m), out, conf.humanize || {})
      }

      case "测试": {
        if (!arg) return e.reply("用法：#喵呜 测试 在干嘛")
        const { card } = await currentCard(conf, qq)
        if (!card) return e.reply("还没装角色卡")
        const t0 = Date.now()
        try {
          const out = await generate(conf, e, qq, card, arg, "chat")
          return e.reply(`[${Date.now() - t0}ms]\n${out}`)
        } catch (err) {
          return e.reply(`失败：${err.message}`)
        }
      }

      case "探活": {
        const p = providerOf(conf)
        if (!p) return e.reply("config.yaml 里没有可用的 provider")
        const t = await ping(p)
        return e.reply(`${p.__name} / ${p.model}\n${t.ok ? "✓" : "✕"} ${t.msg}（${t.ms}ms）`)
      }

      case "调试": {
        const on = arg !== "关"
        patchConfig({ debug: on })
        return e.reply(`调试日志${on ? "开" : "关"}了。开的时候会把完整 prompt 打进日志。`)
      }

      case "关":
        muted = true
        return e.reply("（她背过身去，不理人了）")

      case "开":
        muted = false
        return e.reply("（耳朵动了一下）…嗯。")

      default: {
        // 「喵呜 你好」当聊天
        if (!raw.startsWith("#")) {
          this.handleChat(e, sub, conf).catch(err => log.error(`${TAG} handleChat: ${err.stack || err}`))
          return "return"
        }
        return this.showHelp(e, conf)
      }
    }
  }

  /* ---------------------------------------------------------- 本地酒馆 */

  async stCmd(e, conf, arg) {
    const qq = String(e.user_id)
    const sc = conf.sillytavern || {}
    if (sc.enabled === false) {
      return e.reply(
        "酒馆直连关着。改 config.yaml：\n\n" +
          "sillytavern:\n  enabled: true\n  dir: '酒馆安装目录'\n\n" +
          "端口和密码会自动从酒馆自己的 config.yaml 读。改完发「#喵呜 重载」",
      )
    }

    const [sub, ...rest] = String(arg || "")
      .split(/\s+/)
      .filter(Boolean)
    const subArg = rest.join(" ").trim()

    switch (sub) {
      case undefined:
      case "":
      case "状态": {
        const s = await st.stStatus(conf)
        if (!s.ok) {
          return e.reply(`酒馆没接上：${s.msg}\n在 config.yaml 的 sillytavern.dir 填酒馆目录，然后「#喵呜 重载」`)
        }
        return e.reply(
          [
            `酒馆 · ${s.httpOk ? `服务在线 ${s.version}` : "只有数据目录能读"}`,
            `地址：${s.url}`,
            `目录：${s.root}`,
            `内容：角色卡 ${s.chars} · 聊天 ${s.chatDirs} 份 · 世界书 ${s.worlds} · 预设 ${s.presets}`,
            "",
            s.httpOk ? "" : "HTTP 没连上也没事，导入导出是直接读文件的。",
            "角色：#喵呜 酒馆 角色",
            "接进度：#喵呜 酒馆 接着 <角色>",
            "导出：#喵呜 酒馆 导出",
          ]
            .filter(Boolean)
            .join("\n"),
        )
      }

      case "角色":
      case "角色卡": {
        const list = st.listStChars(conf)
        if (!list.length) return e.reply("酒馆里没找到角色卡。检查 sillytavern.dir 是不是指向酒馆根目录")
        const body = list
          .slice(0, 24)
          .map((c, i) => `${i + 1}. ${c.name}${c.format === "png" ? "" : `（${c.format}）`}`)
          .join("\n")
        return e.reply(
          `酒馆里有 ${list.length} 张卡：\n\n${body}\n\n导入：#喵呜 酒馆 导入 <名字>\n` +
            `目录：${st.stDirs(conf).chars}`,
        )
      }

      case "导入": {
        if (!subArg) return e.reply("用法：#喵呜 酒馆 导入 三体v0.1")
        const r = st.importStChar(conf, subArg)
        if (!r.ok) return e.reply(r.msg)
        return e.reply(`${r.msg}\nid：${r.id}\n发「#喵呜 出场 ${r.id}」让她出场`)
      }

      case "聊天":
      case "记录": {
        if (!subArg) return e.reply("用法：#喵呜 酒馆 聊天 三体v0.1")
        const list = st.listStChats(conf, subArg)
        if (!list.length) return e.reply(`「${subArg}」在酒馆里没有聊天记录`)
        const body = list
          .slice(0, 10)
          .map((c, i) => `${i + 1}. ${c.name}（${c.turns} 轮 · ${ago(c.mtime)}）`)
          .join("\n")
        return e.reply(`「${subArg}」的聊天：\n\n${body}\n\n接上最近那份：#喵呜 酒馆 接着 ${subArg}`)
      }

      case "接着":
      case "续上": {
        if (!subArg) return e.reply("用法：#喵呜 酒馆 接着 三体v0.1 [文件名关键词]")
        const list = st.listStChats(conf, subArg)
        if (!list.length) return e.reply(`「${subArg}」在酒馆里没有聊天记录`)
        const kw = rest.slice(1).join(" ")
        const pick = kw ? list.find(c => c.name.includes(kw)) : list[0]
        if (!pick) return e.reply(`没找到名字里有「${kw}」的聊天文件`)

        const r = await st.resumeStChat(conf, qq, subArg, pick.file)
        if (!r.ok) return e.reply(r.msg)

        const { card } = await currentCard(conf, qq)
        const lines = [`接上了「${r.charName}」：${r.msg}`]
        if (card && card.name !== r.charName) {
          const hit = st.findStChar(conf, subArg)
          lines.push(`（现在出场的是「${card.name}」，想换成她先「#喵呜 酒馆 导入 ${r.charName}」再「#喵呜 出场 ${hit?.id || r.charName}」）`)
        }
        lines.push("直接在 QQ 里接着聊就行，她记得刚才的进度。")
        return e.reply(lines.join("\n"))
      }

      case "导出":
      case "存进酒馆": {
        const { card } = await currentCard(conf, qq)
        const target = subArg || card?.name || ""
        if (!target) return e.reply("用法：#喵呜 酒馆 导出 [角色名]（默认当前出场的）")
        const r = await st.exportStChat(conf, qq, target, nickOf(e))
        if (!r.ok) return e.reply(r.msg)
        return e.reply(`${r.msg}\n在酒馆浏览器里刷新一下角色，就能看到这条聊天。`)
      }

      case "世界书": {
        const list = st.listStWorlds(conf)
        if (!subArg) {
          if (!list.length) return e.reply("酒馆里没有世界书文件")
          const body = list.map(w => `· ${w.name}（${w.entries} 条）`).join("\n")
          return e.reply(`酒馆世界书 ${list.length} 本：\n\n${body}\n\n导入：#喵呜 酒馆 世界书 <名字>`)
        }
        const r = st.importStWorld(conf, subArg)
        if (!r.ok) return e.reply(r.msg)
        return e.reply(`${r.msg}\n已经放进 config/lorebooks/，发「#喵呜 重载」开始生效。`)
      }

      case "预设": {
        const list = st.listStPresets(conf)
        if (!subArg) {
          if (!list.length) return e.reply("酒馆里没有预设文件")
          const body = list.map(p => `· ${p.name}（${p.kind}）`).join("\n")
          return e.reply(`酒馆预设 ${list.length} 个：\n\n${body}\n\n看内容：#喵呜 酒馆 预设 <名字>\n拿去用：#喵呜 酒馆 预设 <名字> 应用`)
        }

        const isApply = /\s应?用$/.test(subArg) || /\sapply$/i.test(subArg)
        const name = subArg.replace(/\s*(应用|apply)$/i, "").trim()
        const p = st.readStPreset(conf, name)
        if (!p.ok) return e.reply(p.msg)

        if (isApply) {
          const text = (p.jailbreak || p.main || "").trim()
          if (!text) return e.reply(`「${p.name}」里没有 jailbreak / main 段落，没东西可应用`)
          patchConfig({ immersion: { ...(conf.immersion || {}), stNote: text.slice(0, 1500) } })
          return e.reply(
            `把「${p.name}」的规则搬进了后置指令（${charLen(text)} 字，截到 1500）。\n` +
              `它会在每次回复前最后一句注入，权重最高。\n\n要撤掉：#喵呜 酒馆 预设 清\n想看原文：#喵呜 酒馆 预设 ${p.name}`,
          )
        }
        if (/^(清|清掉|取消)$/.test(name)) {
          patchConfig({ immersion: { ...(conf.immersion || {}), stNote: "" } })
          return e.reply("预设规则撤掉了，后置指令回到原来的样子。")
        }

        const lines = [
          `「${p.name}」（${p.kind}）`,
          p.meta.temperature != null ? `温度 ${p.meta.temperature} · top_p ${p.meta.top_p ?? "-"} · ${p.meta.prompts} 条 prompt` : `${p.meta.prompts} 条 prompt`,
          "",
        ]
        if (p.jailbreak) lines.push("—— jailbreak ——", cut(p.jailbreak, 500), "")
        if (p.main) lines.push("—— main ——", cut(p.main, 400), "")
        if (p.postHistory) lines.push("—— post-history ——", cut(p.postHistory, 300), "")
        if (!p.jailbreak && !p.main && !p.postHistory) {
          lines.push("（这个预设没有可搬的规则段落，只有参数）")
        }
        lines.push("", `应用：#喵呜 酒馆 预设 ${p.name} 应用`)
        return e.reply(lines.join("\n"))
      }

      default:
        return e.reply(
          [
            "酒馆 · 用法",
            "",
            "#喵呜 酒馆              状态",
            "#喵呜 酒馆 角色          列酒馆里的卡",
            "#喵呜 酒馆 导入 <名字>   导进喵呜",
            "#喵呜 酒馆 聊天 <角色>   列它的聊天记录",
            "#喵呜 酒馆 接着 <角色> [关键词]   接上那段进度",
            "#喵呜 酒馆 导出 [角色]   把这边对话存进酒馆",
            "#喵呜 酒馆 世界书 [名字]  列出 / 导入",
            "#喵呜 酒馆 预设 [名字] [应用]   看 / 搬规则",
          ].join("\n"),
        )
    }
  }

  async showHelp(e, conf) {
    const qq = String(e.user_id)
    const { card } = await currentCard(conf, qq)
    const data = buildHelpData({
      conf,
      card,
      cards: listCharacters(conf).length,
      profile: await mem.getProfile(conf, qq),
      stOn: conf.sillytavern?.enabled !== false,
      clock: conf.clock?.enabled === false ? "" : clock.clockText(conf),
    })
    const img = await helpImage(data)
    if (img) return e.reply(img)
    return e.reply(HELP.join("\n"))
  }

  async showStatus(e, conf) {
    const qq = String(e.user_id)
    const p = providerOf(conf)
    const { card } = await currentCard(conf, qq)
    const ctx = await mem.loadCtx(conf, qq)
    const sum = await mem.getSummary(conf, qq)
    const eps = await mem.listEpisodes(conf, qq)
    const idle = await mem.idleMinutes(conf, qq)
    const tv = await tavern.tavernState(conf, qq)
    const prof = await mem.getProfile(conf, qq)
    const all = listCharacters(conf)
    const pc = conf.proactive || {}
    const h = new Date().getHours()
    const [from, to] = pc.activeHours || [9, 23]
    const inWindow = from <= to ? h >= from && h < to : h >= from || h < to

    const last = await mem.loadLastPlan(conf, qq)
    const drawState = drawing.get(qq)
      ? `正在画（${Math.round((Date.now() - drawing.get(qq).t0) / 1000)}s）`
      : last
        ? `上一张 ${ago(last.createdAt)}`
        : "还没画过"

    const castNames = tv.cameo.map(id => loadCharacter(conf, id)?.name || id)
    const pendingRemind = (await clock.listReminders(conf, qq)).filter(r => !r.done).length
    const ttsReady = conf.tts?.enabled ? (await tts.ttsStatus(conf)).online : true

    const lines = [
      `喵呜 · ${conf.enabled ? "在线" : "已停用"}${muted ? "（闭嘴中）" : ""}`,
      `后端：${p?.__name || "?"} / ${p?.model || "?"}`,
      `存档：${prof}`,
      `出场：${card ? `${card.name}（${card.id}）` : "（无角色卡）"} · 共 ${all.length} 张`,
      card && !tavern.openingFor(card) ? "开场白：（这张卡没写）" : "",
      tv.userPersona ? `我是：${cut(tv.userPersona, 40)}` : "",
      castNames.length ? `同场：${castNames.join("、")}` : "",
      tv.scene ? `场景：${cut(tv.scene, 40)}` : "",
      `记忆：${Math.floor(ctx.length / 2)} 轮${sum.text ? ` + 摘要 ${charLen(sum.text)} 字` : ""} · ${eps.length} 条事件`,
      `上次说话：${idle < 0 ? "还没说过" : ago(Date.now() - idle * 60000)}`,
      await (async () => {
        try {
          const p2 = await pressure(conf, qq, p)
          const modeText = { auto: "自动", remind: "提醒", manual: "只手动" }[p2.mode] || p2.mode
          return `上下文：${fmtUsage(p2.usage)} · 策略 ${modeText}`
        } catch {
          return ""
        }
      })(),
      `压缩：${conf.compress?.enabled ? `开（超过 ${conf.compress.triggerTurns} 轮 / ${Math.round((conf.compress.warnRatio ?? 0.75) * 100)}% 提醒）` : "关"}`,
      `绘图：${conf.draw?.enabled ? `开 · ${listLoras(conf.draw).length} 个 LoRA · ${drawState}` : "关"}`,
      `语音：${conf.tts?.enabled ? `开 · ${conf.tts.engine} · ${conf.tts.mode}` : "关"}${ttsReady ? "" : "（服务没连上）"}`,
      `时钟：${conf.clock?.enabled === false ? "关" : clock.clockText(conf)}${clock.festivalOf(new Date()) ? ` · ${clock.festivalOf(new Date())}` : ""} · 提醒 ${pendingRemind} 个`,
      `主动：${pc.enabled ? `开（${pc.activeHours?.[0]}:00-${pc.activeHours?.[1]}:00，${inWindow ? "当前可发" : "当前不发"}）` : "关"}`,
      `今日已主动：${await mem.getProactiveCount(conf, qq)}/${pc.maxPerDay ?? 3}`,
      "",
      "发 #喵呜 帮助 看全部命令",
    ].filter(Boolean)
    return e.reply(lines.join("\n"))
  }
}
