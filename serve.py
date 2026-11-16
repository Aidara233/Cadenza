#!/usr/bin/env python3
"""CADENZA — 页面宿主 + 控制面反代（python3 标准库，无依赖）。

**页面不直连核心：连核心的是这个进程。** 浏览器只打开本脚本服务的那一个源，页面把
`/core/*` 发回本进程，本进程再转发给核心（HTTP 与 WebSocket 两条都转）。

为什么值得这么绕（用户 2026-11-14 的裁定，见 README「谁在连核心」）：
  · **token 不进浏览器**：本进程握着核心的 token（`--token` / `LILARA_CORE_TOKEN`），
    页面一条请求都不带它，localStorage 里也不存；
  · **一个源**：页面与 API 同源 ⇒ 没有 CORS、没有混合内容（https 页面打 http 核心）、
    没有「本页 origin 不在核心白名单里」那类握手被静默拒绝的事故；
  · **WS 白名单不再拦人**：核心只在握手**带了 Origin** 时才较真，而本进程不是浏览器、
    不发 Origin（核心 `OriginMatcher` 的前提就是这个）。于是换设备、换地址、走隧道、上
    https 都不用再去改 `LILARA_ALLOWED_ORIGIN`。

⚠️ 与 `serve.ps1` / `serve.sh` 是**同一份契约的实现**（用户裁定 2026-10-23：只做跨平台脚本，
   不另起一个 exe 宿主）：参数名、默认值、`/core` 前缀、`/config.json` 的形状、措辞要对齐。
⚠️ 它不是「静态服务器 + 一点点路由」了：**这一个文件就是那三条反代**（HTTP 转发、WS 隧道）。
   WS 隧道是**原始 TCP 泵**——不解帧、不懂协议，一条消息多少字节就转多少字节。那正是它可靠的
   原因，也是它比 `php -S` / `busybox httpd` 多出来的唯一能力（那两个只能退成「页面直连核心」）。

用法（`serve.sh` 会拉起它，也可以直接跑）：
    python3 serve.py --port 17990 --root . --core http://127.0.0.1:17988
    python3 serve.py --port 17990 --root . --token <核心的访问 token>
"""

import argparse
import base64
import hashlib
import http.client
import json
import os
import select
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

# ⚠️ 与 serve.ps1 / serve.sh **逐字相同**：页面从 /config.json 读到它，再把每个核心路径拼在后面。
PREFIX = "/core"
# ⚠️ 页面在代理模式下会在 WS 上请求这个子协议（`js/core.js` 按 /config.json 的 wsProtocol 带）。
# 本进程必须把它回给浏览器——客户端请求了子协议而服务端一个都不选，浏览器会**直接失败**。
WS_PROTOCOL = "cadenza"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


