#!/usr/bin/env bash
# Idempotent testnet deploy for all four OracleDesk contracts.
#
# Safe to re-run: each step checks deployments/testnet.json first and skips
# anything already recorded there. Delete an entry (or the whole file) to
# force that piece to redeploy. Never touches mainnet — the network is
# hardcoded to `testnet` below, not read from the environment.
#
# Requires: stellar CLI, jq. Builds the four contracts first if their wasm
# isn't already built (`make build` does this, or run `stellar contract
# build` yourself first).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=testnet
DEPLOYER_KEY=oracledesk-deployer
AGENT_KEY=oracledesk-agent
# Least-privilege per-role agents registered in the treasury's agent
# registry: the maker creates/seeds and settles, the trader trades and
# settles. The constructor agent above keeps every role until removed.
MAKER_KEY=oracledesk-maker
TRADER_KEY=oracledesk-trader
OUT=deployments/testnet.json
WASM_DIR=target/wasm32v1-none/release

# treasury's risk caps (7-decimal USDC units). Must comfortably clear
# market-core's MIN_SEED (100 USDC) since agent_create_market's seed amount
# is capped by max_trade. Override via env if you need different limits.
MAX_TRADE=${MAX_TRADE:-2000000000}   # 200 USDC
MAX_MARKET=${MAX_MARKET:-5000000000} # 500 USDC
MAX_DAILY=${MAX_DAILY:-10000000000}  # 1,000 USDC
# Cap on capital deployed in open positions across all markets at once
# (must be >= MAX_TRADE).
MAX_NET_EXPOSURE=${MAX_NET_EXPOSURE:-$MAX_DAILY}
# Timelock (seconds, >= 86400) on every loosening treasury change: raising a
# cap, adding or widening an agent, switching market-core or collateral.
CONFIG_DELAY=${CONFIG_DELAY:-86400}
# Per-agent sub-budgets, within the global caps above. The maker's max_trade
# must clear market-core's 100 USDC MIN_SEED.
MAKER_MAX_TRADE=${MAKER_MAX_TRADE:-$MAX_TRADE}
MAKER_MAX_DAILY=${MAKER_MAX_DAILY:-5000000000}   # 500 USDC
TRADER_MAX_TRADE=${TRADER_MAX_TRADE:-$MAX_TRADE}
TRADER_MAX_DAILY=${TRADER_MAX_DAILY:-5000000000} # 500 USDC
ROLE_CREATE=1
ROLE_TRADE=2
ROLE_SETTLE=4
DEFAULT_FEE_BPS=${DEFAULT_FEE_BPS:-100} # 1%
# Portion of each fee kept by the protocol treasury (bps). The remainder
# accrues to the market creator, claimable before resolution. 10000 = the
# protocol keeps everything (pre-#8 behavior).
PROTOCOL_FEE_SHARE_BPS=${PROTOCOL_FEE_SHARE_BPS:-10000}

log() { echo "==> $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' is required but not installed" >&2
    exit 1
  }
}
require_cmd stellar
require_cmd jq

mkdir -p deployments
[ -f "$OUT" ] || echo '{}' >"$OUT"

json_get() { jq -r "$1 // empty" "$OUT"; }
json_set() {
  local tmp
  tmp=$(mktemp)
  jq "$@" "$OUT" >"$tmp" && mv "$tmp" "$OUT"
}

ensure_identity() {
  local name=$1
  if stellar keys address "$name" >/dev/null 2>&1; then
    log "identity '$name' already exists"
  else
    log "generating and funding identity '$name'"
    stellar keys generate "$name" --network "$NETWORK" --fund
  fi
}

# --- wasm must already be built -------------------------------------------
for f in market_core resolver reasoning_registry treasury; do
  if [ ! -f "$WASM_DIR/$f.wasm" ]; then
    log "missing $WASM_DIR/$f.wasm — building all contracts first"
    stellar contract build
    break
  fi
done

# contractimport! (resolver, treasury) reads a vendored copy of
# market-core's wasm at *their* compile time — keep it fresh before
# rebuilding them. See docs/adr/0002-cross-contract-calls.md.
cp "$WASM_DIR/market_core.wasm" contracts/resolver/market_core.wasm
cp "$WASM_DIR/market_core.wasm" contracts/treasury/market_core.wasm
cp "$WASM_DIR/reasoning_registry.wasm" contracts/resolver/reasoning_registry.wasm
stellar contract build

