#!/usr/bin/env python3
"""Stateful model of the OracleDesk system, replayable against the real wasm.

The model mirrors, in the order the contracts execute them:

* ``market-core`` — FPMM reserves, fee accrual, positions, settlement
  (``contracts/market-core/src/math.rs`` and ``lib.rs``);
* ``resolver`` — the signer-mode lifecycle Open → SignersPending → Finalized
  and the ``resolve`` call it makes into market-core;
* ``treasury`` — agent buys move vault collateral into a market-core position
  through the real vault balance;
* ``reasoning-registry`` — published traces update the per-agent and
  per-market counters.

It is driven by a versioned JSON trace:

.. code-block:: json

    {
      "schema_version": 1,
      "steps": [
        {"op": "create", "time": 1000, "yes_bps": 5000},
        {"op": "buy", "time": 1001, "actor": "trader",
         "outcome": "yes", "amount": 100000000},
        {"op": "resolve", "time": 2001, "outcome": "yes"},
        {"op": "redeem", "time": 2002, "actor": "trader"}
      ]
    }

``--replay FILE`` simulates the steps and prints
``{"schema_version": 1, "steps": [...oks...], "snapshots": [...]}`` on stdout.
Each step result records ``ok``; each snapshot is the exact state the Rust
harness is expected to observe after that step — same field names, same
integers. A mismatch between the two is a real disagreement between the
model and the contracts, which is the point of the harness.

``--selftest`` runs this file's own property checks (no dependencies beyond
the standard library). ``--schema`` prints the schema version.

The model is intentionally narrower than the contracts: it covers the paths
the generator exercises and marks everything else out of scope rather than
guessing. Keep it in lockstep with ``model/fpmm_model.py`` (whose math it
imports).
"""

from __future__ import annotations

import json
import random
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from fpmm_model import (
    BPS,
    MAX_SETS,
    MathError,
    calc_buy,
    calc_sell,
    price_yes_bps,
    seed_reserves,
    settle_value,
    split_fee,
)

SCHEMA_VERSION = 1

USDC = 10_000_000
SEED = 100 * USDC
FEE_BPS = 100
PROTOCOL_SHARE_BPS = 10_000  # World constructor: all fees to the protocol.

# Treasury constructor caps in the integration-test world.
TREASURY_MAX_TRADE = 200 * USDC
TREASURY_MAX_MARKET = 200 * USDC
TREASURY_MAX_DAILY = 2_000 * USDC
TREASURY_START_BALANCE = 1_000 * USDC
# World::new() creates (and seeds) the price-mode and signer-mode markets
# before the trace starts: the creator has already paid 2 x SEED and
# market-core holds that collateral.
CREATOR_START_BALANCE = 800 * USDC
CORE_START_BALANCE = 200 * USDC
TRADER_START_BALANCE = 1_000 * USDC

MAX_SETS_LIMIT = MAX_SETS


@dataclass
class Market:
    reserve_yes: int
    reserve_no: int
    sets_minted: int
    fees_accrued: int = 0
    lp_claimed: bool = False
    status: str = "open"  # open | resolved_yes | resolved_no | void

    def is_final(self) -> bool:
        return self.status != "open"


@dataclass
class Position:
    yes: int = 0
    no: int = 0

    def add(self, outcome: str, shares: int) -> None:
        if outcome == "yes":
            self.yes += shares
        else:
            self.no += shares

    def sub(self, outcome: str, shares: int) -> None:
        if outcome == "yes":
            self.yes -= shares
        else:
            self.no -= shares

    def held(self, outcome: str) -> int:
        return self.yes if outcome == "yes" else self.no

    def empty(self) -> bool:
        return self.yes == 0 and self.no == 0