def make_handler(root: str, core_url: str, token: str):
    root = os.path.realpath(root)
    parts = urlsplit(core_url)
    core_https = parts.scheme == "https"
    core_host = parts.hostname or "127.0.0.1"
    core_port = parts.port or (443 if core_https else 80)
    core_netloc = f"{core_host}:{core_port}"

    class Handler(BaseHTTPRequestHandler):
        # 静态文件与反代都是小响应，但每一条都带 Content-Length ⇒ keep-alive 是安全的。
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # 一行一条，别刷屏
            sys.stdout.write("  " + (fmt % args) + "\n")
            sys.stdout.flush()

        def end_headers(self):
            # ⚠️ 与 serve.ps1 同一条判据：页面 + 几十个模块，不 no-store 就会看到旧副本。
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        # ---- 出口 ----

        def _send(self, status: int, ctype: str, body: bytes):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD" and body:
                self.wfile.write(body)

        def _send_text(self, status: int, text: str):
            self._send(status, "text/plain; charset=utf-8", text.encode("utf-8"))

        def _fail_upstream(self, what: str):
            # 这一句会原样出现在页面的横幅里：说清「是谁不通」，别让人去改错的参数。
            msg = json.dumps({"error": "Cadenza 进程连不上核心（" + core_url + "）：" + what},
                             ensure_ascii=False).encode("utf-8")
            self._send(502, "application/json; charset=utf-8", msg)
            sys.stdout.write("  ! 上游 " + what + "：" + core_url + "\n")
            sys.stdout.flush()

        def _upstream_auth(self):
            """本进程替页面交的凭据：自己配了就用它，否则把页面带的那条原样转过去（旧形态仍能用）。"""
            if token:
                return "Bearer " + token
            return self.headers.get("Authorization")

        # ---- 分派 ----

        def do_GET(self):
            self._dispatch()

        def do_HEAD(self):
            self._dispatch()

        def do_POST(self):
            self._dispatch()

        def do_PUT(self):
            self._dispatch()

        def do_DELETE(self):
            self._dispatch()

        def do_OPTIONS(self):
            self._dispatch()

        def _dispatch(self):
            path = self.path.split("?", 1)[0]
            if path == PREFIX or path.startswith(PREFIX + "/"):
                rest = self.path[len(PREFIX):] or "/"
                if rest.split("?", 1)[0] == "/ws" and "websocket" in (self.headers.get("Upgrade") or "").lower():
                    return self._ws_tunnel(rest)
                return self._proxy(rest)
            if path == "/config.json":
                cfg = {"proxy": PREFIX, "upstream": core_url,
                       "auth": "head" if token else "page", "wsProtocol": WS_PROTOCOL}
                return self._send(200, "application/json; charset=utf-8",
                                  json.dumps(cfg, ensure_ascii=False).encode("utf-8"))
            return self._static(path)

        # ---- 控制面：HTTP ----

        def _proxy(self, up_path_and_query: str):
            body = None
            n = self.headers.get("Content-Length")
            if n:
                try:
                    body = self.rfile.read(int(n))
                except ValueError:
                    return self._send_text(400, "bad content-length")
            headers = {}
            if self.headers.get("Content-Type"):
                headers["Content-Type"] = self.headers.get("Content-Type")
            if self.headers.get("Accept"):
                headers["Accept"] = self.headers.get("Accept")
            auth = self._upstream_auth()
            if auth:
                headers["Authorization"] = auth
            headers["Content-Length"] = str(len(body)) if body is not None else "0"

            cls = http.client.HTTPSConnection if core_https else http.client.HTTPConnection
            conn = None
            try:
                conn = cls(core_host, core_port, timeout=60)
                conn.request(self.command, up_path_and_query, body=body, headers=headers)
                resp = conn.getresponse()
                data = resp.read()
                ctype = resp.getheader("Content-Type") or "application/octet-stream"
                # ⚠️ 上游的 4xx/5xx 要**原样**交回去（状态 + 体）：页面的 token 闸与 `HttpError`
                # 上那句人话理由全靠它。把 404 变成 200 或者把体丢掉，页面上就只剩「服务器出错」。
                self._send(resp.status, ctype, data)
            except Exception as e:  # 连接失败 / 超时 / 上游半路挂掉
                self._fail_upstream("没应答（" + type(e).__name__ + "）")
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass

        # ---- 控制面：WebSocket 隧道 ----

        def _ws_tunnel(self, up_path_and_query: str):
            offered = [p.strip() for p in (self.headers.get("Sec-WebSocket-Protocol") or "").split(",")]
            if WS_PROTOCOL not in offered:
                return self._send_text(400, "本头只接受子协议 " + WS_PROTOCOL
                                       + "（页面里是 new WebSocket(url, '" + WS_PROTOCOL + "')）")
            key = self.headers.get("Sec-WebSocket-Key")
            if not key:
                return self._send_text(400, "不是 WebSocket 握手：少了 Sec-WebSocket-Key")

            try:
                upstream = socket.create_connection((core_host, core_port), timeout=10)
            except Exception as e:
                return self._fail_upstream("WS 连不上（" + type(e).__name__ + "）")

            accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("latin-1")).digest()).decode("ascii")
            lines = [
                "GET " + up_path_and_query + " HTTP/1.1",
                "Host: " + core_netloc,
                "Upgrade: websocket",
                "Connection: Upgrade",
                "Sec-WebSocket-Key: " + key,
                "Sec-WebSocket-Version: 13",
                # ⚠️ 我们**请求**这个子协议，让核心在 101 里回它；浏览器要的也是它。
                "Sec-WebSocket-Protocol: " + WS_PROTOCOL,
            ]
            auth = self._upstream_auth()
            if auth:
                lines.append("Authorization: " + auth)
            # ⚠️ **不发 Origin**：核心只在握手里带了 Origin 时才较真（`OriginMatcher` 的前提），
            # 不带就一律放行。本进程不是浏览器，本来也没有该报的 origin。
            upstream.settimeout(10)
            try:
                upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
                head = b""
                while b"\r\n\r\n" not in head and len(head) < 65536:
                    chunk = upstream.recv(4096)
                    if not chunk:
                        break
                    head += chunk
            except Exception:
                try:
                    upstream.close()
                except Exception:
                    pass
                return self._fail_upstream("WS 握手没答完")

            if not head.startswith(b"HTTP/1.1 101"):
                # ⚠️ 这里**没法**把原因交给页面（浏览器的 WS 拿不到失败响应体），所以要留一行日志；
                # 同时把上游那句原样交回去——curl 之类的客户端仍然看得到它。
                first = head.split(b"\r\n", 1)[0].decode("latin-1", "replace") if head else "（没应答）"
                sys.stdout.write("  ! 上游 WS 拒绝：" + up_path_and_query + " → " + first + "\n")
                sys.stdout.flush()
                try:
                    self.connection.sendall(head or b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                except Exception:
                    pass
                try:
                    upstream.close()
                except Exception:
                    pass
                self.close_connection = True
                return

            # 交回 101：Accept 由我们自己算（RFC 6455 的公式是确定的），子协议必须带上。
            self.wfile.write((
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Accept: " + accept + "\r\n"
                "Sec-WebSocket-Protocol: " + WS_PROTOCOL + "\r\n"
                "\r\n").encode("latin-1"))
            self.wfile.flush()

            # 之后两边都是裸字节：谁发来多少就转多少，一端关掉就收摊。
            # ⚠️ 用 `self.connection`（未缓冲）而不是 `self.rfile`：缓冲读会吃掉本该转发的字节。
            client = self.connection
            client.setblocking(True)
            upstream.setblocking(True)
            client.settimeout(None)
            upstream.settimeout(None)
            self.close_connection = True
            try:
                while True:
                    ready, _, _ = select.select([client, upstream], [], [], 300)
                    if not ready:
                        continue  # 空闲：不主动断（核心可能很久才发一帧）
                    for s in ready:
                        data = s.recv(65536)
                        if not data:
                            return
                        (upstream if s is client else client).sendall(data)
            except Exception:
                return
            finally:
                try:
                    upstream.close()
                except Exception:
                    pass

        # ---- 静态文件 ----

        def _static(self, path: str):
            if path in ("", "/"):
                path = "/index.html"
            # ⚠️ 越界闸：解析出来的绝对路径必须仍在根目录之下（形状校验），
            # 与核心 SessionToolContext.ResolvePath 同一条判据。
            full = os.path.realpath(os.path.join(root, path.lstrip("/")))
            if not (full == root or full.startswith(root + os.sep)):
                return self._send_text(404, "not found: " + path)
            if not os.path.isfile(full):
                return self._send_text(404, "not found: " + path)
            ext = os.path.splitext(full)[1].lower()
            with open(full, "rb") as f:
                body = f.read()
            self._send(200, TYPES.get(ext, "application/octet-stream"), body)

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Cadenza page host + control-plane reverse proxy")
    ap.add_argument("--port", type=int, default=int(os.environ.get("LILARA_HEAD_PORT", "17990")))
    # ⚠️ 默认对局域网开放（0.0.0.0），与核心 2026-11-05 那个裁定一致；收回本机才 --bind 127.0.0.1。
    ap.add_argument("--bind", default=os.environ.get("LILARA_HEAD_BIND", "0.0.0.0"))
    ap.add_argument("--root", default=os.path.dirname(os.path.abspath(__file__)))
    # **上游**：本进程替页面连的那个核心（与页面里的 `?core=` 是两件事——那个是「页面自己直连」）。
    ap.add_argument("--core", default=os.environ.get("LILARA_CORE") or "http://127.0.0.1:17988")
    # 核心的访问 token（LILARA_AUTH=1 才需要）。配了它页面就一条凭据都不带。
    ap.add_argument("--token", default=os.environ.get("LILARA_CORE_TOKEN") or "")
    a = ap.parse_args()

    core = a.core.rstrip("/")
    token = a.token.strip()
    loopback = a.bind in ("127.0.0.1", "localhost", "::1")

    print(f"CADENZA — http://127.0.0.1:{a.port}", flush=True)
    print(f"  页面 经由本进程连核心：{PREFIX}/* → {core}（HTTP 与 WS 都转）", flush=True)
    print("  token " + ("由本进程持有（--token / LILARA_CORE_TOKEN）——页面不带凭据" if token
                        else f"未配置：页面经 {PREFIX} 转过来的 Authorization 会被原样转给核心"), flush=True)
    print(f"  根目录 {os.path.realpath(a.root)}", flush=True)
    print(f"  监听 {a.bind}" + ("（只在本机）" if loopback else "（对局域网开放；收回本机：--bind 127.0.0.1）"), flush=True)
    if not loopback:
        print("  ⚠️ 对局域网开放：同一网络里的设备都能打开页面，**并且能经 "
              + PREFIX + " 驱动核心**。", flush=True)
        print("     要收回本机：--bind 127.0.0.1；要拦人：核心设 LILARA_AUTH=1，再把 token 交给本进程（--token）。",
              flush=True)

    handler = make_handler(a.root, core, token)
    httpd = ThreadingHTTPServer((a.bind, a.port), handler)
    httpd.daemon_threads = True
    print(f"  服务器：python3 http.server on {a.bind}:{a.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
