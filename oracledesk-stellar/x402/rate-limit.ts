/**
 * Token-bucket rate limiting for x402.
 * Two independent buckets: unpaid (by IP) and paid (by payer address + IP).
 * Paid requests never consume unpaid tokens.
 */

export interface RateLimitStore {
  /** Returns remaining tokens after consuming `count`. Returns negative if over limit. */
  consume(key: string, count: number, windowMs: number, maxTokens: number): Promise<number>;
  /** Returns current token count without consuming. */
  peek(key: string): Promise<number | undefined>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async consume(key: string, count: number, windowMs: number, maxTokens: number): Promise<number> {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: maxTokens, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count -= count;
    return bucket.count;
  }

  async peek(key: string): Promise<number | undefined> {
    return this.buckets.get(key)?.count;
  }
}

export interface RateLimitConfig {
  unpaidPerMinute: number;
  unpaidBurst: number;
  paidPerMinute: number;
  store?: RateLimitStore;
  trustProxy?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSecs: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly store: RateLimitStore;

  constructor(private readonly config: RateLimitConfig) {
    this.store = config.store ?? new MemoryRateLimitStore();
  }

  private clientIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
    if (this.config.trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.ip ?? "unknown";
  }

  async checkUnpaid(
    req: { ip?: string; headers: Record<string, string | string[] | undefined> },
  ): Promise<RateLimitResult> {
    const ip = this.clientIp(req);
    const key = `unpaid:${ip}`;
    const remaining = await this.store.consume(key, 1, WINDOW_MS, this.config.unpaidPerMinute);
    return {
      allowed: remaining >= 0,
      remaining: Math.max(0, remaining),
      retryAfterSecs: remaining < 0 ? 60 : 0,
    };
  }

  async checkPaid(
    req: { ip?: string; headers: Record<string, string | string[] | undefined> },
    payerAddress?: string,
  ): Promise<RateLimitResult> {
    const ip = this.clientIp(req);
    const key = `paid:${payerAddress ?? ip}:${ip}`;
    const remaining = await this.store.consume(key, 1, WINDOW_MS, this.config.paidPerMinute);
    return {
      allowed: remaining >= 0,
      remaining: Math.max(0, remaining),
      retryAfterSecs: remaining < 0 ? 60 : 0,
    };
  }
}
