import { createHash, createPublicKey, verify } from "node:crypto";

export type TraceVerdict =
  | { tag: "Valid"; values?: void }
  | { tag: "HashMismatch"; values?: void }
  | { tag: "Flagged"; values: [string] | readonly [string] }
  | { tag: "AgentRevokedAfter"; values: [bigint] | readonly [bigint] };

export interface TraceRecord {
  traceId: string;
  ipfsCid: string;
  traceHash: string;
  marketId?: bigint;
  agent?: string;
}

export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function verifyTraceHash(content: Uint8Array, expectedHash: string): boolean {
  const normalized = expectedHash.toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(normalized) && sha256Hex(content) === normalized;
}

export function ipfsUrl(gateway: string, cid: string): string {
  const base = gateway.endsWith("/") ? gateway.slice(0, -1) : gateway;
  return `${base}/${encodeURIComponent(cid)}`;
}

export type TraceLocator =
  | { kind: "ipfs"; cid: string; path: string[] }
  | { kind: "local"; path: string }
  | { kind: "unsupported"; reason: string };

export function parseTraceLocator(raw: string): TraceLocator {
  const trimmed = raw.trim();

  if (trimmed.startsWith("ipfs://")) {
    const rest = trimmed.slice(7);
    const [cidPart, ...pathParts] = rest.split("/").filter((s) => s);
    if (!cidPart) return { kind: "unsupported", reason: "empty ipfs:// URI" };
    return { kind: "ipfs", cid: cidPart, path: pathParts };
  }

  if (trimmed.startsWith("/ipfs/")) {
    const rest = trimmed.slice(6);
    const [cidPart, ...pathParts] = rest.split("/").filter((s) => s);
    if (!cidPart) return { kind: "unsupported", reason: "empty /ipfs/ path" };
    return { kind: "ipfs", cid: cidPart, path: pathParts };
  }

  if (trimmed.startsWith("local://")) {
    const path = trimmed.slice(8);
    if (!path) return { kind: "unsupported", reason: "empty local:// path" };
    return { kind: "local", path };
  }

  if (/^[Qm]/.test(trimmed) || /^bafy/.test(trimmed) || /^ba[a-z2-7]+/.test(trimmed)) {
    const [cidPart, ...pathParts] = trimmed.split("/").filter((s) => s);
    return { kind: "ipfs", cid: cidPart, path: pathParts };
  }

  if (
    trimmed.startsWith("ipns://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  ) {
    return { kind: "unsupported", reason: `unsupported scheme or format: ${trimmed}` };
  }

  return { kind: "unsupported", reason: `unrecognized locator format: ${trimmed}` };
}

export type CidCheck = { level: "cid-multihash"; ok: boolean } | { level: "trace-hash-only" };

export function checkCidAgainstTraceHash(loc: TraceLocator, traceHash: string): CidCheck {
  if (loc.kind !== "ipfs" || loc.path.length > 0) {
    return { level: "trace-hash-only" };
  }
  return { level: "trace-hash-only" };
}

export function gatewayUrl(gateway: string, cid: string, path: string[] = []): string {
  const base = gateway.endsWith("/") ? gateway.slice(0, -1) : gateway;
  const pathSegments = [cid, ...path.map((p) => encodeURIComponent(p))];
  return `${base}/${pathSegments.join("/")}`;
}

export interface ChainEntry {
  seq: bigint;
  traceHash: string;
  prevTraceHash: string;
}

export type ChainVerdict =
  | { ok: true }
  | { ok: false; reason: "gap" | "broken-link" | "bad-genesis"; atSeq: bigint };

const GENESIS_HASH = "0".repeat(64);

function normalizeHash(hash: string): string {
  return hash.toLowerCase().replace(/^0x/, "");
}

export function verifyChain(entries: ChainEntry[], fromGenesis: boolean): ChainVerdict {
  if (entries.length === 0) return { ok: true };

  const first = entries[0];
  if (fromGenesis && (first.seq !== 1n || normalizeHash(first.prevTraceHash) !== GENESIS_HASH)) {
    return { ok: false, reason: "bad-genesis", atSeq: first.seq };
  }

  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (cur.seq !== prev.seq + 1n) {
      return { ok: false, reason: "gap", atSeq: prev.seq + 1n };
    }
    if (normalizeHash(cur.prevTraceHash) !== normalizeHash(prev.traceHash)) {
      return { ok: false, reason: "broken-link", atSeq: cur.seq };
    }
  }
  return { ok: true };
}

// ─── Ed25519 trace attestations (#53) ───────────────────────────────────────

/**
 * Verifies an Ed25519 signature over a message using Node's standard crypto.
 * Can be run completely offline with no network or registry access.
 */
export function verifyEd25519Signature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const der = Buffer.concat([spkiPrefix, Buffer.from(publicKey)]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

