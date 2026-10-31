# 喵呜 · 一键安装（Windows PowerShell）
#
# 用法：把本插件 clone 到 Miao-Yunzai/plugins/miao-wu 之后，在插件目录里执行：
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#
# 做四件事：确认云崽环境 → 生成 config.yaml（如果没有）→ 跑自检 → 打印下一步

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path   # scripts/
$pluginDir = Resolve-Path (Join-Path $here '..')
$yunzaiDir = Resolve-Path (Join-Path $pluginDir '..\..')

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

Say "`n=== 喵呜 · 安装 ===" 'Cyan'

# 1. 确认这是云崽的插件目录
if (-not (Test-Path (Join-Path $yunzaiDir 'lib\plugins\plugin.js'))) {
    Say "[x] 没找到云崽：$yunzaiDir 不像 Miao-Yunzai 根目录" 'Red'
    Say "    请先把本插件 clone 到 Miao-Yunzai\plugins\miao-wu 再运行本脚本" 'Yellow'
    exit 1
}
Say "[ok] 云崽根目录：$yunzaiDir" 'Green'

# 2. Node 版本
$nodeVer = $null
try { $nodeVer = (& node --version) 2>$null } catch { }
if (-not $nodeVer) {
    # 云崽自带 runtime 的话借用它跑自检
    $rt = Join-Path $yunzaiDir 'runtime\node\node.exe'
    if (Test-Path $rt) {
        $nodeVer = & $rt --version
        Say "[ok] 用云崽自带 Node：$nodeVer" 'Green'
        $env:Path = (Split-Path -Parent $rt) + ';' + $env:Path
    } else {
        Say "[x] 没找到 Node.js。先装 Node 18+ 或用云崽的安装器装好再试" 'Red'
        exit 1
    }
} else {
    Say "[ok] Node $nodeVer" 'Green'
}

# 3. 配置文件
$cfgDir = Join-Path $pluginDir 'config'
$cfg = Join-Path $cfgDir 'config.yaml'
$example = Join-Path $cfgDir 'config.example.yaml'
if (-not (Test-Path $cfg)) {
    Copy-Item $example $cfg
    Say "[ok] 已生成 config/config.yaml（请编辑填入你的 LLM 后端）" 'Green'
} else {
    Say "[ok] config.yaml 已存在，不动" 'Green'
}

# 4. 自检
Say "`n=== 跑自检 ===" 'Cyan'
Push-Location $pluginDir
node test\selftest.mjs
$pass1 = $LASTEXITCODE
Pop-Location
if ($pass1 -ne 0) { Say "[x] 自检没过，把上面的输出发给作者" 'Red'; exit 1 }

Say "`n=== 完成。下一步 ===" 'Cyan'
Say "1. 编辑 plugins/miao-wu/config/config.yaml，填 LLM 的 apiKey 和 model"
Say "2. 启动云崽（日志出现『[喵呜] 已加载』即成功）"
Say "3. 私聊机器人说声你好；发 #喵呜 帮助 看全部命令"
Say "4. WebUI：http://127.0.0.1:5199（密码在 config.yaml 的 webui.password）"
Say ""
