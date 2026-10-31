/**
 * LLM 传输层
 *
 * 只负责"把 messages 送出去、把文本拿回来"。
 * 输出清洗在 immersion.js，这里不掺和，避免职责混乱和循环依赖。
 *
 * 支持：OpenAI 兼容（各类中转/官方）、Ollama 原生、Gemini 原生（可选）
 */

const log = () => globalThis.logger || console

export class LLMError extends Error {
  constructor(msg, provider) {
    super(msg)
    this.name = "LLMError"
    this.provider = provider
  }
}

/** 剥掉 reasoning 模型的思考块（qwen3 / deepseek-r1 / gpt-oss 等） */
export function stripThink(text) {
  if (!text) return ""
  let t = String(text)
  t = t.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "")
  t = t.replace(/<\|?begin[▁_]?of[▁_]?thought[▁_]*\|?>[\s\S]*?<\|?end[▁_]?of[▁_]?thought[▁_]*\|?>/gi, "")
  // 没闭合（被截断）：把开标签到末尾全丢
  if (/<think[^>]*>/i.test(t) && !/<\/think>/i.test(t)) t = t.replace(/<think[^>]*>[\s\S]*$/i, "")
  return t.trim()
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ Ollama */

async function viaOllama(conf, messages, opts) {
  const base = String(conf.baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "")
  const body = {
    model: opts.model || conf.model,
    messages,
    stream: false,
    think: conf.think === true,
    keep_alive: conf.keepAlive || "30m",
    options: {
      temperature: opts.temperature ?? conf.temperature ?? 0.9,
      top_p: opts.topP ?? conf.topP ?? 0.9,
      num_predict: opts.maxTokens ?? conf.maxTokens ?? 400,
      num_ctx: conf.numCtx ?? 8192,
      repeat_penalty: conf.repeatPenalty ?? 1.1,
      ...(opts.stop?.length ? { stop: opts.stop } : {}),
    },
  }
  const res = await fetchWithTimeout(
    `${base}/api/chat`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    opts.timeoutMs ?? conf.timeoutMs ?? 180000,
  )
  if (!res.ok) throw new LLMError(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, "ollama")
  const data = await res.json()
  if (data.error) throw new LLMError(String(data.error), "ollama")
  return data?.message?.content ?? ""
}

/* ------------------------------------------------------- OpenAI 兼容接口 */

