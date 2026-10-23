import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalTraceStore } from "../core/trace.js";
import { FakeEventsRpc, IDS, testDecoder, trade } from "../core/events/testing.js";
import { followTask, type FollowAdapter } from "./follow.js";
import { NoLease } from "./lease.js";
import { Runtime } from "./runtime.js";
import { MemoryStateStore } from "./state.js";
import type { TraderCandidate } from "./tasks/trader.js";

const NOW = 1_700_000_000;

function fakeAdapter(buys: bigint[], exposure: Record<string, bigint>): FollowAdapter {
  return {
    mode: "dry-run",
    agent: "GTRADER",
    rpcServer: () => {
      throw new Error("tests inject the RPC");
    },
    contractIds: () => ({ ...IDS, usdc: IDS.treasury }),
    getMarket: async () => ({ creator: "G", questionHash: "", resolutionHash: "", closeTime: BigInt(NOW + 3600), status: "Open", reserveYes: 600n, reserveNo: 400n, feeBps: 100n }),
    treasuryPosition: async (id) => ({ yes: exposure[String(id)] ?? 0n, no: 0n }),
    resolutionState: async () => "SignersPending",
    quoteBuy: async () => 1_000n,
    agentBuyV2: async (args) => {
      buys.push(args.market_id);
      return { dryRun: true, contractId: "CTREASURY", method: "agent_buy_v2", args };
    },
    publishTrace: async () => ({ dryRun: true, contractId: "CREGISTRY", method: "publish_trace", args: {} }),
  } as FollowAdapter;
}

const candidates = async (): Promise<TraderCandidate[]> =>
  [1, 2, 3].map((marketId) => ({ market: { marketId, question: "q", yesBps: 4000, closeTime: NOW + 3600 }, fairValueBps: 6000 }));

async function setup(exposure: Record<string, bigint> = {}) {
  const rpc = await FakeEventsRpc.create();
  const buys: bigint[] = [];
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const stateDir = mkdtempSync(join(tmpdir(), "follow-"));
  const task = await followTask({
    cfg: {
      network: "testnet",
      events: { stateDir, tradeThresholdStroops: 1_000n, pollIntervalMs: 1, pageLimit: 100, concurrency: 2, maxAttempts: 2, disputeWindowSecs: 600 },
    },
    adapter: fakeAdapter(buys, exposure),
    trader: {
      adapter: fakeAdapter(buys, exposure),
      traceStore: new LocalTraceStore(stateDir),
      candidates,
      minEdgeBps: 500,
      tradeSizeStroops: 100n,
      slippageBps: 50n,
      deadlineSecs: 60,
      nowSecs: () => NOW,
    },
    rpc,
    decoder: await testDecoder(),
    nowSecs: () => NOW,
    log: (event, fields) => void logs.push({ event, fields }),
  });
  const runtime = new Runtime({
    tasks: [task],
    state: new MemoryStateStore(),
    lease: new NoLease(),
    shutdownGraceMs: 1_000,
    maxConsecutiveFailures: 3,
    failureWindowMs: 60_000,
    maxFailuresInWindow: 10,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  return { rpc, buys, logs, runtime, task };
}

test("--follow re-evaluates only markets with a significant trade", async () => {
  const s = await setup();
  await s.runtime.runOnce(); // starts at the tip
  assert.deepEqual(s.buys, [], "no periodic evaluation of every market");
  s.rpc.emit(trade(2n, 5_000n, 1_001)); // significant
  s.rpc.emit(trade(3n, 10n, 1_002)); // below EVENTS_TRADE_THRESHOLD
  await s.runtime.runOnce();
  assert.deepEqual(s.buys, [2n]);
  await s.runtime.runOnce();
  assert.deepEqual(s.buys, [2n], "an acknowledged event does not trigger again");
});

test("--follow alerts on a resolution proposal where the treasury has exposure", async () => {
  const s = await setup({ "1": 400n });
  await s.runtime.runOnce();
  for (const market_id of [1n, 3n]) {
    s.rpc.emit({ contract: "resolver", name: "ResolutionProposedV2", ledger: 1_001, values: { market_id, outcome: { tag: "No", values: undefined }, proposed_at: BigInt(NOW) } });
  }
  await s.runtime.runOnce();
  const alerts = s.logs.filter((l) => l.event === "PROPOSAL_ALERT");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].fields?.marketId, 1n);
  assert.equal(alerts[0].fields?.disputeDeadline, BigInt(NOW + 600));
});

test("a retention gap in follow mode re-evaluates every tradable market", async () => {
  const s = await setup();
  await s.runtime.runOnce();
  s.rpc.latest = 9_000;
  s.rpc.oldest = 8_000;
  await s.runtime.runOnce();
  assert.deepEqual(s.buys, [1n, 2n, 3n]);
  assert.ok(s.logs.some((l) => l.event === "EVENTS_RESYNC"));
});
