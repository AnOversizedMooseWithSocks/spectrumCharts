#!/usr/bin/env python3
"""
Spectrum - Simple HTTP Server
=====================================================
Run this, then open http://localhost:8080 in your browser.

Usage:
    python server.py
    python server.py 9000    (custom port)
"""

import http.server
import os
import sys

def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

    # Serve files from the same directory as this script
    web_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(web_dir)

    handler = http.server.SimpleHTTPRequestHandler
    server = http.server.HTTPServer(("0.0.0.0", port), handler)

    print(f"Spectrum")
    print(f"================================")
    print(f"Serving from: {web_dir}")
    print(f"Open in browser: http://localhost:{port}")
    print(f"Press Ctrl+C to stop.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()

if __name__ == "__main__":
    main()
