/**
 * 配置加载：mtime 热加载 + 默认值深合并
 *
 * 改完 config.yaml 不需要重启机器人，下次消息自动生效。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "yaml"

export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const CONFIG_FILE = path.join(PLUGIN_DIR, "config", "config.yaml")

const log = () => globalThis.logger || console

/** 默认配置。用户 config.yaml 里没写的字段全用这里的 */
export const DEFAULTS = {
  /** 启用插件。关掉后完全静默，不响应任何消息 */
  enabled: true,
  /** 默认后端名字，对应 providers 的 key */
  active: "gemini-flash",

  providers: {},

  /** 生效范围 */
  scope: {
    private: true,
    group: false,
    /** true = 只服务主人和 whitelist 里的人；false = 私聊谁都能用 */
    masterOnly: true,
    whitelist: [],
    blacklist: [],
    /**
     * 别人私聊发这一个词（默认「喵呜」），就自动进 whitelist，从此能聊。
     * 给朋友开门不想手动改配置时用这个。
     */
    unlockEnabled: true,
    unlockKey: "喵呜",
    /** 有人解锁时给主人发个通知 */
    unlockNotify: true,
    /** 群聊白名单，空 = 所有群都行（前提是 group 开了） */
    groupWhitelist: [],
    /** 带这些前缀的消息不接管（留给别的插件） */
    ignorePrefix: ["#", "/"],
    /** 超长消息直接拒绝 */
    maxChars: 500,
  },

  /** 对话 */
  chat: {
    maxTurns: 12,
    ttlMin: 240,
    temperature: 1.0,
    maxTokens: 400,
    /** 单条回复最多多少字（超了会被截） */
    maxReplyChars: 80,
  },

  /**
   * 工具自主调用
   *
   * 给角色模型说明她能做什么（画画/发语音），模型自己在回复里嵌
   * [[画:…]] / [[画改:…]] / [[语音]] 标记，插件解析后执行。
   * 关掉后回退到纯正则意图识别。
   */
  tools: {
    enabled: true,
  },

  /**
   * 表情包系统
   *
   * 识别（云端多模态优先，本地 Ollama 视觉模型兜底）→ 自动收藏（sha1 去重）
   * → [[发表情:描述]] 甩图 / [[做表情:上字|下字]] 配字制作。
   */
  meme: {
    enabled: true,
    /** 收到表情包自动入库 */
    autoCollect: true,
    /** 库上限，满了挤掉最旧最少用的 */
    maxCount: 100,
    /** 云端识图开关（走当前对话后端的多模态，如 Gemini） */
    visionCloud: true,
    /** 本地兜底视觉（Ollama）。false = 只用云端 */
    localVision: true,
    localModel: "qwen3-vl-4b",
    ollamaUrl: "http://127.0.0.1:11434",
  },

  /**
   * 上下文压缩
   *
   * mode：
   *   remind —— 到线只提醒，等你说「#喵呜 压缩」才真压（默认）
   *   auto   —— 到线自动压（省事，但摘要毕竟有损，可能把语气压淡）
   *   manual —— 完全不提，只有你主动发命令才压
   *
   * 为什么默认改成 remind：不同模型的上下文窗口差很多，
   * 而且摘要是有损压缩 —— 压早了角色会"变淡"，压晚了直接报超长。
   * 交给你决定比交给阈值决定安全。
   */
  compress: {
    enabled: true,
    mode: "remind",
    /** 超过这么多轮就提醒 / 压缩 */
    triggerTurns: 16,
    /** 压缩后保留最近几轮原样 */
    keepTurns: 8,
    /** 摘要最多多少字 */
    maxSummaryChars: 600,
    /** 摘要用哪个后端，空 = 跟 active 一样 */
    provider: "",
    /** 上下文占用超过这个比例就提醒（0~1） */
    warnRatio: 0.75,
    /** 两次提醒最小间隔（分钟），防刷屏 */
    remindCooldownMin: 30,
    /**
     * 轮数触发的前提：窗口至少用掉这个比例。
     * 1M 窗口的模型不该按 16 轮就喊"装满了"，真正说了算的是 warnRatio。
     */
    turnsFloorRatio: 0.5,
    /** 摘要里额外保住"她是谁、怎么说话"，避免压缩后变味 */
    keepCharacter: true,
  },

  /** 记忆库 */
  memory: {
    enabled: true,
    /** 默认存档名。一个 QQ 可以开多份互不干扰的记忆 */
    defaultProfile: "default",
    /** 情景记忆最多留几条 */
    maxEpisodes: 200,
    /** 每轮对话后是否自动抽事件（会多花一次便宜模型的调用） */
    autoExtract: false,
    /** 自动抽取用哪个后端 */
    extractProvider: "",
    /** 双写落盘目录（相对 PLUGIN_DIR） */
    dataDir: "data",
  },

  /** 出场人物 / 角色 */
  cast: {
    /** 默认出场角色 id */
    default: "",
    /** 允许被切换的角色，空 = 全部允许 */
    allowed: [],
    /** 角色卡目录（相对 PLUGIN_DIR） */
    dir: "config/characters",
    /** 切换角色时是否生成"交接"信息，让新角色知道刚才谁在聊 */
    handover: true,
    /** 交接信息保留几轮对话 */
    handoverTurns: 6,
    /** 「写人设 / 改人设」用哪个后端，空 = 跟 active 一样 */
    writerProvider: "",
  },

  /** 世界书 */
  lorebook: {
    enabled: true,
    dir: "config/lorebooks",
    /** 一次最多注入几条 */
    maxEntries: 6,
    /** 按这个字数上限截断注入内容 */
    maxChars: 1200,
    /** 扫描深度：拿最近几条消息参与关键词匹配（酒馆 scanDepth） */
    scanDepth: 4,
    /** 递归扫描：命中条目的内容可以带出更多条目（一层） */
    recursion: true,
  },

  /** 沉浸强化 */
  immersion: {
    enabled: true,
    /** 后置指令（放在对话历史之后，权重最高） */
    postHistory: true,
    /** 作者注释 */
    authorNote: "",
    /** 从酒馆预设搬过来的规则（#喵呜 酒馆 预设 xxx 应用），单独存，不覆盖 authorNote */
    stNote: "",
    /** 输出清洗 */
    clean: true,
    /** 反重复：跟上一句太像就重生成一次 */
    antiRepeat: true,
    /** 相似度超过这个值算重复 */
    repeatThreshold: 0.85,
  },

  /** 活人感 */
  humanize: {
    maxSegments: 3,
    splitChars: ["。", "！", "？", "～", "…", "\n"],
    typingPerChar: 55,
    typingMin: 400,
    typingMax: 2400,
    segmentGap: [350, 1100],
    readDelay: [300, 1500],
  },

  /** 酒馆式交互（开源场白 / 场景锚 / 我是谁 / 同场角色） */
  tavern: {
    /** 这个存档第一次说话时，先让角色自己开口（角色卡有 first_mes 才有） */
    autoOpening: true,
    /** 换人出场时也放开场白 */
    openingOnSwitch: true,
    /** 开场白之前等多久（毫秒区间），别一换人立刻蹦出来 */
    openingDelay: [600, 1500],
    /** 开场白最多发多少字（卡里写太长会截） */
    openingMaxChars: 220,
    /**
     * 状态栏自动渲染：0 = 关（用「#喵呜 状态栏」手动看）；
     * N ≥ 1 = 每 N 轮对话自动发一张（1 = 每轮都带，像酒馆助手那样）。
     * 只对写了 statebar 的角色卡生效。
     */
    autoStatebar: 0,
  },

  /** 主动发言 */
  proactive: {
    enabled: false,
    activeHours: [9, 23],
    /** 周末单独时段，[] = 跟 activeHours 一样 */
    weekendHours: [],
    minIdleMin: 120,
    maxIdleMin: 720,
    chance: 0.45,
    cronMin: 40,
    maxPerDay: 3,
    /**
     * 语气：auto 让她自己拿主意；也可以锁定一种
     *   life  说点自己在干嘛
     *   ask   问一句你的事
     *   miss  撒娇说想你
     *   tease 吐槽你
     */
    style: "auto",
    /** 话题池，非空时从里面随机挑一个当引子（留空就自由发挥） */
    topics: [],
    /** 说话时把"现在几点"带上（这么晚还不睡 / 这个点还在忙） */
    mentionTime: true,
    /** 连续这么多次没被回复就停，等对方先开口（0 = 不限） */
    maxNoReply: 2,
    /** 深夜（23:00-07:00）即使 activeHours 开着也不主动 */
    nightQuiet: true,
    /** 允许用表情 */
    emoji: false,
  },

  /**
   * 时钟
   * 把真实时间塞进提示词，让她知道"今天几号、周几、现在几点、外面天黑没"。
   */
  clock: {
    enabled: true,
    /** 带上日期和星期 */
    showDate: true,
    /** 带上公历/农历节日、节气 */
    showFestival: true,
    /** 时区，空 = 跟系统走。例：Asia/Shanghai */
    timezone: "",
    /** 允许「提醒 / 闹钟」这类定时器 */
    reminds: true,
    /** 同时最多挂几个未触发的定时器 */
    maxPending: 20,
    /** 到点用角色口吻说（false = 干巴巴纯文本） */
    inCharacter: true,
  },

  /**
   * 语音（TTS）
   *
   * 现在接的是 GPT-SoVITS 的 api_v2 接口（本机默认 9880）：
   *   python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
   *
   * mode：off 不发 / sometimes 偶尔发 / all 每条都发
   */
  tts: {
    enabled: false,
    engine: "gptsovits",
    url: "http://127.0.0.1:9880",
    /** 参考音频的绝对路径（音色就听这个） */
    refAudio: "",
    /** 参考音频里说的那句话，必须一字不差 */
    refText: "",
    refLang: "zh",
    textLang: "zh",
    /** cut0~cut5，默认按标点切 */
    splitMethod: "cut5",
    speedFactor: 1.0,
    mode: "sometimes",
    chance: 0.25,
    /** 超过这么多字的回复不转语音（太长听着累） */
    maxChars: 120,
    timeoutMs: 60000,
    /** 转完语音还发不发文字（false = 只发语音） */
    keepText: true,
  },

  /** 绘图 */
  draw: {
    enabled: false,
    bridgeUrl: "http://127.0.0.1:7860",
    loraDir: "",
    /** LoRA 说明表（相对 PLUGIN_DIR），key=文件名或相对路径，value=一句话用途 */
    loraNotes: "config/lora-notes.yaml",
    knowledgeFile: "config/draw-knowledge.md",
    saveDir: "",
    timeoutMs: 300000,
    provider: "",
    narrate: true,
    lastPlanTtlMin: 30,
    /** [[需求:…]] 自主提需求的冷却（分钟），防刷屏 */
    wishCooldownMin: 360,
  },

  /** 本地酒馆（SillyTavern）直连：吃它的角色卡 / 聊天 / 世界书 / 预设 */
  sillytavern: {
    enabled: true,
    /** 酒馆安装目录（认 data/<user>/... 和 config.yaml） */
    dir: "",
    /** data 下的用户目录，一般就是 default-user */
    user: "default-user",
    /** 留空 = 按 config.yaml 的 port 推 http://127.0.0.1:<port> */
    url: "",
    /** 留空 = 用酒馆 config.yaml 里的 basicAuthUser */
    username: "",
    password: "",
  },

  /** 本地控制台（网页） */
  webui: {
    enabled: true,
    /**
     * 听哪个地址：
     *   127.0.0.1 —— 只有这台机器能开（默认，最安全）
     *   0.0.0.0   —— 同一个局域网里的手机 / 平板也能开，启动日志会打印局域网地址
     * 开 0.0.0.0 之前先确认密码够强 —— 密码是唯一那道门。
     */
    host: "127.0.0.1",
    port: 5199,
    /** 登录密码。留空则首次启动自动生成并写回配置 */
    password: "",
    /**
     * 会话多久过期（小时）。手机上常开的话可以调大
     */
    sessionHours: 12,
  },

  /** 调试：把完整 prompt 打到日志 */
  debug: false,
}

