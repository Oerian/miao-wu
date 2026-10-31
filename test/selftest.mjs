/**
 * 喵呜插件自检
 *
 * 全程用假 QQ 号，不碰真实用户数据。
 *
 * 用法（从 Miao-Yunzai 目录跑）：
 *   node plugins/miao-wu/test/selftest.mjs          纯本地逻辑（快）
 *   node plugins/miao-wu/test/selftest.mjs --llm    连真实模型跑一轮对话
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.resolve(HERE, "..")

const TEST_QQ = "999999"
const WITH_LLM = process.argv.includes("--llm")

let pass = 0
let fail = 0
const check = (name, ok, extra = "") => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? `  ${extra}` : ""}`)
}

const { loadConfig, providerOf } = await import("../lib/config.js")
const { listCharacters, loadCharacter, readCharaFromPNG, parseMarkdownCard } = await import("../lib/character.js")
const { selectLore, loadLorebookFiles } = await import("../lib/lorebook.js")
const { composeSystem, cardBlock, currentCard } = await import("../lib/persona.js")
const { coreRules, cleanOutput, detectOOC, looksRepeated, enforceLength } = await import("../lib/immersion.js")
const { detectDrawIntent } = await import("../lib/draw.js")
const { splitSegments } = await import("../lib/reply.js")
const mem = await import("../lib/memory.js")

const conf = loadConfig()
console.log(`\n配置：active=${conf.active} · 角色目录=${conf.cast.dir}\n`)

/* ============================================================ 1. 角色卡 */

console.log("=== 1. 角色卡 ===")
const chars = listCharacters(conf, true)
check("扫描到角色卡", chars.length > 0, `共 ${chars.length} 张：${chars.map(c => c.id).join(", ")}`)
check("模板卡被排除（_base_catgirl 不该出现）", !chars.some(c => c.id === "_base_catgirl"))

const yh = loadCharacter(conf, "yinghua")
check("能加载 yinghua", !!yh, yh?.name)
check("description 有内容", !!yh?.description?.trim())
check("示例对话进 mesExample", /主人：在干嘛/.test(yh?.mesExample || ""))
check("说话方式进独立字段（不混进 description）", !!yh?.styleExtra && !/【说话方式】/.test(yh?.description || ""))
check("关于画图进独立字段", /画好了/.test(yh?.drawExtra || ""))

const lz = loadCharacter(conf, "lizi")
check("能加载 lizi", !!lz, lz?.name)
check("继承到父卡的说话方式", !!lz?.styleExtra, `styleExtra ${[...(lz?.styleExtra || "")].length} 字`)
check("继承到父卡的关于画图", /撒谎|画好了/.test(lz?.drawExtra || ""))
check("继承到父卡的小习惯", !!lz?.habitExtra)
check("自己的 description 覆盖了父卡", /栗子/.test(lz?.description || "") && !/化成人形的猫娘，住在主人家里/.test(lz?.description || ""))
check("继承链记录在 meta", Array.isArray(lz?.meta?.inheritedFrom) && lz.meta.inheritedFrom.includes("_base_catgirl"))

// PNG 解析不崩
const anyPng = "E:\\YunzaiBot\\runtime\\draw\\whale-2026-10-28T13-14-07.png"
if (fs.existsSync(anyPng)) {
  const r = readCharaFromPNG(fs.readFileSync(anyPng))
  check("普通 PNG 安全返回 null（不当成角色卡）", r === null)
}

/* ============================================================ 2. 世界书 */

console.log("\n=== 2. 世界书 ===")
const loreFiles = loadLorebookFiles(conf, true)
check("加载到世界书条目", loreFiles.length > 0, `${loreFiles.length} 条`)

const hit1 = selectLore(conf, yh, "今天下雨了，好烦", "")
check("关键词命中（下雨）", hit1.hits.length > 0, hit1.hits.join(", "))
check("常驻条目也进去了", /老槐树/.test(hit1.text))

const hit2 = selectLore(conf, yh, "随便聊聊吧", "")
check("闲聊只注入常驻条目", hit2.hits.length >= 2 && !/鱼缸/.test(hit2.text), hit2.hits.join(", "))

/* ============================================================ 3. 提示词 */

