"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { TOKENS, TOKEN_COLORS, PRESETS, DEFAULT_DRIFT_THRESHOLD } from "../lib/constants";
import { computeAllocations, planTrades, getMaxDrift, fetchPrices } from "../lib/rebalancer";
import type { PortfolioAllocation, PortfolioTarget, RebalanceTrade } from "../lib/types";

// X Layer chain config
const XLAYER_CHAIN = {
  chainId: "0xc4", // 196
  chainName: "X Layer",
  rpcUrls: ["https://rpc.xlayer.tech"],
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  blockExplorerUrls: ["https://www.okx.com/explorer/xlayer"],
};

// ERC-20 balanceOf ABI
const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

export default function Dashboard() {
  // Wallet state
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Portfolio state
  const [allocations, setAllocations] = useState<PortfolioAllocation[]>([]);
  const [targets, setTargets] = useState<PortfolioTarget>({ OKB: 60, USDT: 30, ETH: 10 });
  const [totalValue, setTotalValue] = useState(0);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Rebalance state
  const [trades, setTrades] = useState<RebalanceTrade[]>([]);
  const [rebalancing, setRebalancing] = useState(false);
  const [driftThreshold, setDriftThreshold] = useState(DEFAULT_DRIFT_THRESHOLD);
  const [autoRebalance, setAutoRebalance] = useState(false);
  const [history, setHistory] = useState<{ time: string; drift: number; trades: number }[]>([]);

  // x402 / Agent state
  const [agentWallet, setAgentWallet] = useState<string | null>(null);
  const [x402Price, setX402Price] = useState("$0.01");
  const [x402Paid, setX402Paid] = useState(0); // total paid rebalances
  const [showX402Modal, setShowX402Modal] = useState(false);

  // Deposit/Withdraw state
  const [showFundModal, setShowFundModal] = useState<"deposit" | "withdraw" | null>(null);
  const [fundToken, setFundToken] = useState("USDT");
  const [fundAmount, setFundAmount] = useState("");
  const [fundLoading, setFundLoading] = useState(false);
  const [agentBalance, setAgentBalance] = useState<string | null>(null);

  // UI state
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [activeTab, setActiveTab] = useState<"portfolio" | "history">("portfolio");
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const autoRef = useRef<NodeJS.Timeout | null>(null);

  // Connect wallet
  const connectWallet = useCallback(async () => {
    if (!(window as any).ethereum) {
      setToast({ msg: "Please install MetaMask or OKX Wallet", type: "err" });
      return;
    }
    setConnecting(true);
    try {
      const provider = (window as any).ethereum;
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const chain = await provider.request({ method: "eth_chainId" });
      setAccount(accounts[0]);
      setChainId(parseInt(chain, 16));

      // Switch to X Layer if needed
      if (parseInt(chain, 16) !== 196) {
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0xc4" }],
          });
          setChainId(196);
        } catch (switchErr: any) {
          if (switchErr.code === 4902) {
            await provider.request({
              method: "wallet_addEthereumChain",
              params: [XLAYER_CHAIN],
            });
            setChainId(196);
          }
        }
      }

      setToast({ msg: "Wallet connected!", type: "ok" });
    } catch (err: any) {
      setToast({ msg: err.message || "Connection failed", type: "err" });
    } finally {
      setConnecting(false);
    }
  }, []);

  // Disconnect
  const disconnect = useCallback(() => {
    setAccount(null);
    setChainId(null);
    setAllocations([]);
    setTotalValue(0);
    setTrades([]);
    setAutoRebalance(false);
    if (autoRef.current) clearInterval(autoRef.current);
  }, []);

  // Fetch portfolio data
  const refreshPortfolio = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const tokenAddrs = Object.keys(TOKENS);
      const prices = await fetchPrices(tokenAddrs);

      // Fetch balances via RPC
      const provider = (window as any).ethereum;
      const balances: Record<string, string> = {};

      for (const addr of tokenAddrs) {
        try {
          const data = "0x70a08231" + "000000000000000000000000" + account.slice(2);
          const result = await provider.request({
            method: "eth_call",
            params: [{ to: addr, data }, "latest"],
          });
          let bal = BigInt(result);

          // OKB is the native gas token on X Layer; the ERC-20 contract is WOKB.
          // Add native OKB balance so users see their full OKB holdings.
          if (addr.toLowerCase() === "0xe538905cf8410324e03a5a23c1c177a474d59b2b") {
            try {
              const nativeBal = await provider.request({
                method: "eth_getBalance",
                params: [account, "latest"],
              });
              bal += BigInt(nativeBal);
            } catch {}
          }

          balances[addr] = bal.toString();
        } catch {
          balances[addr] = "0";
        }
      }

      const allocs = computeAllocations(balances, prices, targets);
      setAllocations(allocs);

      const total = allocs.reduce((s, a) => s + a.balanceUsd, 0);
      setTotalValue(total);

      const planned = planTrades(allocs, driftThreshold);
      setTrades(planned);

      setLastRefresh(new Date());
    } catch (err: any) {
      setToast({ msg: "Failed to load portfolio: " + err.message, type: "err" });
    } finally {
      setLoading(false);
    }
  }, [account, targets, driftThreshold]);

  // Auto refresh on connect
  useEffect(() => {
    if (account) refreshPortfolio();
  }, [account, refreshPortfolio]);

  // x402 auto-rebalance via paid API
  const triggerX402Rebalance = useCallback(async () => {
    if (!account) return;
    try {
      // Call the x402-gated rebalance endpoint
      const res = await fetch("/api/rebalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddress: account,
          targets,
          driftThreshold,
        }),
      });

      if (res.status === 402) {
        // Payment required - show the x402 modal
        setShowX402Modal(true);
        return;
      }

      const data = await res.json();
      if (data.status === "ok") {
        setX402Paid((p) => p + 1);
        setToast({ msg: "Auto-rebalance triggered via x402!", type: "ok" });
        await refreshPortfolio();
      }
    } catch (err: any) {
      setToast({ msg: "Auto-rebalance failed: " + err.message, type: "err" });
    }
  }, [account, targets, driftThreshold, refreshPortfolio]);

  // Auto rebalance timer (uses x402 paid endpoint)
  useEffect(() => {
    if (autoRebalance && account) {
      autoRef.current = setInterval(() => {
        triggerX402Rebalance();
      }, 60000); // check every minute
    }
    return () => {
      if (autoRef.current) clearInterval(autoRef.current);
    };
  }, [autoRebalance, account, triggerX402Rebalance]);

  // Listen for account/chain changes
  useEffect(() => {
    const provider = (window as any).ethereum;
    if (!provider) return;

    const handleAccounts = (accs: string[]) => {
      if (accs.length === 0) disconnect();
      else setAccount(accs[0]);
    };
    const handleChain = (chain: string) => setChainId(parseInt(chain, 16));

    provider.on("accountsChanged", handleAccounts);
    provider.on("chainChanged", handleChain);
    return () => {
      provider.removeListener("accountsChanged", handleAccounts);
      provider.removeListener("chainChanged", handleChain);
    };
  }, [disconnect]);

  // Toast auto-dismiss
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  // Fetch agent wallet info on mount
  useEffect(() => {
    fetch("/api/agent")
      .then((r) => r.json())
      .then((d) => {
        if (d.agentWallet?.address) setAgentWallet(d.agentWallet.address);
        if (d.x402?.price) setX402Price(d.x402.price);
      })
      .catch(() => {});
    // Fetch agent wallet balance
    fetch("/api/wallet")
      .then((r) => r.json())
      .then((d) => {
        if (d.balance?.totalValueUsd) setAgentBalance(d.balance.totalValueUsd);
      })
      .catch(() => {});
  }, []);

  // Deposit to Agentic Wallet (send from user's connected wallet)
  const handleDeposit = useCallback(async () => {
    if (!account || !agentWallet || !fundAmount) return;
    setFundLoading(true);
    try {
      const provider = (window as any).ethereum;
      const tokenEntry = Object.values(TOKENS).find((t) => t.symbol === fundToken);
      if (!tokenEntry) throw new Error("Token not found");

      // ERC-20 transfer(address,uint256)
      const decimals = tokenEntry.decimals;
      const rawAmount = BigInt(Math.floor(parseFloat(fundAmount) * 10 ** decimals));
      const amountHex = rawAmount.toString(16).padStart(64, "0");
      const toHex = agentWallet.slice(2).toLowerCase().padStart(64, "0");
      const data = "0xa9059cbb" + toHex + amountHex;

      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [{
          from: account,
          to: tokenEntry.address,
          data,
          value: "0x0",
        }],
      });

      setToast({ msg: `Deposited ${fundAmount} ${fundToken} to Agent Wallet! Tx: ${txHash.slice(0, 10)}...`, type: "ok" });
      setShowFundModal(null);
      setFundAmount("");
      // Refresh agent balance
      setTimeout(() => {
        fetch("/api/wallet").then(r => r.json()).then(d => {
          if (d.balance?.totalValueUsd) setAgentBalance(d.balance.totalValueUsd);
        }).catch(() => {});
      }, 5000);
    } catch (err: any) {
      setToast({ msg: "Deposit failed: " + (err.message || err), type: "err" });
    } finally {
      setFundLoading(false);
    }
  }, [account, agentWallet, fundAmount, fundToken]);

  // Withdraw from Agentic Wallet (agent sends to user)
  const handleWithdraw = useCallback(async () => {
    if (!account || !fundAmount) return;
    setFundLoading(true);
    try {
      const tokenEntry = Object.values(TOKENS).find((t) => t.symbol === fundToken);
      const res = await fetch("/api/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: account,
          amount: fundAmount,
          tokenAddress: tokenEntry?.address || undefined,
        }),
      });
      const data = await res.json();
      if (data.status === "ok") {
        setToast({ msg: `Withdrew ${fundAmount} ${fundToken} to your wallet!`, type: "ok" });
        setShowFundModal(null);
        setFundAmount("");
        setTimeout(() => {
          fetch("/api/wallet").then(r => r.json()).then(d => {
            if (d.balance?.totalValueUsd) setAgentBalance(d.balance.totalValueUsd);
          }).catch(() => {});
        }, 5000);
      } else {
        setToast({ msg: "Withdraw failed: " + (data.error || "Unknown error"), type: "err" });
      }
    } catch (err: any) {
      setToast({ msg: "Withdraw failed: " + (err.message || err), type: "err" });
    } finally {
      setFundLoading(false);
    }
  }, [account, fundAmount, fundToken]);

  // Execute rebalance
  const executeRebalance = async () => {
    if (trades.length === 0 || !account) return;
    setRebalancing(true);

    const updatedTrades = [...trades];
    for (let i = 0; i < updatedTrades.length; i++) {
      updatedTrades[i] = { ...updatedTrades[i], status: "quoting" };
      setTrades([...updatedTrades]);

      try {
        const res = await fetch("/api/swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromToken: updatedTrades[i].fromAddress,
            toToken: updatedTrades[i].toAddress,
            amountUsd: updatedTrades[i].amountUsd,
            userAddress: account,
          }),
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          throw new Error(data.error || `Swap API returned ${res.status}`);
        }

        if (data.tx) {
          updatedTrades[i] = { ...updatedTrades[i], status: "executing" };
          setTrades([...updatedTrades]);

          // Send tx via the user's wallet
          const provider = (window as any).ethereum;
          const txHash = await provider.request({
            method: "eth_sendTransaction",
            params: [
              {
                from: account,
                to: data.tx.to,
                data: data.tx.data,
                value: data.tx.value || "0x0",
                gas: data.tx.gas,
              },
            ],
          });

          updatedTrades[i] = { ...updatedTrades[i], status: "done", txHash };
        } else {
          updatedTrades[i] = { ...updatedTrades[i], status: "failed", error: "No swap tx returned (quote only)" };
        }
      } catch (err: any) {
        updatedTrades[i] = {
          ...updatedTrades[i],
          status: "failed",
          error: err.message,
        };
      }
      setTrades([...updatedTrades]);
    }

    // Record in history
    const maxDrift = getMaxDrift(allocations);
    setHistory((h) => [
      {
        time: new Date().toLocaleTimeString(),
        drift: Math.round(maxDrift * 10) / 10,
        trades: updatedTrades.filter((t) => t.status === "done").length,
      },
      ...h,
    ]);

    setRebalancing(false);
    const doneCount = updatedTrades.filter((t) => t.status === "done").length;
    const failedCount = updatedTrades.filter((t) => t.status === "failed").length;
    if (failedCount > 0 && doneCount === 0) {
      setToast({ msg: `Rebalance failed: ${updatedTrades.find(t => t.status === "failed")?.error || "swap error"}`, type: "err" });
    } else if (failedCount > 0) {
      setToast({ msg: `Rebalance partial: ${doneCount} done, ${failedCount} failed`, type: "err" });
    } else {
      setToast({ msg: "Rebalance complete!", type: "ok" });
    }
    setTimeout(refreshPortfolio, 3000);
  };

  // Update target slider
  const updateTarget = (symbol: string, value: number) => {
    setTargets((prev) => {
      const newTargets = { ...prev, [symbol]: value };
      // Auto-normalize: adjust the first other token to make sum = 100
      const sum = Object.values(newTargets).reduce((s, v) => s + v, 0);
      if (sum !== 100) {
        const others = Object.keys(newTargets).filter((k) => k !== symbol);
        if (others.length > 0) {
          const diff = 100 - sum;
          const adjustKey = others[0];
          newTargets[adjustKey] = Math.max(0, Math.min(100, newTargets[adjustKey] + diff));
        }
      }
      return newTargets;
    });
  };

  // Apply preset
  const applyPreset = (preset: (typeof PRESETS)[0]) => {
    setTargets(preset.allocations);
    setToast({ msg: `Applied "${preset.name}" strategy`, type: "ok" });
  };

  const maxDrift = getMaxDrift(allocations);
  const needsRebalance = maxDrift > driftThreshold;
  const isWrongChain = chainId !== null && chainId !== 196;
  const shortAddr = account ? `${account.slice(0, 6)}...${account.slice(-4)}` : "";

  return (
    <div className={`min-h-screen relative ${theme === "dark" ? "bg-[#030306] text-gray-100" : "bg-[#fafbfe] text-gray-900"}`}>
      {/* Ambient background */}
      <div className="fixed inset-0 -z-10 pointer-events-none" aria-hidden>
        <div className={`absolute inset-0 ${theme === "dark" ? "opacity-[0.03]" : "opacity-[0.04]"}`}
          style={{ backgroundImage: "radial-gradient(circle at center, currentColor 0.5px, transparent 0.5px)", backgroundSize: "24px 24px" }} />
        <div className="absolute top-[-30%] left-[-15%] w-[700px] h-[700px] rounded-full bg-blue-500/[0.06] blur-[150px] animate-[float_20s_ease-in-out_infinite]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-purple-500/[0.04] blur-[130px] animate-[float_25s_ease-in-out_infinite_reverse]" />
      </div>

      {/* Header */}
      <header
        className={`sticky top-0 z-50 border-b px-6 h-14 flex items-center justify-between glass ${
          theme === "dark" ? "bg-[#030306]/70 border-white/[0.06]" : "bg-white/70 border-black/[0.06]"
        }`}
      >
        <div className="flex items-center gap-3">
          <button onClick={disconnect} className="flex items-center gap-2 hover:opacity-80 transition" title="Back to home">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center text-white font-bold text-xs">
              YP
            </div>
            <span className="font-bold text-sm tracking-tight">YieldPilot</span>
          </button>
          <span
            className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${
              theme === "dark"
                ? "bg-gray-800 border-gray-700 text-gray-400"
                : "bg-gray-100 border-gray-200 text-gray-500"
            }`}
          >
            X Layer
          </span>
          <span
            className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${
              theme === "dark"
                ? "bg-green-500/10 border-green-500/20 text-green-400"
                : "bg-green-50 border-green-200 text-green-600"
            }`}
          >
            x402
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className={`w-8 h-8 rounded-md border flex items-center justify-center transition ${
              theme === "dark"
                ? "border-gray-700 bg-gray-800 text-gray-400 hover:text-blue-400"
                : "border-gray-200 bg-gray-100 text-gray-500 hover:text-blue-500"
            }`}
          >
            {theme === "dark" ? "☀" : "🌙"}
          </button>

          {!account ? (
            <button
              onClick={connectWallet}
              disabled={connecting}
              className="bg-blue-500 text-white text-xs font-semibold px-4 py-2 rounded-lg hover:bg-blue-600 transition disabled:opacity-50"
            >
              {connecting ? "Connecting..." : "Connect Wallet"}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span
                className={`font-mono text-xs px-3 py-1.5 rounded ${
                  theme === "dark" ? "bg-blue-500/10 text-blue-400" : "bg-blue-50 text-blue-600"
                }`}
              >
                {shortAddr}
              </span>
              <button
                onClick={disconnect}
                className={`text-[10px] font-semibold px-2 py-1.5 rounded border transition ${
                  theme === "dark"
                    ? "border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-800"
                    : "border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-300"
                }`}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Wrong chain banner */}
      {isWrongChain && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 text-amber-500 text-center py-2 text-xs font-medium">
          You&apos;re on the wrong network.{" "}
          <button
            onClick={async () => {
              try {
                await (window as any).ethereum.request({
                  method: "wallet_switchEthereumChain",
                  params: [{ chainId: "0xc4" }],
                });
              } catch {}
            }}
            className="bg-amber-500 text-black px-3 py-0.5 rounded font-bold ml-2"
          >
            Switch to X Layer
          </button>
        </div>
      )}

      {/* Main content */}
      {!account ? (
        /* Landing / Connect screen */
        <div className="flex-1 flex flex-col items-center min-h-[calc(100vh-56px)] px-6 relative">
          {/* Hero */}
          <div className="relative w-full max-w-4xl pt-24 pb-20 text-center">
            {/* Orbiting decorative dots */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[60%] w-[280px] h-[280px] -z-10 opacity-[0.15] pointer-events-none" aria-hidden>
              <div className="absolute w-3 h-3 rounded-full bg-blue-500 animate-[orbit_12s_linear_infinite]" />
              <div className="absolute w-2 h-2 rounded-full bg-purple-500 animate-[orbit_18s_linear_infinite_reverse]" />
              <div className="absolute w-2.5 h-2.5 rounded-full bg-cyan-400 animate-[orbit_15s_linear_infinite_2s]" />
            </div>

            {/* Hackathon banner */}
            <div className="animate-fade-up mb-8">
              <div className={`inline-flex items-center gap-2.5 px-4 py-2 rounded-full border ${
                theme === "dark" ? "bg-white/[0.03] border-white/[0.08]" : "bg-black/[0.02] border-black/[0.06]"
              }`}>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                <span className={`text-[11px] font-medium ${theme === "dark" ? "text-gray-300" : "text-gray-600"}`}>
                  OKX Build X Hackathon
                </span>
              </div>
            </div>

            {/* Feature pills */}
            <div className="animate-fade-up stagger-1 flex flex-wrap items-center justify-center gap-2 mb-8">
              {[
                { text: "X Layer Native", cls: theme === "dark" ? "bg-blue-500/10 border-blue-500/20 text-blue-400" : "bg-blue-50 border-blue-200 text-blue-600" },
                { text: "x402 Micropayments", cls: theme === "dark" ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-green-50 border-green-200 text-green-600" },
                { text: "Agentic Wallet", cls: theme === "dark" ? "bg-purple-500/10 border-purple-500/20 text-purple-400" : "bg-purple-50 border-purple-200 text-purple-600" },
                { text: "Zero Gas", cls: theme === "dark" ? "bg-amber-500/10 border-amber-500/20 text-amber-400" : "bg-amber-50 border-amber-200 text-amber-600" },
              ].map((pill, i) => (
                <span key={i} className={`text-[10px] font-bold px-3 py-1 rounded-full border ${pill.cls}`}>{pill.text}</span>
              ))}
            </div>

            {/* Hero heading */}
            <h1 className="animate-fade-up stagger-2 text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tighter mb-6 leading-[1.05]">
              Your Portfolio,
              <br />
              <span className="bg-gradient-to-r from-blue-500 via-cyan-400 to-emerald-400 bg-clip-text text-transparent animate-gradient-flow bg-[length:200%_auto]">
                Always Balanced
              </span>
            </h1>

            <p className={`animate-fade-up stagger-3 text-lg sm:text-xl max-w-xl mx-auto leading-relaxed mb-10 ${
              theme === "dark" ? "text-gray-400" : "text-gray-500"
            }`}>
              Set your ideal allocation with simple sliders. An autonomous agent monitors drift and rebalances your tokens on X Layer.
            </p>

            {/* CTA */}
            <div className="animate-fade-up stagger-4 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                onClick={connectWallet}
                disabled={connecting}
                className="group relative bg-gradient-to-r from-blue-500 to-cyan-500 text-white px-10 py-4 rounded-2xl text-sm font-bold hover:shadow-2xl hover:shadow-blue-500/25 transition-all duration-300 hover:-translate-y-1 disabled:opacity-50 disabled:hover:translate-y-0"
              >
                <span className="relative z-10 flex items-center gap-2">
                  {connecting ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      Connect Wallet
                      <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                    </>
                  )}
                </span>
              </button>
              <a
                href="https://github.com/giwaov/xlayer-rebalancer"
                target="_blank"
                rel="noopener noreferrer"
                className={`group px-8 py-4 rounded-2xl text-sm font-semibold border-2 transition-all duration-300 hover:-translate-y-0.5 ${
                  theme === "dark"
                    ? "border-white/10 text-gray-300 hover:border-white/20 hover:bg-white/[0.03]"
                    : "border-black/10 text-gray-600 hover:border-black/20 hover:bg-black/[0.02]"
                }`}
              >
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                  View Source
                </span>
              </a>
            </div>
            <p className={`mt-4 text-[11px] ${theme === "dark" ? "text-gray-600" : "text-gray-400"}`}>
              Works with MetaMask & OKX Wallet on X Layer (Chain 196)
            </p>
          </div>

          {/* Live stats ticker */}
          <div className="w-full max-w-3xl mb-20 animate-fade-up stagger-5">
            <div className={`flex items-center justify-center divide-x py-5 px-8 rounded-2xl border ${
              theme === "dark" ? "bg-white/[0.02] border-white/[0.06] divide-white/[0.06]" : "bg-white border-gray-200 divide-gray-200"
            }`}>
              {[
                { value: "$0.01", label: "per rebalance", color: "text-green-500" },
                { value: "0", label: "gas fees", color: "text-cyan-500" },
                { value: "196", label: "chain ID", color: "text-blue-500" },
                { value: "60s", label: "auto-check", color: "text-purple-500" },
              ].map((stat, i) => (
                <div key={i} className="text-center flex-1 px-4">
                  <div className={`text-xl font-extrabold font-mono ${stat.color}`}>{stat.value}</div>
                  <div className={`text-[10px] mt-0.5 ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>{stat.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* How it works */}
          <div className="w-full max-w-4xl pb-20">
            <div className="text-center mb-12">
              <p className={`text-[10px] font-bold uppercase tracking-[0.2em] mb-3 ${
                theme === "dark" ? "text-blue-400" : "text-blue-500"
              }`}>How it works</p>
              <h3 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                Four steps to{" "}
                <span className="bg-gradient-to-r from-blue-500 to-cyan-500 bg-clip-text text-transparent">autopilot</span>
              </h3>
            </div>

            <div className="relative">
              {/* Connecting line */}
              <div className={`hidden lg:block absolute top-14 left-[12.5%] right-[12.5%] h-px ${
                theme === "dark" ? "bg-gradient-to-r from-transparent via-white/10 to-transparent" : "bg-gradient-to-r from-transparent via-gray-300 to-transparent"
              }`} />

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { icon: "🔗", title: "Connect", desc: "Link your MetaMask or OKX Wallet in one click", gradient: "from-blue-500/20 to-cyan-500/20" },
                  { icon: "🎯", title: "Set Targets", desc: "Drag sliders or pick a preset strategy", gradient: "from-purple-500/20 to-pink-500/20" },
                  { icon: "📊", title: "Monitor", desc: "Watch portfolio drift in real-time", gradient: "from-amber-500/20 to-orange-500/20" },
                  { icon: "🤖", title: "Autopilot", desc: "Pay $0.01 via x402, agent rebalances for you", gradient: "from-green-500/20 to-emerald-500/20" },
                ].map((step, i) => (
                  <div
                    key={i}
                    className={`animate-fade-up group relative p-6 rounded-2xl border text-center transition-all duration-300 hover:-translate-y-2 hover:shadow-xl gradient-border-card ${
                      theme === "dark"
                        ? "bg-white/[0.02] border-white/[0.06] hover:border-white/[0.12] hover:shadow-blue-500/5"
                        : "bg-white border-gray-200 hover:border-gray-300 hover:shadow-blue-100"
                    }`}
                    style={{ animationDelay: `${i * 0.1}s` }}
                  >
                    <div className={`absolute -top-3 left-1/2 -translate-x-1/2 w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] font-bold font-mono ${
                      theme === "dark"
                        ? "bg-[#030306] border-blue-500/30 text-blue-400"
                        : "bg-[#fafbfe] border-blue-300 text-blue-500"
                    }`}>
                      {i + 1}
                    </div>
                    <div className={`w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center text-2xl bg-gradient-to-br ${step.gradient} transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3`}>
                      {step.icon}
                    </div>
                    <div className="font-bold text-sm mb-1.5">{step.title}</div>
                    <div className={`text-[11px] leading-relaxed ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>{step.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Tech stack */}
          <div className="w-full max-w-4xl pb-20">
            <div className="text-center mb-8">
              <p className={`text-[10px] font-bold uppercase tracking-[0.2em] ${
                theme === "dark" ? "text-gray-500" : "text-gray-400"
              }`}>Powered by</p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {[
                { label: "X Layer", detail: "Chain 196", dot: "bg-blue-500" },
                { label: "x402 Protocol", detail: "HTTP 402 micropayments", dot: "bg-green-500" },
                { label: "Onchain OS", detail: "Agentic Wallet + TEE", dot: "bg-purple-500" },
                { label: "OKX DEX", detail: "Aggregated optimal swaps", dot: "bg-cyan-500" },
                { label: "Zero Gas", detail: "Subsidized transactions", dot: "bg-amber-500" },
              ].map((tech, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl border transition-all duration-200 hover:-translate-y-0.5 ${
                    theme === "dark"
                      ? "bg-white/[0.02] border-white/[0.06] hover:border-white/[0.12]"
                      : "bg-white border-gray-200 hover:border-gray-300 hover:shadow-sm"
                  }`}
                >
                  <div className={`w-2 h-2 rounded-full ${tech.dot}`} />
                  <div>
                    <div className="text-xs font-bold">{tech.label}</div>
                    <div className={`text-[10px] ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>{tech.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* Dashboard */
        <main className="max-w-6xl mx-auto px-6 py-5">
          {/* Agent Wallet Banner */}
          {agentWallet && agentWallet !== "0x0000000000000000000000000000000000000000" && (
            <div
              className={`rounded-xl border p-3 mb-4 flex items-center gap-3 ${
                theme === "dark"
                  ? "bg-blue-500/5 border-blue-500/20"
                  : "bg-blue-50 border-blue-200"
              }`}
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${
                theme === "dark" ? "bg-blue-500/10" : "bg-blue-100"
              }`}>
                🤖
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-500">Agentic Wallet (Project Identity)</div>
                <a
                  href={`https://www.okx.com/explorer/xlayer/address/${agentWallet}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono text-blue-400 hover:underline truncate block"
                >
                  {agentWallet}
                </a>
              </div>
              <div className={`text-[10px] px-2 py-1 rounded border font-semibold ${
                theme === "dark"
                  ? "bg-green-500/10 border-green-500/20 text-green-400"
                  : "bg-green-50 border-green-200 text-green-600"
              }`}>
                TEE-protected
              </div>
              {agentBalance && (
                <div className={`text-xs font-mono font-bold ${
                  theme === "dark" ? "text-gray-300" : "text-gray-700"
                }`}>
                  ${agentBalance}
                </div>
              )}
              <button
                onClick={() => { setShowFundModal("deposit"); setFundAmount(""); }}
                className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-green-500 text-white hover:bg-green-600 transition"
              >
                Deposit
              </button>
              <button
                onClick={() => { setShowFundModal("withdraw"); setFundAmount(""); }}
                className={`text-[10px] font-bold px-3 py-1.5 rounded-lg border transition ${
                  theme === "dark"
                    ? "border-gray-700 text-gray-400 hover:text-white hover:border-gray-500"
                    : "border-gray-300 text-gray-500 hover:text-gray-900"
                }`}
              >
                Withdraw
              </button>
            </div>
          )}

          {/* Loading skeleton */}
          {loading && allocations.length === 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4 animate-pulse">
              {[1,2,3,4].map(i => (
                <div key={i} className={`rounded-xl border p-4 ${
                  theme === "dark" ? "bg-gray-900/50 border-gray-800" : "bg-white border-gray-200"
                }`}>
                  <div className={`h-2.5 w-20 rounded mb-3 ${theme === "dark" ? "bg-gray-800" : "bg-gray-200"}`} />
                  <div className={`h-6 w-24 rounded mb-2 ${theme === "dark" ? "bg-gray-800" : "bg-gray-200"}`} />
                  <div className={`h-2 w-16 rounded ${theme === "dark" ? "bg-gray-800" : "bg-gray-200"}`} />
                </div>
              ))}
            </div>
          )}

          {/* Metrics row */}
          <div className={`grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4 transition-opacity duration-500 ${loading && allocations.length === 0 ? "opacity-0 h-0 overflow-hidden" : "opacity-100"}`}>
            <MetricCard
              label="Total Value"
              value={`$${totalValue.toFixed(2)}`}
              sub="X Layer portfolio"
              icon="💰"
              theme={theme}
            />
            <MetricCard
              label="Max Drift"
              value={`${maxDrift.toFixed(1)}%`}
              sub={needsRebalance ? "Rebalance needed" : "Portfolio balanced"}
              icon={needsRebalance ? "⚠️" : "✅"}
              theme={theme}
            />
            <MetricCard
              label="x402 Rebalances"
              value={String(x402Paid)}
              sub={`${x402Price} per trigger`}
              icon="💳"
              theme={theme}
            />
            <MetricCard
              label="Auto-Rebalance"
              value={autoRebalance ? "ON" : "OFF"}
              sub={autoRebalance ? "x402 paid, every 60s" : "Manual mode"}
              icon={autoRebalance ? "🤖" : "✋"}
              theme={theme}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Left column: Donut + Strategy */}
            <div className="space-y-4">
              {/* Donut chart */}
              <div
                className={`rounded-xl border p-5 ${
                  theme === "dark" ? "bg-gray-900/50 border-gray-800" : "bg-white border-gray-200"
                }`}
              >
                <div className="flex items-center justify-between mb-4">
                  <span className={`text-[10px] font-semibold uppercase tracking-wider ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                    Current Allocation
                  </span>
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                    Live
                  </div>
                </div>

                {/* Simple donut using conic gradient */}
                <div className="flex flex-col items-center">
                  <div className="relative w-44 h-44 mb-4">
                    <div
                      className="w-full h-full rounded-full"
                      style={{
                        background:
                          allocations.length > 0
                            ? `conic-gradient(${allocations
                                .map((a, i) => {
                                  const start = allocations.slice(0, i).reduce((s, x) => s + x.currentPct, 0);
                                  const color = TOKEN_COLORS[a.symbol] || TOKEN_COLORS.DEFAULT;
                                  return `${color} ${start}% ${start + a.currentPct}%`;
                                })
                                .join(", ")})`
                            : theme === "dark"
                              ? "#1f2937"
                              : "#e5e7eb",
                      }}
                    />
                    <div
                      className={`absolute inset-6 rounded-full flex flex-col items-center justify-center ${
                        theme === "dark" ? "bg-[#030306]" : "bg-[#fafbfe]"
                      }`}
                    >
                      <div className="font-bold font-mono text-lg">${totalValue.toFixed(0)}</div>
                      <div className={`text-[9px] uppercase tracking-wider ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                        Total
                      </div>
                    </div>
                  </div>

                  {/* Legend */}
                  <div className="w-full space-y-1.5">
                    {allocations.map((a) => (
                      <div
                        key={a.symbol}
                        className={`flex items-center justify-between py-1.5 border-b ${
                          theme === "dark" ? "border-gray-800" : "border-gray-100"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className="w-2 h-2 rounded-sm"
                            style={{ background: TOKEN_COLORS[a.symbol] || TOKEN_COLORS.DEFAULT }}
                          />
                          <span className="text-xs font-medium">{a.symbol}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-xs font-semibold font-mono">{a.currentPct.toFixed(1)}%</span>
                          <span className={`text-[10px] ml-2 font-mono ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                            ${a.balanceUsd.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Quick strategies */}
              <div
                className={`rounded-xl border p-5 ${
                  theme === "dark" ? "bg-gray-900/50 border-gray-800" : "bg-white border-gray-200"
                }`}
              >
                <span className={`text-[10px] font-semibold uppercase tracking-wider block mb-3 ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                  Quick Strategies
                </span>
                <div className="space-y-2">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => applyPreset(p)}
                      className={`w-full text-left p-3 rounded-lg border transition hover:-translate-y-0.5 ${
                        theme === "dark"
                          ? "bg-gray-800/50 border-gray-700 hover:border-blue-800"
                          : "bg-gray-50 border-gray-200 hover:border-blue-300"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-lg">{p.icon}</span>
                        <div>
                          <div className="text-xs font-bold">{p.name}</div>
                          <div className={`text-[10px] ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>
                            {p.description}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Center + Right: Allocation bars + Controls */}
            <div className="lg:col-span-2 space-y-4">
              {/* Target allocation sliders */}
              <div
                className={`rounded-xl border p-5 ${
                  theme === "dark" ? "bg-gray-900/50 border-gray-800" : "bg-white border-gray-200"
                }`}
              >
                <div className="flex items-center justify-between mb-4">
                  <span className={`text-[10px] font-semibold uppercase tracking-wider ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                    Target Allocation
                  </span>
                  <button
                    onClick={refreshPortfolio}
                    disabled={loading}
                    className={`text-[10px] font-semibold px-3 py-1 rounded border transition ${
                      theme === "dark"
                        ? "border-gray-700 text-gray-400 hover:text-blue-400 hover:border-blue-800"
                        : "border-gray-200 text-gray-500 hover:text-blue-500 hover:border-blue-300"
                    }`}
                  >
                    {loading ? "Loading..." : "↻ Refresh"}
                  </button>
                </div>

                <div className="space-y-4">
                  {Object.entries(TOKENS).map(([addr, info]) => {
                    const alloc = allocations.find((a) => a.symbol === info.symbol);
                    const target = targets[info.symbol] || 0;
                    const current = alloc?.currentPct || 0;
                    const drift = alloc?.drift || 0;
                    const color = TOKEN_COLORS[info.symbol] || TOKEN_COLORS.DEFAULT;

                    return (
                      <div
                        key={addr}
                        className={`p-3 rounded-lg border ${
                          theme === "dark" ? "bg-gray-800/30 border-gray-700" : "bg-gray-50 border-gray-200"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-sm" style={{ background: color }} />
                            <span className="text-sm font-semibold">{info.symbol}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-mono">
                              {current.toFixed(1)}% → {target}%
                            </span>
                            <span
                              className={`text-[10px] font-semibold font-mono px-2 py-0.5 rounded ${
                                Math.abs(drift) < driftThreshold
                                  ? "text-green-500 bg-green-500/10"
                                  : Math.abs(drift) < driftThreshold * 2
                                    ? "text-amber-500 bg-amber-500/10"
                                    : "text-red-500 bg-red-500/10"
                              }`}
                            >
                              {drift > 0 ? "+" : ""}
                              {drift.toFixed(1)}%
                            </span>
                          </div>
                        </div>

                        {/* Slider */}
                        <div className="relative">
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={target}
                            onChange={(e) => updateTarget(info.symbol, Number(e.target.value))}
                            className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                            style={{
                              background: `linear-gradient(to right, ${color} ${target}%, ${
                                theme === "dark" ? "#1f2937" : "#d1d5db"
                              } ${target}%)`,
                            }}
                          />
                        </div>

                        {/* Bar showing current vs target */}
                        <div className={`mt-2 h-1 rounded-full relative ${theme === "dark" ? "bg-gray-700" : "bg-gray-200"}`}>
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${Math.min(current, 100)}%`, background: color }}
                          />
                          <div
                            className="absolute top-[-3px] w-0.5 h-[10px] bg-gray-400 rounded transition-all duration-300"
                            style={{ left: `${target}%` }}
                          />
                        </div>
                        <div className="flex justify-between mt-1">
                          <span className={`text-[10px] font-mono ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                            ${(alloc?.balanceUsd || 0).toFixed(2)}
                          </span>
                          <span className={`text-[10px] font-mono ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                            Target: {target}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Total check */}
                <div className={`mt-3 text-xs text-center font-mono ${
                  Object.values(targets).reduce((s, v) => s + v, 0) === 100
                    ? "text-green-500"
                    : "text-red-500"
                }`}>
                  Total: {Object.values(targets).reduce((s, v) => s + v, 0)}%
                  {Object.values(targets).reduce((s, v) => s + v, 0) !== 100 && " (must equal 100%)"}
                </div>
              </div>

              {/* Rebalance controls */}
              <div
                className={`rounded-xl border p-5 ${
                  theme === "dark" ? "bg-gray-900/50 border-gray-800" : "bg-white border-gray-200"
                }`}
              >
                <div className="flex items-center justify-between mb-4">
                  <span className={`text-[10px] font-semibold uppercase tracking-wider ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                    Rebalance
                  </span>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                      Drift threshold:
                    </span>
                    <select
                      value={driftThreshold}
                      onChange={(e) => setDriftThreshold(Number(e.target.value))}
                      className={`text-xs font-mono px-2 py-1 rounded border ${
                        theme === "dark"
                          ? "bg-gray-800 border-gray-700 text-gray-300"
                          : "bg-white border-gray-200"
                      }`}
                    >
                      {[2, 3, 5, 7, 10].map((v) => (
                        <option key={v} value={v}>
                          {v}%
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Status badge */}
                {allocations.length > 0 && (
                  <div
                    className={`flex items-center gap-3 p-3 rounded-lg border mb-3 ${
                      needsRebalance
                        ? theme === "dark"
                          ? "bg-amber-500/5 border-amber-500/20"
                          : "bg-amber-50 border-amber-200"
                        : theme === "dark"
                          ? "bg-green-500/5 border-green-500/20"
                          : "bg-green-50 border-green-200"
                    }`}
                  >
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${
                        needsRebalance ? "bg-amber-500/10" : "bg-green-500/10"
                      }`}
                    >
                      {needsRebalance ? "⚠️" : "✅"}
                    </div>
                    <div>
                      <div className="text-xs font-semibold">
                        {needsRebalance
                          ? `Drift detected: ${maxDrift.toFixed(1)}%`
                          : "Portfolio is balanced"}
                      </div>
                      <div className={`text-[10px] ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>
                        {needsRebalance
                          ? `${trades.length} trade(s) needed to rebalance`
                          : "No trades needed right now"}
                      </div>
                    </div>
                  </div>
                )}

                {/* Planned trades */}
                {trades.length > 0 && (
                  <div className="space-y-2 mb-4">
                    {trades.map((t, i) => (
                      <div
                        key={i}
                        className={`flex items-center gap-3 p-3 rounded-lg border ${
                          theme === "dark" ? "bg-gray-800/30 border-gray-700" : "bg-gray-50 border-gray-200"
                        }`}
                      >
                        <div
                          className={`w-7 h-7 rounded-md flex items-center justify-center text-xs ${
                            theme === "dark" ? "bg-blue-500/10 text-blue-400" : "bg-blue-50 text-blue-600"
                          }`}
                        >
                          ↔
                        </div>
                        <div className="flex-1">
                          <div className="text-xs font-semibold">
                            <span className="text-red-500">{t.fromSymbol}</span> → <span className="text-green-500">{t.toSymbol}</span>
                          </div>
                          <div className={`text-[10px] ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                            Sell overweight → buy underweight
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-bold font-mono text-blue-500">${t.amountUsd}</div>
                          <div className={`text-[10px] capitalize font-mono ${
                            t.status === "done" ? "text-green-500" : t.status === "failed" ? "text-red-500" : theme === "dark" ? "text-gray-500" : "text-gray-400"
                          }`}>
                            {t.status}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={executeRebalance}
                    disabled={trades.length === 0 || rebalancing}
                    className="flex-1 bg-gradient-to-r from-blue-500 to-cyan-500 text-white py-3 rounded-xl text-sm font-bold hover:shadow-lg hover:shadow-blue-500/25 transition-all duration-300 hover:-translate-y-0.5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                  >
                    {rebalancing ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Rebalancing...
                      </span>
                    ) : (
                      `Rebalance Now${trades.length > 0 ? ` (${trades.length} trades)` : ""}`
                    )}
                  </button>

                  <button
                    onClick={() => setAutoRebalance(!autoRebalance)}
                    className={`px-4 py-3 rounded-lg text-sm font-bold border transition ${
                      autoRebalance
                        ? "bg-green-500/10 border-green-500/30 text-green-500 hover:bg-green-500/20"
                        : theme === "dark"
                          ? "border-gray-700 text-gray-400 hover:border-blue-800 hover:text-blue-400"
                          : "border-gray-200 text-gray-500 hover:border-blue-300 hover:text-blue-500"
                    }`}
                    title={`Auto-rebalance via x402 (${x402Price}/trigger, zero gas on X Layer)`}
                  >
                    {autoRebalance ? "🤖 Auto ON" : `Auto (${x402Price})`}
                  </button>
                </div>

                {/* x402 Economy Loop explainer */}
                <div
                  className={`flex items-center gap-2 mt-3 p-2 rounded-lg border ${
                    theme === "dark"
                      ? "bg-green-500/5 border-green-500/10"
                      : "bg-green-50 border-green-100"
                  }`}
                >
                  <span className="text-[10px]">💳</span>
                  <span className={`text-[10px] ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>
                    Auto-rebalance uses{" "}
                    <span className="font-semibold text-green-500">x402 protocol</span> - pay {x402Price}/trigger,
                    zero gas on X Layer. Agent earns fees, pays Onchain OS API costs, executes swaps.
                  </span>
                </div>

                {lastRefresh && (
                  <div className={`mt-2 text-[10px] text-center ${theme === "dark" ? "text-gray-600" : "text-gray-400"}`}>
                    Last updated: {lastRefresh.toLocaleTimeString()}
                  </div>
                )}
              </div>

              {/* History */}
              {history.length > 0 && (
                <div
                  className={`rounded-xl border p-5 ${
                    theme === "dark" ? "bg-gray-900/50 border-gray-800" : "bg-white border-gray-200"
                  }`}
                >
                  <span className={`text-[10px] font-semibold uppercase tracking-wider block mb-3 ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                    Rebalance History
                  </span>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className={`border-b ${theme === "dark" ? "border-gray-800" : "border-gray-200"}`}>
                          <th className={`text-left pb-2 text-[9px] font-semibold uppercase tracking-wider ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                            Time
                          </th>
                          <th className={`text-left pb-2 text-[9px] font-semibold uppercase tracking-wider ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                            Max Drift
                          </th>
                          <th className={`text-left pb-2 text-[9px] font-semibold uppercase tracking-wider ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
                            Trades
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((h, i) => (
                          <tr key={i} className={`border-b ${theme === "dark" ? "border-gray-800" : "border-gray-100"}`}>
                            <td className="py-2 font-mono">{h.time}</td>
                            <td className="py-2 font-mono text-amber-500">{h.drift}%</td>
                            <td className="py-2 font-mono text-green-500">{h.trades}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      )}

      {/* Footer */}
      <footer
        className={`text-center py-6 text-[11px] border-t mt-auto ${
          theme === "dark" ? "border-white/[0.06] text-gray-500" : "border-gray-200 text-gray-400"
        }`}
      >
        Built for{" "}
        <a
          href="https://web3.okx.com/xlayer/build-x-hackathon"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-gradient-to-r from-blue-500 to-cyan-500 bg-clip-text text-transparent hover:underline font-semibold"
        >
          OKX Build X Hackathon
        </a>{" "}
        · Powered by{" "}
        <a
          href="https://web3.okx.com/onchainos"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-gradient-to-r from-purple-500 to-pink-500 bg-clip-text text-transparent hover:underline font-semibold"
        >
          Onchain OS
        </a>
      </footer>

      {/* x402 Payment Modal */}
      {showX402Modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div
            className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${
              theme === "dark" ? "bg-[#0a0a0f] border-gray-800" : "bg-white border-gray-200"
            }`}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center text-xl">
                💳
              </div>
              <div>
                <h3 className="text-sm font-bold">x402 Payment Required</h3>
                <p className={`text-[11px] ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>
                  Auto-rebalance is a premium feature
                </p>
              </div>
            </div>

            <div className={`rounded-lg border p-4 mb-4 space-y-2 ${
              theme === "dark" ? "bg-gray-900/50 border-gray-800" : "bg-gray-50 border-gray-200"
            }`}>
              <div className="flex justify-between text-xs">
                <span className={theme === "dark" ? "text-gray-400" : "text-gray-500"}>Price per trigger</span>
                <span className="font-bold text-green-500">{x402Price}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className={theme === "dark" ? "text-gray-400" : "text-gray-500"}>Payment</span>
                <span className="font-semibold">USDT on X Layer</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className={theme === "dark" ? "text-gray-400" : "text-gray-500"}>Gas fee</span>
                <span className="font-semibold text-green-500">Zero (subsidized)</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className={theme === "dark" ? "text-gray-400" : "text-gray-500"}>Protocol</span>
                <span className="font-semibold">x402 (HTTP 402)</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className={theme === "dark" ? "text-gray-400" : "text-gray-500"}>Settlement</span>
                <span className="font-semibold">Async (instant delivery)</span>
              </div>
            </div>

            <div className={`rounded-lg border p-3 mb-4 ${
              theme === "dark" ? "bg-blue-500/5 border-blue-500/20" : "bg-blue-50 border-blue-200"
            }`}>
              <div className="text-[10px] font-semibold text-blue-500 uppercase tracking-wider mb-1">Economy Loop</div>
              <div className={`text-[11px] leading-relaxed ${theme === "dark" ? "text-gray-300" : "text-gray-600"}`}>
                You pay {x402Price} via x402 ➜ Agent wallet earns USDT ➜ Agent pays Onchain OS API calls ➜ Agent executes swaps on X Layer DEX ➜ Your portfolio stays balanced
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowX402Modal(false)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition ${
                  theme === "dark"
                    ? "border-gray-700 text-gray-400 hover:text-white"
                    : "border-gray-200 text-gray-500 hover:text-gray-900"
                }`}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowX402Modal(false);
                  setAutoRebalance(true);
                  setToast({ msg: "Auto-rebalance enabled! x402 payments active.", type: "ok" });
                }}
                className="flex-1 bg-green-500 text-white py-2.5 rounded-lg text-sm font-bold hover:bg-green-600 transition"
              >
                Enable Auto ({x402Price}/trigger)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deposit/Withdraw Modal */}
      {showFundModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div
            className={`w-full max-w-sm rounded-2xl border p-6 shadow-2xl ${
              theme === "dark" ? "bg-[#0a0a0f] border-gray-800" : "bg-white border-gray-200"
            }`}
          >
            <div className="flex items-center gap-3 mb-5">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl ${
                showFundModal === "deposit" ? "bg-green-500/10" : "bg-orange-500/10"
              }`}>
                {showFundModal === "deposit" ? "💰" : "📤"}
              </div>
              <div>
                <h3 className="text-sm font-bold">
                  {showFundModal === "deposit" ? "Deposit to Agent Wallet" : "Withdraw from Agent Wallet"}
                </h3>
                <p className={`text-[11px] ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>
                  {showFundModal === "deposit"
                    ? "Send tokens from your wallet to fund the agent"
                    : "Agent sends tokens back to your wallet"}
                </p>
              </div>
            </div>

            {/* Token selector */}
            <div className="mb-3">
              <label className={`text-[10px] font-semibold uppercase tracking-wider block mb-1 ${
                theme === "dark" ? "text-gray-500" : "text-gray-400"
              }`}>Token</label>
              <div className="flex gap-2">
                {["USDT", "OKB", "ETH"].map((sym) => (
                  <button
                    key={sym}
                    onClick={() => setFundToken(sym)}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold border transition ${
                      fundToken === sym
                        ? "bg-blue-500 text-white border-blue-500"
                        : theme === "dark"
                          ? "border-gray-700 text-gray-400 hover:border-gray-500"
                          : "border-gray-200 text-gray-500 hover:border-gray-400"
                    }`}
                  >
                    {sym}
                  </button>
                ))}
              </div>
            </div>

            {/* Amount input */}
            <div className="mb-4">
              <label className={`text-[10px] font-semibold uppercase tracking-wider block mb-1 ${
                theme === "dark" ? "text-gray-500" : "text-gray-400"
              }`}>Amount</label>
              <input
                type="number"
                step="any"
                min="0"
                value={fundAmount}
                onChange={(e) => setFundAmount(e.target.value)}
                placeholder="0.00"
                className={`w-full px-4 py-3 rounded-lg border text-sm font-mono font-bold focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  theme === "dark"
                    ? "bg-gray-900 border-gray-700 text-white placeholder-gray-600"
                    : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400"
                }`}
              />
            </div>

            {/* Info */}
            <div className={`rounded-lg border p-3 mb-4 text-[11px] space-y-1 ${
              theme === "dark" ? "bg-gray-900/50 border-gray-800 text-gray-400" : "bg-gray-50 border-gray-200 text-gray-500"
            }`}>
              {showFundModal === "deposit" ? (
                <>
                  <div>Your wallet signs a token transfer to the Agent Wallet.</div>
                  <div>The agent uses these funds to pay for x402 API calls and execute swaps.</div>
                  <div className="font-semibold text-blue-500">Zero gas on X Layer!</div>
                </>
              ) : (
                <>
                  <div>The Agent Wallet sends tokens back to your connected address.</div>
                  <div>Processed via onchainos CLI with TEE-signed transaction.</div>
                </>
              )}
            </div>

            {/* Buttons */}
            <div className="flex gap-3">
              <button
                onClick={() => { setShowFundModal(null); setFundAmount(""); }}
                className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition ${
                  theme === "dark"
                    ? "border-gray-700 text-gray-400 hover:text-white"
                    : "border-gray-200 text-gray-500 hover:text-gray-900"
                }`}
              >
                Cancel
              </button>
              <button
                onClick={showFundModal === "deposit" ? handleDeposit : handleWithdraw}
                disabled={fundLoading || !fundAmount || parseFloat(fundAmount) <= 0}
                className={`flex-1 py-2.5 rounded-lg text-sm font-bold text-white transition disabled:opacity-50 ${
                  showFundModal === "deposit"
                    ? "bg-green-500 hover:bg-green-600"
                    : "bg-orange-500 hover:bg-orange-600"
                }`}
              >
                {fundLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Processing...
                  </span>
                ) : (
                  `${showFundModal === "deposit" ? "Deposit" : "Withdraw"} ${fundAmount || "0"} ${fundToken}`
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-5 right-5 rounded-xl border px-5 py-3.5 text-xs flex items-center gap-2.5 shadow-2xl z-50 animate-slide-toast glass ${
            toast.type === "ok"
              ? theme === "dark"
                ? "bg-[#030306]/90 border-green-500/30 shadow-green-500/10"
                : "bg-white/90 border-green-300 shadow-green-100"
              : theme === "dark"
                ? "bg-[#030306]/90 border-red-500/30 shadow-red-500/10"
                : "bg-white/90 border-red-300 shadow-red-100"
          }`}
        >
          <span className="text-base">{toast.type === "ok" ? "✅" : "❌"}</span>
          <span className="font-medium">{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

// Metric card component
function MetricCard({
  label,
  value,
  sub,
  icon,
  theme,
}: {
  label: string;
  value: string;
  sub: string;
  icon: string;
  theme: "dark" | "light";
}) {
  return (
    <div
      className={`rounded-xl border p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg gradient-border-card ${
        theme === "dark" ? "bg-white/[0.02] border-white/[0.06] hover:shadow-blue-500/5" : "bg-white border-gray-200 hover:shadow-blue-100"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>
          {label}
        </span>
        <span className="text-sm">{icon}</span>
      </div>
      <div className="text-xl font-bold font-mono tracking-tight">{value}</div>
      <div className={`text-[10px] mt-1 ${theme === "dark" ? "text-gray-500" : "text-gray-400"}`}>{sub}</div>
    </div>
  );
}