/** 深合并：对象递归，数组直接替换 */
function merge(base, over) {
  if (over === undefined || over === null) return base
  if (Array.isArray(over) || typeof over !== "object") return over
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v)
  return out
}

let cache = { mtime: 0, data: null }

/**
 * 读配置。force=true 强制重读。
 */
export function loadConfig(force = false) {
  try {
    const st = fs.statSync(CONFIG_FILE)
    if (!force && cache.data && st.mtimeMs === cache.mtime) return cache.data
    const raw = yaml.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) || {}
    const data = merge(DEFAULTS, raw)
    cache = { mtime: st.mtimeMs, data }
    return data
  } catch (e) {
    if (e.code !== "ENOENT") log().error?.(`[miao-wu] 读配置失败: ${e.message}`)
    return cache.data || structuredClone(DEFAULTS)
  }
}

/** 把嵌套对象压成 a.b.c 路径，数组当叶子（整段替换） */
function flatten(obj, prefix = [], out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, [...prefix, k], out)
    else out[[...prefix, k].join(".")] = v
  }
  return out
}

/**
 * 改配置并写回。
 *
 * 用 yaml 的 Document 逐条 setIn，而不是 stringify 整个对象 ——
 * 后者会把 config.yaml 里所有注释冲掉，那是给人看的，不能丢。
 */
