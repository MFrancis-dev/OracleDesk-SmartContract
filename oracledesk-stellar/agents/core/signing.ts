/**
 * Off-chain Ed25519 agent key binding and trace attestations (#53).
 *
 * An agent binds dedicated Ed25519 signing keys to their registered address
 * with on-chain proof of possession, and signs domain-separated trace attestations
 * that can be verified independently by any consumer offline without trusting
 * the registry admin.
 *
 * Byte layout for key binding message:
 *   "oracledesk-agent-key-v1"               23 ASCII bytes, domain tag
 *   || network_id                           32 bytes, sha256(network passphrase)
 *   || ScVal-XDR(registry contract address) 40 bytes for a C... address
 *   || ScVal-XDR(agent address)             36 bytes for G... or 40 bytes for C...
 *   || public_key                           32 bytes raw Ed25519 public key
 *
 * Byte layout for trace attestation message:
 *   "oracledesk-trace-v1"                   19 ASCII bytes, domain tag
 *   || network_id                           32 bytes, sha256(network passphrase)
 *   || ScVal-XDR(registry contract address) 40 bytes for a C... address
 *   || ScVal-XDR(agent address)             36 bytes for G... or 40 bytes for C...
 *   || market_id                            u64 big-endian (8 bytes)
 *   || action_tag                           1 byte (0..7 canonical, 8 Other + sym XDR)
 *   || trace_hash                           32 bytes
 */

import { createHash } from "node:crypto";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { toTraceAction, type TraceActionString, type TraceActionType } from "./trace.js";

const KEY_BIND_DOMAIN = Buffer.from("oracledesk-agent-key-v1", "ascii");
const TRACE_SIG_DOMAIN = Buffer.from("oracledesk-trace-v1", "ascii");

/** Order of the Ed25519 base-point subgroup. */
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

export function actionToAttestationBytes(action: TraceActionType | TraceActionString): Buffer {
  const act = typeof action === "string" ? toTraceAction(action) : action;
  switch (act.tag) {
    case "CreateMarket":
      return Buffer.from([0]);
    case "ProposeMarket":
      return Buffer.from([1]);
    case "Buy":
      return Buffer.from([2]);
    case "Sell":
      return Buffer.from([3]);
    case "Skip":
      return Buffer.from([4]);
    case "Redeem":
      return Buffer.from([5]);
    case "ClaimRemainder":
      return Buffer.from([6]);
    case "Resolve":
      return Buffer.from([7]);
    case "Other": {
      const symScVal = xdr.ScVal.scvSymbol(act.values[0]);
      return Buffer.concat([Buffer.from([8]), symScVal.toXDR()]);
    }
  }
}

export interface KeyBindContext {
  networkPassphrase: string;
  registryId: string;
  agent: string;
  publicKey: Uint8Array;
}

export interface TraceAttestationContext {
  networkPassphrase: string;
  registryId: string;
  agent: string;
  marketId: bigint;
  action: TraceActionType | TraceActionString;
  traceHash: Uint8Array;
}

export interface AttestationSignature {
  publicKey: Uint8Array;
  signature: Uint8Array;
}

export function buildKeyBindMessage(ctx: KeyBindContext): Uint8Array {
  if (ctx.publicKey.length !== 32) {
    throw new Error(`publicKey must be 32 bytes, got ${ctx.publicKey.length}`);
  }
  return Buffer.concat([
    KEY_BIND_DOMAIN,
    createHash("sha256").update(ctx.networkPassphrase).digest(),
    Address.fromString(ctx.registryId).toScVal().toXDR(),
    Address.fromString(ctx.agent).toScVal().toXDR(),
    Buffer.from(ctx.publicKey),
  ]);
}

export function buildTraceAttestationMessage(ctx: TraceAttestationContext): Uint8Array {
  if (ctx.traceHash.length !== 32) {
    throw new Error(`traceHash must be 32 bytes, got ${ctx.traceHash.length}`);
  }
  const marketIdBuf = Buffer.alloc(8);
  marketIdBuf.writeBigUInt64BE(ctx.marketId);
  const actionBuf = actionToAttestationBytes(ctx.action);

  return Buffer.concat([
    TRACE_SIG_DOMAIN,
    createHash("sha256").update(ctx.networkPassphrase).digest(),
    Address.fromString(ctx.registryId).toScVal().toXDR(),
    Address.fromString(ctx.agent).toScVal().toXDR(),
    marketIdBuf,
    actionBuf,
    Buffer.from(ctx.traceHash),
  ]);
}

export function signKeyBind(
  keypair: Keypair,
  ctx: Omit<KeyBindContext, "publicKey">,
): AttestationSignature {
  const pubkey = new Uint8Array(keypair.rawPublicKey());
  const msg = buildKeyBindMessage({ ...ctx, publicKey: pubkey });
  const sig = new Uint8Array(keypair.sign(Buffer.from(msg)));
  return { publicKey: pubkey, signature: sig };
}

export function verifyKeyBind(
  publicKey: Uint8Array,
  signature: Uint8Array,
  ctx: Omit<KeyBindContext, "publicKey">,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const s = BigInt(`0x${Buffer.from(signature.slice(32)).reverse().toString("hex")}`);
  if (s >= GROUP_ORDER) return false;
  const msg = Buffer.from(buildKeyBindMessage({ ...ctx, publicKey }));
  const key = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)));
  return key.verify(msg, Buffer.from(signature));
}

export function signTraceAttestation(
  keypair: Keypair,
  ctx: TraceAttestationContext,
): AttestationSignature {
  const pubkey = new Uint8Array(keypair.rawPublicKey());
  const msg = buildTraceAttestationMessage(ctx);
  const sig = new Uint8Array(keypair.sign(Buffer.from(msg)));
  return { publicKey: pubkey, signature: sig };
}

export function verifyTraceAttestation(
  publicKey: Uint8Array,
  signature: Uint8Array,
  ctx: TraceAttestationContext,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const s = BigInt(`0x${Buffer.from(signature.slice(32)).reverse().toString("hex")}`);
  if (s >= GROUP_ORDER) return false;
  const msg = Buffer.from(buildTraceAttestationMessage(ctx));
  const key = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)));
  return key.verify(msg, Buffer.from(signature));
}
