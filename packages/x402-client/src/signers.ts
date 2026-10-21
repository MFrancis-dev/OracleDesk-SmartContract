/**
 * SEP-43 wallet signers for x402 client.
 * Abstracts Freighter and other wallets for signature operations.
 */
import type { ClientStellarSigner } from "@stellar/stellar-sdk";

export interface WalletSigner extends ClientStellarSigner {
  address: string;
}

export interface SignaturePayload {
  data: Buffer | Uint8Array;
  memo?: string;
}

export interface SignatureResult {
  signature: Buffer;
  address: string;
}

/**
 * Browser-safe signing using Freighter or injected stellar-wallet object.
 * Requests public key first if not cached.
 */
export async function signPayment(
  payload: SignaturePayload,
  signer?: WalletSigner,
): Promise<SignatureResult> {
  if (!signer && typeof window === "undefined") {
    throw new Error("No signer provided and not in browser environment");
  }

  const walletSigner = signer ?? (globalThis as any)?.stellar?.signer;
  if (!walletSigner) {
    throw new Error("No wallet signer available — install Freighter or provide signer");
  }

  const address = walletSigner.address ?? (await walletSigner.getPublicKey?.());
  if (!address) {
    throw new Error("Cannot determine signer address");
  }

  const sig = await walletSigner.signMessage?.(payload.data, payload.memo);
  if (!sig) {
    throw new Error("Wallet refused signature");
  }

  return {
    signature: sig instanceof Buffer ? sig : Buffer.from(sig),
    address,
  };
}

/**
 * For Node.js: sign using a keypair directly (test use only).
 * Production should use Freighter.
 */
export async function signPaymentNode(
  payload: SignaturePayload,
  keypair: any,
): Promise<SignatureResult> {
  const sig = keypair.sign(Buffer.from(payload.data));
  return {
    signature: sig,
    address: keypair.publicKey(),
  };
}
