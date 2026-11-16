#!/usr/bin/env bash
# CADENZA — 页面宿主 + 控制面反代（macOS / Linux / WSL / Git Bash）。
#
# **页面不直连核心：连核心的是这个进程。** 浏览器只打开本脚本服务的那一个源，页面把
# `/core/*` 发回本进程，本进程再转发给核心（HTTP 与 WebSocket 两条都转）。
#
# 为什么值得这么绕（用户 2026-11-14 的裁定，见 README「谁在连核心」）：
#   · **token 不进浏览器**：本进程握着核心的 token（--token / LILARA_CORE_TOKEN）；
#   · **一个源**：没有 CORS、没有混合内容、没有「本页 origin 不在核心白名单里」那类事故；
#   · **WS 白名单不再拦人**：核心只在握手带了 Origin 时才较真，而本进程不是浏览器、不发 Origin。
#
# ⚠️ 与 serve.ps1 / serve.py 是**同一份契约的实现**（用户裁定 2026-10-23：只做跨平台脚本，
#    不另起一个 exe 宿主）。参数名、默认值、`/core` 前缀、启动自检、报错措辞要对齐：
#   ⚠️ 改这里时**必须**同时改 serve.ps1 / serve.py，反之亦然。
#
# 服务器：这台机器上**现成**的那一个。这里有一条**硬约束**：反代要能同时转 HTTP 与
# **WebSocket 隧道**，而只有 `python3 serve.py` 做得到（它自己就是那三条反代）。
#   python3（serve.py，**完整反代**）→ php -S（serve-router.php，**静态 + 直连退路**）
#   → busybox httpd（同上，且不关缓存）
# ⚠️ 落到 php / busybox 时页面会**退回直连核心**（与旧版行为一致），横幅会明说为什么：
#    php -S 单线程、拿不到已接受连接的原始套接字 ⇒ 撑不起一条长命的 WS 隧道。
#    要「由 Cadenza 的进程连核心」，装 python3（几乎每台 Unix 都自带）。
#
# 用法：
#   ./serve.sh                                 默认 17990、上游 http://127.0.0.1:17988
#   ./serve.sh --port 17991                    换端口
#   ./serve.sh --core http://127.0.0.1:17999   换上游（本进程替页面连的那个核心）
#   ./serve.sh --token <token>                 核心开了鉴权时，把 token 交给本进程（页面就不带了）
#   ./serve.sh --root /path/to/Cadenza         换根目录（默认本脚本所在目录）
#   ./serve.sh --bind 127.0.0.1                收回仅本机（默认 0.0.0.0，与核心的裁定一致）
#   ./serve.sh --no-check                      跳过启动自检
#   ./serve.sh --no-open                       不自动打开浏览器（默认会尝试）
#   ./serve.sh --open-only                    只打开浏览器（服务器已在别处跑着时）
#
# 环境变量：LILARA_HEAD_PORT / LILARA_CORE / LILARA_CORE_TOKEN / LILARA_HEAD_BIND 是
# **默认值的来源**（与核心自己的头同名），命令行参数优先。
#
# 停止：Ctrl+C。

set -u

PORT="${LILARA_HEAD_PORT:-17990}"
CORE="${LILARA_CORE:-http://127.0.0.1:17988}"
TOKEN="${LILARA_CORE_TOKEN:-}"
# 监听地址。**默认对局域网开放（0.0.0.0）**——与核心 2026-11-05 那个裁定一致：
# 同一网络里的手机/平板直接打开页面，而不是默认不可用。要收回本机：--bind 127.0.0.1。
# ⚠️ 页面已经不只是静态文件了：`/core/*` 这条反代把核心也带了出去，所以「谁能打开页面」
#    现在等于「谁能驱动核心」。要拦人：核心设 LILARA_AUTH=1 + 本脚本 --token。
BIND="${LILARA_HEAD_BIND:-0.0.0.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK=1
OPEN=1
OPEN_ONLY=0

