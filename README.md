# XLayer Rebalancer

Autonomous portfolio rebalancing agent for X Layer (Chain ID 196).
Built for the OKX Build X Hackathon - Season 2 (Apr 1-15, 2026).

## What It Does

You set your ideal portfolio split (e.g., 60% OKB, 40% USDT). The agent
watches your X Layer wallet and automatically swaps tokens to maintain your
target allocation when drift exceeds a threshold.

Every cycle the agent:

1. Checks all token balances via `onchainos wallet`
2. Fetches live prices via `onchainos market`
3. Computes current allocation vs target weights
4. If any token drifts beyond the threshold:
   - Runs security scans on buy-side tokens via `onchainos security`
   - Calculates optimal swap amounts
   - Executes swaps via `onchainos swap` (or quotes in paper mode)
5. Logs the rebalance event and updates the dashboard

## Features

- **Paper-trade mode** (default) for risk-free testing
- **Drift-based triggers** - only trades when allocations move beyond threshold
- **Security scanning** before every buy-side swap
- **Multi-token support** - rebalance across any number of X Layer tokens
- **Web dashboard** at http://localhost:3197 with:
  - Live allocation bar chart (current vs target)
  - Pie chart visualization
  - Drift indicators (green/amber/red)
  - Full rebalance history
- **Config hot-reload** - change targets without restarting
- **Zero pip dependencies** - Python stdlib only

## Quick Start

```bash
# 1. Install onchainos CLI
# Windows:
irm https://raw.githubusercontent.com/okx/onchainos-skills/main/install.ps1 | iex
# macOS/Linux:
curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh

# 2. Login to Agentic Wallet
onchainos wallet login your@email.com

# 3. Find token addresses on X Layer
onchainos token search --chain xlayer --query USDT
onchainos token search --chain xlayer --query OKB

# 4. Edit scripts/config.py with your desired allocation

# 5. Run (paper mode by default)
cd scripts
python3 agent.py
```

Open http://localhost:3197 to view the dashboard.

## Configuration

All parameters live in `scripts/config.py` and support hot-reload.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DRY_RUN` | `True` | Paper mode (quote only), set `False` for live |
| `DRIFT_THRESHOLD` | `5.0` | % drift from target that triggers rebalancing |
| `CHECK_INTERVAL` | `300` | Seconds between portfolio checks |
| `TARGET_PORTFOLIO` | 60/40 OKB/USDT | Dict of token address -> weight (must sum to 1.0) |
| `MIN_SWAP_USD` | `1.0` | Skip swaps below this USD value |
| `MAX_SWAP_AMOUNT_USD` | `50.0` | Cap on single swap value |
| `MAX_REBALANCES` | `100` | Session limit on rebalance events |
| `SLIPPAGE` | `0.5` | Max slippage % for live swaps |

### Example: 3-Token Portfolio

```python
TARGET_PORTFOLIO = {
    "0xe538905cf8410324e03a5a23c1c177a474d59b2b": 0.50,   # OKB
    "0x779ded0c9e1022225f8e0630b35a9b54be713736": 0.30,   # USDT
    "0x5a77f1443d16ee5761d310e38b7446e3b8b19a5e": 0.20,   # ETH
}
```

## Architecture

```
+-----------------------+
|    config.py          |   User sets target allocations
|  TARGET_PORTFOLIO     |   and risk parameters
+-----------+-----------+
            |
            v
+-----------+-----------+
|    Rebalance Cycle     |
|                        |
|  1. wallet balance     |----> onchainos wallet balance --chain 196
|  2. market prices      |----> onchainos market prices --tokens 196:addr
|  3. compute drift      |----> portfolio math (current % vs target %)
|  4. plan trades        |----> pair overweight sells with underweight buys
|  5. security scan      |----> onchainos security token-scan --chain xlayer
|  6. execute swaps      |----> onchainos swap quote/swap --chain xlayer
|                        |
+-----------+------------+
            |
            v
+-----------+------------+
|   Web Dashboard        |   http://localhost:3197
|   - Allocation bars    |
|   - Pie chart          |
|   - Drift indicators   |
|   - Rebalance history  |
+------------------------+

Data persistence:
  events.json     -> trade history
  state.json      -> session counters
  snapshots.json  -> portfolio snapshots over time
```

## OnchainOS / Uniswap Skill Usage

| Skill | Module | How It's Used |
|-------|--------|---------------|
| `okx-agentic-wallet` | Wallet API | Authenticate, get addresses, check balances |
| `okx-dex-swap` | Trade API | Get swap quotes and execute live swaps |
| `okx-dex-market` | Market API | Fetch real-time token prices |
| `okx-security` | Security API | Scan tokens for honeypots/rug-pulls before buying |
| `okx-dex-token` | Token API | Search and discover tokens on X Layer |
| Uniswap Skills | Swap Planning | Swap route optimization via OnchainOS DEX aggregator (routes through Uniswap V3 pools on X Layer when available) |

## Working Mechanics

### Drift Detection

The agent computes each token's current allocation as a percentage of total
portfolio value, then compares it to the target weight. If any token's drift
exceeds `DRIFT_THRESHOLD`, a rebalance is triggered.

```
drift = current_pct - target_pct
if abs(drift) >= DRIFT_THRESHOLD:
    trigger rebalance
```

### Trade Planning

Overweight tokens (positive drift) are paired with underweight tokens
(negative drift). The agent calculates the USD amount to swap from each
overweight token to each underweight token to bring allocations back to target.

### Safety Checks

Before executing any swap:
1. Token security scan (honeypot, rug-pull detection)
2. Risk level assessment (rejects high/critical/scam)
3. Max swap amount cap
4. Session rebalance limit

## Deployment Address

The agent's Agentic Wallet address on X Layer is displayed at startup:
```
[2026-04-08 12:00:00 UTC] Wallet: 0x...your-xlayer-address...
```

Fund this address with the tokens in your `TARGET_PORTFOLIO` to begin.

## Project Positioning in X Layer Ecosystem

XLayer Rebalancer brings traditional portfolio management to X Layer's DeFi
ecosystem. It:

- **Increases X Layer DEX activity** through automated, legitimate swap transactions
- **Demonstrates OnchainOS skill composability** by chaining 5+ skills in a single workflow
- **Lowers the barrier** for users to maintain diversified positions on X Layer
- **Promotes token liquidity** across X Layer's growing token ecosystem

## Team

- **giwaov** - Solo developer

## License

MIT
