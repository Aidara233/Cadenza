#!/usr/bin/env bash
# CADENZA — 静态宿主（macOS / Linux / WSL / Git Bash）。
#
# 与 serve.ps1 是**同一份契约的两个实现**（用户裁定 2026-10-23：只做跨平台脚本，
# 不另起一个 exe 宿主）。两边的参数名、默认值、启动自检、报错措辞要对齐——
# 这一对**曾经漂过**，所以：
#   ⚠️ 改这里时**必须**同时改 serve.ps1，反之亦然。
#
# 核心只接受 Origin 在白名单里的 WS 握手（默认 http://127.0.0.1:17990）。
# 本脚本在**完全一样的 origin** 之上把 Cadenza 目录服务出去，且绝不缓存
# （页面 + 几十个模块，不 no-store 就会看到旧副本而毫无提示）。
#
# 服务器：这台机器上**现成**的那一个，按以下顺序挑第一个存在的——
#   php -S（Unix 发行版常见，且支持单文件路由）→ python3 serve.py → busybox httpd。
# ⚠️ 刻意**不内置**一个几十行的 HTTP 服务：bash 没有可靠的多线程 / HTTP 解析，
#    而一个半吊子的静态服务器正是「看起来能跑、偶尔挂住」的那类东西。
#    三个候选都没有时，脚本明确报错并给出装什么（见 END 那段），不静默降级。
#
# 用法：
#   ./serve.sh                                 默认 17990、核心 http://127.0.0.1:17988
#   ./serve.sh --port 17991                    换端口（同时给核心设 LILARA_HEAD_PORT=17991）
#   ./serve.sh --core http://127.0.0.1:17999   换核心地址
#   ./serve.sh --root /path/to/Cadenza         换根目录（默认本脚本所在目录）
#   ./serve.sh --no-check                      跳过启动自检
#   ./serve.sh --no-open                       不自动打开浏览器（默认会尝试）
#   ./serve.sh --open-only                    只打开浏览器（服务器已在别处跑着时）
#
# 环境变量：LILARA_HEAD_PORT / LILARA_CORE 是**默认值的来源**（与 serve.ps1 同名），
# 命令行参数优先。
#
# 停止：Ctrl+C。

set -u

PORT="${LILARA_HEAD_PORT:-17990}"
CORE="${LILARA_CORE:-http://127.0.0.1:17988}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK=1
OPEN=1
OPEN_ONLY=0

usage() { sed -n '20,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --port)      [ $# -ge 2 ] || { echo "✗ --port 缺值" >&2; exit 2; }; PORT="$2"; shift 2 ;;
        --port=*)    PORT="${1#*=}"; shift ;;
        --core)      [ $# -ge 2 ] || { echo "✗ --core 缺值" >&2; exit 2; }; CORE="$2"; shift 2 ;;
        --core=*)    CORE="${1#*=}"; shift ;;
        --root)      [ $# -ge 2 ] || { echo "✗ --root 缺值" >&2; exit 2; }; ROOT="$2"; shift 2 ;;
        --root=*)    ROOT="${1#*=}"; shift ;;
        --no-check)  CHECK=0; shift ;;
        --no-open)   OPEN=0; shift ;;
        --open)      OPEN=1; shift ;;
        --open-only) OPEN_ONLY=1; shift ;;
        -h|--help)   usage; exit 0 ;;
        *) echo "✗ 未知参数 '$1'（--help 看用法）" >&2; exit 2 ;;
    esac
done

case "$PORT" in ''|*[!0-9]*) echo "✗ --port 必须是数字：'$PORT'" >&2; exit 2 ;; esac
CORE="${CORE%/}"
ROOT="$(cd "$ROOT" 2>/dev/null && pwd)" || { echo "✗ --root 不存在：'$ROOT'" >&2; exit 2; }
[ -f "$ROOT/index.html" ] || { echo "✗ $ROOT 里没有 index.html——这不是 Cadenza 目录" >&2; exit 2; }

URL="http://127.0.0.1:$PORT"

# ⚠️ 判据是**模式**：核心 2026-11-05 起默认放行 `http://*:<头端口>`（任意主机，端口钉住），
# 所以 localhost / 127.0.0.1 / 局域网 IP 打开都行——逐字相等会把这些全部误报成「不吻合」。
open_browser() {
    [ "$OPEN" = "1" ] || return 0
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL/" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then open "$URL/" >/dev/null 2>&1 &
    elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe //c start "" "$URL/" >/dev/null 2>&1 &
    else return 0   # 无图形/无打开器：不报错，用户自己点
    fi
}

