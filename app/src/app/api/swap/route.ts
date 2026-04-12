import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const OKX_BASE = "https://www.okx.com";
const DEX_PATH = "/api/v5/dex/aggregator";
const CHAIN_ID = "196";

/** Build OKX API auth headers (HMAC-SHA256 signed) */
function okxHeaders(method: string, requestPath: string, body?: string) {
  const timestamp = new Date().toISOString();
  const prehash = timestamp + method + requestPath + (body ?? "");
  const sign = crypto
    .createHmac("sha256", process.env.OKX_SECRET_KEY || "")
    .update(prehash)
    .digest("base64");
  return {
    "OK-ACCESS-KEY": process.env.OKX_API_KEY || "",
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_PASSPHRASE || "",
    "Content-Type": "application/json",
  };
}

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
    const quotePath = `${DEX_PATH}/quote?chainId=${CHAIN_ID}&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&amount=${rawAmount}&slippage=0.5`;

    const quoteRes = await fetch(`${OKX_BASE}${quotePath}`, {
      headers: okxHeaders("GET", quotePath),
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

    // Step 3: Get swap transaction data
    const swapPath = `${DEX_PATH}/swap?chainId=${CHAIN_ID}&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&amount=${rawAmount}&slippage=0.5&userWalletAddress=${userAddress}`;

    const swapRes = await fetch(`${OKX_BASE}${swapPath}`, {
      headers: okxHeaders("GET", swapPath),
      signal: AbortSignal.timeout(15000),
    });

    if (!swapRes.ok) {
      const errText = await swapRes.text();
      console.error("[swap] swap tx failed:", swapRes.status, errText);
      return NextResponse.json({
        error: "Swap tx build failed",
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
