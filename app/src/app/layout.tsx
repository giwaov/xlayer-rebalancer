import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "YieldPilot - Autonomous Portfolio Rebalancer on X Layer",
  description: "Keep your crypto portfolio balanced automatically. Set targets, pay $0.01 via x402, and let the agent rebalance your X Layer tokens with zero gas.",
  keywords: ["X Layer", "portfolio rebalancer", "x402", "OKX", "DeFi", "crypto", "Onchain OS", "agentic wallet"],
  openGraph: {
    title: "YieldPilot - Autonomous Portfolio Rebalancer",
    description: "Set targets, pay $0.01 via x402, and let the agent rebalance your X Layer tokens with zero gas.",
    type: "website",
    siteName: "YieldPilot",
  },
  twitter: {
    card: "summary_large_image",
    title: "YieldPilot - Autonomous Portfolio Rebalancer on X Layer",
    description: "Set targets, pay $0.01 via x402, and let the agent rebalance your X Layer tokens with zero gas.",
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