console.log("\n=== 3. 提示词组装 ===")
const rules = coreRules(conf, yh)
check("核心规则含防 OOC", /不能说自己是 AI/.test(rules))
check("核心规则含字数限制", /不超过 \d+ 字/.test(rules))

const cardPart = cardBlock(yh)
check("卡片段落含说话方式", /说话方式/.test(cardPart))
check("卡片段落含示例对话", /模仿这个语气/.test(cardPart))

const { system, loreHits } = await composeSystem(conf, TEST_QQ, yh, { nickname: "测试者", idleMin: 30, userText: "今天下雨了" })
check("system 有分层", system.includes("角色扮演") && system.includes("现在"))
check("system 含真实时间", /现在（真实世界的时间）/.test(system) && /\d{1,2}:\d{2}/.test(system), system.includes("真实世界") ? "" : "没注入时钟")
check("system 含世界书", system.includes("老槐树"), loreHits.join(","))
check("system 长度合理", [...system].length < 12000, `${[...system].length} 字`)

/* ============================================================ 4. 记忆 */

console.log(`\n=== 4. 记忆（假 QQ ${TEST_QQ}）===`)
await mem.forgetAll(conf, TEST_QQ)
await mem.pushCtx(conf, TEST_QQ, "我叫阿明", "记住了")
const ctx = await mem.loadCtx(conf, TEST_QQ)
check("写读上下文", ctx.length === 2, `${ctx.length} 条`)

await mem.setFact(conf, TEST_QQ, "名字", "阿明")
const facts = await mem.factsLine(conf, TEST_QQ)
check("实体记忆", /名字：阿明/.test(facts), facts)

await mem.addEpisode(conf, TEST_QQ, "主人说他下周三要出差")
const eps = await mem.listEpisodes(conf, TEST_QQ)
check("情景记忆", eps.length === 1 && /出差/.test(eps[0].text))

await mem.setCast(conf, TEST_QQ, "lizi", "栗子")
const cast = await mem.getCast(conf, TEST_QQ)
check("出场状态", cast?.current === "lizi", cast?.name)

// 切人后 currentCard 应该跟着变
const cur = await currentCard(conf, TEST_QQ)
check("currentCard 跟着出场状态走", cur.card?.id === "lizi", cur.card?.name)

// 交接：切回鲸鱼娘，应该能拿到 prevCast
await mem.setCast(conf, TEST_QQ, "yinghua", "鲸鱼娘")
const cast2 = await mem.getCast(conf, TEST_QQ)
check("出场历史有记录", (cast2?.history?.length ?? 0) >= 2, `${cast2?.history?.length ?? 0} 条`)

/* ============================================================ 5. 压缩 */

console.log("\n=== 5. 上下文压缩 ===")
await mem.forgetAll(conf, TEST_QQ)
for (let i = 0; i < 20; i++) {
  await mem.pushCtx(conf, TEST_QQ, `测试消息 ${i}`, `回复 ${i}`)
  await new Promise(r => setTimeout(r, 2))
}
const before = await mem.loadCtx(conf, TEST_QQ)
check("造了 20 轮", Math.floor(before.length / 2) === 20, `${Math.floor(before.length / 2)} 轮`)

const { maybeCompress } = await import("../lib/compress.js")
const provForCompress = providerOf(conf, conf.compress?.provider || "")
if (WITH_LLM) {
  const r = await maybeCompress(conf, TEST_QQ, provForCompress, yh)
  check("触发压缩", !!r, r ? `压掉 ${r.compressed} 轮，摘要 ${[...r.summary].length} 字` : "没触发")
  if (r) {
    const after = await mem.loadCtx(conf, TEST_QQ)
    const sum = await mem.getSummary(conf, TEST_QQ)
    check("压缩后轮数变少", Math.floor(after.length / 2) < 20, `${Math.floor(after.length / 2)} 轮`)
    check("摘要非空", !!sum.text, `${[...sum.text].length} 字`)
    console.log(`\n  摘要内容：\n${sum.text.split("\n").map(l => "  " + l).join("\n")}\n`)
  }
} else {
  console.log("· 跳过（加 --llm 会真跑压缩）")
}

/* ============================================================ 6. 输出清洗 */

