/**
 * SharedStore: distributed KV + lock primitive for multi-instance x402.
 * MemoryStore for single-instance, RedisStore for multi-instance deployment.
 */
import { randomUUID } from "node:crypto";

export interface Lease {
  key: string;
  token: string;
  fence: number;
  expiresAt: number;
}

export interface SharedStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, opts?: { ttlMs?: number; nx?: boolean }): Promise<boolean>;
  cas(key: string, expected: string | undefined, next: string, ttlMs?: number): Promise<boolean>;
  incr(key: string, by: number, ttlMs: number): Promise<number>;
  acquire(key: string, ttlMs: number): Promise<Lease | undefined>;
  renew(lease: Lease, ttlMs: number): Promise<boolean>;
  release(lease: Lease): Promise<boolean>;
  close(): Promise<void>;
}

interface MemEntry {
  value: string;
  expiresAt?: number;
}

export class MemoryStore implements SharedStore {
  private readonly kv = new Map<string, MemEntry>();
  private readonly fences = new Map<string, number>();
  private clock: () => number;

  constructor(clock?: () => number) {
    this.clock = clock ?? (() => Date.now());
  }

  private live(entry: MemEntry | undefined): string | undefined {
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && this.clock() >= entry.expiresAt) return undefined;
    return entry.value;
  }

  async get(key: string): Promise<string | undefined> {
    return this.live(this.kv.get(key));
  }

  async set(key: string, value: string, opts?: { ttlMs?: number; nx?: boolean }): Promise<boolean> {
    if (opts?.nx && this.live(this.kv.get(key)) !== undefined) return false;
    const expiresAt = opts?.ttlMs !== undefined ? this.clock() + opts.ttlMs : undefined;
    this.kv.set(key, { value, expiresAt });
    return true;
  }

  async cas(key: string, expected: string | undefined, next: string, ttlMs?: number): Promise<boolean> {
    const current = this.live(this.kv.get(key));
    if (current !== expected) return false;
    const expiresAt = ttlMs !== undefined ? this.clock() + ttlMs : undefined;
    this.kv.set(key, { value: next, expiresAt });
    return true;
  }

  async incr(key: string, by: number, ttlMs: number): Promise<number> {
    const current = this.live(this.kv.get(key));
    const val = (current !== undefined ? Number(current) : 0) + by;
    const expiresAt = current === undefined ? this.clock() + ttlMs : this.kv.get(key)!.expiresAt;
    this.kv.set(key, { value: String(val), expiresAt });
    return val;
  }

  async acquire(key: string, ttlMs: number): Promise<Lease | undefined> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const ok = await this.set(lockKey, token, { ttlMs, nx: true });
    if (!ok) return undefined;
    const fence = (this.fences.get(key) ?? 0) + 1;
    this.fences.set(key, fence);
    return { key, token, fence, expiresAt: this.clock() + ttlMs };
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    const lockKey = `lock:${lease.key}`;
    const current = this.live(this.kv.get(lockKey));
    if (current !== lease.token) return false;
    this.kv.set(lockKey, { value: lease.token, expiresAt: this.clock() + ttlMs });
    lease.expiresAt = this.clock() + ttlMs;
    return true;
  }

  async release(lease: Lease): Promise<boolean> {
    const lockKey = `lock:${lease.key}`;
    const current = this.live(this.kv.get(lockKey));
    if (current !== lease.token) return false;
    this.kv.delete(lockKey);
    return true;
  }

  async close(): Promise<void> {
    this.kv.clear();
  }
}

/**
 * RedisStore using ioredis. Uses Lua scripts for atomic CAS, release and renew.
 * Requires REDIS_URL env var. Fails fast on connection errors (no silent fallback).
 */
export class RedisStore implements SharedStore {
  private redis: any;

  static async create(redisUrl: string): Promise<RedisStore> {
    const { default: Redis } = await import("ioredis");
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    await redis.connect();
    const store = new RedisStore();
    store.redis = redis;
    return store;
  }

  async get(key: string): Promise<string | undefined> {
    const val = await this.redis.get(key);
    return val ?? undefined;
  }

  async set(key: string, value: string, opts?: { ttlMs?: number; nx?: boolean }): Promise<boolean> {
    const args: any[] = [key, value];
    if (opts?.ttlMs) args.push("PX", opts.ttlMs);
    if (opts?.nx) args.push("NX");
    const result = await this.redis.set(...args);
    return result === "OK" || result === 1;
  }

  async cas(key: string, expected: string | undefined, next: string, ttlMs?: number): Promise<boolean> {
    const lua = `
      local cur = redis.call('GET', KEYS[1])
      local exp = ARGV[1] == '__nil__' and false or (cur == ARGV[1])
      if cur == false and ARGV[1] == '__nil__' then exp = true end
      if not exp then return 0 end
      if ARGV[3] ~= '' then
        redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
      else
        redis.call('SET', KEYS[1], ARGV[2])
      end
      return 1
    `;
    const result = await this.redis.eval(
      lua, 1, key,
      expected === undefined ? "__nil__" : expected,
      next,
      ttlMs !== undefined ? String(ttlMs) : "",
    );
    return result === 1;
  }

  async incr(key: string, by: number, ttlMs: number): Promise<number> {
    const lua = `
      local v = redis.call('INCRBY', KEYS[1], ARGV[1])
      if v == tonumber(ARGV[1]) then
        redis.call('PEXPIRE', KEYS[1], ARGV[2])
      end
      return v
    `;
    return await this.redis.eval(lua, 1, key, String(by), String(ttlMs));
  }

  async acquire(key: string, ttlMs: number): Promise<Lease | undefined> {
    const token = randomUUID();
    const lockKey = `lock:${key}`;
    const fenceKey = `fence:${key}`;
    const lua = `
      local ok = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
      if not ok then return nil end
      local fence = redis.call('INCR', KEYS[2])
      return fence
    `;
    const fence = await this.redis.eval(lua, 2, lockKey, fenceKey, token, String(ttlMs));
    if (fence === null) return undefined;
    return { key, token, fence: Number(fence), expiresAt: Date.now() + ttlMs };
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    const lua = `
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      return 1
    `;
    const result = await this.redis.eval(lua, 1, `lock:${lease.key}`, lease.token, String(ttlMs));
    if (result === 1) lease.expiresAt = Date.now() + ttlMs;
    return result === 1;
  }

  async release(lease: Lease): Promise<boolean> {
    const lua = `
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('DEL', KEYS[1])
      return 1
    `;
    const result = await this.redis.eval(lua, 1, `lock:${lease.key}`, lease.token);
    return result === 1;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export async function createStore(storeType?: string, redisUrl?: string): Promise<SharedStore> {
  const type = storeType ?? process.env.X402_STORE ?? "memory";
  if (type === "redis") {
    const url = redisUrl ?? process.env.REDIS_URL;
    if (!url) throw new Error("X402_STORE=redis requires REDIS_URL");
    return RedisStore.create(url);
  }
  return new MemoryStore();
}
