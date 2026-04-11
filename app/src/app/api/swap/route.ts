import { NextRequest, NextResponse } from "next/server";

const OKX_BASE = "https://www.okx.com/api/v5/dex/aggregator";
const CHAIN_ID = "196";

export async function POST(req: NextRequest) {
  try {
    const { fromToken, toToken, amountUsd, userAddress } = await req.json();

    if (!fromToken || !toToken || !amountUsd || !userAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Step 1: Get a quote from OKX DEX aggregator
    const tokenInfo = getTokenInfo(fromToken);
    // Convert USD amount to token amount (approximate)
    const priceRes = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/prices`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens: [fromToken] }),
      }
    );
    const prices = await priceRes.json();
    const price = prices[fromToken.toLowerCase()] || 1;
    const tokenAmount = amountUsd / price;
    const rawAmount = BigInt(Math.floor(tokenAmount * 10 ** tokenInfo.decimals)).toString();

    // Step 2: Get swap quote from OKX
    const quoteUrl = `${OKX_BASE}/quote?chainId=${CHAIN_ID}&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&amount=${rawAmount}&slippage=0.5`;

    const quoteRes = await fetch(quoteUrl, {
      headers: {
        "Ok-Access-Key": process.env.OKX_API_KEY || "",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!quoteRes.ok) {
      return NextResponse.json(
        { error: "Failed to get swap quote", details: await quoteRes.text() },
        { status: 502 }
      );
    }

    const quoteData = await quoteRes.json();

    // Step 3: Get swap transaction data
    const swapUrl = `${OKX_BASE}/swap?chainId=${CHAIN_ID}&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&amount=${rawAmount}&slippage=0.5&userWalletAddress=${userAddress}`;

    const swapRes = await fetch(swapUrl, {
      headers: {
        "Ok-Access-Key": process.env.OKX_API_KEY || "",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!swapRes.ok) {
      // Return quote data so frontend can show what would happen
      return NextResponse.json({
        mode: "quote",
        quote: quoteData?.data?.[0] || null,
        fromAmount: rawAmount,
        fromSymbol: tokenInfo.symbol,
      });
    }

    const swapData = await swapRes.json();

    return NextResponse.json({
      mode: "swap",
      tx: swapData?.data?.[0]?.tx || null,
      quote: quoteData?.data?.[0] || null,
    });
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
