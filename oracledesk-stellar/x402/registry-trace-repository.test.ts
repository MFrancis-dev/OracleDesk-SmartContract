import assert from "node:assert/strict";
import test from "node:test";
import {
  RegistryTraceRepository,
  type RegistryTrace,
  type RegistryTracePage,
  type RegistryTraceReader,
} from "./registry-trace-repository.js";

function trace(id: number, overrides: Partial<RegistryTrace> = {}): RegistryTrace {
  return {
    market_id: 7n,
    agent: "GAGENT",
    action: "buy",
    trace_hash: Buffer.from("ab".repeat(32), "hex"),
    ipfs_cid: `ipfs://${id}`,
    published_at: BigInt(id),
    ...overrides,
  };
}

function page(ids: number[], next: number, total: number): RegistryTracePage {
  return {
    entries: ids.map((id) => ({ trace_id: BigInt(id), trace: trace(id) })),
    next: BigInt(next),
    total: BigInt(total),
  };
}

interface FakeOptions {
  byId?: Map<bigint, { trace_hash: string; ipfs_cid: string }>;
  agentPage?: RegistryTracePage;
  marketActionPage?: RegistryTracePage;
  onAgentArgs?: (args: { agent: string; start: bigint; limit: number }) => void;
  onMarketActionArgs?: (args: {
    market_id: bigint;
    action: string;
    start: bigint;
    limit: number;
  }) => void;
}

function fakeReader(options: FakeOptions = {}): RegistryTraceReader {
  const byId = options.byId ?? new Map();
  return {
    async get_trace({ trace_id }) {
      const record = byId.get(trace_id);
      if (!record) throw new Error("Error(Contract, #3005)"); // TraceNotFound
      return {
        result: {
          market_id: 0n,
          agent: "GAGENT",
          action: "create_market",
          trace_hash: Buffer.from(record.trace_hash, "hex"),
          ipfs_cid: record.ipfs_cid,
          published_at: 0n,
        },
      };
    },
    async traces_by_agent(args) {
      options.onAgentArgs?.(args);
      return { result: options.agentPage ?? page([], 0, 0) };
    },
    async traces_by_market_action(args) {
      options.onMarketActionArgs?.(args);
      return { result: options.marketActionPage ?? page([], 0, 0) };
    },
  };
}

test("returns a TraceRecord translated from the on-chain trace", async () => {
  const hash = "ab".repeat(32);
  const repo = new RegistryTraceRepository(
    fakeReader({ byId: new Map([[0n, { trace_hash: hash, ipfs_cid: "ipfs://x" }]]) }),
  );
  const record = await repo.get("0");
  assert.deepEqual(record, {
    traceId: "0",
    ipfsCid: "ipfs://x",
    traceHash: hash,
    action: "create_market",
    verdict: undefined,
  });
});

test("maps verdict from reader", async () => {
  const hash = "ab".repeat(32);
  const reader: RegistryTraceReader = {
    async get_trace() {
      return {
        result: {
          market_id: 0n,
          agent: "GAGENT",
          action: "create_market",
          trace_hash: Buffer.from(hash, "hex"),
          ipfs_cid: "ipfs://x",
          published_at: 0n,
        },
      };
    },
    async trace_verdict() {
      return {
        result: { tag: "Flagged", values: ["fraud"] },
      };
    },
  };
  const repo = new RegistryTraceRepository(reader);
  const record = await repo.get("0");
  assert.deepEqual(record, {
    traceId: "0",
    ipfsCid: "ipfs://x",
    traceHash: hash,
    action: "create_market",
    verdict: { tag: "Flagged", values: ["fraud"] },
  });
});

test("normalizes tagged action to string", async () => {
  const hash = "ab".repeat(32);
  const reader: RegistryTraceReader = {
    async get_trace() {
      return {
        result: {
          market_id: 0n,
          agent: "GAGENT",
          action: { tag: "Buy", values: undefined },
          trace_hash: Buffer.from(hash, "hex"),
          ipfs_cid: "ipfs://x",
          published_at: 0n,
        },
      };
    },
  };
  const repo = new RegistryTraceRepository(reader);
  const record = await repo.get("0");
  assert.equal(record?.action, "buy");
});

test("returns undefined for a trace id the registry does not know", async () => {
  const repo = new RegistryTraceRepository(fakeReader());
  assert.equal(await repo.get("999"), undefined);
});

test("returns undefined rather than throwing for a non-numeric trace id", async () => {
  const repo = new RegistryTraceRepository(fakeReader());
  assert.equal(await repo.get("not-a-number"), undefined);
});

test("lists an agent's traces from the #57 index", async () => {
  let seen: { agent: string; start: bigint; limit: number } | undefined;
  const repo = new RegistryTraceRepository(
    fakeReader({
      agentPage: page([0, 1], 2, 5),
      onAgentArgs: (args) => {
        seen = args;
      },
    }),
  );
  const result = await repo.listByAgent("GAGENT", "0", 2);
  assert.deepEqual(seen, { agent: "GAGENT", start: 0n, limit: 2 });
  assert.equal(result.next, "2");
  assert.equal(result.total, "5");
  assert.deepEqual(
    result.items.map((entry) => entry.traceId),
    ["0", "1"],
  );
  assert.equal(result.items[0].traceHash, "ab".repeat(32));
  assert.equal(result.items[0].agent, "GAGENT");
  // The unpaid listing never leaks the CID, or content could be fetched
  // straight from the gateway and bypass the paywall.
  assert.equal("ipfsCid" in result.items[0], false);
});

test("lists a market/action pair and clamps the page size", async () => {
  let seen:
    | { market_id: bigint; action: string; start: bigint; limit: number }
    | undefined;
  const repo = new RegistryTraceRepository(
    fakeReader({
      marketActionPage: page([3], 4, 4),
      onMarketActionArgs: (args) => {
        seen = args;
      },
    }),
  );
  const result = await repo.listByMarketAction("7", "buy", "3", 1_000);
  // 1_000 exceeds the contract's MAX_PAGE_SIZE (25); clamp to 25.
  assert.deepEqual(seen, { market_id: 7n, action: "buy", start: 3n, limit: 25 });
  assert.equal(result.items[0].marketId, "7");
  assert.equal(result.items[0].action, "buy");
});

test("defaults the cursor and page size when omitted", async () => {
  let seen: { agent: string; start: bigint; limit: number } | undefined;
  const repo = new RegistryTraceRepository(
    fakeReader({
      onAgentArgs: (args) => {
        seen = args;
      },
    }),
  );
  await repo.listByAgent("GAGENT");
  assert.deepEqual(seen, { agent: "GAGENT", start: 0n, limit: 25 });
});
