/**
 * TraceRepository backed by the deployed reasoning-registry contract,
 * closing the gap the design doc calls out explicitly: "confirm it matches
 * the on-chain trace_hash from reasoning_registry before serving." The
 * static `MapTraceRepository` (server.ts's default) is a
 * TRACE_RECORDS_JSON-driven stand-in for when no registry is configured.
 *
 * The read is narrowed to `RegistryTraceReader` (structurally, not the full
 * generated Client type) so this file — and its tests — never need
 * `@oracledesk/bindings-reasoning-registry` installed; only
 * `createRegistryTraceRepository`'s dynamic import does.
 */

import type {
  TraceListEntry,
  TraceListPage,
  TraceListRepository,
  TraceRecord,
  TraceRepository,
} from "./trace-api.js";
import type { TraceVerdict } from "./trace-verification.js";

export interface RegistryTrace {
  market_id: bigint;
  agent: string;
  action: RegistryAction;
  trace_hash: Buffer;
  ipfs_cid: string;
  published_at: bigint;
}
export type RegistryAction =
  | string
  | { tag: string; values?: unknown[] };

export interface RegistryTracePageEntry {
  trace_id: bigint;
  trace: RegistryTrace;
}

export interface RegistryTracePage {
  entries: RegistryTracePageEntry[];
  next: bigint;
  total: bigint;
}

export interface RegistryTraceReader {
  get_trace(args: { trace_id: bigint }): Promise<{ result: RegistryTrace }>;
  trace_verdict?(args: { trace_id: bigint; received_hash: Buffer }): Promise<{ result: TraceVerdict }>;
  /** #57 paginated secondary indexes. */
  traces_by_agent?(args: {
    agent: string;
    start: bigint;
    limit: number;
  }): Promise<{ result: RegistryTracePage }>;
  traces_by_market?(args: {
    market_id: bigint;
    start: bigint;
    limit: number;
  }): Promise<{ result: RegistryTracePage }>;
  traces_by_market_action?(args: {
    market_id: bigint;
    action: string;
    start: bigint;
    limit: number;
  }): Promise<{ result: RegistryTracePage }>;
  market_trace_count?(args: { market_id: bigint }): Promise<{ result: bigint }>;
  market_trace_at?(args: { market_id: bigint; index: bigint }): Promise<{ result: bigint }>;
}

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 25;

export function actionLabel(action: RegistryAction): string {
  if (typeof action === "string") return action.toLowerCase();
  const tag = action.tag;
  if (tag === "Other") return `other:${String(action.values?.[0] ?? "")}`;
  return tag.replace(/[A-Z]/g, (c, i) => (i ? `_${c.toLowerCase()}` : c.toLowerCase()));
}

function toTraceListEntry(traceId: string, trace: RegistryTrace): TraceListEntry {
  return {
    traceId,
    traceHash: trace.trace_hash.toString("hex"),
    marketId: trace.market_id.toString(),
    agent: trace.agent,
    action: actionLabel(trace.action),
    publishedAt: trace.published_at.toString(),
  };
}

