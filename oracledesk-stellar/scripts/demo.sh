#!/usr/bin/env bash
# End-to-end demo: create a market, trade in it, wait for it to close,
# resolve it, record a reasoning trace, and verify the trace hash on-chain.
#
# NETWORK=testnet (default) or NETWORK=local. The local path is what
# scripts/e2e-local.sh drives; it uses tiny close/dispute windows and the
# deployable test oracle for --mode price.
#
# Usage: scripts/demo.sh [--mode signer|price]
#   signer (default): attest through the resolver's signer mode.
#   price:            resolve through a Reflector-shaped oracle. Requires the
#                     local `test-oracle` contract recorded in the deployment.
#
# What this script does NOT cover by itself: buying the trace through the x402
# HTTP service. scripts/e2e-local.sh starts x402 against the local registry and
# curls it; see docs/STATUS.md for the manual steps.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=${NETWORK:-testnet}
case "$NETWORK" in
  testnet) NETWORK_PASSPHRASE="Test SDF Network ; September 2015" ;;
  local) NETWORK_PASSPHRASE="Standalone Network ; February 2017" ;;
  *) echo "error: NETWORK must be testnet or local (never mainnet)" >&2; exit 1 ;;
esac

IDENTITY_PREFIX=${IDENTITY_PREFIX:-oracledesk}
DEPLOYER_KEY=${DEPLOYER_KEY:-${IDENTITY_PREFIX}-deployer}
AGENT_KEY=${AGENT_KEY:-${IDENTITY_PREFIX}-agent}
DEPLOYMENTS=${DEPLOYMENTS:-deployments/$NETWORK.json}
if [ "$NETWORK" = "local" ]; then
  CLOSE_IN_SECONDS=${CLOSE_IN_SECONDS:-10}
  DISPUTE_WINDOW=${DISPUTE_WINDOW:-3}
else
  CLOSE_IN_SECONDS=${CLOSE_IN_SECONDS:-90}
  DISPUTE_WINDOW=${DISPUTE_WINDOW:-5}
fi
MODE=signer
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      [ "$#" -ge 2 ] || { echo "error: --mode needs signer or price" >&2; exit 2; }
      MODE=$2
      shift 2
      ;;
    --mode=*)
      MODE=${1#--mode=}
      shift
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done
case "$MODE" in
  signer|price) ;;
  *) echo "error: --mode must be signer or price" >&2; exit 2 ;;
esac

[ -f "$DEPLOYMENTS" ] || { echo "error: run NETWORK=$NETWORK scripts/deploy-testnet.sh first" >&2; exit 1; }

MARKET_CORE=$(jq -r .contracts.market_core "$DEPLOYMENTS")
TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
RESOLVER=$(jq -r .contracts.resolver "$DEPLOYMENTS")
REGISTRY=$(jq -r .contracts.reasoning_registry "$DEPLOYMENTS")
AGENT=$(jq -r .agent "$DEPLOYMENTS")
ORACLE=$(jq -r '.contracts.test_oracle // empty' "$DEPLOYMENTS")

invoke() { stellar contract invoke --id "$1" --source-account "$2" --network "$NETWORK" -- "${@:3}"; }
read_only() { stellar contract invoke --id "$1" --source-account "$DEPLOYER_KEY" --network "$NETWORK" -- "${@:2}" 2>/dev/null; }

RPC_URL=${SOROBAN_RPC_URL:-}
if [ -z "$RPC_URL" ]; then
  if [ "$NETWORK" = "local" ]; then RPC_URL=http://localhost:8000/soroban/rpc; else RPC_URL=https://soroban-testnet.stellar.org; fi
fi

wait_until() {
  # Poll RPC getLatestLedger instead of sleeping blindly.
  local target=$1 now
  for _ in $(seq 1 120); do
    now=$(curl -sf -X POST "$RPC_URL" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | jq -r '.result.closeTime // 0')
    [ "${now:-0}" -ge "$target" ] && return 0
    sleep 1
  done
  return 1
}

if [ "$MODE" = "price" ]; then
  [ -n "$ORACLE" ] || { echo "error: --mode price requires contracts.test_oracle in $DEPLOYMENTS (local only)" >&2; exit 1; }
  echo "### 1/5 create price-mode market (treasury.agent_create_market)"
  QUESTION="OracleDesk price demo $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  QUESTION_HASH=$(python3 -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$QUESTION")
  CLOSE_TIME=$(( $(date +%s) + CLOSE_IN_SECONDS ))
  PRICE_SPEC=$(jq -nc --arg oracle "$ORACLE" \
    '{reflector: $oracle, asset: {Other: "XLM"}, threshold: 2000, direction: "Above", max_staleness: 3600}')
  RESOLUTION_HASH=$(cargo run --quiet --manifest-path scripts/spec-hash/Cargo.toml -- price "$ORACLE" other:XLM 2000 above 3600)
  MARKET_ID=$(invoke "$TREASURY" "$AGENT_KEY" agent_create_market \
    --agent "$AGENT" --question_hash "$QUESTION_HASH" --resolution_hash "$RESOLUTION_HASH" \
    --meta_uri '"ipfs://oracledesk-price-demo"' --category Crypto --close_time "$CLOSE_TIME" \
    --seed_amount 1500000000 --initial_yes_bps 5000)
  invoke "$RESOLVER" "$AGENT_KEY" register_price_spec --market_id "$MARKET_ID" --spec "$PRICE_SPEC"
  # Price timestamp must be <= close_time and inside max_staleness.
  invoke "$ORACLE" "$DEPLOYER_KEY" set_price --asset '{"Other":"XLM"}' --timestamp "$CLOSE_TIME" --price 2100
  echo "### 2/5 wait for close"
  wait_until "$((CLOSE_TIME + 1))" || sleep "$((CLOSE_IN_SECONDS + 2))"
  echo "### 3/5 resolve via price"
  OUTCOME=$(invoke "$RESOLVER" "$AGENT_KEY" resolve_price --market_id "$MARKET_ID")
  echo "resolved outcome: $OUTCOME"
