#!/usr/bin/env python3
"""Serve Marginalia locally: python3 serve.py, then open http://localhost:5178"""
import http.server, os, sys, webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler) as httpd:
    url = f'http://localhost:{PORT}'
    print(f'Marginalia is running at {url}  (Ctrl+C to stop)')
    if '--no-open' not in sys.argv:
        try: webbrowser.open(url)
        except Exception: pass
    httpd.serve_forever()
