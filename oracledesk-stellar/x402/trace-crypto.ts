import { createHash } from "node:crypto";

export interface EncryptedTraceEnvelope {
  v: 1;
  alg: "A256GCM";
  traceHash: string;
  iv: string;
  ct: string;
}

export async function encryptTrace(
  json: string,
  hash: string,
): Promise<{ envelope: string; key: Uint8Array }> {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(json);
  const aad = encoder.encode(`oracledesk-trace-v1:${hash}`);
  
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    plaintext,
  );
  
  const envelope: EncryptedTraceEnvelope = {
    v: 1,
    alg: "A256GCM",
    traceHash: hash,
    iv: Buffer.from(iv).toString("base64"),
    ct: Buffer.from(ciphertext).toString("base64"),
  };
  
  return {
    envelope: JSON.stringify(envelope),
    key,
  };
}

export async function decryptTrace(
  envelopeJson: string,
  key: Uint8Array,
): Promise<string> {
  const envelope: EncryptedTraceEnvelope = JSON.parse(envelopeJson);
  if (envelope.v !== 1 || envelope.alg !== "A256GCM") {
    throw new Error("Unsupported envelope version or algorithm");
  }
  
  const iv = Buffer.from(envelope.iv, "base64");
  const ct = Buffer.from(envelope.ct, "base64");
  const aad = new TextEncoder().encode(`oracledesk-trace-v1:${envelope.traceHash}`);
  
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ct,
  );
  
  const plainStr = new TextDecoder().decode(plaintext);
  
  const { sha256Hex } = await import("./trace-verification.js");
  const actual = sha256Hex(new Uint8Array(plaintext));
  const expected = envelope.traceHash.toLowerCase().replace(/^0x/, "");
  if (actual !== expected) {
    throw new Error("Plaintext hash does not match envelope");
  }
  
  return plainStr;
}