function toTraceListPage(page: RegistryTracePage): TraceListPage {
  return {
    items: page.entries.map((entry) => toTraceListEntry(entry.trace_id.toString(), entry.trace)),
    next: page.next.toString(),
    total: page.total.toString(),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(limit, MAX_PAGE_LIMIT);
}

function parseStart(cursor: bigint | string | undefined): bigint {
  if (cursor === undefined || cursor === "") return 0n;
  try {
    const value = BigInt(cursor);
    return value < 0n ? 0n : value;
  } catch {
    return 0n;
  }
}

export class RegistryTraceRepository implements TraceRepository, TraceListRepository {
  constructor(private readonly reader: RegistryTraceReader) {}

  async get(traceId: string): Promise<TraceRecord | undefined> {
    let id: bigint;
    try {
      id = BigInt(traceId);
    } catch {
      return undefined;
    }
    try {
      const { result } = await this.reader.get_trace({ trace_id: id });
      let verdict: TraceVerdict | undefined = undefined;
      if (typeof this.reader.trace_verdict === "function") {
        try {
          const verdictRes = await this.reader.trace_verdict({
            trace_id: id,
            received_hash: result.trace_hash,
          });
          verdict = verdictRes.result;
        } catch {
          // Contract-level error or method unavailable
        }
      }
      return {
        traceId,
        ipfsCid: result.ipfs_cid,
        traceHash: result.trace_hash.toString("hex"),
        action: actionLabel(result.action),
        verdict,
      };
    } catch {
      // Contract-level TraceNotFound, or any RPC failure: treat as "no
      // record" rather than surfacing an internal error to the caller.
      return undefined;
    }
  }

  async listByAgent(
    agent: string,
    cursor?: bigint | string,
    limit?: number,
  ): Promise<TraceListPage> {
    if (!this.reader.traces_by_agent) throw new Error("Agent index unavailable");
    const { result } = await this.reader.traces_by_agent({
      agent,
      start: parseStart(cursor),
      limit: clampLimit(limit),
    });
    return toTraceListPage(result);
  }

  async listByMarketAction(
    marketId: string,
    action: string,
    cursor?: bigint | string,
    limit?: number,
  ): Promise<TraceListPage> {
    if (!this.reader.traces_by_market_action) throw new Error("Market action index unavailable");
    const { result } = await this.reader.traces_by_market_action({
      market_id: BigInt(marketId),
      action,
      start: parseStart(cursor),
      limit: clampLimit(limit),
    });
    return toTraceListPage(result);
  }

  async listByMarket(
    marketId: string,
    cursor?: bigint | string,
    limit?: number,
  ): Promise<TraceListPage> {
    if (!this.reader.traces_by_market) throw new Error("Market index unavailable");
    const market = BigInt(marketId);
    const start = parseStart(cursor);
    try {
      const { result } = await this.reader.traces_by_market!({
        market_id: market, start, limit: clampLimit(limit),
      });
      return toTraceListPage(result);
    } catch (error) {
      // A single archived entry can abort trace_page. Re-read the bounded
      // index and retain a metadata-only placeholder for that entry.
      if (!this.reader.market_trace_count || !this.reader.market_trace_at) throw error;
      const total = BigInt((await this.reader.market_trace_count({ market_id: market })).result);
      const ids: bigint[] = [];
      for (let i = start; i < total && ids.length < clampLimit(limit); i++) {
        try { ids.push(BigInt((await this.reader.market_trace_at({ market_id: market, index: i })).result)); } catch { /* stale index */ }
      }
      const entries: TraceListEntry[] = [];
      for (const id of ids) {
        try {
          const trace = (await this.get(id.toString()));
          if (trace) entries.push(toTraceListEntry(id.toString(), {
            market_id: market, agent: trace.agent ?? "", action: trace.action ?? "",
            trace_hash: Buffer.from(trace.traceHash, "hex"), ipfs_cid: "", published_at: 0n,
          }));
          else entries.push({ traceId: id.toString(), traceHash: "", marketId: market.toString(), agent: "", action: "", publishedAt: "0", archived: true });
        } catch {
          entries.push({ traceId: id.toString(), traceHash: "", marketId: market.toString(), agent: "", action: "", publishedAt: "0", archived: true });
        }
      }
      return { items: entries, next: (start + BigInt(entries.length)).toString(), total: total.toString() };
    }
  }
}

export interface RegistryConnection {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export async function createRegistryTraceRepository(
  conn: RegistryConnection,
): Promise<RegistryTraceRepository> {
  const { Client } = await import("@oracledesk/bindings-reasoning-registry");
  const client = await Client.from({
    contractId: conn.contractId,
    rpcUrl: conn.rpcUrl,
    networkPassphrase: conn.networkPassphrase,
  });
  return new RegistryTraceRepository(client as unknown as RegistryTraceReader);
}
