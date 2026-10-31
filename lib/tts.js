/**
 * 语音合成（TTS）
 *
 * 接两种：
 *   gptsovits —— GPT-SoVITS 的 api_v2（本机默认 http://127.0.0.1:9880）
 *   openai    —— OpenAI 兼容的 /v1/audio/speech（fish-speech / CosyVoice / IndexTTS
 *                这类带兼容层的都能直接用）
 *
 * 为什么默认 gptsovits：本机就装了它，能克隆音色，中文自然。
 *
 * 用法上最重要的是「别每条都发语音」—— 真人不会条条语音。
 * 所以 mode 默认 sometimes，按概率发。
 */
import fs from "node:fs"
import path from "node:path"
import { resolve } from "./config.js"
import { stamp } from "./util.js"

const log = () => globalThis.logger || console

function base(conf) {
  return String(conf?.tts?.url || "http://127.0.0.1:9880").replace(/\/+$/, "")
}

function outDir() {
  const d = resolve("data/tts")
  try {
    fs.mkdirSync(d, { recursive: true })
  } catch {}
  return d
}

/* ------------------------------------------------------------ 探活 */

export async function ttsStatus(conf) {
  const tc = conf?.tts || {}
  const url = base(conf)
  const out = {
    enabled: tc.enabled === true,
    engine: tc.engine || "gptsovits",
    url,
    refOk: !!tc.refAudio && fs.existsSync(String(tc.refAudio)),
    refAudio: tc.refAudio || "",
    online: false,
    msg: "",
  }

  try {
    // FastAPI 起来的服务都有 /docs；没有也不代表不行，再试个根路径
    const r = await fetch(`${url}/docs`, { signal: AbortSignal.timeout(2500) })
    out.online = r.status < 500
  } catch {
    try {
      const r2 = await fetch(url, { signal: AbortSignal.timeout(2500) })
      out.online = r2.status < 500
    } catch {
      out.online = false
    }
  }

  if (!out.online) {
    out.msg = "TTS 服务没开。GPT-SoVITS 这样起：\npython api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml"
  } else if (out.engine === "gptsovits" && !out.refOk) {
    out.msg = "服务在，但没配参考音频。config.yaml 的 tts.refAudio 填一个 wav 路径（5~10 秒、单人、安静）"
  } else if (!tc.enabled) {
    out.msg = "服务就绪，但语音还没开：config.yaml 的 tts.enabled 改成 true"
  } else {
    out.msg = "就绪"
  }
  return out
}

/* ------------------------------------------------------------ 合成 */

/** 太长就切段，一次合成别超过这个字数 */
const CHUNK = 90

function chunks(text, max = CHUNK) {
  const s = String(text || "").trim()
  if (!s) return []
  const parts = s.split(/(?<=[。！？!?…~\n])/).map(x => x.trim()).filter(Boolean)
  const out = []
  let buf = ""
  for (const p of parts) {
    if ([...(buf + p)].length > max && buf) {
      out.push(buf)
      buf = p
    } else {
      buf += p
    }
  }
  if (buf) out.push(buf)
  return out.length ? out : [s]
}

async function synthGptSovits(conf, text) {
  const tc = conf.tts || {}
  const body = {
    text: String(text),
    text_lang: tc.textLang || "zh",
    ref_audio_path: String(tc.refAudio || "").replace(/\\/g, "/"),
    prompt_text: String(tc.refText || ""),
    prompt_lang: tc.refLang || "zh",
    text_split_method: tc.splitMethod || "cut5",
    batch_size: 1,
    speed_factor: Number(tc.speedFactor) || 1.0,
    streaming_mode: false,
    media_type: "wav",
    parallel_infer: true,
  }
  const r = await fetch(`${base(conf)}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(tc.timeoutMs) || 60000),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => "")
    throw new Error(`TTS HTTP ${r.status}: ${String(t).slice(0, 160)}`)
  }
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 800) throw new Error("TTS 返回的内容不像音频（太小）")
  return buf
}

async function synthOpenAI(conf, text) {
  const tc = conf.tts || {}
  const r = await fetch(`${base(conf)}/v1/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(tc.apiKey ? { Authorization: `Bearer ${tc.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: tc.model || "tts-1",
      input: String(text),
      voice: tc.voice || "alloy",
      response_format: "wav",
      speed: Number(tc.speedFactor) || 1.0,
    }),
    signal: AbortSignal.timeout(Number(tc.timeoutMs) || 60000),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => "")
    throw new Error(`TTS HTTP ${r.status}: ${String(t).slice(0, 160)}`)
  }
  return Buffer.from(await r.arrayBuffer())
}

/**
 * 把一句话变成 wav 文件。
 * @returns {Promise<{ok:boolean, file?:string, ms?:number, msg?:string}>}
 */
export async function synthesize(conf, text) {
  const t0 = Date.now()
  const clean = String(text || "").trim()
  if (!clean) return { ok: false, msg: "没内容可念" }

  const engine = String(conf?.tts?.engine || "gptsovits").toLowerCase()
  const bufs = []
  for (const seg of chunks(clean)) {
    try {
      bufs.push(engine === "openai" ? await synthOpenAI(conf, seg) : await synthGptSovits(conf, seg))
    } catch (e) {
      log().warn?.(`[miao-wu] TTS 失败：${e.message}`)
      return { ok: false, msg: String(e.message).slice(0, 160) }
    }
  }
  if (!bufs.length) return { ok: false, msg: "没合成出音频" }

  // 多段就直接拼（wav 头部只保留第一段的，播放器一般能吃；单段最常见）
  const buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs)
  const file = path.join(outDir(), `mw-${stamp()}.wav`)
  try {
    fs.writeFileSync(file, buf)
  } catch (e) {
    return { ok: false, msg: `写文件失败：${e.message}` }
  }
  return { ok: true, file, ms: Date.now() - t0, bytes: buf.length }
}

/* ------------------------------------------------------------ 策略 */

/**
 * 这条回复该不该发语音。
 * @returns {boolean}
 */
export function shouldVoice(conf, text) {
  const tc = conf?.tts || {}
  if (tc.enabled !== true) return false
  const mode = String(tc.mode || "sometimes")
  if (mode === "off") return false
  if ([...String(text || "")].length > Number(tc.maxChars ?? 120)) return false
  if (mode === "all") return true
  return Math.random() < Number(tc.chance ?? 0.25)
}

/** 发语音失败时不要影响文字回复 —— 这里吞掉错误只打日志 */
export async function tryVoice(conf, text) {
  const r = await synthesize(conf, text)
  if (!r.ok) log().warn?.(`[miao-wu] 语音跳过：${r.msg}`)
  return r
}

export async function cleanup(days = 3) {
  const dir = outDir()
  const cut = Date.now() - days * 86400000
  let n = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      try {
        if (fs.statSync(p).mtimeMs < cut) {
          fs.unlinkSync(p)
          n++
        }
      } catch {}
    }
  } catch {}
  return n
}
