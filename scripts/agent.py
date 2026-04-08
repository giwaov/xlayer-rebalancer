#!/usr/bin/env python3
"""
XLayer Rebalancer v1.0.0 - Autonomous Portfolio Rebalancing on X Layer.

Monitors your X Layer wallet and automatically rebalances token allocations
when they drift beyond a configurable threshold. Uses the onchainos CLI for
wallet management, market data, security scanning, and swap execution.

Requirements: Python 3.8+, onchainos CLI (>= 2.0.0)
"""

import importlib
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Ensure onchainos is in PATH (Windows default install location)
_local_bin = os.path.join(os.path.expanduser("~"), ".local", "bin")
if _local_bin not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _local_bin + os.pathsep + os.environ.get("PATH", "")

import config as cfg

SCRIPT_DIR = Path(__file__).parent
EVENTS_FILE = SCRIPT_DIR / "events.json"
STATE_FILE = SCRIPT_DIR / "state.json"
SNAPSHOT_FILE = SCRIPT_DIR / "snapshots.json"


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(msg: str):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{ts}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# onchainos CLI wrapper
# ---------------------------------------------------------------------------

def onchainos(args: str, timeout: int = 30) -> dict:
    """Run an onchainos CLI command and return parsed JSON."""
    cmd = f"onchainos {args}"
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Timeout running: {cmd}")

    if result.returncode != 0:
        stderr = result.stderr.strip()
        raise RuntimeError(f"onchainos exit {result.returncode}: {stderr}")

    stdout = result.stdout.strip()
    if not stdout:
        return {}
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return {"raw": stdout}


# ---------------------------------------------------------------------------
# Wallet helpers
# ---------------------------------------------------------------------------

def get_wallet_address() -> str:
    """Get the agent's X Layer wallet address."""
    data = onchainos("wallet addresses --chain 196")
    if isinstance(data, dict):
        inner = data.get("data", data)
        for key in ("xlayer", "evm"):
            entries = inner.get(key, [])
            if isinstance(entries, list):
                for entry in entries:
                    if str(entry.get("chainIndex", "")) == "196":
                        return entry["address"]
                if entries:
                    return entries[0].get("address", "")
        addr = inner.get("address", "")
        if addr:
            return addr
    if isinstance(data, list):
        for entry in data:
            if str(entry.get("chainIndex", "")) == "196":
                return entry["address"]
        if data:
            return data[0].get("address", "")
    raise RuntimeError(
        "No X Layer address found. Run: onchainos wallet login <your-email>"
    )


def get_token_balances() -> dict:
    """Get all token balances on X Layer. Returns {address_lower: balance_human}."""
    data = onchainos("wallet balance --chain 196")

    if isinstance(data, dict) and "data" in data:
        inner = data["data"]
    else:
        inner = data

    tokens = []
    if isinstance(inner, list):
        tokens = inner
    elif isinstance(inner, dict):
        tokens = inner.get("tokenAssets", inner.get("tokens", []))
        if not isinstance(tokens, list):
            tokens = []

    importlib.reload(cfg)
    balances = {}
    for tok in tokens:
        addr = (
            tok.get("tokenContractAddress")
            or tok.get("tokenAddress")
            or ""
        ).lower()
        if not addr:
            continue

        raw = float(tok.get("balance", tok.get("amount", 0)))
        dec = int(tok.get("decimals", cfg.TOKEN_DECIMALS.get(addr, 18)))
        human = raw / (10 ** dec) if raw > 10 ** dec else raw
        balances[addr] = human

    return balances


# ---------------------------------------------------------------------------
# Market helpers
# ---------------------------------------------------------------------------

