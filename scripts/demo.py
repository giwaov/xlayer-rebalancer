#!/usr/bin/env python3
"""
Demo server - runs the dashboard with simulated data for video recording.
No onchainos CLI or wallet required.

Usage: python demo.py
Then open http://localhost:3197
"""

import json
import math
import random
import threading
import time
from datetime import datetime, timezone, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DASHBOARD_FILE = SCRIPT_DIR / "dashboard.html"
PORT = 3197

# Simulated portfolio
TOKENS = [
    {"addr": "0xe538905cf8410324e03a5a23c1c177a474d59b2b", "label": "OKB", "target": 60, "price": 48.52, "balance": 12.8},
    {"addr": "0x779ded0c9e1022225f8e0630b35a9b54be713736", "label": "USDT", "target": 40, "price": 1.00, "balance": 285.0},
]

state = {
    "total_rebalances": 3,
    "total_trades": 5,
    "cycle": 0,
}

events = [
    {"timestamp": "2026-04-08T10:15:00Z", "sell_label": "USDT", "buy_label": "OKB", "usd_amount": 18.50, "mode": "paper"},
    {"timestamp": "2026-04-08T11:30:00Z", "sell_label": "OKB", "buy_label": "USDT", "usd_amount": 12.30, "mode": "paper"},
    {"timestamp": "2026-04-08T13:00:00Z", "sell_label": "USDT", "buy_label": "OKB", "usd_amount": 22.10, "mode": "paper"},
    {"timestamp": "2026-04-08T14:45:00Z", "sell_label": "OKB", "buy_label": "USDT", "usd_amount": 8.75, "mode": "paper"},
    {"timestamp": "2026-04-08T16:20:00Z", "sell_label": "USDT", "buy_label": "OKB", "usd_amount": 15.40, "mode": "paper"},
]


def simulate():
    """Add slight price noise each cycle for realism."""
    while True:
        state["cycle"] += 1
        for tok in TOKENS:
            noise = random.uniform(-0.02, 0.02)
            tok["price"] *= (1 + noise)
            tok["balance"] += random.uniform(-0.1, 0.1) * (0.01 if tok["label"] == "USDT" else 1)
            tok["balance"] = max(tok["balance"], 0.1)

        # Occasionally add a new trade event
        if state["cycle"] % 6 == 0:
            sell = random.choice(["OKB", "USDT"])
            buy = "USDT" if sell == "OKB" else "OKB"
            events.append({
                "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "sell_label": sell,
                "buy_label": buy,
                "usd_amount": round(random.uniform(5, 30), 2),
                "mode": "paper",
            })
            state["total_trades"] += 1
            state["total_rebalances"] += 1

        time.sleep(8)


def build_status():
    total_value = sum(t["price"] * t["balance"] for t in TOKENS)
    portfolio = []
    for t in TOKENS:
        value = t["price"] * t["balance"]
        current = (value / total_value * 100) if total_value > 0 else 0
        portfolio.append({
            "label": t["label"],
            "current": round(current, 1),
            "target": t["target"],
            "drift": round(current - t["target"], 1),
            "value": round(value, 2),
        })

    return {
        "total_rebalances": state["total_rebalances"],
        "total_trades": state["total_trades"],
        "dry_run": True,
        "paused": False,
        "total_value": round(total_value, 2),
        "token_count": len(TOKENS),
        "portfolio": portfolio,
        "events": events[-50:],
    }


class DemoHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/status":
            body = json.dumps(build_status())
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body.encode())
        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            with open(DASHBOARD_FILE, "rb") as f:
                self.wfile.write(f.read())


def main():
    print(f"Demo dashboard: http://localhost:{PORT}")
    print("Press Ctrl+C to stop.\n")

    # Start simulation thread
    sim = threading.Thread(target=simulate, daemon=True)
    sim.start()

    server = HTTPServer(("127.0.0.1", PORT), DemoHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
