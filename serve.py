#!/usr/bin/env python3
"""CADENZA — 静态宿主（没有 php 时的退路：python3 -m http.server）。

与 serve.ps1 / serve.sh 是**同一份契约的三个实现**（用户裁定 2026-10-23）。
⚠️ 只处理「静态文件 + /config.json」，别把它扩成一个框架。
⚠️ 它比 php -S 少两样东西，写在这里免得被当成等价物：
   · 没有内建路由脚本 ⇒ no-store 只能靠自定义 handler，也就是本文件；
   · 没有自动打开浏览器（那只在 serve.sh 里做，因为三个平台的开法不同）。

用法（serve.sh 会拉起它，也可以直接跑）：
    python3 serve.py --port 17990 --root . --core http://127.0.0.1:17988
"""

import argparse
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

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


def make_handler(root: str, core: str):
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
                body = json.dumps({"core": core}, separators=(",", ":")).encode()
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
    ap.add_argument("--root", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--core", default=os.environ.get("LILARA_CORE", "http://127.0.0.1:17988"))
    a = ap.parse_args()

    handler = make_handler(a.root, a.core.rstrip("/"))
    # 只监听回环：与核心同一条边界（本机单用户）。
    httpd = ThreadingHTTPServer(("127.0.0.1", a.port), handler)
    print(f"  服务器：python3 http.server on 127.0.0.1:{a.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