# --- identities -------------------------------------------------------------
ensure_identity "$DEPLOYER_KEY"
ensure_identity "$AGENT_KEY"
ensure_identity "$MAKER_KEY"
ensure_identity "$TRADER_KEY"
DEPLOYER=$(stellar keys address "$DEPLOYER_KEY")
AGENT=$(stellar keys address "$AGENT_KEY")
MAKER=$(stellar keys address "$MAKER_KEY")
TRADER=$(stellar keys address "$TRADER_KEY")
# `.agent` stays for tools that predate the registry.
json_set --arg d "$DEPLOYER" --arg a "$AGENT" --arg m "$MAKER" --arg t "$TRADER" \
  '.deployer = $d | .agent = $a | .agents = {maker: $m, trader: $t}'

# --- USDC test asset ---------------------------------------------------------
# Self-issued testnet "USDC": a real SEP-41 token (7 decimals, matching the
# design doc) with no dependency on guessing a real issuer's contract id.
# <!-- TODO(maintainer): point `collateral` at Circle's real testnet USDC
# issuer if/when this needs to interoperate with other testnet apps. -->
USDC=$(json_get .contracts.usdc)
if [ -z "$USDC" ]; then
  log "deploying self-issued testnet USDC (SEP-41)"
  USDC=$(stellar contract asset deploy \
    --asset "USDC:$DEPLOYER" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK")
  json_set --arg id "$USDC" '.contracts.usdc = $id'
else
  log "USDC already deployed: $USDC"
fi

# --- market-core (placeholder resolver/treasury, wired up after) -----------
MARKET_CORE=$(json_get .contracts.market_core)
if [ -z "$MARKET_CORE" ]; then
  log "deploying market-core"
  MARKET_CORE=$(stellar contract deploy \
    --wasm "$WASM_DIR/market_core.wasm" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" \
    -- \
    --admin "$DEPLOYER" \
    --collateral "$USDC" \
    --treasury "$DEPLOYER" \
    --resolver "$DEPLOYER" \
    --default_fee_bps "$DEFAULT_FEE_BPS" \
    --protocol_fee_share_bps "$PROTOCOL_FEE_SHARE_BPS")
  json_set --arg id "$MARKET_CORE" '.contracts.market_core = $id'
else
  log "market-core already deployed: $MARKET_CORE"
fi

# --- resolver ----------------------------------------------------------------
RESOLVER=$(json_get .contracts.resolver)
if [ -z "$RESOLVER" ]; then
  log "deploying resolver"
  RESOLVER=$(stellar contract deploy \
    --wasm "$WASM_DIR/resolver.wasm" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" \
    -- \
    --admin "$DEPLOYER" \
    --market_core "$MARKET_CORE")
  json_set --arg id "$RESOLVER" '.contracts.resolver = $id'
else
  log "resolver already deployed: $RESOLVER"
fi

# --- treasury ------------------------------------------------------------
TREASURY=$(json_get .contracts.treasury)
if [ -z "$TREASURY" ]; then
  log "deploying treasury"
  TREASURY=$(stellar contract deploy \
    --wasm "$WASM_DIR/treasury.wasm" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" \
    -- \
    --admin "$DEPLOYER" \
    --agent "$AGENT" \
    --collateral "$USDC" \
    --market_core "$MARKET_CORE" \
    --max_trade "$MAX_TRADE" \
    --max_market "$MAX_MARKET" \
    --max_daily "$MAX_DAILY" \
    --max_net_exposure "$MAX_NET_EXPOSURE" \
    --config_delay "$CONFIG_DELAY")
  json_set --arg id "$TREASURY" '.contracts.treasury = $id'
  json_set '.needs_treasury_wiring = true'
else
  log "treasury already deployed: $TREASURY"
fi

# --- reasoning-registry ------------------------------------------------------
REGISTRY=$(json_get .contracts.reasoning_registry)
if [ -z "$REGISTRY" ]; then
  log "deploying reasoning-registry"
  REGISTRY=$(stellar contract deploy \
    --wasm "$WASM_DIR/reasoning_registry.wasm" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" \
    -- \
    --admin "$DEPLOYER")
  json_set --arg id "$REGISTRY" '.contracts.reasoning_registry = $id'
else
  log "reasoning-registry already deployed: $REGISTRY"
fi

# --- wire market-core to the real resolver/treasury -------------------------
if [ "$(json_get .needs_treasury_wiring)" = "true" ] || [ "$(json_get .wired)" != "true" ]; then
  log "wiring market-core.set_resolver / set_treasury"
  stellar contract invoke --id "$MARKET_CORE" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- set_resolver --resolver "$RESOLVER"
  stellar contract invoke --id "$MARKET_CORE" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- set_treasury --treasury "$TREASURY"
  json_set 'del(.needs_treasury_wiring) | .wired = true'
else
  log "market-core already wired to resolver/treasury"
fi

# --- register the agents with reasoning-registry -----------------------------
if [ "$(json_get .agent_registered)" != "true" ]; then
  log "registering agent with reasoning-registry"
  stellar contract invoke --id "$REGISTRY" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- register_agent --agent "$AGENT"
  json_set '.agent_registered = true'
else
  log "agent already registered"
fi
if [ "$(json_get .role_agents_registered)" != "true" ]; then
  log "registering maker and trader with reasoning-registry"
  for a in "$MAKER" "$TRADER"; do
    stellar contract invoke --id "$REGISTRY" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- register_agent --agent "$a"
  done
  json_set '.role_agents_registered = true'
else
  log "maker and trader already registered with reasoning-registry"
fi

# --- maker / trader policies in the treasury's agent registry ---------------
# New agents are a loosening, so set_agent only queues them; they go live
# once execute_agent runs after CONFIG_DELAY. Re-run this script after the
# delay to execute (until then the constructor agent keeps every role).
agent_policy() {
  jq -nc --argjson roles "$1" --arg t "$2" --arg d "$3" \
    '{roles: $roles, max_trade: $t, max_daily: $d, active: true}'
}
propose_agent() {
  local name=$1 addr=$2 roles=$3 max_trade=$4 max_daily=$5
  if [ "$(json_get ".agent_policies.$name")" = "" ]; then
    log "treasury.set_agent($name) — live after ${CONFIG_DELAY}s"
    stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- set_agent --agent "$addr" \
      --policy "$(agent_policy "$roles" "$max_trade" "$max_daily")"
    json_set --arg n "$name" '.agent_policies[$n] = "proposed"'
  fi
  if [ "$(json_get ".agent_policies.$name")" = "proposed" ]; then
    if stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- execute_agent --agent "$addr" >/dev/null 2>&1; then
      log "treasury.execute_agent($name): live"
      json_set --arg n "$name" '.agent_policies[$n] = "active"'
    else
      log "treasury.execute_agent($name): still timelocked, re-run after the delay"
    fi
  else
    log "$name agent already active in the treasury"
  fi
}
propose_agent maker "$MAKER" $((ROLE_CREATE | ROLE_SETTLE)) "$MAKER_MAX_TRADE" "$MAKER_MAX_DAILY"
propose_agent trader "$TRADER" $((ROLE_TRADE | ROLE_SETTLE)) "$TRADER_MAX_TRADE" "$TRADER_MAX_DAILY"

# --- fund the treasury with test USDC ---------------------------------------
# The treasury is a share vault: collateral sent to it directly would be a
# donation to existing shareholders, so the deployer mints to itself and
# deposits, receiving shares (docs/adr/0005-treasury-vault.md).
TREASURY_FUNDED=$(json_get .treasury_funded_amount)
FUND_AMOUNT=${TREASURY_FUND_AMOUNT:-10000000000000} # 1,000,000 USDC
if [ "$TREASURY_FUNDED" != "$FUND_AMOUNT" ]; then
  log "minting $FUND_AMOUNT stroops of test USDC and depositing it into the treasury"
  stellar contract invoke --id "$USDC" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- mint --to "$DEPLOYER" --amount "$FUND_AMOUNT"
  stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- deposit --from "$DEPLOYER" --amount "$FUND_AMOUNT"
  json_set --arg a "$FUND_AMOUNT" '.treasury_funded_amount = $a'
else
  log "treasury already funded with $FUND_AMOUNT stroops"
fi

json_set --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.last_deployed_at = $ts'

log "done. Deployment record: $OUT"
cat "$OUT"
