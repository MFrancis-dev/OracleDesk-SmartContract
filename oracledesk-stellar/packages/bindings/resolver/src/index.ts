import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"Unauthorized"},
  3: {message:"InvalidConfig"},
  4: {message:"MarketAlreadyConfigured"},
  5: {message:"MarketNotConfigured"},
  6: {message:"WrongMode"},
  7: {message:"MarketNotClosed"},
  8: {message:"PriceUnavailable"},
  9: {message:"StalePrice"},
  10: {message:"InvalidPrice"},
  11: {message:"NotSigner"},
  12: {message:"AlreadyAttested"},
  13: {message:"ThresholdNotReached"},
  14: {message:"DisputeActive"},
  15: {message:"DisputeWindowOpen"},
  16: {message:"NoProposal"},
  17: {message:"AlreadyFinalized"},
  18: {message:"SpecHashMismatch"},
  19: {message:"DeadlineNotReached"},
  20: {message:"ResolutionAvailable"},
  21: {message:"DomainMismatch"},
  22: {message:"StaleRound"},
  23: {message:"TooManySignatures"},
  24: {message:"DisputeWindowClosed"},
  25: {message:"NoDispute"}
}

/**
 * The escalation authority's ruling. `Invalid` voids the market.
 */
export type Verdict = {tag: "Yes", values: void} | {tag: "No", values: void} | {tag: "Invalid", values: void};


/**
 * Who rules on a dispute.
 */
export type Escalation = {tag: "Guardian", values: void} | {tag: "Committee", values: readonly [Array<string>, u32]};

/**
 * Which resolution path a market was on when it expired.
 */
export type ExpiryMode = {tag: "Unrevealed", values: void} | {tag: "Price", values: void} | {tag: "Signers", values: void};

export type OracleAsset = {tag: "Stellar", values: readonly [string]} | {tag: "Other", values: readonly [string]};


export interface PriceConfig {
  asset: OracleAsset;
  direction: PriceDirection;
  max_staleness: u64;
  reflector: string;
  threshold: i128;
}


export interface WeightedKey {
  /**
 * Raw Ed25519 public key. For a `G...` account address this is
 * `StrKey.decodeEd25519PublicKey(address)`; `C...` addresses have none.
 */
pubkey: Buffer;
  weight: u32;
}


export interface SignerConfig {
  dispute_window: u64;
  signers: Array<string>;
  threshold: u32;
}


export type PriceDirection = {tag: "Above", values: void} | {tag: "AtOrAbove", values: void} | {tag: "Below", values: void} | {tag: "AtOrBelow", values: void};

/**
 * The full resolution rule a market's `resolution_hash` commits to. Hashing
 * this (rather than the bare `PriceConfig`/`SignerConfig`) keeps the two
 * modes in disjoint hash spaces even if their field encodings could
 * otherwise collide. See `docs/adr/0001-resolution-commitment.md`.
 */
export type ResolutionSpec = {tag: "Price", values: readonly [PriceConfig]} | {tag: "Signers", values: readonly [SignerConfig]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]} | {tag: "SignersDisputable", values: readonly [DisputableSignerConfig]};


export type ResolutionState = {tag: "Unconfigured", values: void} | {tag: "SignersPending", values: void} | {tag: "Finalized", values: void} | {tag: "Expired", values: void} | {tag: "Disputed", values: void};



/**
 * Versioned commitment envelope. Unlike a bare [`ResolutionSpec`] it binds the
 * network and the market-core instance, and carries a creator-chosen `salt`
 * that makes a pre-reveal brute-force of the (low-entropy) rule infeasible.
 */
export interface ResolutionSpecV2 {
  market_core: string;
  /**
 * `sha256(network passphrase)`, i.e. `env.ledger().network_id()`.
 */
network_id: Buffer;
  rule: ResolutionSpec;
  salt: Buffer;
  version: u32;
}


export interface WeightedKeyConfig {
  dispute_window: u64;
  signers: Array<WeightedKey>;
  /**
 * Total weight that must sign one outcome. Choose it above half the total
 * weight so two outcomes can never both reach it.
 */
weight_threshold: u32;
}




/**
 * Attested resolution whose proposal can be challenged with a bond during
 * the dispute window. Hashed as `ResolutionSpec::SignersDisputable`, a
 * separate variant, so existing `Signers` commitments are unaffected.
 */
export interface DisputableSignerConfig {
  /**
 * Collateral escrowed by `dispute`; must be positive.
 */
dispute_bond: i128;
  dispute_window: u64;
  escalation: Escalation;
  /**
 * Seconds after a dispute opens before anyone may void it unresolved.
 */
escalation_timeout: u64;
  signers: Array<string>;
  threshold: u32;
}

export type Outcome = {tag: "Yes", values: void} | {tag: "No", values: void};

