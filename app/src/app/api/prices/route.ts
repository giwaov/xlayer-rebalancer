import { NextRequest, NextResponse } from "next/server";

const OKX_BASE = "https://www.okx.com/api/v5/dex/aggregator";
const CHAIN_ID = "196"; // X Layer

export async function POST(req: NextRequest) {
  try {
    const { tokens } = await req.json();

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return NextResponse.json({ error: "tokens array required" }, { status: 400 });
    }

    // Fetch from CoinGecko as fallback (Onchain OS Market MCP)
    // In production, this would use onchainos market prices API
    const prices: Record<string, number> = {};

    // Use OKX DEX quote endpoint to get token prices via USDT pairs
    const usdtAddr = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

    for (const token of tokens) {
      const addr = token.toLowerCase();
      if (addr === usdtAddr) {
        prices[addr] = 1.0;
        continue;
      }

      try {
        // Get quote for 1 unit of token -> USDT to determine price
        const tokenInfo = getTokenInfo(addr);
        const amount = (10 ** tokenInfo.decimals).toString();

        const quoteUrl = `${OKX_BASE}/quote?chainId=${CHAIN_ID}&fromTokenAddress=${addr}&toTokenAddress=${usdtAddr}&amount=${amount}`;

        const res = await fetch(quoteUrl, {
          headers: {
            "Ok-Access-Key": process.env.OKX_API_KEY || "",
          },
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          const data = await res.json();
          if (data?.data?.[0]?.toTokenAmount) {
            const toAmount = Number(data.data[0].toTokenAmount) / 10 ** 6; // USDT has 6 decimals
            prices[addr] = toAmount;
            continue;
          }
        }
      } catch {
        // fallback below
      }

      // Fallback: CoinGecko
      try {
        const cgRes = await fetch(
          `https://api.coingecko.com/api/v3/simple/token_price/x-layer?contract_addresses=${addr}&vs_currencies=usd`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (cgRes.ok) {
          const cgData = await cgRes.json();
          prices[addr] = cgData[addr]?.usd || 0;
          continue;
        }
      } catch {
        // use hardcoded fallbacks
      }

      // Last resort fallback
      prices[addr] = addr === "0xe538905cf8410324e03a5a23c1c177a474d59b2b" ? 50 : 0;
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
    "0x5a77f1443d16ee5761d310e38b7446e3b8b19a5e": { decimals: 18, symbol: "ETH" },
  };
  return map[addr.toLowerCase()] || { decimals: 18, symbol: "UNKNOWN" };
}