def get_prices(token_addresses: list) -> dict:
    """Get USD prices for a list of tokens. Returns {address_lower: price}."""
    tokens_arg = " ".join(f"196:{a}" for a in token_addresses)
    data = onchainos(f"market prices --tokens {tokens_arg}")

    if isinstance(data, dict) and "ok" in data and "data" in data:
        data = data["data"]

    prices = {}

    def extract_price(obj):
        if isinstance(obj, dict):
            p = obj.get("price", obj.get("lastPrice", 0))
            return float(p) if p else 0.0
        return 0.0

    if isinstance(data, list):
        for item in data:
            addr = (
                item.get("tokenContractAddress")
                or item.get("tokenAddress")
                or item.get("address")
                or ""
            ).lower()
            prices[addr] = extract_price(item)
    elif isinstance(data, dict):
        items = data.get("data", data.get("prices", []))
        if isinstance(items, list):
            for item in items:
                addr = (
                    item.get("tokenContractAddress")
                    or item.get("tokenAddress")
                    or item.get("address")
                    or ""
                ).lower()
                prices[addr] = extract_price(item)
        else:
            # Single token response
            for a in token_addresses:
                prices[a.lower()] = extract_price(data)

    return prices


# ---------------------------------------------------------------------------
# Security helpers
# ---------------------------------------------------------------------------

def scan_token(token_address: str) -> dict:
    """Run a security scan on a token."""
    try:
        data = onchainos(
            f"security token-scan --address {token_address} --chain xlayer"
        )
        if isinstance(data, dict) and "ok" in data and "data" in data:
            return data["data"]
        return data
    except RuntimeError as e:
        log(f"Security scan error: {e}")
        return {"error": str(e)}


def is_token_safe(scan_result: dict) -> bool:
    """Evaluate token safety. Fail-closed: unknown = unsafe."""
    if not scan_result:
        return False
    if scan_result.get("error"):
        return False
    if scan_result.get("isHoneyPot") or scan_result.get("is_honeypot"):
        return False
    risk = str(
        scan_result.get("riskLevel", scan_result.get("risk_level", ""))
    ).lower()
    return risk not in ("high", "critical", "scam")


# ---------------------------------------------------------------------------
# Swap helpers
# ---------------------------------------------------------------------------

def execute_swap(
    from_token: str, to_token: str, amount_raw: str, wallet: str
) -> dict:
    """Execute a rebalance swap. DRY_RUN=True fetches quote only."""
    importlib.reload(cfg)

    if cfg.DRY_RUN:
        data = onchainos(
            f"swap quote --from {from_token} --to {to_token} "
            f"--amount {amount_raw} --chain xlayer"
        )
        return {"mode": "paper", "quote": data}
    else:
        data = onchainos(
            f"swap swap --from {from_token} --to {to_token} "
            f"--amount {amount_raw} --chain xlayer "
            f"--wallet {wallet} --slippage {cfg.SLIPPAGE}",
            timeout=60,
        )
        return {"mode": "live", "result": data}


# ---------------------------------------------------------------------------
# Portfolio math
# ---------------------------------------------------------------------------

def compute_portfolio(balances: dict, prices: dict, targets: dict) -> dict:
    """
    Compute current allocation vs targets.

    Returns dict with per-token info:
      {address: {balance, price, value_usd, current_pct, target_pct, drift}}
    """
    portfolio = {}
    total_value = 0.0

    for addr, target_pct in targets.items():
        addr_l = addr.lower()
        bal = balances.get(addr_l, 0.0)
        price = prices.get(addr_l, 0.0)
        value = bal * price
        total_value += value
        portfolio[addr_l] = {
            "balance": bal,
            "price": price,
            "value_usd": value,
            "target_pct": target_pct * 100,
        }

    if total_value <= 0:
        for addr_l in portfolio:
            portfolio[addr_l]["current_pct"] = 0.0
            portfolio[addr_l]["drift"] = 0.0
        return portfolio

    for addr_l in portfolio:
        current = (portfolio[addr_l]["value_usd"] / total_value) * 100
        portfolio[addr_l]["current_pct"] = current
        portfolio[addr_l]["drift"] = current - portfolio[addr_l]["target_pct"]

    return portfolio


