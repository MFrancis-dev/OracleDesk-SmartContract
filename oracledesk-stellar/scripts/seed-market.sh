#!/usr/bin/env bash
# Creates one market through the deployed treasury (agent_create_market) and
# reveals its signer-mode resolution spec, using the addresses recorded in
# deployments/testnet.json by scripts/deploy-testnet.sh.
#
# The agent itself is the sole signer (threshold 1) with a short dispute
# window — good enough to demonstrate the commit/reveal flow end to end
# without needing a real oracle. For a PriceConfig-based market, compute the
# hash with `spec-hash --v2 ... price ...` instead (same envelope, different
# rule).
#
# The commitment is a salted ResolutionSpecV2 (docs/adr/0004-spec-versioning.md).
# The salt is the only secret protecting the rule until reveal and is needed to
# reveal it, so it is written to deployments/specs/<resolution_hash>.json and
# read back BEFORE the market is created: if that fails, no market is created.
#
# Usage: scripts/seed-market.sh [seed_amount_stroops] [initial_yes_bps] [close_in_seconds]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=testnet
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
DEPLOYER_KEY=oracledesk-deployer
AGENT_KEY=oracledesk-agent
DEPLOYMENTS=deployments/testnet.json
SPECS_DIR=deployments/specs

SEED_AMOUNT=${1:-1500000000}   # 150 USDC, comfortably above the 100 USDC MIN_SEED
INITIAL_YES_BPS=${2:-5000}     # 50/50
CLOSE_IN_SECONDS=${3:-90}
DISPUTE_WINDOW=${4:-5}
QUESTION_TEXT=${5:-"Demo market seeded by scripts/seed-market.sh"}

[ -f "$DEPLOYMENTS" ] || { echo "error: $DEPLOYMENTS not found — run scripts/deploy-testnet.sh first" >&2; exit 1; }

TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
RESOLVER=$(jq -r .contracts.resolver "$DEPLOYMENTS")
MARKET_CORE=$(jq -r .contracts.market_core "$DEPLOYMENTS")
AGENT=$(jq -r .agent "$DEPLOYMENTS")
for addr in "$TREASURY" "$MARKET_CORE"; do
  [ -n "$addr" ] && [ "$addr" != "null" ] || { echo "error: no treasury/market_core address in $DEPLOYMENTS" >&2; exit 1; }
done

sha256_hex() {
  python3 -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$1"
}

spec_hash() {
  cargo run --quiet --manifest-path scripts/spec-hash/Cargo.toml -- "$@"
}

# $1 = salt. Prints the V2 flags spec-hash expects, one per line.
v2_flags() {
  printf '%s\n' --v2 --salt "$1" --network-passphrase "$NETWORK_PASSPHRASE" --market-core "$MARKET_CORE"
}

echo "==> computing salted V2 resolution commitment (signers: [$AGENT], threshold 1)" >&2
SALT=$(spec_hash gen-salt)
mapfile -t V2_FLAGS < <(v2_flags "$SALT")
RESOLUTION_HASH=$(spec_hash "${V2_FLAGS[@]}" signers 1 "$DISPUTE_WINDOW" "$AGENT")

echo "==> persisting the salt to $SPECS_DIR before creating the market" >&2
mkdir -p "$SPECS_DIR"
SPEC_FILE="$SPECS_DIR/$RESOLUTION_HASH.json"
(
  umask 077
  jq -n --arg question "$QUESTION_TEXT" --arg hash "$RESOLUTION_HASH" --arg salt "$SALT" \
    --arg network_id "$(sha256_hex "$NETWORK_PASSPHRASE")" --arg market_core "$MARKET_CORE" \
    --arg agent "$AGENT" --argjson window "$DISPUTE_WINDOW" '{
      market_question: $question,
      resolution_hash: $hash,
      salt: $salt,
      spec: {
        version: 2, network_id: $network_id, market_core: $market_core, salt: $salt,
        rule: { Signers: { dispute_window: $window, signers: [$agent], threshold: 1 } }
      }
    }' >"$SPEC_FILE.tmp"
  mv "$SPEC_FILE.tmp" "$SPEC_FILE"
)
# Prove the stored salt reproduces the commitment before any funds move.
mapfile -t V2_FLAGS < <(v2_flags "$(jq -r .salt "$SPEC_FILE")")
spec_hash verify "$RESOLUTION_HASH" "${V2_FLAGS[@]}" signers 1 "$DISPUTE_WINDOW" "$AGENT" >/dev/null

QUESTION_HASH=$(sha256_hex "$QUESTION_TEXT")
CLOSE_TIME=$(( $(date +%s) + CLOSE_IN_SECONDS ))

echo "==> creating market (seed=$SEED_AMOUNT, close_time=$CLOSE_TIME)" >&2
MARKET_ID=$(stellar contract invoke --id "$TREASURY" --source-account "$AGENT_KEY" --network "$NETWORK" -- \
  agent_create_market \
  --agent "$AGENT" \
  --question_hash "$QUESTION_HASH" \
  --resolution_hash "$RESOLUTION_HASH" \
  --meta_uri "\"ipfs://$(echo -n "$QUESTION_TEXT" | tr ' ' '-')\"" \
  --category Macro \
  --close_time "$CLOSE_TIME" \
  --seed_amount "$SEED_AMOUNT" \
  --initial_yes_bps "$INITIAL_YES_BPS")

echo "==> revealing the resolution spec to the resolver" >&2
stellar contract invoke --id "$RESOLVER" --source-account "$AGENT_KEY" --network "$NETWORK" -- \
  register_spec_v2 \
  --market_id "$MARKET_ID" \
  --spec "$(jq -c .spec "$SPEC_FILE")"

echo "market_id=$MARKET_ID"
echo "close_time=$CLOSE_TIME"
echo "dispute_window=$DISPUTE_WINDOW"
echo "spec_file=$SPEC_FILE"
