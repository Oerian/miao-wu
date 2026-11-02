/**
 * 工具自主调用
 *
 * 让角色模型自己决定什么时候画画、什么时候发语音，而不是只靠正则猜意图。
 * 约定：模型在回复末尾嵌标记，机器人解析后剥掉标记、执行工具：
 *   [[画:鲸鱼娘趴在窗边晒太阳]]   画一张新图（主体/画面描述）
 *   [[画改:换成夜景]]            基于上一张改图
 *   [[语音]]                     这句话用语音发出去
 *
 * 设计取舍：
 *   - 不用 OpenAI function calling：三家 provider 语法不一，小模型容易写崩
 *   - 标记是普通文本，任何模型都会写；解析失败也只是一行多余文字，不会崩
 *   - 正则意图识别（draw.js detectDrawIntent）保留，作为没写标记时的兜底
 */
import { bridgeAlive } from "./draw.js"
import * as meme from "./meme.js"
import { recordWish, notifyMaster } from "./wish.js"

const log = () => globalThis.logger || console

/** 每个 QQ 最近甩过的一张表情包 id（斗图防连发同图） */
const lastSticker = new Map()

/** 匹配 [[画:...]] / [[画改:...]] / [[语音]] / [[发表情:...]] / [[做表情:...]] / [[需求:...]] */
const TOOL_TAG_RE = /\[\[\s*(画改|画|语音|发表情|做表情|需求)\s*[:：]?\s*([^\]]{0,160}?)\s*\]\]/g

export const TOOL_NAMES = ["draw", "drawRefine", "voice", "sticker", "meme", "wish"]
export const TAG_ALIAS = { 画: "draw", 画改: "drawRefine", 语音: "voice", 发表情: "sticker", 做表情: "meme", 需求: "wish" }

/**
 * 从模型输出里剥出工具调用。
 * @returns {{ text: string, calls: Array<{name:string, arg:string}> }}
 */
export function parseToolCalls(text) {
  const calls = []
  const clean = String(text || "").replace(TOOL_TAG_RE, (_m, tag, arg) => {
    const name = TAG_ALIAS[tag]
    if (!name) return ""
    // 同一条回复同类工具只留一个，别让她一口气排五张图
    if (calls.some(c => c.name === name)) return ""
    calls.push({ name, arg: String(arg || "").trim() })
    return ""
  })
  return { text: clean.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(), calls }
}

/**
 * 给 system 用的工具说明。返回空串 = 本轮没有可用工具。
 */
export function toolsBlock(conf) {
  const parts = []
  if (conf?.draw?.enabled !== false) {
    parts.push(
      "- [[画:画面描述]]：动手画一张图。只在话题自然适合的时候用（她聊到想给你看什么、你俩在聊的画面、她心情想表达），**不要**每次都用，也不要拿来敷衍。",
      "- [[画改:修改点]]：把你刚画的那张改一改（换个颜色/角度/表情）。",
    )
  }
  if (conf?.tts?.enabled) {
    parts.push("- [[语音]]：这句话想直接说给他听（撒娇、重要的话、唱一句）时用，文字还是会正常发出。")
  }
  parts.push(
    "- [[选项:吃饭|看电影|在家待着]]：想让他做选择的时候给几个选项，他回数字就行。",
    "- [[变量:好感度=+1]] / [[变量:地点=海边]]：把重要的状态变化记下来（好感、地点、约定的事…），下次还记得。小小的事不用记。",
    "- 不要用 QQ 默认小表情，也不要写 [[表情:…]] 标记 —— 那种黄脸表情很呆，想表达情绪就用文字（笑死/真的会谢/哼）。",
  )
  if (conf?.meme?.enabled !== false) {
    parts.push(
      "- [[发表情:描述]]：斗图！从你的表情包库里挑一张最贴的甩出去（比如 [[发表情:无语]]）。他发图挑衅、或者气氛搞怪时用。",
      "- [[做表情:顶部文字|底部文字]]：拿最近那张图配两行大字做成表情包。刚画完图、或他说了什么金句的时候很好用。",
      "- 斗图时**可以只回一张表情包，一个字都不说** —— 那样更有活人感。正文留空，只写 [[发表情:…]] 就行。",
    )
  }
  if (conf?.draw?.enabled !== false) {
    parts.push(
      "- [[需求:想要什么，为什么]]：发现自己**真的缺东西**时向主人开口 —— 比如画不好某种画面是没有对应的 LoRA、表情包库里搜不到想要的图。说清楚缺什么、想拿来干什么。很稀少地用，别当成聊天内容。",
    )
  }
  return [
    "## 你的能力（工具标记）",
    "你可以在回复末尾嵌入标记来使用能力，标记会被系统识别执行，**不会**显示出来：",
    ...parts,
    "规则：标记放在回复最后一行的末尾（[[表情:…]] 跟在句尾即可）；画图标记里直接写画面内容，不要写“画一张”这种动词；一条回复最多一个动作类标记。",
  ].join("\n")
}

