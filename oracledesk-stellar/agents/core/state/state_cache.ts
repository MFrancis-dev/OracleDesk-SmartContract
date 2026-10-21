/**
 * SnapshotCache: TTL-based in-memory cache for chain state snapshots.
 * Prevents thundering herd on RPC by serving stale data while a refresh is in flight.
 */
import type { Snapshot } from "./types.js";

const DEFAULT_TTL_MS = Number(process.env.AGENT_SNAPSHOT_TTL_MS ?? 15_000);

interface CacheEntry {
  snapshot: Snapshot;
  fetchedAt: number;
  staleAt: number;
}

export class SnapshotCache {
  private entry: CacheEntry | undefined;
  private refreshing = false;
  private waiters: Array<(s: Snapshot) => void> = [];
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get current(): Snapshot | undefined {
    return this.entry?.snapshot;
  }

  isFresh(): boolean {
    if (!this.entry) return false;
    return Date.now() < this.entry.staleAt;
  }

  /** Get a fresh snapshot: serve from cache if fresh, otherwise await the refresh. */
  async get(fetch: () => Promise<Snapshot>): Promise<Snapshot> {
    if (this.isFresh()) return this.entry!.snapshot;

    if (this.refreshing) {
      return new Promise<Snapshot>((resolve) => this.waiters.push(resolve));
    }

    this.refreshing = true;
    try {
      const snapshot = await fetch();
      this.store(snapshot);
      return snapshot;
    } catch (e) {
      // On failure, return stale data if available
      if (this.entry) return this.entry.snapshot;
      throw e;
    } finally {
      this.refreshing = false;
      const pending = this.waiters.splice(0);
      if (this.entry) {
        const snap = this.entry.snapshot;
        pending.forEach((r) => r(snap));
      }
    }
  }

  store(snapshot: Snapshot): void {
    this.entry = {
      snapshot,
      fetchedAt: Date.now(),
      staleAt: Date.now() + this.ttlMs,
    };
  }

  invalidate(): void {
    if (this.entry) this.entry.staleAt = 0;
  }
}