# ⚠️ 用「从哪一行到哪一行」的锚文本，不用行号：加一行用法就会把 `sed -n '20,30p'` 打偏。
usage() { sed -n '/^# 用法：/,/^# 停止/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --port)      [ $# -ge 2 ] || { echo "✗ --port 缺值" >&2; exit 2; }; PORT="$2"; shift 2 ;;
        --port=*)    PORT="${1#*=}"; shift ;;
        --core)      [ $# -ge 2 ] || { echo "✗ --core 缺值" >&2; exit 2; }; CORE="$2"; shift 2 ;;
        --core=*)    CORE="${1#*=}"; shift ;;
        --token)     [ $# -ge 2 ] || { echo "✗ --token 缺值" >&2; exit 2; }; TOKEN="$2"; shift 2 ;;
        --token=*)   TOKEN="${1#*=}"; shift ;;
        --bind)      [ $# -ge 2 ] || { echo "✗ --bind 缺值" >&2; exit 2; }; BIND="$2"; shift 2 ;;
        --bind=*)    BIND="${1#*=}"; shift ;;
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

case "$BIND" in
    127.0.0.1|localhost|::1|"[::1]") LOOPBACK=1 ;;
    *) LOOPBACK=0 ;;
esac

# 对局域网开放时把代价与可达地址说出来（与 serve.ps1 / serve.py 逐句对齐）。
lan_block() {
    [ "$LOOPBACK" = "0" ] || return 0
    echo "  ⚠️ 对局域网开放（$BIND）：同一网络里的设备都能打开页面，**并且能经 /core 驱动核心**。"
    echo "     核心自己绑哪里已经不重要了（是这台在转发）；要收回本机：--bind 127.0.0.1。"
    echo "     要拦人：核心设 LILARA_AUTH=1，再把 token 交给本进程（--token）。"
    # 可达地址：换一台设备时照着输。拿不到就跳过（列不出来不该影响启动）。
    if command -v hostname >/dev/null 2>&1; then
        for addr in $(hostname -I 2>/dev/null || true); do
            case "$addr" in *:*) continue ;; esac      # IPv6 先不列（方括号写法容易出错）
            echo "     可达地址 http://$addr:$PORT"
        done
    fi
}

open_browser() {
    [ "$OPEN" = "1" ] || return 0
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL/" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then open "$URL/" >/dev/null 2>&1 &
    elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe //c start "" "$URL/" >/dev/null 2>&1 &
    else return 0   # 无图形/无打开器：不报错，用户自己点
    fi
}

echo "CADENZA — $URL"
echo "  页面 经由本进程连核心：/core/* → $CORE（HTTP 与 WS 都转）"
if [ -n "$TOKEN" ]; then
    echo "  token 由本进程持有（--token / LILARA_CORE_TOKEN）——页面不带凭据"
else
    echo "  token 未配置：页面经 /core 转过来的 Authorization 会被原样转给核心"
fi
echo "  根目录 $ROOT"
echo "  监听 $(if [ "$LOOPBACK" = "1" ]; then echo '127.0.0.1（只在本机；要对局域网开放用 --bind 0.0.0.0）'; else echo "$BIND（对局域网开放；收回本机：--bind 127.0.0.1）"; fi)"
lan_block
echo ""

if [ "$OPEN_ONLY" = "1" ]; then OPEN=1; open_browser; echo "  已在浏览器打开 $URL/"; exit 0; fi

# ---- 选服务器 ----
# ⚠️ python3 排第一：**只有它能把 /core/* 与 WS 隧道一起转**（见文件头那条硬约束）。
HAVE_PY=0
if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; assert sys.version_info[0] == 3' >/dev/null 2>&1; then
    HAVE_PY=1
fi

