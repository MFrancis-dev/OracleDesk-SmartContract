import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export interface KeyRecord {
  traceHash: string;
  key: Uint8Array;
  cid: string;
  depositedBy: string;
  depositedAt: number;
}

export interface TraceKeyStore {
  put(traceHash: string, rec: Omit<KeyRecord, "depositedAt">): Promise<void>;
  get(traceHash: string): Promise<KeyRecord | undefined>;
  exists(traceHash: string): Promise<boolean>;
}

export class FileTraceKeyStore implements TraceKeyStore {
  private readonly kekHash: string;

  constructor(
    private readonly rootDir: string,
    private readonly kek: Uint8Array,
  ) {
    if (kek.length !== 32) throw new Error("KEK must be exactly 32 bytes");
    this.kekHash = createHash("sha256").update(kek).digest("hex").slice(0, 8);
  }

  private getPath(traceHash: string): string {
    const shard = traceHash.slice(0, 2);
    return join(this.rootDir, shard, `${traceHash}.key`);
  }

  async put(traceHash: string, rec: Omit<KeyRecord, "depositedAt">): Promise<void> {
    const path = this.getPath(traceHash);
    const dir = dirname(path);
    try { await mkdir(dir, { recursive: true }); } catch {}

    if (existsSync(path)) {
      const existing = await this.get(traceHash);
      if (existing && Buffer.from(existing.key).toString("hex") !== Buffer.from(rec.key).toString("hex")) {
        throw new Error(`Key for trace ${traceHash} already exists (write-once)`);
      }
      return;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.kek, iv);
    let encrypted = cipher.update(rec.key);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    const wrapped = {
      v: 1,
      kek_hash: this.kekHash,
      iv: iv.toString("hex"),
      auth_tag: authTag.toString("hex"),
      ct: encrypted.toString("hex"),
      cid: rec.cid,
      deposited_by: rec.depositedBy,
      deposited_at: Date.now(),
    };

    await writeFile(path, JSON.stringify(wrapped), "utf8");
  }

  async get(traceHash: string): Promise<KeyRecord | undefined> {
    const path = this.getPath(traceHash);
    if (!existsSync(path)) return undefined;

    try {
      const content = await readFile(path, "utf8");
      const wrapped = JSON.parse(content);

      if (wrapped.v !== 1 || wrapped.kek_hash !== this.kekHash) {
        throw new Error("KEK mismatch or unsupported version");
      }

      const iv = Buffer.from(wrapped.iv, "hex");
      const authTag = Buffer.from(wrapped.auth_tag, "hex");
      const ct = Buffer.from(wrapped.ct, "hex");

      const decipher = createDecipheriv("aes-256-gcm", this.kek, iv);
      decipher.setAuthTag(authTag);
      let key = decipher.update(ct);
      key = Buffer.concat([key, decipher.final()]);

      return {
        traceHash,
        key: new Uint8Array(key),
        cid: wrapped.cid,
        depositedBy: wrapped.deposited_by,
        depositedAt: wrapped.deposited_at,
      };
    } catch (err) {
      throw new Error(`Failed to decrypt key for trace ${traceHash}: ${err}`);
    }
  }

  async exists(traceHash: string): Promise<boolean> {
    const path = this.getPath(traceHash);
    return existsSync(path);
  }
}

export class MemoryTraceKeyStore implements TraceKeyStore {
  private store = new Map<string, KeyRecord>();

  async put(traceHash: string, rec: Omit<KeyRecord, "depositedAt">): Promise<void> {
    if (this.store.has(traceHash)) {
      const existing = this.store.get(traceHash)!;
      if (Buffer.from(existing.key).toString("hex") !== Buffer.from(rec.key).toString("hex")) {
        throw new Error(`Key for trace ${traceHash} already exists (write-once)`);
      }
      return;
    }
    this.store.set(traceHash, { ...rec, depositedAt: Date.now() });
  }

  async get(traceHash: string): Promise<KeyRecord | undefined> {
    return this.store.get(traceHash);
  }

  async exists(traceHash: string): Promise<boolean> {
    return this.store.has(traceHash);
  }
}
