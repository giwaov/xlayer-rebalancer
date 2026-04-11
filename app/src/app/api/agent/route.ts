import { NextResponse } from "next/server";

// The project's Agentic Wallet - onchain identity on X Layer
// This wallet is created via: onchainos wallet login <email>
// Private keys live in TEE - never exposed
const AGENT_WALLET = process.env.AGENT_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000";

export async function GET() {
  return NextResponse.json({
    project: "YieldPilot",
    description: "Autonomous portfolio rebalancing agent for X Layer",
    agentWallet: {
      address: AGENT_WALLET,
      chain: "X Layer (Chain ID 196)",
      role: "Primary agent - monitors portfolios, executes rebalance swaps, collects x402 fees",
      security: "TEE-protected private key via Onchain OS Agentic Wallet",
    },
    skills: {
      "okx-agentic-wallet": "Wallet authentication, balance queries, transaction signing",
      "okx-dex-swap": "DEX aggregation, swap quotes and execution on X Layer",
      "okx-dex-market": "Real-time token price feeds",
      "okx-security": "Token security scanning (honeypot/rug-pull detection)",
      "okx-dex-token": "Token discovery and metadata on X Layer",
      "uniswap-skills": "Uniswap V3 pool routing on X Layer",
    },
    x402: {
      role: "Seller - charges micropayments for auto-rebalance service",
      price: "$0.01 per rebalance trigger",
      economyLoop: "Users pay x402 -> Agent earns USDT -> Agent pays Onchain OS API fees -> Agent executes swaps on X Layer",
    },
    hackathon: "OKX Build X Hackathon - Season 2 (Apr 1-15, 2026)",
    team: "giwaov",
  });
}
