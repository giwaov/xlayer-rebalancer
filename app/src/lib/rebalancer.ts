import { TOKENS } from "./constants";
import type { PortfolioAllocation, PortfolioTarget, RebalanceTrade } from "./types";

/**
 * Fetch token prices from Onchain OS Market API via our backend route
 */
export async function fetchPrices(tokenAddresses: string[]): Promise<Record<string, number>> {
  const res = await fetch("/api/prices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokens: tokenAddresses }),
  });
  if (!res.ok) throw new Error("Failed to fetch prices");
  return res.json();
}

/**
 * Build portfolio allocations from balances and prices
 */
export function computeAllocations(
  balances: Record<string, string>,
  prices: Record<string, number>,
  targets: PortfolioTarget
): PortfolioAllocation[] {
  const items: { symbol: string; address: string; balanceUsd: number; price: number }[] = [];
  let totalUsd = 0;

  for (const [addr, info] of Object.entries(TOKENS)) {
    const rawBal = balances[addr] || "0";
    const price = prices[addr] || 0;
    const decimals = info.decimals;
    const bal = Number(rawBal) / 10 ** decimals;
    const usd = bal * price;
    totalUsd += usd;
    items.push({ symbol: info.symbol, address: addr, balanceUsd: usd, price });
  }

  if (totalUsd === 0) {
    return items.map((i) => ({
      ...i,
      currentPct: 0,
      targetPct: targets[i.symbol] || 0,
      drift: -(targets[i.symbol] || 0),
    }));
  }

  return items.map((i) => {
    const currentPct = (i.balanceUsd / totalUsd) * 100;
    const targetPct = targets[i.symbol] || 0;
    return {
      ...i,
      currentPct,
      targetPct,
      drift: currentPct - targetPct,
    };
  });
}

/**
 * Plan trades to rebalance from current to target allocations
 */
export function planTrades(
  allocations: PortfolioAllocation[],
  driftThreshold: number
): RebalanceTrade[] {
  const overweight = allocations
    .filter((a) => a.drift > driftThreshold)
    .sort((a, b) => b.drift - a.drift);

  const underweight = allocations
    .filter((a) => a.drift < -driftThreshold)
    .sort((a, b) => a.drift - b.drift);

  if (overweight.length === 0 || underweight.length === 0) return [];

  const totalUsd = allocations.reduce((s, a) => s + a.balanceUsd, 0);
  const trades: RebalanceTrade[] = [];

  // Simple greedy pairing: sell overweight -> buy underweight
  const sellAmounts = overweight.map((a) => (a.drift / 100) * totalUsd);
  const buyAmounts = underweight.map((a) => (Math.abs(a.drift) / 100) * totalUsd);

  let si = 0,
    bi = 0;
  let sellRemaining = sellAmounts[0];
  let buyRemaining = buyAmounts[0];

  while (si < overweight.length && bi < underweight.length) {
    const amount = Math.min(sellRemaining, buyRemaining);

    if (amount >= 1) {
      trades.push({
        fromSymbol: overweight[si].symbol,
        toSymbol: underweight[bi].symbol,
        fromAddress: overweight[si].address,
        toAddress: underweight[bi].address,
        amountUsd: Math.round(amount * 100) / 100,
        status: "pending",
      });
    }

    sellRemaining -= amount;
    buyRemaining -= amount;

    if (sellRemaining < 0.01) {
      si++;
      if (si < overweight.length) sellRemaining = sellAmounts[si];
    }
    if (buyRemaining < 0.01) {
      bi++;
      if (bi < underweight.length) buyRemaining = buyAmounts[bi];
    }
  }

  return trades;
}

/**
 * Execute a swap via Onchain OS DEX API (through our backend)
 */
export async function executeSwap(trade: RebalanceTrade, walletAddress: string): Promise<string> {
  const res = await fetch("/api/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromToken: trade.fromAddress,
      toToken: trade.toAddress,
      amountUsd: trade.amountUsd,
      userAddress: walletAddress,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Swap failed" }));
    throw new Error(err.error || "Swap failed");
  }

  const data = await res.json();
  return data.txHash || "";
}

/**
 * Get maximum drift in the portfolio
 */
export function getMaxDrift(allocations: PortfolioAllocation[]): number {
  return Math.max(...allocations.map((a) => Math.abs(a.drift)), 0);
}
