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

const log = () => globalThis.logger || console

/** 匹配 [[画:...]] / [[画改:...]] / [[语音]]（标记独立成行或跟在句尾都行） */
const TOOL_TAG_RE = /\[\[\s*(画改|画|语音)\s*[:：]?\s*([^\]]{0,160}?)\s*\]\]/g

export const TOOL_NAMES = ["draw", "drawRefine", "voice"]
export const TAG_ALIAS = { 画: "draw", 画改: "drawRefine", 语音: "voice" }

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
  if (!parts.length) return ""
  return [
    "## 你的能力（工具标记）",
    "你可以在回复末尾嵌入标记来使用能力，标记会被系统识别执行，**不会**显示出来：",
    ...parts,
    "规则：一条回复最多一个标记；放在回复最后一行的末尾；[[画:…]] 里直接写画面内容（比如 [[画:鲸鱼娘趴在窗边晒太阳]]），不要写“画一张”这种动词。",
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
      }
    } catch (err) {
      log().warn?.(`[miao-wu] 工具 ${call.name} 执行失败：${err.message}`)
      results.push(`（${call.name} 失败：${String(err.message).slice(0, 60)}）`)
    }
  }
  return results
}
