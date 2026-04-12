import { NextRequest, NextResponse } from "next/server";
import { getOkxHeaders } from "../../../lib/okx-auth";

const OKX_BASE = "https://web3.okx.com";
const DEX_PATH = "/api/v6/dex/aggregator";
const CHAIN_INDEX = "196";

export async function POST(req: NextRequest) {
  try {
    const { fromToken, toToken, amountUsd, userAddress } = await req.json();

    if (!fromToken || !toToken || !amountUsd || !userAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const tokenInfo = getTokenInfo(fromToken);

    // Get price to convert USD amount to token amount
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

    // Step 1: Get swap quote from OKX DEX
    const quoteQS = `?chainIndex=${CHAIN_INDEX}&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&amount=${rawAmount}&slippage=0.5`;
    const quoteRes = await fetch(`${OKX_BASE}${DEX_PATH}/quote${quoteQS}`, {
      headers: getOkxHeaders("GET", `${DEX_PATH}/quote`, quoteQS),
      signal: AbortSignal.timeout(15000),
    });

    if (!quoteRes.ok) {
      const errText = await quoteRes.text();
      console.error("[swap] quote failed:", quoteRes.status, errText);
      return NextResponse.json(
        { error: "Failed to get swap quote", details: errText },
        { status: 502 }
      );
    }

    const quoteData = await quoteRes.json();
    console.log("[swap] quote response code:", quoteData?.code, "msg:", quoteData?.msg);

    if (quoteData?.code !== "0") {
      return NextResponse.json(
        { error: `Quote error: ${quoteData?.msg || "unknown"}`, code: quoteData?.code },
        { status: 502 }
      );
    }

    // Step 2: Get swap transaction data
    const swapQS = `?chainIndex=${CHAIN_INDEX}&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&amount=${rawAmount}&slippagePercent=0.5&userWalletAddress=${userAddress}`;
    const swapRes = await fetch(`${OKX_BASE}${DEX_PATH}/swap${swapQS}`, {
      headers: getOkxHeaders("GET", `${DEX_PATH}/swap`, swapQS),
      signal: AbortSignal.timeout(15000),
    });

    const swapData = await swapRes.json();
    console.log("[swap] swap response code:", swapData?.code, "msg:", swapData?.msg);

    if (!swapRes.ok || swapData?.code !== "0") {
      return NextResponse.json({
        error: `Swap build failed: ${swapData?.msg || swapRes.status}`,
        mode: "quote",
        quote: quoteData?.data?.[0] || null,
        fromAmount: rawAmount,
        fromSymbol: tokenInfo.symbol,
      });
    }

    const tx = swapData?.data?.[0]?.tx;
    if (!tx) {
      return NextResponse.json({
        error: "No tx data in swap response",
        mode: "quote",
        quote: quoteData?.data?.[0] || null,
      });
    }

    return NextResponse.json({
      mode: "swap",
      tx,
      quote: quoteData?.data?.[0] || null,
    });
  } catch (err: any) {
    console.error("[swap] error:", err);
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