def calculate_rebalance_trades(portfolio: dict, total_value: float) -> list:
    """
    Determine swaps needed to rebalance.

    Returns list of {"sell_token", "buy_token", "usd_amount"} dicts.
    Only generates trades when drift exceeds threshold.
    """
    importlib.reload(cfg)

    overweight = []  # tokens to sell (positive drift)
    underweight = []  # tokens to buy (negative drift)

    for addr, info in portfolio.items():
        drift = info["drift"]
        if abs(drift) < cfg.DRIFT_THRESHOLD:
            continue
        usd_delta = abs(drift / 100) * total_value
        if usd_delta < cfg.MIN_SWAP_USD:
            continue
        if drift > 0:
            overweight.append((addr, usd_delta))
        else:
            underweight.append((addr, usd_delta))

    if not overweight or not underweight:
        return []

    trades = []
    sell_idx = 0
    buy_idx = 0
    sell_remaining = overweight[0][1] if overweight else 0
    buy_remaining = underweight[0][1] if underweight else 0

    while sell_idx < len(overweight) and buy_idx < len(underweight):
        amount = min(sell_remaining, buy_remaining)
        amount = min(amount, cfg.MAX_SWAP_AMOUNT_USD)

        trades.append({
            "sell_token": overweight[sell_idx][0],
            "buy_token": underweight[buy_idx][0],
            "usd_amount": round(amount, 2),
        })

        sell_remaining -= amount
        buy_remaining -= amount

        if sell_remaining <= cfg.MIN_SWAP_USD:
            sell_idx += 1
            if sell_idx < len(overweight):
                sell_remaining = overweight[sell_idx][1]

        if buy_remaining <= cfg.MIN_SWAP_USD:
            buy_idx += 1
            if buy_idx < len(underweight):
                buy_remaining = underweight[buy_idx][1]

    return trades


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def load_json(path: Path):
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return [] if "events" in path.name or "snapshot" in path.name else {}


def save_json(path: Path, data):
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    tmp.replace(path)


def load_events() -> list:
    data = load_json(EVENTS_FILE)
    return data if isinstance(data, list) else []


def load_state() -> dict:
    data = load_json(STATE_FILE)
    if isinstance(data, dict) and data:
        return data
    return {"total_rebalances": 0, "total_trades": 0}


def load_snapshots() -> list:
    data = load_json(SNAPSHOT_FILE)
    return data if isinstance(data, list) else []


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

DASHBOARD_FILE = SCRIPT_DIR / "dashboard.html"

_dashboard_cache = {"mtime": 0.0, "data": b""}


def get_dashboard_html() -> bytes:
    """Load dashboard HTML from external file with file-change caching."""
    if not DASHBOARD_FILE.exists():
        return b"<html><body><h1>dashboard.html not found</h1></body></html>"
    try:
        mtime = DASHBOARD_FILE.stat().st_mtime
    except OSError:
        mtime = 0.0
    if mtime != _dashboard_cache["mtime"]:
        with open(DASHBOARD_FILE, "rb") as f:
            _dashboard_cache["data"] = f.read()
        _dashboard_cache["mtime"] = mtime
    return _dashboard_cache["data"]


class DashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/api/status":
            importlib.reload(cfg)
            state = load_state()
            events = load_events()
            snapshots = load_snapshots()

            portfolio_view = []
            total_value = 0.0
            token_count = 0
            if snapshots:
                latest = snapshots[-1]
                total_value = latest.get("total_value", 0.0)
                token_count = len(latest.get("tokens", {}))
                for addr, info in latest.get("tokens", {}).items():
                    portfolio_view.append({
                        "label": cfg.TOKEN_LABELS.get(addr, addr[:10]),
                        "current": info.get("current_pct", 0),
                        "target": info.get("target_pct", 0),
                        "drift": info.get("drift", 0),
                        "value": info.get("value_usd", 0),
                    })

            body = json.dumps({
                "total_rebalances": state.get("total_rebalances", 0),
                "total_trades": state.get("total_trades", 0),
                "dry_run": cfg.DRY_RUN,
                "paused": cfg.PAUSED,
                "total_value": total_value,
                "token_count": token_count,
                "portfolio": portfolio_view,
                "events": events[-50:],
            })
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body.encode())
        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(get_dashboard_html())


