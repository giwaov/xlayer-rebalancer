---
name: xlayer-rebalancer
description: "Autonomous portfolio rebalancing agent for X Layer using OnchainOS"
version: "1.0.0"
author: "giwaov"
tags:
  - rebalancer
  - xlayer
  - onchainos
  - portfolio
  - uniswap
---

# XLayer Rebalancer

## Overview

This skill runs an autonomous portfolio rebalancing agent on X Layer
(Chain ID 196). It monitors your token allocations and automatically executes
swaps to maintain your target portfolio weights using the onchainos CLI.

The agent includes a web dashboard with live allocation charts, paper-trade
mode (default), security scanning, and drift-based triggers.

## Disclaimer

**This agent is provided for educational and hackathon demonstration purposes
only. It does not constitute investment advice.**

1. **High Risk**: Cryptocurrency trading carries extreme risk.
2. **No Guarantees**: Rebalancing does not guarantee profits.
3. **Paper Mode Default**: No real funds are spent until you switch to live mode.
4. **User Responsibility**: All decisions and consequences are yours.
5. **Third-Party Risk**: Depends on onchainos CLI, OKX API, and X Layer network.

## Pre-flight Checks

1. Install `onchainos` CLI (>= 2.0.0):

   ```bash
   # Windows (PowerShell)
   irm https://raw.githubusercontent.com/okx/onchainos-skills/main/install.ps1 | iex

   # macOS / Linux
   curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh
   ```

2. Log in to Agentic Wallet:

   ```bash
   onchainos wallet login <your-email>
   onchainos wallet status
   ```

3. Find token addresses:

   ```bash
   onchainos token search --chain xlayer --query USDT
   onchainos token search --chain xlayer --query OKB
   ```

4. Edit `scripts/config.py` with your target allocation.

## Quick Start

```bash
cd scripts
python3 agent.py
```

Dashboard opens at http://localhost:3197

## Configuration

All parameters in `scripts/config.py`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DRY_RUN` | `True` | Paper mode (quote only) |
| `DRIFT_THRESHOLD` | `5.0` | Rebalance trigger (% drift) |
| `CHECK_INTERVAL` | `300` | Seconds between checks |
| `TARGET_PORTFOLIO` | 60/40 OKB/USDT | Target weights (must sum to 1.0) |
| `MAX_SWAP_AMOUNT_USD` | `50.0` | Max single swap in USD |
| `SLIPPAGE` | `0.5` | Max slippage % for live swaps |

## OnchainOS Skills Used

| Skill | Purpose |
|-------|---------|
| `okx-agentic-wallet` | Wallet auth, balance, addresses |
| `okx-dex-swap` | Swap quotes and execution |
| `okx-dex-market` | Token price data |
| `okx-security` | Token safety scanning |
| `okx-dex-token` | Token search and discovery |

## Architecture

```
User sets TARGET_PORTFOLIO in config.py
         |
         v
   +------------------+
   | Rebalance Cycle   |
   |                    |
   | 1. Get balances    |  <-- onchainos wallet balance
   | 2. Get prices      |  <-- onchainos market prices
   | 3. Compute drift   |
   | 4. Plan trades     |
   | 5. Security scan   |  <-- onchainos security scan
   | 6. Execute swaps   |  <-- onchainos swap
   +------------------+
         |
         v
   Web Dashboard (port 3197)
```
