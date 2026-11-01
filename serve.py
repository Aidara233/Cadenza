#!/usr/bin/env python3
"""CADENZA — 静态宿主（没有 php 时的退路：python3 -m http.server）。

与 serve.ps1 / serve.sh 是**同一份契约的三个实现**（用户裁定 2026-10-23）。
⚠️ 只处理「静态文件 + /config.json」，别把它扩成一个框架。
⚠️ 它比 php -S 少两样东西，写在这里免得被当成等价物：
   · 没有内建路由脚本 ⇒ no-store 只能靠自定义 handler，也就是本文件；
   · 没有自动打开浏览器（那只在 serve.sh 里做，因为三个平台的开法不同）。

用法（serve.sh 会拉起它，也可以直接跑）：
    python3 serve.py --port 17990 --root . --core http://127.0.0.1:17988
    python3 serve.py --port 17990 --root .                  # 核心地址跟着请求的 Host 走
"""

import argparse
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

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


def core_for_host(host_header, core_port, fallback):
    """这次请求该拿哪个核心地址。

    ⚠️ 头绑到局域网之后，页面里的 `127.0.0.1` 指的是**打开页面的那台设备自己** ⇒ 写死它
    等于「手机永远连不上，而症状与核心没起来一模一样」。所以没显式给核心地址时，用**请求的
    Host**（同一个地址）+ 核心端口。显式给了就照抄：那是「核心在别的机器上 / 走了隧道」那条路。
    """
    host = (host_header or "").strip()
    if not host:
        return fallback
    if host.startswith("["):                      # IPv6 字面量：[::1]:17990
        end = host.find("]")
        if end < 0:
            return fallback
        host = host[: end + 1]
    else:
        host = host.split(":", 1)[0]              # 192.168.1.5:17990 → 192.168.1.5
    if not host:
        return fallback
    return f"http://{host}:{core_port}"


def make_handler(root: str, core, core_port: int):
    root = os.path.realpath(root)

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, fmt, *args):  # 一行一条，别刷屏
            print("  " + fmt % args, flush=True)

        def end_headers(self):
            # ⚠️ 与 serve.ps1 同一条判据：页面 + 几十个模块，不 no-store 就会看到旧副本。
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _send(self, status: int, ctype: str, body: bytes):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/config.json":
                url = core if core else core_for_host(self.headers.get("Host"), core_port, "")
                if not url:
                    url = f"http://127.0.0.1:{core_port}"
                body = json.dumps({"core": url}, separators=(",", ":")).encode()
                self._send(200, "application/json; charset=utf-8", body)
                return

            if path in ("", "/"):
                path = "/index.html"

            # ⚠️ 越界闸：解析出来的绝对路径必须仍在根目录之下（形状校验），
            # 与核心 SessionToolContext.ResolvePath 同一条判据。
            full = os.path.realpath(os.path.join(root, path.lstrip("/")))
            if not (full == root or full.startswith(root + os.sep)):
                self._send(404, "text/plain; charset=utf-8", b"not found: " + path.encode())
                return
            if not os.path.isfile(full):
                self._send(404, "text/plain; charset=utf-8", b"not found: " + path.encode())
                return

            ext = os.path.splitext(full)[1].lower()
            with open(full, "rb") as f:
                body = f.read()
            self._send(200, TYPES.get(ext, "application/octet-stream"), body)

        do_HEAD = do_GET

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Cadenza static host")
    ap.add_argument("--port", type=int, default=int(os.environ.get("LILARA_HEAD_PORT", "17990")))
    # ⚠️ 默认只在本机（与 serve.ps1 / serve.sh 同一个默认值）。要对手机/平板开放才 --bind 0.0.0.0。
    ap.add_argument("--bind", default=os.environ.get("LILARA_HEAD_BIND", "127.0.0.1"))
    ap.add_argument("--root", default=os.path.dirname(os.path.abspath(__file__)))
    # None = 没显式给 ⇒ 跟着请求的 Host 走（见 core_for_host）。
    ap.add_argument("--core", default=os.environ.get("LILARA_CORE") or None)
    ap.add_argument("--core-port", type=int, default=int(os.environ.get("LILARA_CORE_PORT", "17988")))
    a = ap.parse_args()

    core = a.core.rstrip("/") if a.core else None
    core_port = a.core_port
    if core:
        # 核心地址也可能自己带端口（--core http://192.168.1.5:18000）。
        parts = urlsplit(core)
        if parts.port:
            core_port = parts.port

    loopback = a.bind in ("127.0.0.1", "localhost", "::1")
    print(f"CADENZA — http://127.0.0.1:{a.port}", flush=True)
    print(f"  核心 {core or f'http://<打开页面的那台机器的地址>:{core_port}（跟着请求的 Host 走；--core 可钉死）'}", flush=True)
    print(f"  根目录 {os.path.realpath(a.root)}", flush=True)
    print(f"  监听 {a.bind}{'（只在本机；要手机/平板打开用 --bind 0.0.0.0）' if loopback else '（对局域网开放）'}", flush=True)
    if not loopback:
        print("  ⚠️ 头对局域网开放：同一网络里的设备都能打开这个页面。", flush=True)
        print("     要收回本机：--bind 127.0.0.1；要拦人：核心设 LILARA_AUTH=1。", flush=True)

    handler = make_handler(a.root, core, core_port)
    httpd = ThreadingHTTPServer((a.bind, a.port), handler)
    print(f"  服务器：python3 http.server on {a.bind}:{a.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
