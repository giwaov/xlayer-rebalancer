export interface TokenBalance {
  address: string;
  symbol: string;
  decimals: number;
  balance: string; // raw balance
  balanceUsd: number;
  price: number;
}

export interface PortfolioAllocation {
  symbol: string;
  address: string;
  currentPct: number;
  targetPct: number;
  drift: number; // currentPct - targetPct
  balanceUsd: number;
  price: number;
}

export interface RebalanceTrade {
  fromSymbol: string;
  toSymbol: string;
  fromAddress: string;
  toAddress: string;
  amountUsd: number;
  status: "pending" | "quoting" | "executing" | "done" | "failed";
  txHash?: string;
  error?: string;
}

export interface RebalanceEvent {
  id: string;
  timestamp: number;
  trades: RebalanceTrade[];
  totalValueBefore: number;
  totalValueAfter?: number;
  driftMax: number;
  mode: "manual" | "auto";
}

export interface PortfolioTarget {
  [symbol: string]: number; // symbol -> percentage (0-100)
}

export interface UserConfig {
  targets: PortfolioTarget;
  driftThreshold: number;
  autoRebalance: boolean;
  slippage: number;
}