async function viaOpenAI(conf, messages, opts) {
  if (!conf.apiKey) throw new LLMError("apiKey 为空，检查 config.yaml", conf.__name || conf.model)
  const base = String(conf.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")
  const body = {
    model: opts.model || conf.model,
    messages,
    temperature: opts.temperature ?? conf.temperature ?? 1.0,
    max_tokens: opts.maxTokens ?? conf.maxTokens ?? 400,
    top_p: opts.topP ?? conf.topP ?? 0.95,
    stream: false,
  }
  if (opts.frequencyPenalty ?? conf.frequencyPenalty) body.frequency_penalty = opts.frequencyPenalty ?? conf.frequencyPenalty
  if (opts.presencePenalty ?? conf.presencePenalty) body.presence_penalty = opts.presencePenalty ?? conf.presencePenalty
  // 只有明确要求 stop 时才带。默认不带 —— 否则人设/文档里的「主人：」会被截断
  if (opts.stop?.length) body.stop = opts.stop
  if (opts.jsonMode) body.response_format = { type: "json_object" }

  const res = await fetchWithTimeout(
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${conf.apiKey}` },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? conf.timeoutMs ?? 120000,
  )
  if (!res.ok) throw new LLMError(`HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`, conf.__name || conf.model)
  const data = await res.json()
  if (data.error) throw new LLMError(JSON.stringify(data.error).slice(0, 240), conf.__name || conf.model)
  return data?.choices?.[0]?.message?.content ?? ""
}

/* ------------------------------------------------------------------ Gemini */

/**
 * Gemini 原生 API。反代通常给了 OpenAI 兼容层，所以一般用不上；
 * 但直连 Google 时这条更省事（支持 systemInstruction）。
 */
async function viaGemini(conf, messages, opts) {
  const key = conf.apiKey
  if (!key) throw new LLMError("apiKey 为空", "gemini")
  const base = String(conf.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "")
  const sys = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n")
  const contents = messages
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }))
  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? conf.temperature ?? 1.0,
      maxOutputTokens: opts.maxTokens ?? conf.maxTokens ?? 400,
      ...(opts.jsonMode ? { responseMimeType: "application/json" } : {}),
    },
    ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
  }
  if (opts.stop?.length) body.generationConfig.stopSequences = opts.stop

  const res = await fetchWithTimeout(
    `${base}/models/${opts.model || conf.model}:generateContent?key=${encodeURIComponent(key)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    opts.timeoutMs ?? conf.timeoutMs ?? 120000,
  )
  if (!res.ok) throw new LLMError(`HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`, "gemini")
  const data = await res.json()
  const parts = data?.candidates?.[0]?.content?.parts || []
  return parts.map(p => p.text || "").join("")
}

/* ------------------------------------------------------------------ 入口 */

/** 按 provider.type 分发 */
function send(conf, messages, opts) {
  const type = String(conf.type || "openai").toLowerCase()
  if (type === "ollama") return viaOllama(conf, messages, opts)
  if (type === "gemini") return viaGemini(conf, messages, opts)
  return viaOpenAI(conf, messages, opts)
}

/**
 * 发一次请求，带降级与重试。
 *
 * @param {object} conf  provider 配置（需含 model）
 * @param {Array}  messages  [{role, content}]
 * @param {object} opts
 *   - stop / maxTokens / temperature / jsonMode / model / timeoutMs
 *   - retries   同一模型重试次数，默认 2
 *   - fallback  降级模型名，默认取 conf.fallbackModel
 *   - silent    true 时不打 warn 日志
 * @returns {Promise<string>} 已去掉思考块的文本
 */
export async function chat(conf, messages, opts = {}) {
  if (!conf?.model) throw new LLMError("provider 未配置 model", "?")

  const models = [opts.model || conf.model]
  const fb = opts.fallback ?? conf.fallbackModel
  if (fb && fb !== models[0]) models.push(fb)

  const retries = Math.max(1, opts.retries ?? 2)
  let lastErr = null

  for (const model of models) {
    const c2 = { ...conf, model }
    for (let i = 0; i < retries; i++) {
      try {
        const raw = await send(c2, messages, { ...opts, model })
        const out = stripThink(raw)
        if (out) {
          if (model !== models[0] && !opts.silent) {
            log().warn?.(`[miao-wu] 已降级到 ${model}`)
          }
          return out
        }
        lastErr = new LLMError("模型返回空内容", conf.__name || model)
      } catch (e) {
        lastErr = e?.name === "AbortError" ? new LLMError("请求超时", conf.__name || model) : e
        if (i < retries - 1) await new Promise(r => setTimeout(r, 700))
      }
    }
    if (models.length > 1 && !opts.silent) {
      log().warn?.(`[miao-wu] ${model} 失败：${String(lastErr?.message).slice(0, 100)}`)
    }
  }
  throw lastErr || new LLMError("生成失败", conf.__name || "?")
}

/**
 * 要 JSON 的调用：失败时自动重试一次并把错误回灌给模型。
 * @returns {Promise<object>}
 */
export async function chatJSON(conf, messages, opts = {}) {
  const sysExtra = {
    role: "system",
    content: "只输出一个合法的 JSON 对象，不要用 ``` 包裹，不要写任何解释或前后缀。",
  }
  const msgs = [...messages]
  // 插在最后一条 system 之后（如果没 system 就放最前面）
  const lastSys = msgs.map(m => m.role).lastIndexOf("system")
  msgs.splice(lastSys + 1, 0, sysExtra)

  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(conf, attempt === 0 ? msgs : [
      ...msgs,
      { role: "user", content: `上次输出不是合法 JSON（${String(lastErr?.message).slice(0, 80)}），请只输出 JSON：` },
    ], { ...opts, jsonMode: true })

    const parsed = extractJSON(raw)
    if (parsed) return parsed
    lastErr = new LLMError(`JSON 解析失败，结尾：${JSON.stringify(String(raw).slice(-60))}`, conf.__name)
  }
  throw lastErr
}

/** 从可能带 md 包裹 / 前后废话的文本里抠出第一个 JSON 对象 */
export function extractJSON(text) {
  let t = String(text || "").trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const a = t.indexOf("{")
  const b = t.lastIndexOf("}")
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(t.slice(a, b + 1))
  } catch {
    return null
  }
}

/** 探活 */
export async function ping(conf) {
  const t0 = Date.now()
  const type = String(conf?.type || "openai").toLowerCase()
  try {
    if (type === "ollama") {
      const base = String(conf.baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "")
      const res = await fetchWithTimeout(`${base}/api/tags`, {}, 5000)
      if (!res.ok) return { ok: false, msg: `HTTP ${res.status}`, ms: Date.now() - t0 }
      const data = await res.json()
      const names = (data.models || []).map(m => m.name)
      const want = String(conf.model || "").split(":")[0]
      const has = names.some(n => n === conf.model || n.split(":")[0] === want)
      return { ok: has, msg: has ? "模型已就绪" : `服务在，但没有 ${conf.model}（有：${names.slice(0, 6).join(", ")}）`, ms: Date.now() - t0 }
    }
    const out = await chat(conf, [{ role: "user", content: "回复一个字：好" }], { maxTokens: 20, retries: 1 })
    return { ok: !!out, msg: out ? "接口连通" : "返回空", ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, msg: String(e.message).slice(0, 160), ms: Date.now() - t0 }
  }
}
