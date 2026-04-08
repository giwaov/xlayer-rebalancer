"""
XLayer Rebalancer - Configuration
All adjustable parameters in one file.
Supports hot-reload: changes take effect on the next cycle without restart.
"""

# -- Mode ------------------------------------------------------------------
DRY_RUN = True          # True = paper trading (quote only), False = live swaps
PAUSED  = False         # True = skip all cycles, False = run normally

# -- Rebalancing Parameters ------------------------------------------------
CHECK_INTERVAL = 300        # Seconds between portfolio checks (default: 5 min)
DRIFT_THRESHOLD = 5.0       # Rebalance when any token drifts this % from target
MIN_SWAP_USD = 1.0           # Minimum swap value in USD (skip tiny rebalances)

# -- Target Portfolio Allocations ------------------------------------------
# Keys   = token contract addresses on X Layer (Chain ID 196)
# Values = target weight (must sum to 1.0)
#
# Find addresses: onchainos token search --chain xlayer --query <symbol>
#
# Example: 60% WOKB, 40% USDT
TARGET_PORTFOLIO = {
    "0xe538905cf8410324e03a5a23c1c177a474d59b2b": 0.60,   # WOKB
    "0x779ded0c9e1022225f8e0630b35a9b54be713736": 0.40,   # USDT
}

# Human-readable labels for dashboard display
TOKEN_LABELS = {
    "0xe538905cf8410324e03a5a23c1c177a474d59b2b": "OKB",
    "0x779ded0c9e1022225f8e0630b35a9b54be713736": "USDT",
}

TOKEN_DECIMALS = {
    "0xe538905cf8410324e03a5a23c1c177a474d59b2b": 18,
    "0x779ded0c9e1022225f8e0630b35a9b54be713736": 6,
}

# -- Risk Controls ---------------------------------------------------------
MAX_SWAP_AMOUNT_USD = 50.0      # Max single swap value in USD
MAX_REBALANCES      = 100       # Max rebalance events per session
SLIPPAGE            = 0.5       # Max slippage % for live swaps

# -- Dashboard -------------------------------------------------------------
DASHBOARD_PORT = 3197           # Web dashboard port (different from DCA agent)
