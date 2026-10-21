import { createHmac } from "node:crypto";

export interface TraceIndexRow {
  traceId: bigint;
  marketId: bigint;
  agent: string;
  action: string;
  traceHash: string;
  cid: string;
  publishedAt: number;
  syncedAt: number;
}

export type VerificationStatus = "verified" | "mismatch" | "unreachable" | "pending" | "archived";

export interface VerificationRow {
  traceId: bigint;
  status: VerificationStatus;
  checkedHash?: string;
  checkedAt?: number;
  attempts: number;
  error?: string;
}

export interface DiscoveryStore {
  upsertTraces(rows: TraceIndexRow[]): Promise<void>;
  highWater(): Promise<bigint>;
  byMarket(marketId: bigint, cursor: bigint | null, limit: number, order: "asc" | "desc"): Promise<TraceIndexRow[]>;
  byAgent(agent: string, cursor: bigint | null, limit: number): Promise<TraceIndexRow[]>;
  getVerification(id: bigint): Promise<VerificationRow | undefined>;
  putVerification(v: VerificationRow): Promise<void>;
}

export class MemoryDiscoveryStore implements DiscoveryStore {
  private traces = new Map<bigint, TraceIndexRow>();
  private verifications = new Map<bigint, VerificationRow>();
  private highWaterMark = 0n;

  async upsertTraces(rows: TraceIndexRow[]): Promise<void> {
    for (const row of rows) {
      this.traces.set(row.traceId, row);
      if (row.traceId > this.highWaterMark) {
        this.highWaterMark = row.traceId;
      }
    }
  }

  async highWater(): Promise<bigint> {
    return this.highWaterMark;
  }

  async byMarket(marketId: bigint, cursor: bigint | null, limit: number, order: "asc" | "desc"): Promise<TraceIndexRow[]> {
    let rows = Array.from(this.traces.values()).filter((r) => r.marketId === marketId);
    if (cursor !== null) {
      rows = rows.filter((r) => order === "asc" ? r.traceId > cursor : r.traceId < cursor);
    }
    rows.sort((a, b) => order === "asc" ? Number(a.traceId - b.traceId) : Number(b.traceId - a.traceId));
    return rows.slice(0, limit);
  }

  async byAgent(agent: string, cursor: bigint | null, limit: number): Promise<TraceIndexRow[]> {
    let rows = Array.from(this.traces.values()).filter((r) => r.agent === agent);
    if (cursor !== null) rows = rows.filter((r) => r.traceId > cursor);
    rows.sort((a, b) => Number(b.traceId - a.traceId));
    return rows.slice(0, limit);
  }

  async getVerification(id: bigint): Promise<VerificationRow | undefined> {
    return this.verifications.get(id);
  }

  async putVerification(v: VerificationRow): Promise<void> {
    this.verifications.set(v.traceId, v);
  }
}

export interface CursorData {
  marketId?: string;
  index: bigint;
  order: "asc" | "desc";
}

export function encodeCursor(data: CursorData, secret: string): string {
  const payload = JSON.stringify(data);
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}:${hmac}`).toString("base64url");
}

export function decodeCursor(cursor: string, secret: string): CursorData | null {
  try {
    const payload = Buffer.from(cursor, "base64url").toString();
    const [data, hmac] = payload.split(":");
    const expectedHmac = createHmac("sha256", secret).update(data).digest("hex");
    if (hmac !== expectedHmac) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function shouldReverify(verification: VerificationRow | undefined, maxAgeSecs: number): boolean {
  if (!verification || verification.status === "pending") return true;
  if (!verification.checkedAt) return true;
  const age = (Date.now() - verification.checkedAt) / 1000;
  return age > maxAgeSecs;
}

export function updateVerificationFromFetch(
  current: VerificationRow | undefined,
  traceId: bigint,
  fetchedHash: string | null,
  onChainHash: string,
  error?: string,
): VerificationRow {
  const attempts = (current?.attempts ?? 0) + 1;

  if (error) {
    if (error === "ARCHIVED") {
      return { traceId, status: "archived", attempts, error: "Trace was archived from Soroban state" };
    }
    return { traceId, status: "unreachable", attempts, error, checkedAt: Date.now(), checkedHash: current?.checkedHash };
  }

  if (!fetchedHash) {
    return { traceId, status: "pending", attempts };
  }

  const normalized = (h: string) => h.toLowerCase().replace(/^0x/, "");
  if (normalized(fetchedHash) === normalized(onChainHash)) {
    return { traceId, status: "verified", checkedHash: fetchedHash, checkedAt: Date.now(), attempts };
  }

  return {
    traceId,
    status: "mismatch",
    checkedHash: fetchedHash,
    checkedAt: Date.now(),
    attempts,
    error: `Hash mismatch: fetched ${fetchedHash}, expected ${onChainHash}`,
  };
}