def start_dashboard():
    try:
        server = HTTPServer(("127.0.0.1", cfg.DASHBOARD_PORT), DashboardHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        log(f"Dashboard: http://localhost:{cfg.DASHBOARD_PORT}")
    except OSError as e:
        log(f"Dashboard failed to start (port {cfg.DASHBOARD_PORT} in use): {e}")


# ---------------------------------------------------------------------------
# Rebalance cycle
# ---------------------------------------------------------------------------

def rebalance_cycle(wallet: str, state: dict, events: list, snapshots: list):
    """Run a single rebalance check and execute trades if needed."""
    importlib.reload(cfg)

    if cfg.PAUSED:
        log("PAUSED - skipping cycle")
        return

    if state["total_rebalances"] >= cfg.MAX_REBALANCES:
        log(f"MAX_REBALANCES reached ({cfg.MAX_REBALANCES}). Stopping.")
        return

    targets = {k.lower(): v for k, v in cfg.TARGET_PORTFOLIO.items()}
    if not targets:
        log("ERROR: TARGET_PORTFOLIO is empty in config.py")
        return

    weight_sum = sum(targets.values())
    if abs(weight_sum - 1.0) > 0.01:
        log(f"ERROR: TARGET_PORTFOLIO weights sum to {weight_sum:.2f}, must be 1.0")
        return

    # 1. Get balances
    log("Fetching balances...")
    balances = get_token_balances()
    if not balances:
        log("No token balances found. Ensure wallet is funded on X Layer.")
        return

    for addr in targets:
        if addr not in balances:
            balances[addr] = 0.0
            label = cfg.TOKEN_LABELS.get(addr, addr[:10])
            log(f"  {label}: 0.0 (not in wallet)")

    # 2. Get prices
    log("Fetching prices...")
    addresses = list(targets.keys())
    prices = get_prices(addresses)

    missing_prices = [a for a in addresses if prices.get(a, 0) <= 0]
    if missing_prices:
        labels = [cfg.TOKEN_LABELS.get(a, a[:10]) for a in missing_prices]
        log(f"Price unavailable for: {', '.join(labels)}. Skipping cycle.")
        return

    # 3. Compute portfolio
    portfolio = compute_portfolio(balances, prices, targets)
    total_value = sum(info["value_usd"] for info in portfolio.values())

    log(f"Portfolio value: ${total_value:.2f}")
    for addr, info in portfolio.items():
        label = cfg.TOKEN_LABELS.get(addr, addr[:10])
        drift_sign = "+" if info["drift"] >= 0 else ""
        log(
            f"  {label}: ${info['value_usd']:.2f} "
            f"({info['current_pct']:.1f}% / {info['target_pct']:.1f}% target, "
            f"drift {drift_sign}{info['drift']:.1f}%)"
        )

    # 4. Save snapshot
    snapshot = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_value": total_value,
        "tokens": {
            addr: {
                "balance": info["balance"],
                "price": info["price"],
                "value_usd": info["value_usd"],
                "current_pct": info["current_pct"],
                "target_pct": info["target_pct"],
                "drift": info["drift"],
            }
            for addr, info in portfolio.items()
        },
    }
    snapshots.append(snapshot)
    # Keep last 500 snapshots
    if len(snapshots) > 500:
        snapshots[:] = snapshots[-500:]
    save_json(SNAPSHOT_FILE, snapshots)

    # 5. Check if rebalancing needed
    max_drift = max(abs(info["drift"]) for info in portfolio.values())
    if max_drift < cfg.DRIFT_THRESHOLD:
        log(f"Max drift {max_drift:.1f}% < threshold {cfg.DRIFT_THRESHOLD}%. No rebalance needed.")
        return

    log(f"Drift threshold exceeded ({max_drift:.1f}% >= {cfg.DRIFT_THRESHOLD}%). Planning rebalance...")

    # 6. Calculate trades
    trades = calculate_rebalance_trades(portfolio, total_value)
    if not trades:
        log("No valid trades computed. Skipping.")
        return

    # 7. Security scan buy-side tokens
    buy_tokens = set(t["buy_token"] for t in trades)
    for buy_addr in buy_tokens:
        label = cfg.TOKEN_LABELS.get(buy_addr, buy_addr[:10])
        log(f"Security scanning {label}...")
        scan = scan_token(buy_addr)
        if not is_token_safe(scan):
            log(f"SAFETY REJECT: {label} failed security scan. Aborting rebalance.")
            return

    # 8. Execute trades
    rebalance_events = []
    for trade in trades:
        sell_addr = trade["sell_token"]
        buy_addr = trade["buy_token"]
        sell_label = cfg.TOKEN_LABELS.get(sell_addr, sell_addr[:10])
        buy_label = cfg.TOKEN_LABELS.get(buy_addr, buy_addr[:10])
        usd_amount = trade["usd_amount"]

        # Convert USD amount to sell-token units
        sell_price = prices.get(sell_addr, 0)
        if sell_price <= 0:
            log(f"Cannot determine sell amount for {sell_label}. Skipping trade.")
            continue

        sell_units = usd_amount / sell_price
        sell_decimals = cfg.TOKEN_DECIMALS.get(sell_addr, 18)
        amount_raw = str(int(sell_units * (10 ** sell_decimals)))

        mode_label = "PAPER" if cfg.DRY_RUN else "LIVE"
        log(f"Swapping {sell_units:.4f} {sell_label} -> {buy_label} (~${usd_amount}) [{mode_label}]")

        try:
            result = execute_swap(sell_addr, buy_addr, amount_raw, wallet)
        except RuntimeError as e:
            log(f"Swap failed: {e}")
            continue

        event = {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sell_token": sell_addr,
            "buy_token": buy_addr,
            "sell_label": sell_label,
            "buy_label": buy_label,
            "usd_amount": usd_amount,
            "sell_units": round(sell_units, 6),
            "mode": "paper" if cfg.DRY_RUN else "live",
            "result": result,
        }
        rebalance_events.append(event)
        events.append(event)
        state["total_trades"] += 1

    if rebalance_events:
        state["total_rebalances"] += 1
        save_json(EVENTS_FILE, events)
        save_json(STATE_FILE, state)
        log(
            f"Rebalance #{state['total_rebalances']} complete. "
            f"{len(rebalance_events)} trade(s) executed."
        )
    else:
        log("No trades were executed this cycle.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    log("=" * 60)
    log("XLayer Rebalancer v1.0.0 - X Layer (Chain ID 196)")
    log("=" * 60)

    # Pre-flight: onchainos CLI
    try:
        ver = onchainos("--version")
        version_str = ver.get("raw", ver.get("version", "unknown"))
        log(f"onchainos CLI: {version_str}")
    except RuntimeError:
        log("FATAL: onchainos CLI not found or not in PATH.")
        log(
            "Install: irm https://raw.githubusercontent.com/okx/onchainos-skills/main/install.ps1 | iex"
        )
        sys.exit(1)

    # Pre-flight: wallet
    try:
        wallet = get_wallet_address()
        log(f"Wallet: {wallet}")
    except RuntimeError as e:
        log(f"FATAL: {e}")
        sys.exit(1)

    # Pre-flight: config validation
    importlib.reload(cfg)
    if not cfg.TARGET_PORTFOLIO:
        log("WARNING: TARGET_PORTFOLIO is empty in config.py")
        log("Set your desired token allocations before running.")

    weight_sum = sum(cfg.TARGET_PORTFOLIO.values())
    if abs(weight_sum - 1.0) > 0.01:
        log(f"WARNING: TARGET_PORTFOLIO weights sum to {weight_sum:.2f} (should be 1.0)")

    # Load state
    state = load_state()
    events = load_events()
    snapshots = load_snapshots()

    mode = "PAPER (DRY_RUN)" if cfg.DRY_RUN else "LIVE"
    log(f"Mode: {mode}")
    log(f"Targets: {len(cfg.TARGET_PORTFOLIO)} tokens")
    for addr, weight in cfg.TARGET_PORTFOLIO.items():
        label = cfg.TOKEN_LABELS.get(addr.lower(), addr[:10])
        log(f"  {label}: {weight * 100:.0f}%")
    log(f"Drift threshold: {cfg.DRIFT_THRESHOLD}%")
    log(f"Check interval: {cfg.CHECK_INTERVAL}s")
    log(f"History: {state['total_rebalances']} rebalances, {state['total_trades']} trades")
    log("=" * 60)

    if cfg.PAUSED:
        log("Bot is PAUSED. Set PAUSED = False in config.py to start.")

    # Start dashboard
    start_dashboard()

    # Main loop
    while True:
        try:
            importlib.reload(cfg)
            rebalance_cycle(wallet, state, events, snapshots)
        except KeyboardInterrupt:
            log("Shutting down.")
            break
        except Exception as e:
            log(f"Cycle error: {e}")
        time.sleep(cfg.CHECK_INTERVAL)


if __name__ == "__main__":
    main()