# 启动自检：把「致命但安静」的那一件事说出来（与 serve.ps1 / serve.py 逐句对齐）。
# ⚠️ 查的是**本进程到上游**那条路；也**不再**检查 WS 白名单吻合与否——握手是本进程发的、
#    不带 Origin，核心一律放行（旧版那句「设 LILARA_HEAD_PORT=… 后重启核心」在这里已无从谈起）。
if [ "$CHECK" = "1" ] && command -v curl >/dev/null 2>&1; then
    info="$(curl -fsS -m 2 "$CORE/info" 2>/dev/null || true)"
    if [ -z "$info" ]; then
        echo "  ⚠️ 上游没应答（$CORE）"
        echo "     页面会显示「Cadenza 进程连不上核心」。先把核心起起来（核心在别的机器上就给 --core）。"
    else
        ver="$(printf '%s' "$info" | sed -n 's/.*"coreVersion":"\([^"]*\)".*/\1/p')"
        echo "  ✓ 上游在：$CORE（版本 ${ver:-?}）"
        if printf '%s' "$info" | grep -Fq '"authRequired":true'; then
            if [ -n "$TOKEN" ]; then
                echo "  ✓ 核心开了鉴权（LILARA_AUTH=1），token 由本进程持有"
            else
                echo "  ⚠️ 核心开了鉴权（LILARA_AUTH=1），而本进程没配 token。"
                echo "     token 在核心的控制台启动横幅里（访问 token … 那一行）。两条路："
                echo "       · 交给本进程（推荐，页面就不带凭据了）：--token <token> 或设 LILARA_CORE_TOKEN"
                echo "       · 或者让页面自己填：页面第一次连会弹 token 闸，经 /core 转过去的核心照样认"
            fi
        fi
    fi
elif [ "$CHECK" = "1" ]; then
    echo "  ⚠️ 没有 curl，跳过启动自检（页面连不上时先看核心是否在 $CORE）"
fi
echo ""

# ---- 有多好就用多好：python3 完整反代，其余退成直连 ----

if [ "$HAVE_PY" = "1" ]; then
    open_browser
    echo "  服务器：python3（serve.py；静态 + /core 反代 + WS 隧道，全部由它给）"
    set -- --bind "$BIND" --port "$PORT" --root "$ROOT" --core "$CORE"
    if [ -n "$TOKEN" ]; then set -- "$@" --token "$TOKEN"; fi
    exec python3 "$ROOT/serve.py" "$@"
fi

echo "  ⚠️ 这台机器上没有 python3 ⇒ **反代起不来**（php -S / busybox httpd 撑不起 WS 隧道）。" >&2
echo "     页面会退回「自己直连核心」那种旧形态：token 与 origin 白名单又得在浏览器这一侧操心。" >&2
echo "     要有由 Cadenza 的进程连核心，装一个 python3 即可（多数系统自带）：" >&2
echo "       · Debian / Ubuntu   sudo apt install python3" >&2
echo "       · Fedora            sudo dnf install python3" >&2
echo "       · Arch              sudo pacman -S python" >&2
echo "       · macOS             xcode-select --install   （自带 python3）" >&2
echo "" >&2

if command -v php >/dev/null 2>&1; then
    open_browser
    echo "  服务器：php -S $BIND:$PORT（静态 + 直连退路；路由交给 serve-router.php 处理 no-store）"
    echo "  ⚠️ 页面直连核心：core 地址由 serve-router.php 按请求的 Host 拼出来。"
    echo "     对局域网开放时，别的设备打开页面会去连**它自己**能看到的那个核心地址。"
    exec php -S "$BIND:$PORT" -t "$ROOT" "$ROOT/serve-router.php"
fi

if command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx httpd; then
    open_browser
    echo "  服务器：busybox httpd（⚠️ 不支持 no-store；改了 js/css 记得硬刷新）"
    echo "  ⚠️ busybox 也不给 /config.json：页面会退回默认核心地址 127.0.0.1:17988，"
    echo "     而那在别的设备上指的是**设备自己**。要能用局域网，装 python3 或 php。"
    exec busybox httpd -f -p "$BIND:$PORT" -h "$ROOT"
fi

cat >&2 <<'EOF'
✗ 这台机器上既没有 python3，也没有 php / busybox httpd。装任意一个即可：

  · Debian / Ubuntu   sudo apt install python3   （**首选**：serve.py 会做静态 + /core 反代 + WS 隧道）
  · Fedora            sudo dnf install python3
  · Arch              sudo pacman -S python
  · macOS             xcode-select --install     （自带 python3）
  · 或者              sudo apt install php-cli   （⚠️ 只能静态 + 页面直连核心，没有反代）
  · 或者              sudo apt install busybox   （⚠️ 同上，且不关缓存）
EOF
exit 1