console.log("\n=== 6. 输出清洗与破戏检测 ===")
const dirty = '**鲸鱼娘**：唔…（揉了揉眼睛）\n\n"今天好安静"'
const clean = cleanOutput(dirty, { name: "鲸鱼娘" })
check("剥掉 markdown 和名字前缀", !clean.includes("**") && !clean.includes("鲸鱼娘："), JSON.stringify(clean))

check("识别 AI 腔", !!detectOOC("作为一个AI，我不能这样"))
check("正常台词不误判", !detectOOC("唔…那你躺下吧。我不吵你。"))
check("识别复读", looksRepeated("今天好安静啊", ["今天好安静啊"]))
check("不同的话不算复读", !looksRepeated("我才不要", ["今天好安静啊"]))
check("超长截断", [...enforceLength("一".repeat(200), 40)].length <= 41)

/* ============================================================ 7. 分句 */

console.log("\n=== 7. 分句 ===")
const segs = splitSegments("唔…那你躺下吧。我不吵你。被子分你一半。还有别的事吗？", { maxSegments: 3 })
check("切成 1~3 段", segs.length >= 1 && segs.length <= 3, `${segs.length} 段：${JSON.stringify(segs)}`)
check("括号内不切", splitSegments("（揉了揉眼睛）好困。", { maxSegments: 3 }).length <= 2)

/* ============================================================ 8. 绘图意图 */

console.log("\n=== 8. 绘图意图 ===")
const FRESH = { hasLastPlan: true, planAgeMs: 60000, drawing: false }
const NONE = { hasLastPlan: false, planAgeMs: 0, drawing: false }
const DRAW_CASES = [
  ["画个猫耳少女", FRESH, "new"],
  ["猫耳，棕发", FRESH, "refine"],
  ["改成棕发", FRESH, "refine"],
  ["还有多久出图", FRESH, "query"],
  ["画好了吗", FRESH, "query"],
  ["在干嘛", FRESH, null],
  ["我喜欢棕色", FRESH, null],
  ["不要它了", FRESH, null],
  ["猫耳，棕发", NONE, null],
  // 「喂」「嗯」曾被当成属性枚举去重画 —— 用户为这个生过气
  ["喂", FRESH, null],
  ["嗯", FRESH, null],
  ["…", FRESH, null],
  ["哈哈哈", FRESH, null],
  ["在吗", FRESH, null],
  ["我回来了", FRESH, null],
  // 带情绪的改图要求也要认
  ["白发！琥珀色瞳孔！我愤怒！", FRESH, "refine"],
  ["要换白发和琥珀色的瞳孔", FRESH, "refine"],
  ["白发, 红眼", FRESH, "refine"],
  ["猫耳 双马尾", FRESH, "refine"],
  // 删除类：被删的东西不在词表里也要认
  ["去掉项链", FRESH, "refine"],
  ["别要项链", FRESH, "refine"],
  ["不要这个", FRESH, null],
  // 催图
  ["我！的！画！呢！", FRESH, "query"],
  ["图呢", FRESH, "query"],
  ["画到哪了", FRESH, "query"],
  ["画到哪了", NONE, null],
]
let dfail = 0
for (const [t, ctx, want] of DRAW_CASES) {
  const r = detectDrawIntent(t, ctx)
  const got = r.isDraw ? r.mode : null
  if (got !== want) {
    dfail++
    console.log(`  ✗ ${JSON.stringify(t)} -> ${got}（期望 ${want}）`)
  }
}
check(`绘图意图 ${DRAW_CASES.length - dfail}/${DRAW_CASES.length}`, dfail === 0)

/* ============================================================ 9. 酒馆 */

console.log("\n=== 9. 酒馆（开场白 / 场景 / 我是谁 / 同场）===")
const tavern = await import("../lib/tavern.js")

await mem.setProfile(conf, TEST_QQ, mem.DEFAULT_PROFILE)
await mem.forgetAll(conf, TEST_QQ)
await tavern.clearScene(conf, TEST_QQ)
await tavern.clearUserPersona(conf, TEST_QQ)
await tavern.clearCameo(conf, TEST_QQ)

const op = tavern.openingFor(yh)
check("开场白取到了", !!op, `${[...op].length} 字：${op.slice(0, 30)}`)
check("没有开场白的卡返回空串", tavern.openingFor({ firstMes: "", greetingPool: [] }) === "")
check("多张开场白会从中挑", ["a", "b"].includes(tavern.openingFor({ firstMes: "", greetingPool: ["a", "b"] })))