export function patchConfig(patch) {
  let text = ""
  try {
    text = fs.readFileSync(CONFIG_FILE, "utf-8")
  } catch {}

  if (!text) {
    fs.writeFileSync(CONFIG_FILE, yaml.stringify(patch), "utf-8")
    loadConfig(true)
    return loadConfig()
  }

  try {
    const doc = yaml.parseDocument(text)
    for (const [pathStr, v] of Object.entries(flatten(patch))) {
      doc.setIn(pathStr.split("."), v)
    }
    fs.writeFileSync(CONFIG_FILE, doc.toString(), "utf-8")
  } catch (e) {
    log().error?.(`[miao-wu] 写配置失败: ${e.message}`)
  }

  loadConfig(true)
  return loadConfig()
}

/** 取某个后端配置，带上 __name */
export function providerOf(conf, name) {
  const key = name || conf.active
  const p = conf.providers?.[key]
  if (!p) return null
  return { ...p, __name: key }
}

/** 解析相对插件目录的路径 */
export function resolve(rel) {
  if (!rel) return ""
  return path.isAbsolute(rel) ? rel : path.join(PLUGIN_DIR, rel)
}

/** 数据目录（记忆、备份） */
export function dataDir(conf) {
  const d = resolve(conf.memory?.dataDir || "data")
  try {
    fs.mkdirSync(d, { recursive: true })
  } catch {}
  return d
}
