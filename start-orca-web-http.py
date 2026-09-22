#!/usr/bin/env python3
"""Static file server for Orca's built web client (out/web).

Replaces `python3 -m http.server`: that server wedged under a stuck
keep-alive connection and then answered every new request with an empty
reply. This one sets SO_REUSEADDR, uses daemon threads and disables
HTTP/1.1 keep-alive so a wedged client can never block the listener.

Why the access log is off: this process is normally launched with its stderr
attached to a pipe that nothing drains (a captured-then-detached launcher). A
per-request log line then fills the ~64KB pipe buffer, and because the log is
written BEFORE the response body, every handler thread blocks on that write —
the listener still accepts TCP but every reply is empty. Verified: with logging
on, request #1328 hung forever; with logging off, 3000/3000 succeeded. Pass
--log to opt back in when stderr is a terminal or a file.
"""
import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # no keep-alive: one request per connection

    def log_message(self, format, *args):  # noqa: A002 - name fixed by the base class
        if not ACCESS_LOG_ENABLED:
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


ACCESS_LOG_ENABLED = False


def main():
    global ACCESS_LOG_ENABLED
    args = [arg for arg in sys.argv[1:] if arg != "--log"]
    ACCESS_LOG_ENABLED = "--log" in sys.argv[1:]
    port = int(args[0]) if len(args) > 0 else 8080
    directory = args[1] if len(args) > 1 else "out/web"
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer(
        ("0.0.0.0", port), functools.partial(Handler, directory=directory)
    )
    print("serving %s on http://0.0.0.0:%d" % (directory, port), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