await tavern.setScene(conf, TEST_QQ, "下雨的傍晚，便利店门口")
check("场景写进去", (await tavern.getScene(conf, TEST_QQ)).includes("便利店"))

await tavern.setUserPersona(conf, TEST_QQ, "他的同事，25岁，话很少")
check("用户人设写进去", (await tavern.getUserPersona(conf, TEST_QQ)).includes("同事"))

await tavern.setCameo(conf, TEST_QQ, ["lizi"])
check("同场角色写进去", (await tavern.getCameo(conf, TEST_QQ)).join() === "lizi")

const sysT = (await composeSystem(conf, TEST_QQ, yh, { nickname: "测试者", idleMin: 3 })).system
check("system 含用户人设", sysT.includes("对方是谁"))
check("system 含场景锚", sysT.includes("此刻的场景"))
check("system 含同场角色", sysT.includes("现在还有谁在"))
check("同场只给摘要不给全文", sysT.split("现在还有谁在").length === 2 && !sysT.includes("栗子：\n"))

await tavern.clearScene(conf, TEST_QQ)
await tavern.clearUserPersona(conf, TEST_QQ)
await tavern.clearCameo(conf, TEST_QQ)
const sysT2 = (await composeSystem(conf, TEST_QQ, yh, { nickname: "测试者" })).system
check("清掉后 system 不再带这些", !sysT2.includes("此刻的场景") && !sysT2.includes("对方是谁"))
check("内部键没污染「关于他」", !(await mem.factsLine(conf, TEST_QQ)).includes("便利店"))

/* ============================================================ 10. 命名存档 */

console.log("\n=== 10. 命名存档 ===")
await mem.forgetAll(conf, TEST_QQ)
await mem.pushCtx(conf, TEST_QQ, "默认存档的第一句", "嗯")
check("默认存档名", (await mem.getProfile(conf, TEST_QQ)) === mem.DEFAULT_PROFILE)

await mem.setProfile(conf, TEST_QQ, "工作")
await mem.forgetAll(conf, TEST_QQ)
await mem.pushCtx(conf, TEST_QQ, "工作存档的第一句", "好")
const workCtx = await mem.loadCtx(conf, TEST_QQ)
check("新存档是独立的", workCtx.length === 2 && workCtx[0].content.includes("工作存档"))

await mem.setProfile(conf, TEST_QQ, mem.DEFAULT_PROFILE)
const defCtx = await mem.loadCtx(conf, TEST_QQ)
check("切回来还是原来那份", !!defCtx[0]?.content.includes("默认存档"))

const plist = await mem.listProfiles(conf, TEST_QQ)
check("两个存档都在列表里", plist.includes("工作") && plist.includes(mem.DEFAULT_PROFILE), plist.join(" / "))

const cp = await mem.copyProfile(conf, TEST_QQ, mem.DEFAULT_PROFILE, "分支二")
check("复制存档", cp.ok, cp.msg)
await mem.setProfile(conf, TEST_QQ, "分支二")
check("分支里的内容跟源一样", !!(await mem.loadCtx(conf, TEST_QQ))[0]?.content.includes("默认存档"))

const del = await mem.deleteProfile(conf, TEST_QQ, "分支二")
check("删存档", del.ok && !(await mem.listProfiles(conf, TEST_QQ)).includes("分支二"))
check("不能删默认存档", !(await mem.deleteProfile(conf, TEST_QQ, mem.DEFAULT_PROFILE)).ok)
check("存档名会被清洗", mem.sanitizeProfile("a:b/c d") === "a_b_c_d")

await mem.setProfile(conf, TEST_QQ, mem.DEFAULT_PROFILE)
await mem.deleteProfile(conf, TEST_QQ, "工作")

/* ============================================================ 11. 人设助手 */

console.log("\n=== 11. 人设助手（不调模型，只验解析）===")
const pw = await import("../lib/persona-writer.js")
const rawMd =
  "```markdown\n---\nid: xiaoman\nname: 小满\n---\n\n## 你是谁\n\n修自行车的女孩，脾气冲。\n```"
