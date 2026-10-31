/**
 * 命令冒烟测试：把 #喵呜 的每条命令都打一遍，看会不会炸
 *
 * 用法：node plugins/miao-wu/test/mock-cmd.mjs
 *       node plugins/miao-wu/test/mock-cmd.mjs --llm   连真模型跑写人设/改人设
 *
 * 用假 QQ，不动真实存档；会临时改写 config.yaml 的 cast.default，
 * 跑完自动恢复。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEST_QQ = "999999"
const WITH_LLM = process.argv.includes("--llm")

globalThis.logger = {
  info: () => {},
  warn: (...a) => console.log("  [warn]", ...a),
  error: (...a) => console.log("  [error]", ...a),
  mark: (...a) => console.log("  [mark]", ...a),
  debug: () => {},
}
globalThis.redis = null
globalThis.Bot = { pickFriend: () => null }

let PluginBase
try {
  PluginBase = (await import("../../../lib/plugins/plugin.js")).default
} catch {
  console.log("无法加载云崽插件基类，跳过 mock（正常，这只在云崽进程内才有）")
  process.exit(0)
}

const { MiaoWu } = await import("../index.js")
const mem = await import("../lib/memory.js")
const tavern = await import("../lib/tavern.js")
const { loadConfig, CONFIG_FILE } = await import("../lib/config.js")

let pass = 0
let fail = 0
const check = (name, ok, extra = "") => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? `  ${extra}` : ""}`)
}

/* 备份 config.yaml，跑完还原（出场/开始 会改 cast.default） */
const backup = fs.readFileSync(CONFIG_FILE, "utf-8")
const restore = () => {
  try {
    fs.writeFileSync(CONFIG_FILE, backup, "utf-8")
  } catch {}
}

const conf0 = loadConfig(true)
await mem.setProfile(conf0, TEST_QQ, mem.DEFAULT_PROFILE)
await mem.forgetAll(conf0, TEST_QQ)
await tavern.clearScene(conf0, TEST_QQ)
await tavern.clearUserPersona(conf0, TEST_QQ)
await tavern.clearCameo(conf0, TEST_QQ)
// 别让开场白把输出搅乱
const confSilent = loadConfig()
confSilent.tavern.autoOpening = false
confSilent.tavern.openingOnSwitch = false

/** 发一条 #喵呜 命令，返回收到的所有回复 */
async function run(text) {
  const got = []
  const e = {
    user_id: TEST_QQ,
    isPrivate: true,
    isGroup: false,
    isMaster: true,
    msg: text,
    sender: { nickname: "测试者" },
    reply: async m => {
      got.push(typeof m === "string" ? m : JSON.stringify(m))
      return { message_id: 1 }
    },
  }
  const p = new MiaoWu()
  try {
    await p.cmd(e)
  } catch (err) {
    got.push(`!! 抛错：${err.message}`)
  }
  return got.join("\n---\n")
}

console.log("\n=== 命令冒烟 ===")

let out = await run("#喵呜 帮助")
check("帮助", out.includes("喵呜 · 命令") && out.includes("写人设"), `${[...out].length} 字`)

out = await run("#喵呜")
check("空参数 = 状态", out.includes("喵呜 · "), out.split("\n")[0])

out = await run("#喵呜 状态")
check("状态含存档", out.includes("存档："))

out = await run("#喵呜 人设")
check("人设能看到正文", out.includes("你是谁") || out.includes("鲸鱼"), `${[...out].length} 字`)

out = await run("#喵呜 场景 下雨的傍晚，便利店门口")
check("设场景", out.includes("便利店"))
out = await run("#喵呜 场景")
check("看场景", out.includes("便利店"))
out = await run("#喵呜 场景 清")
check("清场景", out.includes("清掉"))

out = await run("#喵呜 我是 他的同事，25岁，话很少")
check("设我的人设", out.includes("同事"))
out = await run("#喵呜 我是")
check("看我的人设", out.includes("同事"))
out = await run("#喵呜 我是 清")
check("清我的人设", out.includes("清掉"))

out = await run("#喵呜 同场 lizi")
check("设同场", out.includes("栗子"))
out = await run("#喵呜 同场")
check("看同场", out.includes("栗子"))
out = await run("#喵呜 同场 nope")
check("同场写错有提示", out.includes("没有这些卡"))
out = await run("#喵呜 同场 清")
check("清同场", out.includes("只剩她"))