echo "CADENZA — $URL"
echo "  页面 origin 必须落在核心的白名单上（默认模式 http://*:$PORT = 任意主机 + 这个端口）"
echo "  核心 $CORE（页面直连；可用 ?core= 或「后台 · 系统」覆盖）"
echo "  根目录 $ROOT"
echo "  端口必须是 $PORT；主机名/地址随意（127.0.0.1、localhost 都行——核心按端口放行）"
echo ""

if [ "$OPEN_ONLY" = "1" ]; then OPEN=1; open_browser; echo "  已在浏览器打开 $URL/"; exit 0; fi

# 启动自检：把「致命但安静」的那一件事说出来（与 serve.ps1 逐句对齐）。
if [ "$CHECK" = "1" ] && command -v curl >/dev/null 2>&1; then
    info="$(curl -fsS -m 2 "$CORE/info" 2>/dev/null || true)"
    if [ -z "$info" ]; then
        echo "  ⚠️ 核心没应答（$CORE）"
        echo "     页面会显示「已断开 · 重连中」。先把核心起起来。"
    else
        allowed="$(printf '%s' "$info" | sed -n 's/.*"allowedOrigin":"\([^"]*\)".*/\1/p')"
        # case 的模式里 `*` 是通配（这正是我们要的语义：任意主机 + 这个端口），
        # 引号里的 `*` 才是字面量（核心把白名单设成 `*` = 放行任意 origin，仅调试用）。
        case "$allowed" in
            "$URL"|"*"|http://*:"$PORT") ok=1 ;;
            *) ok=0 ;;
        esac
        if [ "$ok" = "1" ]; then
            echo "  ✓ 核心在，WS 白名单 = $allowed"
        else
            echo "  ⚠️ 核心在，但白名单是 ${allowed:-?} —— 页面 origin 是 $URL"
            echo "     浏览器不会把握手 403 交给页面 JS。设 LILARA_HEAD_PORT=$PORT 后重启核心。"
        fi
        # 开了鉴权而页面不知道 = 「页面一片空白，没人说得出为什么」。token 只在核心的控制台里，
        # 这里只指路、不复述。
        if printf '%s' "$info" | grep -Fq '"authRequired":true'; then
            echo "  ⚠️ 核心开了鉴权（LILARA_AUTH=1）：页面第一次连会要 token。"
            echo "     token 在核心的控制台启动横幅里（访问 token … 那一行）。"
        fi
    fi
elif [ "$CHECK" = "1" ]; then
    echo "  ⚠️ 没有 curl，跳过启动自检（页面连不上时先看核心是否在 $CORE）"
fi
echo ""

# ---- 选服务器 ----
# ⚠️ 两个 `exec`：端口会被服务器直接占用，本脚本不再持有子进程——
#    Ctrl+C 直接打给服务器，不留一个「壳还在、服务器没了」的僵尸。

if command -v php >/dev/null 2>&1; then
    open_browser
    echo "  服务器：php -S（-t 根目录，路由交给 router.php 处理 no-store）"
    exec php -S "127.0.0.1:$PORT" -t "$ROOT" "$ROOT/serve-router.php"
fi

if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; assert sys.version_info[0] == 3' >/dev/null 2>&1; then
    open_browser
    echo "  服务器：python3（serve.py；no-store 与 /config.json 由它给）"
    exec python3 "$ROOT/serve.py" --port "$PORT" --root "$ROOT" --core "$CORE"
fi

if command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx httpd; then
    open_browser
    echo "  服务器：busybox httpd（⚠️ 不支持 no-store；改了 js/css 记得硬刷新）"
    exec busybox httpd -f -p "127.0.0.1:$PORT" -h "$ROOT"
fi

cat >&2 <<'EOF'
✗ 这台机器上没有可用的静态服务器。装任意一个即可（都是系统自带的包，不需要本项目的依赖）：

  · Debian / Ubuntu   sudo apt install php-cli      （最推荐：serve.sh 会用一个 20 行的路由脚本关掉缓存）
  · Fedora            sudo dnf install php-cli
  · Arch              sudo pacman -S php
  · macOS             brew install php
  · 或者              sudo apt install python3     （serve.py 同样关掉了缓存，与 php 那条等价）
  · 或者              sudo apt install busybox    （⚠️ busybox httpd 不支持 no-store，改了前端要硬刷新）
EOF
exit 1