const fixed = pw.normalizeCardMarkdown(rawMd)
check("洗掉 ``` 包裹", fixed.startsWith("---") && !fixed.includes("```"))
const c2 = parseMarkdownCard(fixed, "xiaoman")
check("解析出名字和正文", c2.name === "小满" && c2.description.includes("自行车"))
check("slug 优先用 front-matter 的 id", pw.slugOf(c2.name, fixed) === "xiaoman")
check("预览会截断", [...pw.previewOf("字".repeat(2000), 100)].length <= 110)

/* ============================================================ 12. 真跑一轮 */

if (WITH_LLM) {
  console.log("\n=== 12. 真实对话（假 QQ，不碰真实数据）===")
  await mem.forgetAll(conf, TEST_QQ)
  const { buildMessages } = await import("../lib/persona.js")
  const { chat } = await import("../lib/llm.js")
  const prov = providerOf(conf)

  for (const [userText, label] of [
    ["在干嘛", "日常"],
    ["你尾巴露出来了", "被拆穿"],
    ["今天好累啊", "安慰"],
  ]) {
    const { messages } = await buildMessages(conf, TEST_QQ, yh, userText, { nickname: "测试者", idleMin: 5 })
    const t0 = Date.now()
    let out = await chat(prov, messages, { maxTokens: conf.chat.maxTokens, temperature: conf.chat.temperature })
    out = enforceLength(cleanOutput(out, { name: yh.name }), conf.chat.maxReplyChars)
    check(`${label}：${JSON.stringify(userText)}`, !!out && !detectOOC(out), `${Date.now() - t0}ms · ${[...out].length}字`)
    console.log(`   她：${out}`)
    await mem.pushCtx(conf, TEST_QQ, userText, out)
  }
}

/* ============================================================ 12.5 工具自主调用 */

{
  const { parseToolCalls, toolsBlock } = await import("../lib/tools.js")

  const p1 = parseToolCalls("喏，画好了～\n[[画:鲸鱼娘趴在窗边晒太阳]]")
  check("工具：解析画图标记", p1.calls.length === 1 && p1.calls[0].name === "draw" && p1.calls[0].arg === "鲸鱼娘趴在窗边晒太阳")
  check("工具：标记被剥掉", !p1.text.includes("[[") && p1.text.includes("画好了"))

  const p2 = parseToolCases()
  function parseToolCases() {
    const a = parseToolCalls("[[画改:换成夜景]]")
    const b = parseToolCalls("[[语音]]晚安，做个好梦")
    const c = parseToolCalls("[[画:A]] 然后呢 [[画:B]]")
    const d = parseToolCalls("普通聊天，没有标记")
    const e = parseToolCalls("[[画:]]")
    return [
      ["画改别名", a.calls[0]?.name === "drawRefine" && a.calls[0]?.arg === "换成夜景"],
      ["语音标记", b.calls[0]?.name === "voice" && b.text === "晚安，做个好梦"],
      ["同类去重", c.calls.length === 1 && c.calls[0].arg === "A"],
      ["无标记不误伤", d.calls.length === 0 && d.text.includes("普通聊天")],
      ["空参数保留", e.calls.length === 1 && e.calls[0].arg === ""],
    ]
  }
  for (const [name, ok] of p2) check(`工具：${name}`, ok)

  check("工具：说明块（画开tts关）", toolsBlock({ draw: { enabled: true }, tts: { enabled: false } }).includes("[[画:") && !toolsBlock({ draw: { enabled: true }, tts: { enabled: false } }).includes("[[语音]]"))
  check("工具：说明块（画关无画标记）", !toolsBlock({ draw: { enabled: false }, tts: { enabled: false } }).includes("[[画:"))
  check("工具：tts 开则含语音", toolsBlock({ draw: { enabled: true }, tts: { enabled: true } }).includes("[[语音]]"))
}

/* ============================================================ 12.6 酒馆助手等价层 */