else
  echo "### 1/6 create + seed market (treasury.agent_create_market)"
  SEED_OUT=$(NETWORK="$NETWORK" IDENTITY_PREFIX="$IDENTITY_PREFIX" DEPLOYMENTS="$DEPLOYMENTS" \
    ./scripts/seed-market.sh 1500000000 5000 "$CLOSE_IN_SECONDS" "$DISPUTE_WINDOW" \
    "OracleDesk demo $(date -u +%Y-%m-%dT%H:%M:%SZ)")
  echo "$SEED_OUT"
  MARKET_ID=$(echo "$SEED_OUT" | sed -n 's/^market_id=//p')
  CLOSE_TIME=$(echo "$SEED_OUT" | sed -n 's/^close_time=//p')
  echo

  echo "### 2/6 trade (treasury.agent_buy) — price should move off 50/50"
  echo "price before: $(read_only "$MARKET_CORE" get_price --market_id "$MARKET_ID" --outcome Yes)"
  TRADE_TX=$(invoke "$TREASURY" "$AGENT_KEY" agent_buy --agent "$AGENT" --market_id "$MARKET_ID" --outcome Yes --collateral_in 100000000 --min_shares_out 0)
  echo "shares received: $TRADE_TX"
  echo "price after:  $(read_only "$MARKET_CORE" get_price --market_id "$MARKET_ID" --outcome Yes)"
  echo

  echo "### 3/6 wait for close_time, record reasoning trace, then attest with evidence"
  wait_until "$((CLOSE_TIME + 1))" || sleep "$((CLOSE_IN_SECONDS + 2))"

  TRACE_JSON=$(mktemp)
  cat >"$TRACE_JSON" <<TRACE
{"agent":"market-maker","market_id":$MARKET_ID,"action":"create_market","reasoning":"OracleDesk demo run via scripts/demo.sh.","timestamp":$(date +%s)}
TRACE
  TRACE_HASH=$(python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$TRACE_JSON")
  echo "trace hash: $TRACE_HASH"
  TRACE_CID=${TRACE_CID:-oracledesk-demo-trace.json}
  TRACE_DIR=${TRACE_DIR:-deployments/traces-$NETWORK}
  mkdir -p "$TRACE_DIR"
  cp "$TRACE_JSON" "$TRACE_DIR/$TRACE_CID"
  TRACE_ID=$(invoke "$REGISTRY" "$AGENT_KEY" publish_trace \
    --agent "$AGENT" --market_id "$MARKET_ID" --action '"create_market"' \
    --trace_hash "$TRACE_HASH" --ipfs_cid "\"$TRACE_CID\"")
  echo "trace id: $TRACE_ID"
  echo

  VERIFIED=$(read_only "$REGISTRY" verify_trace --trace_id "$TRACE_ID" --received_hash "$TRACE_HASH")
  echo "verify_trace(correct hash) = $VERIFIED"
  [ "$VERIFIED" = "true" ] || { echo "FAILED: trace hash did not verify" >&2; exit 1; }
  echo

  invoke "$RESOLVER" "$AGENT_KEY" attest_with_evidence --market_id "$MARKET_ID" --signer "$AGENT" --outcome Yes --trace_id "$TRACE_ID"
  echo "waiting ${DISPUTE_WINDOW}s dispute window..."
  sleep "$((DISPUTE_WINDOW + 1))"
  OUTCOME=$(invoke "$RESOLVER" "$AGENT_KEY" finalize_signers --market_id "$MARKET_ID")
  echo "resolved outcome: $OUTCOME"
  echo
  rm -f "$TRACE_JSON"
fi

STATUS=$(read_only "$MARKET_CORE" get_market --market_id "$MARKET_ID")
echo "$STATUS" | grep -q 'Resolved' || { echo "FAILED: market did not resolve: $STATUS" >&2; exit 1; }
echo "### final market status: resolved"
echo "market_id=$MARKET_ID"
echo "network=$NETWORK"
echo "mode=$MODE"
echo "trace_file=${TRACE_DIR:-}/${TRACE_CID:-}"
