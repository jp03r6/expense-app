#!/usr/bin/env python3
"""
ExpenseSnap - Local Development & Multi-Device Wi-Fi Sharing Server
Allows running the web app locally on your Windows laptop and opening it
on your iOS work phone and Android phone over the same Wi-Fi network.
"""

import http.server
import socket
import socketserver
import os
import sys

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

def get_local_ip():
    """Find the local IP address on the Wi-Fi/Ethernet network."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Does not actually establish a connection, just queries routing table
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Enable CORS and caching headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def guess_type(self, path):
        # Ensure proper MIME types for PWA and PDF.js
        if path.endswith('.wasm'):
            return 'application/wasm'
        if path.endswith('.json') or path.endswith('.webmanifest'):
            return 'application/manifest+json'
        if path.endswith('.svg'):
            return 'image/svg+xml'
        return super().guess_type(path)

def main():
    os.chdir(DIRECTORY)
    local_ip = get_local_ip()

    # Try binding to PORT, fallback to PORT+1 if busy
    port = PORT
    httpd = None
    for attempt in range(10):
        try:
            httpd = socketserver.TCPServer(("", port), CustomHandler)
            break
        except OSError:
            port += 1

    if not httpd:
        print("Could not bind to any available port.")
        sys.exit(1)

    laptop_url = f"http://localhost:{port}"
    mobile_url = f"http://{local_ip}:{port}"

    print("=" * 65)
    print("  🧾 ExpenseSnap - Cross-Platform Receipt & Expense Server")
    print("=" * 65)
    print(f"\n  💻 ON THIS WINDOWS LAPTOP:")
    print(f"     Open your browser to:  {laptop_url}")
    print(f"\n  📱 ON YOUR WORK IPHONE / PERSONAL ANDROID PHONE:")
    print(f"     1. Connect your phone to the same Wi-Fi network.")
    print(f"     2. Open Safari (iOS) or Chrome (Android).")
    print(f"     3. Enter this URL:     {mobile_url}")
    print(f"     4. Tap 'Share' -> 'Add to Home Screen' to install as an App!")
    print("\n" + "=" * 65)
    print("  Server is RUNNING. Press Ctrl+C in this terminal to stop.")
    print("=" * 65 + "\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping ExpenseSnap server.")
        httpd.server_close()

if __name__ == '__main__':
    main()