export interface Client {
  /**
   * Construct and simulate a state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  state: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<ResolutionState>>

  /**
   * Construct and simulate a attest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  attest: ({market_id, signer, outcome}: {market_id: u64, signer: string, outcome: Outcome}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Challenges the current proposal of a `SignersDisputable` market while
   * its dispute window is still open (strictly before `proposed_at +
   * dispute_window`, the instant `finalize_signers` becomes callable). The
   * disputer escrows `dispute_bond` of the collateral token, which freezes
   * finalization until the escalation authority rules or
   * `escalation_timeout` lapses. `alternative` is the outcome the disputer
   * claims is correct (`None`: the market is invalid); it only informs the
   * ruling and must differ from the proposal. The disputer may also be a
   * proposing signer.
   */
  dispute: ({market_id, disputer, alternative}: {market_id: u64, disputer: string, alternative: Option<Outcome>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a current_round transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current attestation round of a weighted-key market; the `round`
   * argument of `submit_signatures` and part of every signed message.
   */
  current_round: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a expire_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless liveness fallback: once `resolution_deadline` has passed,
   * anyone may void a market that is still unresolved, so collateral is
   * never locked behind a missing reveal, a dead feed or silent signers.
   * 
   * Resolution is preferred over voiding. A price market whose feed is
   * valid right now is *resolved* instead (so a stalled caller can never
   * force a void on a resolvable market), and a market with a pending
   * signer proposal is refused with `ResolutionAvailable` until
   * `finalize_signers` settles it.
   */
  expire_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve_price: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Outcome>>>

  /**
   * Construct and simulate a expire_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless fallback when the escalation authority never rules:
   * `escalation_timeout` after the dispute opened, the bond is refunded and
   * the market is voided, so neither side wins by default.
   */
  expire_dispute: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian escalation: the admin rules on an open dispute.
   */
  settle_dispute: ({market_id, verdict}: {market_id: u64, verdict: Verdict}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian action: withdraws an unfinalized signer proposal, e.g. because
   * evidence surfaced during the dispute window that it is wrong. For
   * address-based signers voting can restart once the counts are cleared by
   * re-attesting; a weighted-key market moves to a fresh round, which makes
   * every signature collected so far unusable.
   */
  cancel_proposal: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a finalize_signers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  finalize_signers: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Outcome>>>

  /**
   * Construct and simulate a register_spec_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveals a rule committed to through a [`ResolutionSpecV2`] envelope.
   * The envelope must name this network and this resolver's market-core
   * (`DomainMismatch`), use a non-zero salt and the current `version`
   * (`InvalidConfig`), and hash to the market's commitment
   * (`SpecHashMismatch`). The inner rule is then validated and stored
   * exactly as the legacy entrypoints do.
   */
  register_spec_v2: ({market_id, spec}: {market_id: u64, spec: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a escalation_attest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Committee escalation: each member votes once; the first verdict to
   * gather `k` votes settles the dispute.
   */
  escalation_attest: ({market_id, member, verdict}: {market_id: u64, member: string, verdict: Verdict}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a submit_signatures transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Counts Ed25519 signatures from a weighted committee. Permissionless: the
   * signatures, not the submitter, carry the authority. Each signature is
   * over the message built by `attestation_message`; non-members and keys
   * that already signed this round (for either outcome) are skipped, and a
   * single invalid signature aborts the whole batch, so submitters should
   * pre-filter with a verifier. Once the accumulated weight for `outcome`
   * first reaches the threshold a proposal is recorded and the dispute
   * window starts; later calls never move it.
   */
  submit_signatures: ({market_id, outcome, round, sigs}: {market_id: u64, outcome: Outcome, round: u32, sigs: Array<readonly [Buffer, Buffer]>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_dispute_bond transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pays a settled dispute's bond to its payee (the disputer, or the
   * market-core treasury when the proposal was upheld). Permissionless.
   */
  claim_dispute_bond: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_price_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveals the resolution rule committed to at market creation. Anyone
   * may call this (there is no admin gate) because the only thing that
   * makes a spec acceptable is that it hashes to `market.resolution_hash`
   * — the commitment, not the caller, is the authority. Fails if a spec
   * was already registered for this market.
   */
  register_price_spec: ({market_id, spec}: {market_id: u64, spec: PriceConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolution_deadline transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * When `expire_market` becomes callable for `market_id`: `close_time` plus
   * [`RESOLUTION_GRACE_SECS`]. Needs only market-core's `close_time`, so it
   * is known before (and without) a spec reveal.
   */
  resolution_deadline: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a guardian_void_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian action: voids an unresolvable market directly through
   * market-core. The resolver is the direct caller, so market-core's
   * `require_resolver` check passes the same way `resolve_price` does.
   */
  guardian_void_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_signer_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, signer mode.
   */
  register_signer_spec: ({market_id, spec}: {market_id: u64, spec: SignerConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_disputable_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, signer mode whose
   * proposals can be challenged with a bond (see `dispute`).
   */
  register_disputable_spec: ({market_id, spec}: {market_id: u64, spec: DisputableSignerConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_weighted_key_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, weighted Ed25519
   * committee that signs off-chain and is verified by `submit_signatures`.
   */
  register_weighted_key_spec: ({market_id, spec}: {market_id: u64, spec: WeightedKeyConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, market_core}: {admin: string, market_core: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, market_core}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAGQAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAABdNYXJrZXRBbHJlYWR5Q29uZmlndXJlZAAAAAAEAAAAAAAAABNNYXJrZXROb3RDb25maWd1cmVkAAAAAAUAAAAAAAAACVdyb25nTW9kZQAAAAAAAAYAAAAAAAAAD01hcmtldE5vdENsb3NlZAAAAAAHAAAAAAAAABBQcmljZVVuYXZhaWxhYmxlAAAACAAAAAAAAAAKU3RhbGVQcmljZQAAAAAACQAAAAAAAAAMSW52YWxpZFByaWNlAAAACgAAAAAAAAAJTm90U2lnbmVyAAAAAAAACwAAAAAAAAAPQWxyZWFkeUF0dGVzdGVkAAAAAAwAAAAAAAAAE1RocmVzaG9sZE5vdFJlYWNoZWQAAAAADQAAAAAAAAANRGlzcHV0ZUFjdGl2ZQAAAAAAAA4AAAAAAAAAEURpc3B1dGVXaW5kb3dPcGVuAAAAAAAADwAAAAAAAAAKTm9Qcm9wb3NhbAAAAAAAEAAAAAAAAAAQQWxyZWFkeUZpbmFsaXplZAAAABEAAAAAAAAAEFNwZWNIYXNoTWlzbWF0Y2gAAAASAAAAAAAAABJEZWFkbGluZU5vdFJlYWNoZWQAAAAAABMAAAAAAAAAE1Jlc29sdXRpb25BdmFpbGFibGUAAAAAFAAAAAAAAAAORG9tYWluTWlzbWF0Y2gAAAAAABUAAAAAAAAAClN0YWxlUm91bmQAAAAAABYAAAAAAAAAEVRvb01hbnlTaWduYXR1cmVzAAAAAAAAFwAAAAAAAAATRGlzcHV0ZVdpbmRvd0Nsb3NlZAAAAAAYAAAAAAAAAAlOb0Rpc3B1dGUAAAAAAAAZ",
        "AAAAAgAAAD5UaGUgZXNjYWxhdGlvbiBhdXRob3JpdHkncyBydWxpbmcuIGBJbnZhbGlkYCB2b2lkcyB0aGUgbWFya2V0LgAAAAAAAAAAAAdWZXJkaWN0AAAAAAMAAAAAAAAAAAAAAANZZXMAAAAAAAAAAAAAAAACTm8AAAAAAAAAAAAAAAAAB0ludmFsaWQA",
        "AAAABQAAAAAAAAAAAAAACERpc3B1dGVkAAAAAQAAAAhkaXNwdXRlZAAAAAQAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAhkaXNwdXRlcgAAABMAAAAAAAAAAAAAAARib25kAAAACwAAAAAAAABJV2hhdCB0aGUgZGlzcHV0ZXIgY2xhaW1zIGlzIGNvcnJlY3Q7IGBOb25lYCBjbGFpbXMgdGhlIG1hcmtldCBpcyBpbnZhbGlkLgAAAAAAAAthbHRlcm5hdGl2ZQAAAAPoAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAAAgAAABdXaG8gcnVsZXMgb24gYSBkaXNwdXRlLgAAAAAAAAAACkVzY2FsYXRpb24AAAAAAAIAAAAAAAAALVRoZSByZXNvbHZlciBhZG1pbiwgdGhyb3VnaCBgc2V0dGxlX2Rpc3B1dGVgLgAAAAAAAAhHdWFyZGlhbgAAAAEAAABfYGtgIG9mIHRoZXNlIG1lbWJlcnMsIHRocm91Z2ggYGVzY2FsYXRpb25fYXR0ZXN0YC4gTXVzdCBiZSBkaXNqb2ludApmcm9tIHRoZSBwcm9wb3Npbmcgc2lnbmVycy4AAAAACUNvbW1pdHRlZQAAAAAAAAIAAAPqAAAAEwAAAAQ=",
        "AAAAAgAAADZXaGljaCByZXNvbHV0aW9uIHBhdGggYSBtYXJrZXQgd2FzIG9uIHdoZW4gaXQgZXhwaXJlZC4AAAAAAAAAAAAKRXhwaXJ5TW9kZQAAAAAAAwAAAAAAAAAAAAAAClVucmV2ZWFsZWQAAAAAAAAAAAAAAAAABVByaWNlAAAAAAAAAAAAAAAAAAAHU2lnbmVycwA=",
        "AAAAAgAAAAAAAAAAAAAAC09yYWNsZUFzc2V0AAAAAAIAAAABAAAAAAAAAAdTdGVsbGFyAAAAAAEAAAATAAAAAQAAAAAAAAAFT3RoZXIAAAAAAAABAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlQ29uZmlnAAAAAAUAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAC1dlaWdodGVkS2V5AAAAAAIAAACCUmF3IEVkMjU1MTkgcHVibGljIGtleS4gRm9yIGEgYEcuLi5gIGFjY291bnQgYWRkcmVzcyB0aGlzIGlzCmBTdHJLZXkuZGVjb2RlRWQyNTUxOVB1YmxpY0tleShhZGRyZXNzKWA7IGBDLi4uYCBhZGRyZXNzZXMgaGF2ZSBub25lLgAAAAAABnB1YmtleQAAAAAD7gAAACAAAAAAAAAABndlaWdodAAAAAAABA==",
        "AAAAAQAAAAAAAAAAAAAADFNpZ25lckNvbmZpZwAAAAMAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldEV4cGlyZWQAAAAAAAABAAAADm1hcmtldF9leHBpcmVkAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAAAAAABG1vZGUAAAfQAAAACkV4cGlyeU1vZGUAAAAAAAAAAAAC",
        "AAAAAgAAAAAAAAAAAAAADlByaWNlRGlyZWN0aW9uAAAAAAAEAAAAAAAAAAAAAAAFQWJvdmUAAAAAAAAAAAAAAAAAAAlBdE9yQWJvdmUAAAAAAAAAAAAAAAAAAAVCZWxvdwAAAAAAAAAAAAAAAAAACUF0T3JCZWxvdwAAAA==",
        "AAAAAgAAARNUaGUgZnVsbCByZXNvbHV0aW9uIHJ1bGUgYSBtYXJrZXQncyBgcmVzb2x1dGlvbl9oYXNoYCBjb21taXRzIHRvLiBIYXNoaW5nCnRoaXMgKHJhdGhlciB0aGFuIHRoZSBiYXJlIGBQcmljZUNvbmZpZ2AvYFNpZ25lckNvbmZpZ2ApIGtlZXBzIHRoZSB0d28KbW9kZXMgaW4gZGlzam9pbnQgaGFzaCBzcGFjZXMgZXZlbiBpZiB0aGVpciBmaWVsZCBlbmNvZGluZ3MgY291bGQKb3RoZXJ3aXNlIGNvbGxpZGUuIFNlZSBgZG9jcy9hZHIvMDAwMS1yZXNvbHV0aW9uLWNvbW1pdG1lbnQubWRgLgAAAAAAAAAADlJlc29sdXRpb25TcGVjAAAAAAAEAAAAAQAAAAAAAAAFUHJpY2UAAAAAAAABAAAH0AAAAAtQcmljZUNvbmZpZwAAAAABAAAAAAAAAAdTaWduZXJzAAAAAAEAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAAAAAAADFdlaWdodGVkS2V5cwAAAAEAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAAAAAAAARU2lnbmVyc0Rpc3B1dGFibGUAAAAAAAABAAAH0AAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAA=",
        "AAAABQAAAVlgZGlzcHV0ZXJfd29uYCBpcyB0cnVlIHdoZW4gdGhlIGJvbmQgcmV0dXJucyB0byB0aGUgZGlzcHV0ZXIgYmVjYXVzZSB0aGUKcnVsaW5nIG92ZXJ0dXJuZWQgdGhlIHByb3Bvc2FsLiBBIHRpbWVvdXQgKGBleHBpcmVfZGlzcHV0ZWApIGFsc28gcmVmdW5kcwp0aGUgYm9uZCBidXQgaXMgcmVwb3J0ZWQgYXMgYHZlcmRpY3Q6IEludmFsaWQsIGRpc3B1dGVyX3dvbjogZmFsc2VgOiBhCnJ1bGluZyBvZiBgSW52YWxpZGAgYWx3YXlzIG92ZXJ0dXJucywgc28gdGhhdCBwYWlyIGlkZW50aWZpZXMgYSB0aW1lb3V0LgpgcGF5b3V0YCBpcyB0aGUgZXNjcm93ZWQgYm9uZCwgY2xhaW1hYmxlIGJ5IGl0cyBwYXllZS4AAAAAAAAAAAAADkRpc3B1dGVTZXR0bGVkAAAAAAABAAAAD2Rpc3B1dGVfc2V0dGxlZAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHdmVyZGljdAAAAAfQAAAAB1ZlcmRpY3QAAAAAAAAAAAAAAAAMZGlzcHV0ZXJfd29uAAAAAQAAAAAAAAAAAAAABnBheW91dAAAAAAACwAAAAAAAAAC",
        "AAAAAgAAAAAAAAAAAAAAD1Jlc29sdXRpb25TdGF0ZQAAAAAFAAAAAAAAAAAAAAAMVW5jb25maWd1cmVkAAAAAAAAAAAAAAAOU2lnbmVyc1BlbmRpbmcAAAAAAAAAAAAAAAAACUZpbmFsaXplZAAAAAAAAAAAAABEVm9pZGVkIGJ5IFtgUmVzb2x2ZXI6OmV4cGlyZV9tYXJrZXRgXSBhZnRlciB0aGUgcmVzb2x1dGlvbiBkZWFkbGluZS4AAAAHRXhwaXJlZAAAAAAAAAAAQkEgYm9uZGVkIGRpc3B1dGUgaXMgb3BlbjsgZmluYWxpemF0aW9uIGlzIGZyb3plbiB1bnRpbCBpdCBzZXR0bGVzLgAAAAAACERpc3B1dGVk",
        "AAAABQAAAAAAAAAAAAAAD1ByaWNlUmVzb2x1dGlvbgAAAAABAAAAEHByaWNlX3Jlc29sdXRpb24AAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAAAAAAPcHJpY2VfdGltZXN0YW1wAAAAAAYAAAAAAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAg==",
        "AAAAAQAAAOBWZXJzaW9uZWQgY29tbWl0bWVudCBlbnZlbG9wZS4gVW5saWtlIGEgYmFyZSBbYFJlc29sdXRpb25TcGVjYF0gaXQgYmluZHMgdGhlCm5ldHdvcmsgYW5kIHRoZSBtYXJrZXQtY29yZSBpbnN0YW5jZSwgYW5kIGNhcnJpZXMgYSBjcmVhdG9yLWNob3NlbiBgc2FsdGAKdGhhdCBtYWtlcyBhIHByZS1yZXZlYWwgYnJ1dGUtZm9yY2Ugb2YgdGhlIChsb3ctZW50cm9weSkgcnVsZSBpbmZlYXNpYmxlLgAAAAAAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAUAAAAAAAAAC21hcmtldF9jb3JlAAAAABMAAAA/YHNoYTI1NihuZXR3b3JrIHBhc3NwaHJhc2UpYCwgaS5lLiBgZW52LmxlZGdlcigpLm5ldHdvcmtfaWQoKWAuAAAAAApuZXR3b3JrX2lkAAAAAAPuAAAAIAAAAAAAAAAEcnVsZQAAB9AAAAAOUmVzb2x1dGlvblNwZWMAAAAAAAAAAAAEc2FsdAAAA+4AAAAgAAAAAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAAB3NpZ25lcnMAAAAD6gAAB9AAAAALV2VpZ2h0ZWRLZXkAAAAAd1RvdGFsIHdlaWdodCB0aGF0IG11c3Qgc2lnbiBvbmUgb3V0Y29tZS4gQ2hvb3NlIGl0IGFib3ZlIGhhbGYgdGhlIHRvdGFsCndlaWdodCBzbyB0d28gb3V0Y29tZXMgY2FuIG5ldmVyIGJvdGggcmVhY2ggaXQuAAAAABB3ZWlnaHRfdGhyZXNob2xkAAAABA==",
        "AAAABQAAAAAAAAAAAAAAElJlc29sdXRpb25Qcm9wb3NlZAAAAAAAAQAAABNyZXNvbHV0aW9uX3Byb3Bvc2VkAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAtwcm9wb3NlZF9hdAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE1Jlc29sdXRpb25GaW5hbGl6ZWQAAAAAAQAAABRyZXNvbHV0aW9uX2ZpbmFsaXplZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAxmaW5hbGl6ZWRfYXQAAAAGAAAAAAAAAAI=",
        "AAAAAQAAANBBdHRlc3RlZCByZXNvbHV0aW9uIHdob3NlIHByb3Bvc2FsIGNhbiBiZSBjaGFsbGVuZ2VkIHdpdGggYSBib25kIGR1cmluZwp0aGUgZGlzcHV0ZSB3aW5kb3cuIEhhc2hlZCBhcyBgUmVzb2x1dGlvblNwZWM6OlNpZ25lcnNEaXNwdXRhYmxlYCwgYQpzZXBhcmF0ZSB2YXJpYW50LCBzbyBleGlzdGluZyBgU2lnbmVyc2AgY29tbWl0bWVudHMgYXJlIHVuYWZmZWN0ZWQuAAAAAAAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAAGAAAAM0NvbGxhdGVyYWwgZXNjcm93ZWQgYnkgYGRpc3B1dGVgOyBtdXN0IGJlIHBvc2l0aXZlLgAAAAAMZGlzcHV0ZV9ib25kAAAACwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAACmVzY2FsYXRpb24AAAAAB9AAAAAKRXNjYWxhdGlvbgAAAAAAQ1NlY29uZHMgYWZ0ZXIgYSBkaXNwdXRlIG9wZW5zIGJlZm9yZSBhbnlvbmUgbWF5IHZvaWQgaXQgdW5yZXNvbHZlZC4AAAAAEmVzY2FsYXRpb25fdGltZW91dAAAAAAABgAAAAAAAAAHc2lnbmVycwAAAAPqAAAAEwAAAAAAAAAJdGhyZXNob2xkAAAAAAAABA==",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAAAAAAAAAAAFc3RhdGUAAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAB9AAAAAPUmVzb2x1dGlvblN0YXRlAA==",
        "AAAAAAAAAAAAAAAGYXR0ZXN0AAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZzaWduZXIAAAAAABMAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAi5DaGFsbGVuZ2VzIHRoZSBjdXJyZW50IHByb3Bvc2FsIG9mIGEgYFNpZ25lcnNEaXNwdXRhYmxlYCBtYXJrZXQgd2hpbGUKaXRzIGRpc3B1dGUgd2luZG93IGlzIHN0aWxsIG9wZW4gKHN0cmljdGx5IGJlZm9yZSBgcHJvcG9zZWRfYXQgKwpkaXNwdXRlX3dpbmRvd2AsIHRoZSBpbnN0YW50IGBmaW5hbGl6ZV9zaWduZXJzYCBiZWNvbWVzIGNhbGxhYmxlKS4gVGhlCmRpc3B1dGVyIGVzY3Jvd3MgYGRpc3B1dGVfYm9uZGAgb2YgdGhlIGNvbGxhdGVyYWwgdG9rZW4sIHdoaWNoIGZyZWV6ZXMKZmluYWxpemF0aW9uIHVudGlsIHRoZSBlc2NhbGF0aW9uIGF1dGhvcml0eSBydWxlcyBvcgpgZXNjYWxhdGlvbl90aW1lb3V0YCBsYXBzZXMuIGBhbHRlcm5hdGl2ZWAgaXMgdGhlIG91dGNvbWUgdGhlIGRpc3B1dGVyCmNsYWltcyBpcyBjb3JyZWN0IChgTm9uZWA6IHRoZSBtYXJrZXQgaXMgaW52YWxpZCk7IGl0IG9ubHkgaW5mb3JtcyB0aGUKcnVsaW5nIGFuZCBtdXN0IGRpZmZlciBmcm9tIHRoZSBwcm9wb3NhbC4gVGhlIGRpc3B1dGVyIG1heSBhbHNvIGJlIGEKcHJvcG9zaW5nIHNpZ25lci4AAAAAAAdkaXNwdXRlAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAACGRpc3B1dGVyAAAAEwAAAAAAAAALYWx0ZXJuYXRpdmUAAAAD6AAAB9AAAAAHT3V0Y29tZQAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAA=",
        "AAAAAAAAAIFDdXJyZW50IGF0dGVzdGF0aW9uIHJvdW5kIG9mIGEgd2VpZ2h0ZWQta2V5IG1hcmtldDsgdGhlIGByb3VuZGAKYXJndW1lbnQgb2YgYHN1Ym1pdF9zaWduYXR1cmVzYCBhbmQgcGFydCBvZiBldmVyeSBzaWduZWQgbWVzc2FnZS4AAAAAAAANY3VycmVudF9yb3VuZAAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAABA==",
        "AAAAAAAAAfdQZXJtaXNzaW9ubGVzcyBsaXZlbmVzcyBmYWxsYmFjazogb25jZSBgcmVzb2x1dGlvbl9kZWFkbGluZWAgaGFzIHBhc3NlZCwKYW55b25lIG1heSB2b2lkIGEgbWFya2V0IHRoYXQgaXMgc3RpbGwgdW5yZXNvbHZlZCwgc28gY29sbGF0ZXJhbCBpcwpuZXZlciBsb2NrZWQgYmVoaW5kIGEgbWlzc2luZyByZXZlYWwsIGEgZGVhZCBmZWVkIG9yIHNpbGVudCBzaWduZXJzLgoKUmVzb2x1dGlvbiBpcyBwcmVmZXJyZWQgb3ZlciB2b2lkaW5nLiBBIHByaWNlIG1hcmtldCB3aG9zZSBmZWVkIGlzCnZhbGlkIHJpZ2h0IG5vdyBpcyAqcmVzb2x2ZWQqIGluc3RlYWQgKHNvIGEgc3RhbGxlZCBjYWxsZXIgY2FuIG5ldmVyCmZvcmNlIGEgdm9pZCBvbiBhIHJlc29sdmFibGUgbWFya2V0KSwgYW5kIGEgbWFya2V0IHdpdGggYSBwZW5kaW5nCnNpZ25lciBwcm9wb3NhbCBpcyByZWZ1c2VkIHdpdGggYFJlc29sdXRpb25BdmFpbGFibGVgIHVudGlsCmBmaW5hbGl6ZV9zaWduZXJzYCBzZXR0bGVzIGl0LgAAAAANZXhwaXJlX21hcmtldAAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAANcmVzb2x2ZV9wcmljZQAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAHT3V0Y29tZQAAAAAD",
        "AAAAAAAAAMFQZXJtaXNzaW9ubGVzcyBmYWxsYmFjayB3aGVuIHRoZSBlc2NhbGF0aW9uIGF1dGhvcml0eSBuZXZlciBydWxlczoKYGVzY2FsYXRpb25fdGltZW91dGAgYWZ0ZXIgdGhlIGRpc3B1dGUgb3BlbmVkLCB0aGUgYm9uZCBpcyByZWZ1bmRlZCBhbmQKdGhlIG1hcmtldCBpcyB2b2lkZWQsIHNvIG5laXRoZXIgc2lkZSB3aW5zIGJ5IGRlZmF1bHQuAAAAAAAADmV4cGlyZV9kaXNwdXRlAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAADhHdWFyZGlhbiBlc2NhbGF0aW9uOiB0aGUgYWRtaW4gcnVsZXMgb24gYW4gb3BlbiBkaXNwdXRlLgAAAA5zZXR0bGVfZGlzcHV0ZQAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHdmVyZGljdAAAAAfQAAAAB1ZlcmRpY3QAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAURHdWFyZGlhbiBhY3Rpb246IHdpdGhkcmF3cyBhbiB1bmZpbmFsaXplZCBzaWduZXIgcHJvcG9zYWwsIGUuZy4gYmVjYXVzZQpldmlkZW5jZSBzdXJmYWNlZCBkdXJpbmcgdGhlIGRpc3B1dGUgd2luZG93IHRoYXQgaXQgaXMgd3JvbmcuIEZvcgphZGRyZXNzLWJhc2VkIHNpZ25lcnMgdm90aW5nIGNhbiByZXN0YXJ0IG9uY2UgdGhlIGNvdW50cyBhcmUgY2xlYXJlZCBieQpyZS1hdHRlc3Rpbmc7IGEgd2VpZ2h0ZWQta2V5IG1hcmtldCBtb3ZlcyB0byBhIGZyZXNoIHJvdW5kLCB3aGljaCBtYWtlcwpldmVyeSBzaWduYXR1cmUgY29sbGVjdGVkIHNvIGZhciB1bnVzYWJsZS4AAAAPY2FuY2VsX3Byb3Bvc2FsAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAQZmluYWxpemVfc2lnbmVycwAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAHT3V0Y29tZQAAAAAD",
        "AAAAAAAAAWlSZXZlYWxzIGEgcnVsZSBjb21taXR0ZWQgdG8gdGhyb3VnaCBhIFtgUmVzb2x1dGlvblNwZWNWMmBdIGVudmVsb3BlLgpUaGUgZW52ZWxvcGUgbXVzdCBuYW1lIHRoaXMgbmV0d29yayBhbmQgdGhpcyByZXNvbHZlcidzIG1hcmtldC1jb3JlCihgRG9tYWluTWlzbWF0Y2hgKSwgdXNlIGEgbm9uLXplcm8gc2FsdCBhbmQgdGhlIGN1cnJlbnQgYHZlcnNpb25gCihgSW52YWxpZENvbmZpZ2ApLCBhbmQgaGFzaCB0byB0aGUgbWFya2V0J3MgY29tbWl0bWVudAooYFNwZWNIYXNoTWlzbWF0Y2hgKS4gVGhlIGlubmVyIHJ1bGUgaXMgdGhlbiB2YWxpZGF0ZWQgYW5kIHN0b3JlZApleGFjdGx5IGFzIHRoZSBsZWdhY3kgZW50cnlwb2ludHMgZG8uAAAAAAAAEHJlZ2lzdGVyX3NwZWNfdjIAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAARzcGVjAAAH0AAAABBSZXNvbHV0aW9uU3BlY1YyAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAGhDb21taXR0ZWUgZXNjYWxhdGlvbjogZWFjaCBtZW1iZXIgdm90ZXMgb25jZTsgdGhlIGZpcnN0IHZlcmRpY3QgdG8KZ2F0aGVyIGBrYCB2b3RlcyBzZXR0bGVzIHRoZSBkaXNwdXRlLgAAABFlc2NhbGF0aW9uX2F0dGVzdAAAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABm1lbWJlcgAAAAAAEwAAAAAAAAAHdmVyZGljdAAAAAfQAAAAB1ZlcmRpY3QAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAhRDb3VudHMgRWQyNTUxOSBzaWduYXR1cmVzIGZyb20gYSB3ZWlnaHRlZCBjb21taXR0ZWUuIFBlcm1pc3Npb25sZXNzOiB0aGUKc2lnbmF0dXJlcywgbm90IHRoZSBzdWJtaXR0ZXIsIGNhcnJ5IHRoZSBhdXRob3JpdHkuIEVhY2ggc2lnbmF0dXJlIGlzCm92ZXIgdGhlIG1lc3NhZ2UgYnVpbHQgYnkgYGF0dGVzdGF0aW9uX21lc3NhZ2VgOyBub24tbWVtYmVycyBhbmQga2V5cwp0aGF0IGFscmVhZHkgc2lnbmVkIHRoaXMgcm91bmQgKGZvciBlaXRoZXIgb3V0Y29tZSkgYXJlIHNraXBwZWQsIGFuZCBhCnNpbmdsZSBpbnZhbGlkIHNpZ25hdHVyZSBhYm9ydHMgdGhlIHdob2xlIGJhdGNoLCBzbyBzdWJtaXR0ZXJzIHNob3VsZApwcmUtZmlsdGVyIHdpdGggYSB2ZXJpZmllci4gT25jZSB0aGUgYWNjdW11bGF0ZWQgd2VpZ2h0IGZvciBgb3V0Y29tZWAKZmlyc3QgcmVhY2hlcyB0aGUgdGhyZXNob2xkIGEgcHJvcG9zYWwgaXMgcmVjb3JkZWQgYW5kIHRoZSBkaXNwdXRlCndpbmRvdyBzdGFydHM7IGxhdGVyIGNhbGxzIG5ldmVyIG1vdmUgaXQuAAAAEXN1Ym1pdF9zaWduYXR1cmVzAAAAAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAAAAAAABHNpZ3MAAAPqAAAD7QAAAAIAAAPuAAAAIAAAA+4AAABAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAIRQYXlzIGEgc2V0dGxlZCBkaXNwdXRlJ3MgYm9uZCB0byBpdHMgcGF5ZWUgKHRoZSBkaXNwdXRlciwgb3IgdGhlCm1hcmtldC1jb3JlIHRyZWFzdXJ5IHdoZW4gdGhlIHByb3Bvc2FsIHdhcyB1cGhlbGQpLiBQZXJtaXNzaW9ubGVzcy4AAAASY2xhaW1fZGlzcHV0ZV9ib25kAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAATpSZXZlYWxzIHRoZSByZXNvbHV0aW9uIHJ1bGUgY29tbWl0dGVkIHRvIGF0IG1hcmtldCBjcmVhdGlvbi4gQW55b25lCm1heSBjYWxsIHRoaXMgKHRoZXJlIGlzIG5vIGFkbWluIGdhdGUpIGJlY2F1c2UgdGhlIG9ubHkgdGhpbmcgdGhhdAptYWtlcyBhIHNwZWMgYWNjZXB0YWJsZSBpcyB0aGF0IGl0IGhhc2hlcyB0byBgbWFya2V0LnJlc29sdXRpb25faGFzaGAK4oCUIHRoZSBjb21taXRtZW50LCBub3QgdGhlIGNhbGxlciwgaXMgdGhlIGF1dGhvcml0eS4gRmFpbHMgaWYgYSBzcGVjCndhcyBhbHJlYWR5IHJlZ2lzdGVyZWQgZm9yIHRoaXMgbWFya2V0LgAAAAAAE3JlZ2lzdGVyX3ByaWNlX3NwZWMAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAALUHJpY2VDb25maWcAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAL1XaGVuIGBleHBpcmVfbWFya2V0YCBiZWNvbWVzIGNhbGxhYmxlIGZvciBgbWFya2V0X2lkYDogYGNsb3NlX3RpbWVgIHBsdXMKW2BSRVNPTFVUSU9OX0dSQUNFX1NFQ1NgXS4gTmVlZHMgb25seSBtYXJrZXQtY29yZSdzIGBjbG9zZV90aW1lYCwgc28gaXQKaXMga25vd24gYmVmb3JlIChhbmQgd2l0aG91dCkgYSBzcGVjIHJldmVhbC4AAAAAAAATcmVzb2x1dGlvbl9kZWFkbGluZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAMJHdWFyZGlhbiBhY3Rpb246IHZvaWRzIGFuIHVucmVzb2x2YWJsZSBtYXJrZXQgZGlyZWN0bHkgdGhyb3VnaAptYXJrZXQtY29yZS4gVGhlIHJlc29sdmVyIGlzIHRoZSBkaXJlY3QgY2FsbGVyLCBzbyBtYXJrZXQtY29yZSdzCmByZXF1aXJlX3Jlc29sdmVyYCBjaGVjayBwYXNzZXMgdGhlIHNhbWUgd2F5IGByZXNvbHZlX3ByaWNlYCBkb2VzLgAAAAAAFGd1YXJkaWFuX3ZvaWRfbWFya2V0AAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAENTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgc2lnbmVyIG1vZGUuAAAAABRyZWdpc3Rlcl9zaWduZXJfc3BlYwAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAIFTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgc2lnbmVyIG1vZGUgd2hvc2UKcHJvcG9zYWxzIGNhbiBiZSBjaGFsbGVuZ2VkIHdpdGggYSBib25kIChzZWUgYGRpc3B1dGVgKS4AAAAAAAAYcmVnaXN0ZXJfZGlzcHV0YWJsZV9zcGVjAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAAWRGlzcHV0YWJsZVNpZ25lckNvbmZpZwAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAI5TZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgd2VpZ2h0ZWQgRWQyNTUxOQpjb21taXR0ZWUgdGhhdCBzaWducyBvZmYtY2hhaW4gYW5kIGlzIHZlcmlmaWVkIGJ5IGBzdWJtaXRfc2lnbmF0dXJlc2AuAAAAAAAacmVnaXN0ZXJfd2VpZ2h0ZWRfa2V5X3NwZWMAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAA+kAAAACAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    state: this.txFromJSON<ResolutionState>,
        attest: this.txFromJSON<Result<void>>,
        dispute: this.txFromJSON<Result<void>>,
        current_round: this.txFromJSON<u32>,
        expire_market: this.txFromJSON<Result<void>>,
        resolve_price: this.txFromJSON<Result<Outcome>>,
        expire_dispute: this.txFromJSON<Result<void>>,
        settle_dispute: this.txFromJSON<Result<void>>,
        cancel_proposal: this.txFromJSON<Result<void>>,
        finalize_signers: this.txFromJSON<Result<Outcome>>,
        register_spec_v2: this.txFromJSON<Result<void>>,
        escalation_attest: this.txFromJSON<Result<void>>,
        submit_signatures: this.txFromJSON<Result<void>>,
        claim_dispute_bond: this.txFromJSON<Result<void>>,
        register_price_spec: this.txFromJSON<Result<void>>,
        resolution_deadline: this.txFromJSON<Result<u64>>,
        guardian_void_market: this.txFromJSON<Result<void>>,
        register_signer_spec: this.txFromJSON<Result<void>>,
        register_disputable_spec: this.txFromJSON<Result<void>>,
        register_weighted_key_spec: this.txFromJSON<Result<void>>
  }
}