{
  const tx = await import("../lib/tavernext.js")

  // 正则脚本
  const cardRx = {
    regex: [
      { find: "<think>[\\s\\S]*?</think>", replace: "", target: "output" },
      { find: "主人", replace: "宿主", target: "input" },
      { find: "([", replace: "x" },
      { find: "aaa", replace: "b", target: "nope" },
    ],
  }
  check("酒馆助手：输出规则生效", tx.applyRegexRules(cardRx, "<think>思考</think>你好", "output") === "你好")
  check("酒馆助手：输入规则生效", tx.applyRegexRules(cardRx, "主人早安", "input") === "宿主早安")
  check("酒馆助手：坏正则不炸", tx.applyRegexRules(cardRx, "看看([这个", "output") === "看看([这个")
  check("酒馆助手：target 隔离", tx.applyRegexRules(cardRx, "主人早安", "output") === "主人早安")

  // 宏
  const macroOut = tx.expandMacros("{{char}}对{{nick}}说：{{random:早安|晚安}} {{var:好感度}} {{eval 1+1}}", {
    char: "鲸鱼娘", nick: "小明", vars: { 好感度: 42 },
  })
  check("酒馆助手：宏 char/nick", macroOut.startsWith("鲸鱼娘对小明说："))
  check("酒馆助手：宏 random 取值合法", /早安|晚安/.test(macroOut))
  check("酒馆助手：宏 var 取值", macroOut.includes("42"))
  check("酒馆助手：宏 不执行代码", macroOut.includes("{{eval 1+1}}"))

  // 变量标记（真实存档）
  const vt1 = await tx.applyVarTags(conf, TEST_QQ, "（她悄悄记下）[[变量:好感度=+2]] [[变量:地点=海边]]")
  check("酒馆助手：变量标记剥离", !vt1.text.includes("[[变量") && vt1.text.includes("（她悄悄记下）"))
  check("酒馆助手：变量写入", vt1.changed.includes("好感度=2") && vt1.changed.includes("地点=海边"))
  const vars = await tx.getVars(conf, TEST_QQ)
  check("酒馆助手：变量读回", vars["好感度"] === 2 && vars["地点"] === "海边")
  await tx.applyVarTags(conf, TEST_QQ, "[[变量:好感度=+3]]")
  check("酒馆助手：相对加减", (await tx.getVars(conf, TEST_QQ))["好感度"] === 5)

  // 快捷选项
  const opt = tx.parseOptions("要去哪？[[选项:海边|山上|家里]]")
  check("酒馆助手：选项解析", opt.options.join(",") === "海边,山上,家里" && !opt.text.includes("[["))
  await tx.saveOptions(conf, TEST_QQ, opt.options)
  check("酒馆助手：选项命中", await tx.takeOption(conf, TEST_QQ, "2") === "山上")
  check("酒馆助手：选项一次性", await tx.takeOption(conf, TEST_QQ, "2") === null)
  await tx.saveOptions(conf, TEST_QQ, ["a", "b"])
  check("酒馆助手：非数字不命中", await tx.takeOption(conf, TEST_QQ, "嗯嗯") === null)

  // 表情
  check("酒馆助手：表情解析", tx.parseFaceTag("好耶！[[表情:偷笑]]") === 28)
  check("酒馆助手：表情数字兜底", tx.parseFaceTag("[[表情:100]]") === 100)
  check("酒馆助手：表情未知名", tx.parseFaceTag("[[表情:比心]]") === null)
  check("酒馆助手：表情剥离", tx.stripFaceTag("好耶！[[表情:偷笑]]") === "好耶！")

  // 软召回
  await mem.addEpisode(conf, TEST_QQ, "两人在海边散步，她说最喜欢晚上的海", "event")
  await mem.addEpisode(conf, TEST_QQ, "在图书馆一起补作业，她睡着了", "event")
  await mem.addEpisode(conf, TEST_QQ, "第一次一起吃火锅，她被辣哭了", "event")
  const recalled = await mem.recallEpisodes(conf, TEST_QQ, "还记得海边的晚上吗", 2)
  check("软召回：相关记忆排前", recalled.length >= 1 && recalled[0].text.includes("海边"))
  const recalled2 = await mem.recallEpisodes(conf, TEST_QQ, "", 2)
  check("软召回：空查询退化为按时间", recalled2.length >= 1 && recalled2[recalled2.length - 1].text.includes("火锅"))

  // 状态栏
  check("酒馆助手：无状态栏为 null", tx.statebarHtml({}) === null)
  const sb = tx.statebarHtml({ statebar: "<div>{{char}} · 好感 {{var:好感度}}</div>" }, { char: "鲸鱼娘", vars: { 好感度: 5 } })
  check("酒馆助手：状态栏展开", sb === "<div>鲸鱼娘 · 好感 5</div>")
}

