/**
 * 模拟运行：用假消息走一遍 accept → handleChat，不发真 QQ 消息
 *
 * 用法：node plugins/miao-wu/test/mock-run.mjs
 *       node plugins/miao-wu/test/mock-run.mjs "今天好累啊"
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEST_QQ = "999999"

// 模拟云崽注入的全局
globalThis.logger = {
  info: (...a) => console.log("  [info]", ...a),
  warn: (...a) => console.log("  [warn]", ...a),
  error: (...a) => console.log("  [error]", ...a),
  mark: (...a) => console.log("  [mark]", ...a),
  debug: () => {},
}
globalThis.redis = null
globalThis.Bot = { pickFriend: () => null }
globalThis.segment = { image: f => `[image:${path.basename(f)}]` }

let PluginBase
try {
  PluginBase = (await import("../../../lib/plugins/plugin.js")).default
} catch (e) {
  console.log("无法加载云崽插件基类，跳过 mock（正常，这只在云崽进程内才有）")
  process.exit(0)
}

const { MiaoWu } = await import("../index.js")
const mem = await import("../lib/memory.js")
const { loadConfig } = await import("../lib/config.js")

const conf = loadConfig()
await mem.forgetAll(conf, TEST_QQ)

const reply = []
const e = {
  user_id: TEST_QQ,
  isPrivate: true,
  isGroup: false,
  isMaster: true,
  msg: process.argv[2] || "今天好累啊",
  sender: { nickname: "测试者" },
  reply: async m => {
    const s = typeof m === "string" ? m : JSON.stringify(m)
    reply.push(s)
    console.log(`  → ${s}`)
    return { message_id: 1 }
  },
}

console.log(`\n模拟私聊消息：${JSON.stringify(e.msg)}\n`)

const p = new MiaoWu()
const t0 = Date.now()
let r
try {
  r = await p.accept(e)
  console.log(`\n  accept 返回：${JSON.stringify(r)}`)
} catch (err) {
  console.log(`\n  accept 抛错：${err.stack}`)
  process.exit(1)
}

// accept 里聊天是 fire-and-forget，等它跑完
await new Promise(res => setTimeout(res, 25000))

console.log(`\n共收到 ${reply.length} 条回复，耗时 ${Math.round((Date.now() - t0) / 1000)}s`)

const ctx = await mem.loadCtx(conf, TEST_QQ)
console.log(`上下文现在 ${Math.floor(ctx.length / 2)} 轮`)
if (ctx.length) {
  for (const m of ctx) console.log(`  ${m.role}: ${String(m.content).slice(0, 60)}`)
}

await mem.forgetAll(conf, TEST_QQ)
console.log("\n已清理测试数据")