/**
 * 执行解析出的工具调用。文字已经先发出去了，这里只处理动作。
 * @param {object} ctx  { e, conf, qq, drawOnce: (subject, opts) => Promise, forceVoice: (text) => Promise<boolean> }
 * @returns {Promise<string[]>} 每个调用的执行结果描述（写日志/进上下文用）
 */
export async function runToolCalls(ctx, calls) {
  const results = []
  for (const call of calls) {
    try {
      if (call.name === "voice") {
        const ok = await ctx.forceVoice()
        results.push(ok ? "（已用语音说出这句话）" : "（想说话但没发出声音）")
      } else if (call.name === "draw") {
        if (!call.arg) {
          results.push("（想画点什么，但没想好画什么）")
          continue
        }
        if (!(await bridgeAlive(ctx.conf.draw || {}))) {
          results.push("（画笔不在手边，没画成）")
          continue
        }
        await ctx.drawOnce(call.arg, { mode: "new" })
        results.push(`（画了${call.arg}，图已发出）`)
      } else if (call.name === "drawRefine") {
        if (!call.arg) {
          results.push("（想改刚才那张，但没说改哪）")
          continue
        }
        if (!(await bridgeAlive(ctx.conf.draw || {}))) {
          results.push("（画笔不在手边，没改成）")
          continue
        }
        await ctx.drawOnce(call.arg, { mode: "refine" })
        results.push(`（把图改了：${call.arg}）`)
      } else if (call.name === "sticker") {
        // 从收藏的表情包库里挑一张甩出去（避开刚发过的那张，斗图别连发同图）
        const picked = meme.findMeme(ctx.conf, call.arg || "", lastSticker.get(ctx.qq) || "")
        if (!picked) {
          results.push("（翻了翻表情包库，是空的）")
          continue
        }
        const seg = globalThis.segment
        try {
          await ctx.e.reply(seg?.image ? seg.image(meme.memeFile(ctx.conf, picked)) : meme.memeFile(ctx.conf, picked))
          lastSticker.set(ctx.qq, picked.id)
          meme.markUsed(ctx.conf, picked)
          results.push(`（甩出一张表情包：${picked.caption || picked.tags?.join("/") || picked.id}）`)
        } catch (err) {
          results.push(`（表情包发失败了：${String(err.message).slice(0, 40)}）`)
        }
      } else if (call.name === "wish") {
        // 自主提需求：落盘 + 私聊主人。被冷却挡住时她也知道"先别催"
        if (!call.arg) {
          results.push("（想说想要点什么，但没组织好语言）")
          continue
        }
        const r = recordWish(ctx.conf, ctx.qq, call.arg)
        if (!r.ok) {
          results.push(`（刚提过需求了，主人还没回应，先等 ${r.waitMin} 分钟再说）`)
          continue
        }
        const told = await notifyMaster(ctx.conf, `[喵呜] ${ctx.qq} 提了个需求：${call.arg}\n看清单：#喵呜 需求`)
        results.push(told ? `（向主人提出了需求：${call.arg}）` : `（把需求记在小本本上了：${call.arg}）`)
      } else if (call.name === "meme") {
        // 拿最近一张图配字做成表情包
        const base = meme.latestBaseImage(ctx.conf)
        if (!base) {
          results.push("（想配字但没有底图）")
          continue
        }
        const [top, bottom] = String(call.arg || "").split(/[|｜]/).map(s => s.trim())
        const img = await meme.renderMeme(`file:///${base.replace(/\\/g, "/")}`, top, bottom)
        if (!img) {
          results.push("（配字失败了）")
          continue
        }
        await ctx.e.reply(img)
        results.push(`（做了张配字表情包：${top || ""}${bottom ? "/" + bottom : ""}）`)
      }
    } catch (err) {
      log().warn?.(`[miao-wu] 工具 ${call.name} 执行失败：${err.message}`)
      results.push(`（${call.name} 失败：${String(err.message).slice(0, 60)}）`)
    }
  }
  return results
}