/* ============================================================ 12.7 安全 */

{
  // 角色卡 id 路径穿越：../../../../windows/win.ini 之类必须拿不到
  const evil = await loadCharacter(conf, "..\\..\\..\\Windows\\win.ini")
  check("安全：反斜杠穿越被拒", evil === null)
  const evil2 = await loadCharacter(conf, "../../../etc/passwd")
  check("安全：正斜杠穿越被拒", evil2 === null)
  const evil3 = await loadCharacter(conf, "..")
  check("安全：.. 单独也被拒", evil3 === null)
  const ok = await loadCharacter(conf, "lizi")
  check("安全：正常 id 不受影响", ok?.name === "栗子")

  // 宏不执行代码（前面 12.6 已覆盖 {{eval}}），这里补正则规则不能把输入变成调用
  const { applyRegexRules } = await import("../lib/tavernext.js")
  const hostile = applyRegexRules(
    { regex: [{ find: "x", replace: "[[画:炸弹图]]", target: "input" }] },
    "x 你好",
    "input",
  )
  check("安全：卡正则替换产物仍走标记解析（不会绕过执行层）", hostile === "[[画:炸弹图]] 你好")

  // 超长 find 直接跳过（防 ReDoS 载荷）
  const long = applyRegexRules({ regex: [{ find: "(a+)+$".padEnd(600, "a"), replace: "!" }] }, "aaaa", "output")
  check("安全：超长正则规则被跳过", long === "aaaa")
}

/* ============================================================ 12.8 表情包 */

{
  const meme = await import("../lib/meme.js")
  const conf2 = { ...conf, memory: { ...(conf.memory || {}), dataDir: "data/test-memes" } }

  // 收藏 + sha1 去重
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const r1 = meme.addMeme(conf2, fakePng, { caption: "一只猫翻白眼", emotion: "无语", tags: ["猫", "翻白眼"], from: "测试" }, "image/png")
  check("表情包：收藏成功", r1.ok === true)
  const r2 = meme.addMeme(conf2, fakePng, { caption: "重复图" }, "image/png")
  check("表情包：sha1 去重", r2.ok === false && r2.dup === true)

  // 按描述找
  meme.addMeme(conf2, Buffer.concat([fakePng, Buffer.from([1])]), { caption: "震惊猫猫头", emotion: "震惊", tags: ["震惊"] }, "image/png")
  const hit = meme.findMeme(conf2, "震惊")
  check("表情包：按描述命中", hit?.emotion === "震惊")
  const rand = meme.findMeme(conf2, "完全不相干的查询词组")
  check("表情包：不命中也兜底随机", !!rand)

  // 列表 / 删除
  check("表情包：列表有数", meme.listMemes(conf2).length === 2)
  check("表情包：删除", meme.removeMeme(conf2, meme.listMemes(conf2)[0].id) && meme.listMemes(conf2).length === 1)

  // 上限挤兑
  const conf3 = { ...conf2, meme: { maxCount: 2 } }
  meme.addMeme(conf3, Buffer.concat([fakePng, Buffer.from([2])]), { caption: "第三张" }, "image/png")
  meme.addMeme(conf3, Buffer.concat([fakePng, Buffer.from([3])]), { caption: "第四张" }, "image/png")
  const afterMax = meme.listMemes(conf3)
  check("表情包：超上限挤掉最旧", afterMax.length === 2 && afterMax[afterMax.length - 1].caption === "第四张")

  // 配字 HTML：转义 + 分行
  const html = meme.memeHtml("file:///x.png", "<script>alert(1)</script>", "底部")
  check("表情包：配字 HTML 转义", html.includes("&lt;script&gt;") && !html.includes("<script>"))
  check("表情包：上下两行都有", html.includes('<div class="cap top">') && html.includes('<div class="cap bottom">'))
  const one = meme.memeHtml("x.png", "只有顶上一行", "")
  check("表情包：空行不渲染", one.includes('<div class="cap top">') && !one.includes('<div class="cap bottom">'))

  // 清理测试目录
  try { fs.rmSync("data/test-memes", { recursive: true, force: true }) } catch { }
}

/* ============================================================ 收尾 */

await mem.forgetAll(conf, TEST_QQ)
console.log(`\n${"=".repeat(50)}`)
console.log(`通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
