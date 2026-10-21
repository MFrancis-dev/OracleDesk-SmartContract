# Stateful system model

`model/system_model.py` is a dependency-free Python model of the OracleDesk
system at the resolution of one market. `contracts/integration-tests/tests/system_model.rs`
runs random operation sequences against the real wasm contracts, records what
happened, replays the same trace through the model, and fails if the two
disagree.

The model deliberately imports `model/fpmm_model.py` for the pricing math
instead of keeping a second copy: the Python FPMM mirror is already pinned to
`contracts/market-core/src/math.rs` by worked examples and property tests.

## Running it

```bash
make model-test
# equivalent:
python3 model/system_model.py --selftest
cargo test -p integration-tests --test system_model
```

The Rust test suite does three things:

1. `committed_regressions_match` replays every `model/regressions/*.json`
   trace against wasm and Python. Traces also carry the exact snapshots the
   contracts produced, so a later contract change shows up as a diff.
2. `random_sequences_match_python_model` generates operation sequences with
   proptest. On a mismatch proptest shrinks the sequence and prints the
   minimal failing trace.
3. `model_selftest_runs` runs the Python conservation/ordering checks.

## Trace schema

Schema version: **1** (`model/trace-schema.json`). The top level is:

```json
{
  "schema_version": 1,
  "steps": [ { "op": "create", "time": 1000, "close_time": 2000, "yes_bps": 5000 } ],
  "snapshots": [ /* optional committed expectations */ ]
}
```

Operations:

| `op` | Fields | Effect |
| --- | --- | --- |
| `create` | `time`, `close_time`, `yes_bps` | Seeds the tracked market from the creator and registers a signer spec. |
| `buy` | `time`, `actor` (`creator`/`trader`), `outcome` (`yes`/`no`), `amount` | `market-core.buy`, including fee accrual and token movement. |
| `sell` | `time`, `actor`, `outcome`, `collateral_out` | `market-core.sell` for an exact collateral amount. |
| `treasury_buy` | `time`, `outcome`, `amount` | `treasury.agent_buy`: vault balance → market position, with the treasury's price/impact/cap checks. |
| `resolve` | `time`, `outcome` | Two signer attestations, then `resolver.finalize_signers` → `market-core.resolve`. |
| `redeem` | `time`, `actor` | Final-market position redemption. |
| `claim_remainder` | `time` | Creator claims the pool remainder (and pending LP fees). |
| `sweep_fees` | `time` | Anyone sweeps accrued protocol fees to the treasury. |
| `publish_trace` | `time` | Agent publishes a reasoning-registry trace. |
| `advance_time` | `time` | Moves the ledger clock; no contract call. |

The model snapshot is the comparison unit:

```json
{
  "market": {"reserve_yes": 0, "reserve_no": 0, "sets_minted": 0,
              "fees_accrued": 0, "lp_claimed": false, "status": "open"},
  "positions": {"creator": {"yes": 0, "no": 0}, "trader": {...}, "treasury": {...}},
  "balances": {"creator": 0, "trader": 0, "treasury": 0, "core": 0},
  "resolver_state": "SignersPending",
  "trace_count": 0,
  "market_trace_count": 0
}
```

All amounts are integer stroops (USDC has 7 decimals). `status` is one of
`open`, `resolved_yes`, `resolved_no`, `void`. Resolver states are the
contract enum names (`Unconfigured`, `SignersPending`, `Finalized`, ...).

## What the model covers, and what it does not

Covered exactly: market-core FPMM buys/sells, fee split (the integration world
routes 100% of fees to the protocol), settlement, treasury agent-buy balance
and position movement, treasury price-band/impact/market-cap checks, resolver
signer quorum → finalize → resolve, and registry trace counters.

Out of scope on purpose: multi-market interactions, price-mode resolution
(covered by `auth_matrix` and the local E2E), disputes/committees/hybrid
feeds, withdrawals/yield, storage TTL, and error *codes*. The model predicts
success/failure, not the numeric error; the auth matrix pins the error paths
that matter for authorization, and unit tests pin the rest.

## Adding an operation

1. add a variant to `Op` in `tests/system_model.rs` and a generator arm;
2. add a `_op_<name>` method to `SystemModel` and include its effects in
   `snapshot()`;
3. run `make model-test`; if proptest finds a mismatch, shrink it and copy the
   minimal trace into `model/regressions/` with the snapshots the contracts
   produced;
4. update `model/trace-schema.json` if the wire shape changed.
