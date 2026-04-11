# YieldPilot - Autonomous Portfolio Rebalancer on X Layer

A retail-friendly autonomous portfolio rebalancer for X Layer (Chain ID 196) with x402 micropayments and Agentic Wallet integration.

Built for the **OKX Build X Hackathon - Season 2** (Apr 1-15, 2026) | Arena: "I'm human"

## What It Does

Connect your wallet, set your ideal portfolio split (e.g., 50% OKB, 30% USDT, 20% ETH), and YieldPilot watches your X Layer wallet in real-time. When token prices drift beyond your threshold, it rebalances automatically - one click or fully hands-free via x402 micropayments.

No technical knowledge required. Just connect, set targets, and let the agent work.

## Features

- **One-click wallet connect** - MetaMask or OKX Wallet, auto-switches to X Layer
- **Visual portfolio dashboard** - Donut chart, allocation bars, drift indicators
- **3 preset strategies** - Conservative (70/20/10), Balanced (40/30/30), Growth (20/20/60)
- **Drag-to-adjust sliders** - Set custom allocations with live preview
- **Auto-rebalance** - x402 micropayment ($0.01/trigger) for hands-free operation
- **Agentic Wallet** - TEE-protected agent identity on X Layer
- **x402 payment protocol** - HTTP 402-based pay-per-call economy loop
- **Dark/light theme** - Toggle with system preference detection
- **Zero gas on X Layer** - USDT/USDG as gas tokens
- **Rebalance history** - Full log of all trades with tx hashes

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/giwaov/xlayer-rebalancer.git
cd xlayer-rebalancer/app

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.local.example .env.local
# Edit .env.local with your OKX API keys and Agentic Wallet address

# 4. Install & login to Agentic Wallet
# Windows:
irm https://raw.githubusercontent.com/okx/onchainos-skills/main/install.ps1 | iex
# macOS/Linux:
curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh

onchainos wallet login your@email.com
onchainos wallet addresses  # Get your X Layer address

# 5. Run the dev server
npm run dev
```

Open http://localhost:3000 to use the dashboard.

## Architecture

```
+-------------------+     +-------------------+     +-------------------+
|   User's Wallet   |     |   YieldPilot UI    |     |  Agentic Wallet   |
|   (MetaMask/OKX)  |     |   (Next.js App)    |     |  (onchainos CLI)  |
+--------+----------+     +--------+----------+     +--------+----------+
         |                         |                          |
         | connect                 | fetch prices             | TEE-protected
         v                         v                          | agent identity
+--------+-------------------------+----------+               |
|              Frontend Dashboard              |               |
|  - Donut chart  - Sliders  - Strategies     |               |
|  - Drift bars   - Auto toggle  - History    |               |
+--------+-------------------------+----------+               |
         |                         |                          |
         | sign txs                | API calls                |
         v                         v                          v
+--------+----------+     +--------+----------+     +--------+----------+
|  /api/swap        |     |  /api/prices      |     |  /api/rebalance   |
|  OKX DEX          |     |  OKX DEX + CG     |     |  x402 gated       |
|  Aggregator       |     |  price feeds       |     |  auto-rebalance   |
+-------------------+     +-------------------+     +-------------------+
                                                             |
                                                    HTTP 402 Payment
                                                    Required flow
                                                             |
                                                    +--------+----------+
                                                    |  /api/agent       |
                                                    |  Wallet info &    |
                                                    |  economy loop     |
                                                    +-------------------+
```

### File Structure

```
app/
  src/
    components/
      Dashboard.tsx       # Main UI - wallet connect, charts, sliders, x402 modal
    lib/
      constants.ts        # Token addresses, presets, colors
      types.ts            # TypeScript interfaces
      rebalancer.ts       # Portfolio math - drift, trade planning, execution
    app/
      page.tsx            # Entry point
      layout.tsx          # Metadata & fonts
      api/
        prices/route.ts   # Token price fetching (OKX DEX -> CoinGecko fallback)
        swap/route.ts     # DEX swap execution via OKX Aggregator
        rebalance/route.ts # x402-gated auto-rebalance endpoint
        agent/route.ts    # Agentic Wallet info & economy loop
```

## x402 Payment Integration

YieldPilot uses the [x402 protocol](https://www.x402.org/) for its auto-rebalance feature:

1. User enables "Auto" mode in the dashboard
2. Frontend calls `POST /api/rebalance` every 60 seconds
3. Server responds with HTTP 402 + payment requirements (ExactEvmScheme on eip155:196)
4. Client signs a $0.01 USDT micropayment via the x402 SDK
5. Server verifies payment, triggers rebalance, returns result
6. Agent earns USDT, pays OnchainOS API fees, executes swaps on X Layer

This creates a self-sustaining economy loop where the agent funds its own operations through user micropayments.

**Packages used:**
- `@okxweb3/x402-core` - Payment scheme types and verification
- `@okxweb3/x402-evm` - EVM-specific x402 facilitator client

## OnchainOS / Uniswap Skill Usage

| Skill | How It's Used |
|-------|---------------|
| `okx-agentic-wallet` | Agent identity on X Layer, TEE-protected key management |
| `okx-dex-swap` | DEX aggregation, swap quotes and execution |
| `okx-dex-market` | Real-time token price feeds for portfolio valuation |
| `okx-security` | Token security scanning (honeypot/rug-pull detection) |
| `okx-dex-token` | Token discovery and metadata on X Layer |
| Uniswap Skills | Swap route optimization via Uniswap V3 pools on X Layer |

## Working Mechanics

### How Drift Detection Works

Each token's current allocation is computed as a percentage of total portfolio value, then compared to the user's target weight:

```
drift = |current_pct - target_pct|
if drift >= threshold (default 5%):
    trigger rebalance
```

### Trade Planning

Overweight tokens (positive drift) are paired with underweight tokens (negative drift). The agent calculates the USD amount to swap from each overweight token to each underweight token using a greedy pairing algorithm.

### Safety

- Token security scan before every buy-side swap
- Max swap amount caps
- Slippage protection via OKX DEX Aggregator
- User signs every transaction (non-custodial)

## Deployment Address

**Agentic Wallet (X Layer):** `0xf2ee7190e35c269408643dcc3d8f4ba82857730a`

Fund the wallet with tokens to enable the agent's auto-rebalance service.

## X Layer Ecosystem Positioning

YieldPilot brings automated portfolio management to X Layer's DeFi ecosystem:

- **Increases X Layer DEX volume** through regular, automated swap transactions
- **Demonstrates OnchainOS composability** - chains 6+ skills in one workflow
- **Lowers the barrier** for retail users to maintain diversified DeFi positions
- **Showcases x402** as a viable micropayment model for agent services
- **Zero gas costs** - leverages X Layer's USDT/USDG gas model

## Tech Stack

- **Frontend:** Next.js 16, React, TypeScript, Tailwind CSS
- **Chain:** X Layer (Chain ID 196)
- **DEX:** OKX DEX Aggregator API
- **Payments:** x402 protocol (@okxweb3/x402-core, @okxweb3/x402-evm)
- **Agent:** OnchainOS Agentic Wallet (onchainos CLI)
- **Wallets:** MetaMask, OKX Wallet (EIP-1193)

## Team

- **giwaov** - Solo developer

## License

MIT