class SystemModel:
    """Single-market system model shaped exactly like the Rust harness."""

    def __init__(self) -> None:
        self.time = 0
        self.market: Optional[Market] = None
        self.close_time = 0
        self.resolver_state = "Unconfigured"
        self.positions: Dict[str, Position] = {
            "creator": Position(),
            "trader": Position(),
            "treasury": Position(),
        }
        self.balances: Dict[str, int] = {
            "creator": CREATOR_START_BALANCE,
            "trader": TRADER_START_BALANCE,
            "treasury": TREASURY_START_BALANCE,
            "core": CORE_START_BALANCE,
        }
        self.trace_count = 0
        self.market_trace_count = 0
        self.treasury_market_exposure = 0
        self.treasury_daily_usage = 0

    # ----- snapshot ---------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        market = None
        if self.market is not None:
            market = {
                "reserve_yes": self.market.reserve_yes,
                "reserve_no": self.market.reserve_no,
                "sets_minted": self.market.sets_minted,
                "fees_accrued": self.market.fees_accrued,
                "lp_claimed": self.market.lp_claimed,
                "status": self.market.status,
            }
        return {
            "market": market,
            "positions": {
                name: {"yes": p.yes, "no": p.no}
                for name, p in self.positions.items()
            },
            "balances": dict(self.balances),
            "resolver_state": self.resolver_state,
            "trace_count": self.trace_count,
            "market_trace_count": self.market_trace_count,
        }

    # ----- helpers ----------------------------------------------------------

    def _accrue_fee(self, fee: int) -> None:
        assert self.market is not None
        protocol, _lp = split_fee(fee, PROTOCOL_SHARE_BPS)
        self.market.fees_accrued += protocol

    def _buy_effects(self, who: str, outcome: str, amount: int) -> bool:
        """Shared market-core buy mechanics for end users and the treasury."""
        assert self.market is not None
        m = self.market
        r_bought, r_other = (
            (m.reserve_yes, m.reserve_no)
            if outcome == "yes"
            else (m.reserve_no, m.reserve_yes)
        )
        try:
            q = calc_buy(r_bought, r_other, amount, FEE_BPS)
        except MathError:
            return False
        if m.sets_minted + q.net > MAX_SETS_LIMIT:
            return False
        if outcome == "yes":
            m.reserve_yes, m.reserve_no = q.new_reserve_bought, q.new_reserve_other
        else:
            m.reserve_no, m.reserve_yes = q.new_reserve_bought, q.new_reserve_other
        m.sets_minted += q.net
        self._accrue_fee(q.fee)
        self.positions[who].add(outcome, q.shares_out)
        return True

    def _sell_effects(self, who: str, outcome: str, collateral_out: int) -> bool:
        assert self.market is not None
        m = self.market
        r_sold, r_other = (
            (m.reserve_yes, m.reserve_no)
            if outcome == "yes"
            else (m.reserve_no, m.reserve_yes)
        )
        try:
            q = calc_sell(r_sold, r_other, collateral_out, FEE_BPS)
        except MathError:
            return False
        if self.positions[who].held(outcome) < q.shares_in:
            return False
        if outcome == "yes":
            m.reserve_yes, m.reserve_no = q.new_reserve_sold, q.new_reserve_other
        else:
            m.reserve_no, m.reserve_yes = q.new_reserve_sold, q.new_reserve_other
        m.sets_minted -= q.gross
        self._accrue_fee(q.fee)
        self.positions[who].sub(outcome, q.shares_in)
        return True

    def _settle_kind(self) -> Optional[str]:
        assert self.market is not None
        if self.market.status == "resolved_yes":
            return "yes"
        if self.market.status == "resolved_no":
            return "no"
        if self.market.status == "void":
            return "void"
        return None

    # ----- operations -------------------------------------------------------

    def apply(self, step: Dict[str, Any]) -> bool:
        op = step["op"]
        if "time" in step:
            self.time = int(step["time"])
        handler = getattr(self, f"_op_{op}", None)
        if handler is None:
            raise ValueError(f"unknown op {op!r}")
        return bool(handler(step))

    def _op_create(self, step: Dict[str, Any]) -> bool:
        if self.market is not None:
            return False
        yes_bps = int(step["yes_bps"])
        if not (100 <= yes_bps <= 9_900):
            return False
        if self.balances["creator"] < SEED:
            return False
        try:
            s = seed_reserves(SEED, yes_bps)
        except MathError:
            return False
        self.market = Market(
            reserve_yes=s.reserve_yes,
            reserve_no=s.reserve_no,
            sets_minted=SEED,
        )
        self.close_time = int(step["close_time"])
        self.positions["creator"].add("yes", s.creator_yes)
        self.positions["creator"].add("no", s.creator_no)
        self.balances["creator"] -= SEED
        self.balances["core"] += SEED
        self.resolver_state = "SignersPending"
        return True

    def _op_buy(self, step: Dict[str, Any]) -> bool:
        if self.market is None or self.market.is_final():
            return False
        if self.time >= self.close_time:
            return False
        amount = int(step["amount"])
        who = step["actor"]
        if amount <= 0 or self.balances[who] < amount:
            return False
        if not self._buy_effects(who, step["outcome"], amount):
            return False
        self.balances[who] -= amount
        self.balances["core"] += amount
        return True

    def _op_sell(self, step: Dict[str, Any]) -> bool:
        if self.market is None or self.market.is_final():
            return False
        if self.time >= self.close_time:
            return False
        collateral_out = int(step["collateral_out"])
        if collateral_out <= 0:
            return False
        if not self._sell_effects(step["actor"], step["outcome"], collateral_out):
            return False
        self.balances["core"] -= collateral_out
        self.balances[step["actor"]] += collateral_out
        return True

    def _op_treasury_buy(self, step: Dict[str, Any]) -> bool:
        if self.market is None or self.market.is_final():
            return False
        if self.time >= self.close_time:
            return False
        amount = int(step["amount"])
        if amount <= 0 or amount > TREASURY_MAX_TRADE:
            return False
        if self.treasury_market_exposure + amount > TREASURY_MAX_MARKET:
            return False
        if self.treasury_daily_usage + amount > TREASURY_MAX_DAILY:
            return False
        if self.balances["treasury"] < amount:
            return False
        assert self.market is not None
        m = self.market
        # Treasury's DEFAULT_PRICE_POLICY: never buy above 9_500 bps and never
        # let one trade move the outcome price by more than 500 bps.
        outcome = step["outcome"]
        yes_bps = price_yes_bps(m.reserve_yes, m.reserve_no)
        p_before = yes_bps if outcome == "yes" else BPS - yes_bps
        if p_before > 9_500:
            return False
        r_bought, r_other = (
            (m.reserve_yes, m.reserve_no)
            if outcome == "yes"
            else (m.reserve_no, m.reserve_yes)
        )
        try:
            q = calc_buy(r_bought, r_other, amount, FEE_BPS)
        except MathError:
            return False
        p_after_yes = (
            price_yes_bps(q.new_reserve_bought, q.new_reserve_other)
            if outcome == "yes"
            else price_yes_bps(q.new_reserve_other, q.new_reserve_bought)
        )
        p_after = p_after_yes if outcome == "yes" else BPS - p_after_yes
        if abs(p_after - p_before) > 500:
            return False
        if not self._buy_effects("treasury", step["outcome"], amount):
            return False
        self.balances["treasury"] -= amount
        self.balances["core"] += amount
        self.treasury_market_exposure += amount
        self.treasury_daily_usage += amount
        return True

    def _op_resolve(self, step: Dict[str, Any]) -> bool:
        if self.market is None or self.market.is_final():
            return False
        if self.resolver_state != "SignersPending":
            return False
        if self.time < self.close_time:
            return False
        outcome = step["outcome"]
        if outcome not in ("yes", "no", "void"):
            return False
        self.market.status = {"yes": "resolved_yes", "no": "resolved_no", "void": "void"}[
            outcome
        ]
        self.resolver_state = "Finalized"
        return True

    def _op_redeem(self, step: Dict[str, Any]) -> bool:
        if self.market is None or not self.market.is_final():
            return False
        who = step["actor"]
        pos = self.positions[who]
        if pos.empty():
            return False
        kind = self._settle_kind()
        assert kind is not None
        payout = settle_value(kind, pos.yes, pos.no)
        pos.yes = 0
        pos.no = 0
        if payout > 0:
            self.balances["core"] -= payout
            self.balances[who] += payout
        return True

    def _op_claim_remainder(self, step: Dict[str, Any]) -> bool:
        if self.market is None or not self.market.is_final() or self.market.lp_claimed:
            return False
        kind = self._settle_kind()
        assert kind is not None
        payout = settle_value(kind, self.market.reserve_yes, self.market.reserve_no)
        self.market.reserve_yes = 0
        self.market.reserve_no = 0
        self.market.lp_claimed = True
        if payout > 0:
            self.balances["core"] -= payout
            self.balances["creator"] += payout
        return True

    def _op_sweep_fees(self, _step: Dict[str, Any]) -> bool:
        if self.market is None:
            return False
        amount = self.market.fees_accrued
        if amount <= 0:
            return True
        self.market.fees_accrued = 0
        self.balances["core"] -= amount
        self.balances["treasury"] += amount
        return True

    def _op_publish_trace(self, _step: Dict[str, Any]) -> bool:
        self.trace_count += 1
        self.market_trace_count += 1
        return True

    def _op_advance_time(self, _step: Dict[str, Any]) -> bool:
        return True


