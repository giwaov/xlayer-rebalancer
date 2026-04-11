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
          balances[addr] = BigInt(result).toString();
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
  }, []);

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
          updatedTrades[i] = { ...updatedTrades[i], status: "done" };
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
    setToast({ msg: "Rebalance complete!", type: "ok" });
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
    <div className={`min-h-screen ${theme === "dark" ? "bg-[#050507] text-gray-100" : "bg-gray-50 text-gray-900"}`}>
      {/* Header */}
      <header
        className={`sticky top-0 z-50 border-b px-6 h-14 flex items-center justify-between ${
          theme === "dark" ? "bg-[#050507] border-gray-800" : "bg-white border-gray-200"
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center text-white font-bold text-xs">
            YP
          </div>
          <span className="font-bold text-sm tracking-tight">YieldPilot</span>
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
        /* Connect screen */
        <div className="flex-1 flex flex-col items-center justify-center min-h-[calc(100vh-56px)] px-6 text-center">
          <div
            className={`w-16 h-16 rounded-2xl flex items-center justify-center text-3xl mb-6 ${
              theme === "dark" ? "bg-blue-500/10" : "bg-blue-50"
            }`}
          >
            ⚖️
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight mb-2">Keep your portfolio balanced</h1>
          <p className={`text-sm max-w-md leading-relaxed mb-8 ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>
            Connect your wallet, set your ideal allocation with simple sliders, and let YieldPilot
            automatically rebalance your X Layer tokens. No coding needed.
          </p>
          <button
            onClick={connectWallet}
            disabled={connecting}
            className="bg-blue-500 text-white px-7 py-3 rounded-xl text-sm font-bold hover:bg-blue-600 hover:shadow-lg hover:shadow-blue-500/20 transition-all hover:-translate-y-0.5 disabled:opacity-50"
          >
            {connecting ? (
              <span className="flex items-center gap-2">
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Connecting...
              </span>
            ) : (
              "Connect Wallet"
            )}
          </button>
          <p className={`mt-3 text-[11px] ${theme === "dark" ? "text-gray-600" : "text-gray-400"}`}>
            Supports MetaMask & OKX Wallet
          </p>

          {/* How it works */}
          <div className="mt-16 w-full max-w-3xl">
            <p className="text-[10px] font-semibold text-blue-500 uppercase tracking-widest mb-2">How it works</p>
            <h3 className="text-lg font-extrabold mb-2">Four steps. Zero complexity.</h3>
            <p className={`text-xs mb-8 ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>
              Set it up in under a minute
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { icon: "🔗", title: "Connect", desc: "Link your wallet in one click" },
                { icon: "🎯", title: "Set Targets", desc: "Choose your ideal allocation" },
                { icon: "📊", title: "Monitor", desc: "Watch drift in real-time" },
                { icon: "💳", title: "Auto-Rebalance", desc: "x402 micropayment, zero gas" },
              ].map((step, i) => (
                <div
                  key={i}
                  className={`p-5 rounded-xl border text-center transition hover:-translate-y-0.5 ${
                    theme === "dark"
                      ? "bg-gray-900/50 border-gray-800 hover:border-gray-700"
                      : "bg-white border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <div
                    className={`w-10 h-10 mx-auto mb-3 rounded-lg flex items-center justify-center text-lg ${
                      theme === "dark" ? "bg-blue-500/10" : "bg-blue-50"
                    }`}
                  >
                    {step.icon}
                  </div>
                  <div className="font-bold text-sm mb-1">{step.title}</div>
                  <div className={`text-xs ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>{step.desc}</div>
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
            </div>
          )}

          {/* Metrics row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
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
                        theme === "dark" ? "bg-[#050507]" : "bg-gray-50"
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
                    className="flex-1 bg-blue-500 text-white py-3 rounded-lg text-sm font-bold hover:bg-blue-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
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
        className={`text-center py-5 text-[11px] border-t mt-auto ${
          theme === "dark" ? "border-gray-800 text-gray-600" : "border-gray-200 text-gray-400"
        }`}
      >
        Built for{" "}
        <a
          href="https://web3.okx.com/xlayer/build-x-hackathon"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:underline font-medium"
        >
          OKX Build X Hackathon
        </a>{" "}
        · Powered by{" "}
        <a
          href="https://web3.okx.com/onchainos"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:underline font-medium"
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

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-5 right-5 rounded-lg border px-4 py-3 text-xs flex items-center gap-2 shadow-lg z-50 animate-fade-in ${
            toast.type === "ok"
              ? theme === "dark"
                ? "bg-gray-900 border-green-500/30"
                : "bg-white border-green-300"
              : theme === "dark"
                ? "bg-gray-900 border-red-500/30"
                : "bg-white border-red-300"
          }`}
        >
          {toast.type === "ok" ? "✅" : "❌"} {toast.msg}
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
      className={`rounded-xl border p-4 transition hover:border-gray-600 ${
        theme === "dark" ? "bg-gray-900/50 border-gray-800" : "bg-white border-gray-200"
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
