import { NextRequest, NextResponse } from "next/server";

const AGENT_WALLET = process.env.AGENT_WALLET_ADDRESS || "";
const XLAYER_RPC = "https://rpc.xlayer.tech";

// Token addresses on X Layer
const WALLET_TOKENS: Record<string, { symbol: string; decimals: number; address: string }> = {
  USDT: { symbol: "USDT", decimals: 18, address: "0x779dB6E1f0C088D3A18c0e42223672e5FCf38e2C" },
  OKB:  { symbol: "OKB",  decimals: 18, address: "0xe538905cf8410324e03a5a23c1c177a474d59b2b" },
  ETH:  { symbol: "ETH",  decimals: 18, address: "0x5A77f1443D16ee5761d310e38b62f77f726bC71c" },
};

// Fetch on-chain balance for a token via RPC (works on Vercel - no CLI needed)
async function fetchTokenBalance(wallet: string, tokenAddr: string): Promise<string> {
  const paddedWallet = wallet.slice(2).toLowerCase().padStart(64, "0");
  const data = "0x70a08231" + paddedWallet;
  const res = await fetch(XLAYER_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: tokenAddr, data }, "latest"] }),
  });
  const json = await res.json();
  return json.result ? BigInt(json.result).toString() : "0";
}

// GET: Return agent wallet address + balances (RPC-based, works on Vercel)
export async function GET() {
  if (!AGENT_WALLET) {
    return NextResponse.json({ address: "", balance: null });
  }

  try {
    const balances: Record<string, string> = {};
    let totalValueUsd = 0;

    // Fetch all token balances in parallel
    const entries = Object.entries(WALLET_TOKENS);
    const results = await Promise.all(
      entries.map(([, t]) => fetchTokenBalance(AGENT_WALLET, t.address))
    );

    entries.forEach(([sym, t], i) => {
      const raw = results[i];
      const human = Number(BigInt(raw)) / 10 ** t.decimals;
      balances[sym] = human.toFixed(6);
      // Simple estimate: USDT = $1, OKB ~ $50, ETH ~ $2500
      const priceEst = sym === "USDT" ? 1 : sym === "OKB" ? 50 : 2500;
      totalValueUsd += human * priceEst;
    });

    return NextResponse.json({
      address: AGENT_WALLET,
      balance: { ...balances, totalValueUsd: totalValueUsd.toFixed(2) },
    });
  } catch {
    return NextResponse.json({ address: AGENT_WALLET, balance: null });
  }
}

// POST: Withdraw from Agentic Wallet (onchainos CLI - only works locally)
export async function POST(req: NextRequest) {
  try {
    const { recipient, amount, tokenAddress } = await req.json();

    if (!recipient || !amount) {
      return NextResponse.json({ error: "Missing recipient or amount" }, { status: 400 });
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      return NextResponse.json({ error: "Invalid recipient address" }, { status: 400 });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    // Try onchainos CLI (only available in local dev, not on Vercel)
    let execSync: typeof import("child_process").execSync;
    try {
      execSync = require("child_process").execSync;
    } catch {
      return NextResponse.json(
        { error: "Withdraw is only available when running locally with onchainos CLI installed" },
        { status: 501 }
      );
    }

    let cmd = `onchainos wallet send --receipt ${recipient} --chain 196 --readable-amount ${amountNum} --force`;
    if (tokenAddress) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
        return NextResponse.json({ error: "Invalid token address" }, { status: 400 });
      }
      cmd += ` --contract-token ${tokenAddress}`;
    }

    const result = execSync(cmd, { timeout: 30000, encoding: "utf-8" });
    const parsed = JSON.parse(result);

    if (parsed.ok) {
      return NextResponse.json({ status: "ok", tx: parsed.data });
    } else {
      return NextResponse.json({ error: parsed.error || "Withdraw failed" }, { status: 500 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Withdraw failed" }, { status: 500 });
  }
}
