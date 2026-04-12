import { NextRequest, NextResponse } from "next/server";

const OKX_BASE = "https://www.okx.com/api/v5/dex/aggregator";
const CHAIN_ID = "196"; // X Layer

const TOKEN_ADDRESSES = {
  okb: "0xe538905cf8410324e03a5a23c1c177a474d59b2b",
  usdt: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  eth: "0x5a77f1443d16ee5761d310e38b62f77f726bc71c",
};

// GET: returns prices for all tracked tokens
export async function GET() {
  const prices: Record<string, number> = {};
  for (const [symbol, addr] of Object.entries(TOKEN_ADDRESSES)) {
    prices[symbol] = await fetchPrice(addr);
  }
  return NextResponse.json(prices);
}

export async function POST(req: NextRequest) {
  try {
    const { tokens } = await req.json();

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return NextResponse.json({ error: "tokens array required" }, { status: 400 });
    }

    const prices: Record<string, number> = {};

    for (const token of tokens) {
      // Resolve symbol names (e.g. "OKB") to addresses
      const resolved = TOKEN_ADDRESSES[token.toLowerCase() as keyof typeof TOKEN_ADDRESSES] || token.toLowerCase();
      prices[token.toLowerCase()] = await fetchPrice(resolved);
    }

    return NextResponse.json(prices);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function getTokenInfo(addr: string): { decimals: number; symbol: string } {
  const map: Record<string, { decimals: number; symbol: string }> = {
    "0xe538905cf8410324e03a5a23c1c177a474d59b2b": { decimals: 18, symbol: "OKB" },
    "0x779ded0c9e1022225f8e0630b35a9b54be713736": { decimals: 6, symbol: "USDT" },
    "0x5a77f1443d16ee5761d310e38b62f77f726bc71c": { decimals: 18, symbol: "ETH" },
  };
  return map[addr.toLowerCase()] || { decimals: 18, symbol: "UNKNOWN" };
}

const FALLBACK_PRICES: Record<string, number> = {
  "0xe538905cf8410324e03a5a23c1c177a474d59b2b": 50.0,
  "0x779ded0c9e1022225f8e0630b35a9b54be713736": 1.0,
  "0x5a77f1443d16ee5761d310e38b62f77f726bc71c": 2500.0,
};

async function fetchPrice(addr: string): Promise<number> {
  const lc = addr.toLowerCase();
  if (lc === TOKEN_ADDRESSES.usdt) return 1.0;

  try {
    const info = getTokenInfo(lc);
    const amount = (10 ** info.decimals).toString();
    const quoteUrl = `${OKX_BASE}/quote?chainId=${CHAIN_ID}&fromTokenAddress=${lc}&toTokenAddress=${TOKEN_ADDRESSES.usdt}&amount=${amount}`;
    const res = await fetch(quoteUrl, {
      headers: { "Ok-Access-Key": process.env.OKX_API_KEY || "" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.data?.[0]?.toTokenAmount) {
        return Number(data.data[0].toTokenAmount) / 10 ** 6;
      }
    }
  } catch {}

  try {
    const cgRes = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/x-layer?contract_addresses=${lc}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (cgRes.ok) {
      const cgData = await cgRes.json();
      if (cgData[lc]?.usd) return cgData[lc].usd;
    }
  } catch {}

  return FALLBACK_PRICES[lc] || 0;
}