// 用户嘴上说的是中文名，不是 id
out = await run("#喵呜 同场 栗子")
check("同场认中文名", out.includes("栗子") && !out.includes("没有这些卡"))
out = await run("#喵呜 同场 清")
out = await run("#喵呜 人设 栗子")
check("人设认中文名", out.startsWith("「栗子」"), out.split("\n")[0])
out = await run("#喵呜 出场 栗子")
check("出场认中文名", out.includes("换人了") && out.includes("栗子"))

out = await run("#喵呜 存档")
check("存档列表", out.includes("当前存档"))

out = await run("#喵呜 新建档 工作")
check("新建档", out.includes("工作"))
out = await run("#喵呜 存档")
check("新档在列表里", out.includes("工作"), out.replace(/\n/g, " / ").slice(0, 90))

await mem.pushCtx(loadConfig(), TEST_QQ, "工作里的第一句", "好")

out = await run("#喵呜 切档 default")
check("切档", out.includes("default"))
out = await run("#喵呜 复制档 工作 分支二")
check("复制档", out.includes("分支二"))
out = await run("#喵呜 删档 分支二")
check("删档", out.includes("已删"))
out = await run("#喵呜 删档 default")
check("默认档不让删", out.includes("不能删"))

out = await run("#喵呜 改 我刚才说的是这句")
check("改口", out.includes("记下了") || out.includes("还没有能改"))

// 重来：先塞两轮，再重来（noOpening，不调模型的话会真的去调 —— 所以只测空上下文分支）
await mem.forgetAll(loadConfig(), TEST_QQ)
out = await run("#喵呜 重来")
check("没聊过时重来有提示", out.includes("还没聊过"))

/* ---------------- 本地酒馆 ---------------- */
out = await run("#喵呜 酒馆")
check("酒馆状态", out.includes("酒馆 ·") && (out.includes("在线") || out.includes("没接上")), out.split("\n")[0])

out = await run("#喵呜 酒馆 角色")
check("酒馆角色列表", out.includes("张卡") || out.includes("没找到"), out.split("\n")[0])

out = await run("#喵呜 酒馆 世界书")
check("酒馆世界书", out.includes("世界书"))

out = await run("#喵呜 酒馆 预设")
check("酒馆预设", out.includes("预设"))

out = await run("#喵呜 酒馆 预设 TGbreak")
check("看预设内容", out.includes("TGbreak") || out.includes("没有"), out.split("\n")[0])

out = await run("#喵呜 酒馆 接着 三体")
check("接酒馆进度", out.includes("接上了") || out.includes("没有聊天"), out.split("\n")[0])

/* ---------------- 时钟 / 提醒 ---------------- */
out = await run("#喵呜 现在")
check("现在", out.includes("周") || out.includes(":"), out.split("\n")[0])

out = await run("#喵呜 提醒 30分钟 该吃药了")
check("提醒 相对时间", out.includes("记下了") || out.includes("没认出"), out.split("\n")[0])

out = await run("#喵呜 提醒 每天7:30 叫我起来")
check("提醒 每天重复", out.includes("记下了") && out.includes("每天"), out.split("\n")[0])

out = await run("#喵呜 提醒 明天8点 起床")
check("提醒 明天+时刻", out.includes("记下了") || out.includes("没认出"), out.split("\n")[0])

out = await run("#喵呜 提醒 列表")
check("提醒列表", out.includes("今天") || out.includes("明天") || out.includes("没有挂着"))

out = await run("#喵呜 提醒 瞎写")
check("提醒 认不出时间有提示", out.includes("没认出") || out.includes("30分钟"))

out = await run("#喵呜 提醒 清")
check("提醒 清空", out.includes("清掉了") || out.includes("本来就没有"))

/* ---------------- 上下文 / 压缩 ---------------- */
out = await run("#喵呜 上下文")
check("上下文报告", out.includes("上下文：") && out.includes("策略"), out.split("\n")[0])

out = await run("#喵呜 压缩")
check("压缩（轮数不够时会给提示）", out.includes("压好了") || out.includes("没压"), out.split("\n")[0])

/* ---------------- 体检 / 语音 / 主动 ---------------- */
out = await run("#喵呜 体检")
check("体检有逐项结果", out.includes("对话后端") && out.includes("角色卡"), out.split("\n")[0])

