/**
 * 帮助卡片
 *
 * 把命令表渲染成一张图（云崽自带 puppeteer 渲染器）。
 * 渲染失败或不在云崽进程里时返回 null，调用方回落到文字版。
 */
import path from "node:path"
import { PLUGIN_DIR } from "./config.js"

/* ------------------------------------------------------------ 数据 */

const G_ROLE = {
  title: "角色",
  items: [
    { cmd: "角色", desc: "列出所有角色卡" },
    { cmd: "人设 [id]", desc: "看某张卡的全文" },
    { cmd: "出场 <id|名字>", desc: "换人出场（自动开场白）" },
    { cmd: "开始 [id]", desc: "让她重新开场一次" },
    { cmd: "导入 <路径>", desc: "导入 md / json / png 卡" },
    { cmd: "写人设 <需求>", desc: "让 AI 写一张新卡" },
    { cmd: "改人设 <id> <要求>", desc: "让 AI 改卡（自动备份）" },
  ],
}

const G_TAVERN = {
  title: "酒馆",
  items: [
    { cmd: "场景 <描述>", desc: "设临时场景（清 清掉）" },
    { cmd: "我是 <人设>", desc: "你在故事里是谁" },
    { cmd: "同场 <id…>", desc: "让别的角色也在场" },
    { cmd: "重来", desc: "撤回上一轮重说" },
    { cmd: "改 <那句话>", desc: "改写她刚说的那句" },
    { cmd: "存档", desc: "看所有记忆存档" },
    { cmd: "切档 <名>", desc: "切到另一个存档" },
    { cmd: "新建档 <名>", desc: "开一段空的" },
    { cmd: "复制档 <旧> <新>", desc: "带着进度开分支" },
    { cmd: "删档 <名>", desc: "删掉一个存档" },
  ],
}

const G_MEM = {
  title: "记忆",
  items: [
    { cmd: "记忆", desc: "看记住了什么" },
    { cmd: "上下文", desc: "上下文吃了多少（按模型算）" },
    { cmd: "压缩", desc: "手动压一次（压完会淡一点）" },
    { cmd: "忘 [保留]", desc: "清记忆（保留 保资料）" },
  ],
}

const G_CLOCK = {
  title: "时钟",
  items: [
    { cmd: "现在", desc: "几点、周几、什么节日" },
    { cmd: "提醒 30分钟 吃药", desc: "到点她来找你" },
    { cmd: "提醒 每天7:30 起床", desc: "每天重复" },
    { cmd: "提醒 列表", desc: "看 / 取消 / 清空" },
  ],
}

const G_DRAW = {
  title: "绘图",
  items: [
    { cmd: "画 <描述>", desc: "指定描述出图" },
    { cmd: "lora", desc: "列出可用 LoRA" },
  ],
}

const G_MISC = {
  title: "其它",
  items: [
    { cmd: "状态", desc: "状态卡" },
    { cmd: "帮助", desc: "这张图" },
    { cmd: "可用者", desc: "谁能用（加/删/清）" },
    { cmd: "密钥 [词]", desc: "换进来的口令" },
    { cmd: "体检", desc: "本地服务挨个探一遍" },
    { cmd: "语音 [开]", desc: "语音合成 / 试听" },
    { cmd: "主动 [开/关]", desc: "主动发言的设置" },
    { cmd: "说", desc: "立刻让她开口" },
    { cmd: "测试 <话>", desc: "跳过上下文直测一句" },
    { cmd: "探活", desc: "测后端连通" },
    { cmd: "调试 [关]", desc: "开关 prompt 日志" },
    { cmd: "关 / 开", desc: "闭嘴 / 说话" },
    { cmd: "重载", desc: "改完配置和角色卡后生效" },
  ],
}

/** 酒馆直连（SillyTavern）。只有配了才显示 */
const G_ST = {
  title: "本地酒馆",
  items: [
    { cmd: "酒馆", desc: "连通状态与内容统计" },
    { cmd: "酒馆 角色", desc: "列出酒馆里的卡" },
    { cmd: "酒馆 导入 <名>", desc: "把那张卡导进喵呜" },
    { cmd: "酒馆 聊天 <角色>", desc: "列出它的聊天记录" },
    { cmd: "酒馆 接着 <角色> [文件]", desc: "接上那段进度" },
    { cmd: "酒馆 导出 [名]", desc: "把当前对话存成酒馆聊天" },
    { cmd: "酒馆 世界书", desc: "列出并导入世界书" },
    { cmd: "酒馆 预设", desc: "看酒馆里的预设/破限" },
  ],
}

/**
 * @param {object} opts { conf, card, cards, profile, stOn }
 * @returns {object} 传给渲染器的模板数据
 */
export function buildHelpData(opts = {}) {
  const { conf, card, cards = 0, profile = "default", stOn = false, clock = "" } = opts
  // 两栏分配要平衡：左下角留一个矮组，免得右栏拖出一大片空白
  const left = [G_ROLE, G_TAVERN, G_MEM, G_DRAW]
  const right = [G_CLOCK, ...(stOn ? [G_ST] : []), G_MISC]

  const p = conf?.providers?.[conf?.active]
  const provider = p?.model ? `${conf.active} / ${p.model}` : conf?.active || "?"

  return {
    tplFile: path.join(PLUGIN_DIR, "resources", "help", "help.html"),
    saveId: "miao-wu-help",
    imgType: "png",
    cols: [left, right],
    meta: {
      role: card?.name || "（无角色卡）",
      cards,
      profile,
      provider,
      clock,
    },
  }
}

/* ------------------------------------------------------------ 渲染 */

/**
 * 渲染成图片。不在云崽进程里（没有 segment / 没有浏览器）就返回 null。
 * @returns {Promise<any|null>} segment 图片段
 */
export async function helpImage(data) {
  if (typeof globalThis.segment?.image !== "function") return null
  try {
    const { default: puppeteer } = await import("../../../lib/puppeteer/puppeteer.js")
    const img = await puppeteer.screenshot("miao-wu/help", data)
    return img || null
  } catch (err) {
    ;(globalThis.logger || console).warn?.(`[miao-wu] 帮助图渲染失败：${err.message}`)
    return null
  }
}