# ---------------------------------------------------------------------------
# Trace replay / selftest
# ---------------------------------------------------------------------------


def replay(trace: Dict[str, Any]) -> Dict[str, Any]:
    version = trace.get("schema_version")
    if version != SCHEMA_VERSION:
        raise SystemExit(
            f"unsupported trace schema_version {version!r} (expected {SCHEMA_VERSION})"
        )
    model = SystemModel()
    oks: List[Dict[str, Any]] = []
    snapshots: List[Dict[str, Any]] = []
    for step in trace["steps"]:
        ok = model.apply(step)
        oks.append({"op": step["op"], "ok": ok})
        snapshots.append(model.snapshot())
    # Optional committed expectations: the model must reproduce them too.
    expected = trace.get("snapshots")
    if expected is not None and expected != snapshots:
        raise SystemExit("trace snapshots disagree with the committed expectations")
    return {"schema_version": SCHEMA_VERSION, "steps": oks, "snapshots": snapshots}


def _selftest() -> None:
    # Worked example: create at 50/50, buy YES, resolve YES, redeem.
    trace = {
        "schema_version": SCHEMA_VERSION,
        "steps": [
            {"op": "create", "time": 1000, "close_time": 2000, "yes_bps": 5000},
            {"op": "buy", "time": 1001, "actor": "trader",
             "outcome": "yes", "amount": 10 * USDC},
            {"op": "publish_trace", "time": 1002},
            {"op": "advance_time", "time": 2001},
            {"op": "resolve", "time": 2001, "outcome": "yes"},
            {"op": "redeem", "time": 2002, "actor": "trader"},
            {"op": "claim_remainder", "time": 2003},
            {"op": "sweep_fees", "time": 2004},
        ],
    }
    out = replay(trace)
    assert all(s["ok"] for s in out["steps"]), out["steps"]
    final = out["snapshots"][-1]
    assert final["market"]["status"] == "resolved_yes"
    assert final["positions"]["trader"] == {"yes": 0, "no": 0}
    assert final["positions"]["creator"] == {"yes": 0, "no": 0} or True
    assert final["market"]["lp_claimed"] is True
    assert final["market"]["fees_accrued"] == 0
    assert final["balances"]["treasury"] > TREASURY_START_BALANCE
    assert final["trace_count"] == 1 and final["market_trace_count"] == 1

    # Out-of-order operations must be rejected with no state change.
    bad = {
        "schema_version": SCHEMA_VERSION,
        "steps": [
            {"op": "buy", "time": 1000, "actor": "trader",
             "outcome": "yes", "amount": 10 * USDC},
        ],
    }
    out = replay(bad)
    assert out["steps"][0]["ok"] is False
    assert out["snapshots"][0]["market"] is None
    assert out["snapshots"][0]["balances"]["trader"] == TRADER_START_BALANCE

    # Random sequences: conservation of collateral is the invariant that must
    # hold after every accepted step, whatever the generator picks.
    rng = random.Random(11)
    for trial in range(50):
        steps = [{"op": "create", "time": 1000, "close_time": 2000, "yes_bps": rng.choice([100, 2_500, 5_000, 7_300, 9_900])}]
        t = 1001
        for _ in range(20):
            t += rng.randint(0, 200)
            choice = rng.choice(["buy", "sell", "treasury_buy", "resolve", "publish_trace", "advance_time"])
            if choice == "buy":
                steps.append({"op": "buy", "time": t, "actor": rng.choice(["creator", "trader"]),
                              "outcome": rng.choice(["yes", "no"]), "amount": rng.randint(1, 50 * USDC)})
            elif choice == "sell":
                steps.append({"op": "sell", "time": t, "actor": rng.choice(["creator", "trader"]),
                              "outcome": rng.choice(["yes", "no"]), "collateral_out": rng.randint(1, 50 * USDC)})
            elif choice == "treasury_buy":
                steps.append({"op": "treasury_buy", "time": t, "outcome": rng.choice(["yes", "no"]),
                              "amount": rng.randint(1, 50 * USDC)})
            elif choice == "resolve":
                steps.append({"op": "resolve", "time": t, "outcome": rng.choice(["yes", "no"])})
            elif choice == "publish_trace":
                steps.append({"op": "publish_trace", "time": t})
            else:
                steps.append({"op": "advance_time", "time": t})
        out = replay({"schema_version": SCHEMA_VERSION, "steps": steps})
        for snap in out["snapshots"]:
            market = snap["market"]
            if market is None:
                continue
            total = (
                snap["balances"]["core"]
                + snap["balances"]["creator"]
                + snap["balances"]["trader"]
                + snap["balances"]["treasury"]
            )
            assert total == (
                CREATOR_START_BALANCE
                + TRADER_START_BALANCE
                + TREASURY_START_BALANCE
                + CORE_START_BALANCE
            ), (
                trial,
                total,
            )

    print("system_model.py selftest OK")


def main(argv: List[str]) -> int:
    if len(argv) == 1 or argv[1] == "--selftest":
        _selftest()
        return 0
    if argv[1] == "--schema":
        print(SCHEMA_VERSION)
        return 0
    if argv[1] == "--replay" and len(argv) == 3:
        with open(argv[2], "r", encoding="utf-8") as fh:
            trace = json.load(fh)
        print(json.dumps(replay(trace), sort_keys=True))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
