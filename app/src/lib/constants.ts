// X Layer Chain Configuration
export const XLAYER_CHAIN_ID = 196;
export const XLAYER_RPC = "https://rpc.xlayer.tech";
export const XLAYER_EXPLORER = "https://www.okx.com/explorer/xlayer";

// Known tokens on X Layer
export const TOKENS: Record<string, { symbol: string; decimals: number; address: string }> = {
  "0xe538905cf8410324e03a5a23c1c177a474d59b2b": {
    symbol: "OKB",
    decimals: 18,
    address: "0xe538905cf8410324e03a5a23c1c177a474d59b2b",
  },
  "0x779ded0c9e1022225f8e0630b35a9b54be713736": {
    symbol: "USDT",
    decimals: 6,
    address: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  },
  "0x5a77f1443d16ee5761d310e38b7446e3b8b19a5e": {
    symbol: "ETH",
    decimals: 18,
    address: "0x5a77f1443d16ee5761d310e38b7446e3b8b19a5e",
  },
};

export const TOKEN_COLORS: Record<string, string> = {
  OKB: "#3b82f6",
  USDT: "#22c55e",
  ETH: "#8b5cf6",
  WBTC: "#f59e0b",
  DEFAULT: "#6b7280",
};

// Preset portfolio strategies
export const PRESETS = [
  {
    name: "Conservative",
    description: "Stablecoin-heavy, low volatility",
    icon: "🛡️",
    allocations: { OKB: 30, USDT: 60, ETH: 10 },
  },
  {
    name: "Balanced",
    description: "Even split between assets",
    icon: "⚖️",
    allocations: { OKB: 40, USDT: 30, ETH: 30 },
  },
  {
    name: "Growth",
    description: "Maximize exposure to volatile assets",
    icon: "🚀",
    allocations: { OKB: 60, USDT: 10, ETH: 30 },
  },
];

// Rebalancing defaults
export const DEFAULT_DRIFT_THRESHOLD = 5; // percent
export const MIN_SWAP_USD = 1;
export const MAX_SWAP_USD = 500;
export const DEFAULT_SLIPPAGE = 0.5; // percent
