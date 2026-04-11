import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";

const AGENT_WALLET = process.env.AGENT_WALLET_ADDRESS || "";

// GET: Return agent wallet address + balance
export async function GET() {
  try {
    const result = execSync("onchainos wallet balance", {
      timeout: 15000,
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result);
    return NextResponse.json({
      address: AGENT_WALLET,
      balance: parsed.ok ? parsed.data : null,
    });
  } catch {
    return NextResponse.json({ address: AGENT_WALLET, balance: null });
  }
}

// POST: Withdraw from Agentic Wallet to user's address
export async function POST(req: NextRequest) {
  try {
    const { recipient, amount, tokenAddress } = await req.json();

    if (!recipient || !amount) {
      return NextResponse.json({ error: "Missing recipient or amount" }, { status: 400 });
    }

    // Validate recipient is a valid Ethereum address
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      return NextResponse.json({ error: "Invalid recipient address" }, { status: 400 });
    }

    // Validate amount is a positive number
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    // Build the onchainos wallet send command
    let cmd = `onchainos wallet send --receipt ${recipient} --chain 196 --readable-amount ${amountNum} --force`;
    if (tokenAddress) {
      // Validate token address
      if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
        return NextResponse.json({ error: "Invalid token address" }, { status: 400 });
      }
      cmd += ` --contract-token ${tokenAddress}`;
    }

    const result = execSync(cmd, {
      timeout: 30000,
      encoding: "utf-8",
    });

    const parsed = JSON.parse(result);
    if (parsed.ok) {
      return NextResponse.json({
        status: "ok",
        tx: parsed.data,
      });
    } else {
      return NextResponse.json({ error: parsed.error || "Withdraw failed" }, { status: 500 });
    }
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Withdraw failed" },
      { status: 500 }
    );
  }
}
