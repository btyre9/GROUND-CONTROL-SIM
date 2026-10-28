"""Serves the simulator locally and tells the browser to recheck files on every load,
so updated scripts are never run from a stale cache."""
import http.server
import os
import subprocess
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        # Cross-origin isolation lets the Kokoro voice model use several CPU threads.
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        super().end_headers()

    def log_message(self, format, *args):
        pass


def main():
    port = int(os.environ.get('PORT') or (sys.argv[1] if len(sys.argv) > 1 else 8000))
    url = f'http://127.0.0.1:{port}/index.html'
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler)
    except OSError as error:
        raise SystemExit(f'Could not start OpenATC Tower on port {port}: {error}')

    if '--open' in sys.argv and os.environ.get('ATC_NO_OPEN') != '1':
        subprocess.run(['open', '-a', 'Google Chrome', url], check=False)

    print(f'OpenATC Tower is running at {url}', flush=True)
    print('Keep this Terminal window open while using the simulator. Press Control-C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
