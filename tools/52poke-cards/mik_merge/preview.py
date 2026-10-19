"""Loopback-only HTML preview. No directory listing or model/credential API."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from .common import output_root, require, safe_path, write


def make_server(run_dir, port=0):
    root = output_root(run_dir)
    page = safe_path(root, root / "semantic-v2/review.html")
    require(page.is_file(), "Build the review page first.")

    class Preview(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            if path not in ("/", "/review.html"):
                self.send_error(404)
                return
            body = page.read_bytes()
            self.send_response(200)
            for key, value in {
                "Content-Type": "text/html; charset=utf-8", "Content-Length": str(len(body)),
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            }.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

    return ThreadingHTTPServer(("127.0.0.1", port), Preview)


def serve(run_dir, port=0):
    root = output_root(run_dir)
    server = make_server(root, port)
    url = f"http://127.0.0.1:{server.server_port}/review.html#semantic"
    write(root, root / "semantic-v2/preview-info.json", {"url": url})
    print("PREVIEW_URL=" + url, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