out = await run("#喵呜 语音")
check("语音状态", out.includes("语音："), out.split("\n")[0])

out = await run("#喵呜 语音 测试")
check("语音测试不炸", out.length > 0 && !out.includes("抛错"), out.slice(0, 40))

out = await run("#喵呜 主动")
check("主动发言设置", out.includes("主动发言：") && out.includes("语气"), out.split("\n")[0])

/* ---------------- 口令开门 / 可用者 ---------------- */
console.log("\n=== 口令与可用者 ===")
const STRANGER = "777000"
/** 命令走 cmd，闲聊走 accept —— 和云崽里的分流一致 */
async function runAs(text, { qq = STRANGER, master = false } = {}) {
  const got = []
  const e = {
    user_id: qq,
    isPrivate: true,
    isGroup: false,
    isMaster: master,
    msg: text,
    sender: { nickname: master ? "测试者" : "路人" },
    reply: async m => {
      got.push(typeof m === "string" ? m : JSON.stringify(m))
      return { message_id: 1 }
    },
  }
  const inst = new MiaoWu()
  try {
    if (/^#/.test(text.trim())) await inst.cmd(e)
    else await inst.accept(e)
  } catch (err) {
    got.push(`!! 抛错：${err.message}`)
  }
  return { got }
}

const keyOf = () => loadConfig().scope?.unlockKey || "喵呜"
let out2 = await runAs(keyOf())
check("口令能开门", out2.got.some(t => t.includes("记住了")), out2.got[0] || "（无回复）")

out2 = await runAs("#喵呜 状态")
check("进来之后命令有回应", out2.got.length > 0, out2.got[0]?.slice(0, 40))

out2 = await runAs(keyOf())
check("重复发口令不再开门", !out2.got.some(t => t.includes("记住了")), out2.got[0]?.slice(0, 40) || "（无回复）")

out2 = await runAs("#喵呜 可用者", { master: true })
check("可用者列表能看到新进来的人", out2.got.join("\n").includes(STRANGER), out2.got[0]?.slice(0, 60))

out2 = await runAs("#喵呜 重载")
check("外人动不了管理命令", out2.got[0]?.includes("只有主人"), out2.got[0]?.slice(0, 40))

out2 = await runAs("#喵呜 可用者 删 " + STRANGER, { master: true })
check("主人能把人删掉", out2.got.length > 0 && !out2.got.join("").includes("抛错"), out2.got[0]?.slice(0, 60))

out2 = await runAs("#喵呜 状态")
check("删掉之后又进不来了", out2.got.length === 0, "（无回复）")

out2 = await runAs("#喵呜 密钥 站住", { master: true })
check("能换口令", out2.got.join("").includes("站住"), out2.got[0]?.slice(0, 40))

out2 = await runAs("站住")
check("新口令能开门", out2.got.some(t => t.includes("记住了")), out2.got[0]?.slice(0, 40))

out2 = await runAs("#喵呜 可用者 删 " + STRANGER, { master: true })
check("测试收尾：把人请出去", true, out2.got[0]?.slice(0, 40))

if (WITH_LLM) {
  console.log("\n=== 连模型 ===")
  out = await run("#喵呜 写人设 一个怕打雷的猫娘，嘴硬心软，叫阿灰")
  check("写人设", out.includes("写好了"), out.split("\n")[1] || "")
  const m = out.match(/（([\w-]+)）/)
  if (m) {
    out = await run(`#喵呜 改人设 ${m[1]} 说话再懒一点，少用感叹号`)
    check("改人设", out.includes("改好"), out.split("\n")[0])
  }
  out = await run("#喵呜 开始")
  check("开始（开场白）", out.length > 4, `${[...out].length} 字`)
}

/* 收尾 */
restore()
const confEnd = loadConfig(true)
await mem.setProfile(confEnd, TEST_QQ, mem.DEFAULT_PROFILE)
await mem.deleteProfile(confEnd, TEST_QQ, "工作")
await mem.deleteProfile(confEnd, TEST_QQ, "分支二")
await mem.forgetAll(confEnd, TEST_QQ)
await tavern.clearScene(confEnd, TEST_QQ)
await tavern.clearUserPersona(confEnd, TEST_QQ)
await tavern.clearCameo(confEnd, TEST_QQ)

console.log(`\n${"=".repeat(50)}`)
console.log(`通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
