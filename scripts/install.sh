#!/usr/bin/env bash
# 喵呜 · 一键安装（Linux / macOS / Android Termux）
#
# 用法：把本插件 clone 到 Miao-Yunzai/plugins/miao-wu 之后，在插件目录里执行：
#   bash scripts/install.sh
#
# Termux 用户：脚本会检查 node/redis，缺了会告诉你怎么 pkg install。

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(dirname "$HERE")"
YUNZAI_DIR="$(dirname "$(dirname "$PLUGIN_DIR")")"

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[x]\033[0m %s\n' "$*"; }

IS_TERMUX=false
case "${PREFIX:-}" in
  *com.termux*) IS_TERMUX=true ;;
esac

say ""
say "=== 喵呜 · 安装 ==="

# 1. 确认云崽目录
if [ ! -f "$YUNZAI_DIR/lib/plugins/plugin.js" ]; then
  fail "没找到云崽：$YUNZAI_DIR 不像 Miao-Yunzai 根目录"
  say "    请先把本插件 clone 到 Miao-Yunzai/plugins/miao-wu 再运行本脚本"
  exit 1
fi
ok "云崽根目录：$YUNZAI_DIR"

# 2. Node
if ! command -v node >/dev/null 2>&1; then
  if $IS_TERMUX; then
    warn "没装 Node。Termux 里执行：pkg install nodejs-lts"
  else
    warn "没装 Node。请先装 Node 18+（apt/dnf/brew 均可）"
  fi
  exit 1
fi
ok "Node $(node --version)"

# 3. Redis（Termux / Linux 提示，云崽双写存储没 Redis 也能跑，但体验差）
if ! command -v redis-server >/dev/null 2>&1; then
  if $IS_TERMUX; then
    warn "没装 Redis。建议：pkg install redis，然后 redis-server --daemonize yes"
    warn "不装也能跑（喵呜是双写存储，文件兜底），但重启后群/好友列表等会少"
  else
    warn "没装 Redis。建议装一个（apt install redis / systemctl start redis）"
  fi
else
  ok "Redis $(redis-server --version 2>/dev/null | awk '{print $3}')"
fi

# 4. 配置文件
CFG_DIR="$PLUGIN_DIR/config"
if [ ! -f "$CFG_DIR/config.yaml" ]; then
  cp "$CFG_DIR/config.example.yaml" "$CFG_DIR/config.yaml"
  ok "已生成 config/config.yaml（请编辑填入你的 LLM 后端）"
else
  ok "config.yaml 已存在，不动"
fi

# 5. 自检
say ""
say "=== 跑自检 ==="
cd "$PLUGIN_DIR"
if node test/selftest.mjs; then
  :
else
  fail "自检没过，把上面的输出发给作者"
  exit 1
fi

say ""
say "=== 完成。下一步 ==="
say "1. 编辑 plugins/miao-wu/config/config.yaml，填 LLM 的 apiKey 和 model"
say "2. 启动云崽（日志出现『[喵呜] 已加载』即成功）"
say "3. 私聊机器人说声你好；发 #喵呜 帮助 看全部命令"
if $IS_TERMUX; then
  say ""
  say "Termux 备注："
  say "  - redis 启动：redis-server --daemonize yes"
  say "  - puppeteer 渲染（帮助图/状态栏）在 Termux 上大概率装不了 chromium，"
  say "    插件会自动降级为文字版，聊天/记忆/绘图不受影响"
  say "  - 绘图需要 ComfyUI/A1111 桥，手机上一般不跑，bridgeUrl 留空即关"
fi
say ""
