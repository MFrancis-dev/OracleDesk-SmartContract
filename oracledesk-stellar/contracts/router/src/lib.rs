#![no_std]

//! Stateless compound-flow router (#64).
//!
//! Creating a resolvable market takes two transactions today: `create_market`
//! on market-core (or `agent_create_market` on the treasury) followed by a
//! `register_*_spec` reveal on the resolver. A crash between them (or a
//! placeholder commitment) leaves a market that trades but can never be
//! resolved — the only escape is `guardian_void_market`.
//!
//! This contract runs those flows atomically in a single invocation. It is
//! deliberately **not** a privileged intermediary:
//!
//! * no admin, no roles;
//! * holds no funds between calls — collateral moves directly from the creator
//!   to market-core;
//! * every downstream action is authorized by the end user's own signature, so
//!   the auth tree is exactly what the user signed (the router is named as an
//!   intermediate invoker, never as an authority).
//!
//! The primary flow, [`Router::create_and_reveal_signers`] /
//! [`Router::create_and_reveal_price`], computes the reveal's commitment hash
//! **before** calling market-core and passes that same hash as the commitment,
//! so a malformed reveal can never create an unresolvable market.
//! [`Router::buy_and_publish_trace`] buys shares and records a reasoning trace
//! in the same transaction, so a trace can't be skipped after a trade.

#[cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, xdr::ToXdr, Address, Bytes,
    BytesN, Env, String,
};

// market-core, resolver and reasoning-registry are imported from their compiled
// wasm rather than as Cargo path dependencies: a direct dependency would merge
// their `#[no_mangle]` entrypoints into this crate's wasm and collide on the
// shared `__constructor` symbol. `contractimport!` only reads the interface
// spec. See docs/adr/0002-cross-contract-calls.md.
#[allow(clippy::too_many_arguments)]
mod market_core {
    soroban_sdk::contractimport!(file = "market_core.wasm");
}
use market_core::{Category, Client as MarketCoreClient, Outcome};

#[allow(clippy::too_many_arguments)]
mod resolver {
    soroban_sdk::contractimport!(file = "resolver.wasm");
}
use resolver::{Client as ResolverClient, ResolutionSpec, ResolutionSpecV2};

#[allow(clippy::too_many_arguments)]
mod reasoning_registry {
    soroban_sdk::contractimport!(file = "reasoning_registry.wasm");
}
use reasoning_registry::Client as RegistryClient;

/// Domain tag prepended to a V2 spec before hashing. Must match the resolver's
/// `SPEC_DOMAIN` so a locally-computed commitment equals the one the resolver
/// would accept. See `docs/adr/0004-spec-versioning.md`.
const SPEC_DOMAIN: &[u8] = b"oracledesk:resolution-spec";
const SPEC_V2_VERSION: u32 = 2;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    /// A `price`/`signers` config failed the resolver's own validation rules.
    InvalidConfig = 2,
    /// The envelope named a different network or market-core.
    DomainMismatch = 3,
    /// `buy_and_publish_trace` was given empty trace content.
    InvalidTrace = 4,
    /// The router was asked to reveal a rule variant it does not support.
    UnsupportedRule = 5,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketCreatedAndRevealed {
    #[topic]
    pub market_id: u64,
    pub creator: Address,
    pub spec_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoughtAndPublishedTrace {
    #[topic]
    pub market_id: u64,
    pub trader: Address,
    pub trace_id: u64,
}

/// The address book the router calls into. Without it, every entrypoint would
/// have to take the downstream contract addresses from the caller, letting
/// anyone point the router at a hostile "resolver". With it, the router is
/// stateless apart from this one instance value.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouterConfig {
    pub market_core: Address,
    pub resolver: Address,
    pub reasoning_registry: Option<Address>,
}

#[contracttype]
enum DataKey {
    Config,
}

#[contract]
pub struct Router;

#[contractimpl]
impl Router {
    /// Stores the address book once, at deploy time. There is no privileged
    /// role and the values never change, so this is not admin-gated.
    pub fn __constructor(
        env: Env,
        market_core: Address,
        resolver: Address,
        reasoning_registry: Option<Address>,
    ) {
        env.storage().instance().set(
            &DataKey::Config,
            &RouterConfig {
                market_core,
                resolver,
                reasoning_registry,
            },
        );
        env.storage()
            .instance()
            .extend_ttl(30 * 17_280, 60 * 17_280);
    }

    /// Creates a market and reveals its signer-mode rule in one transaction.
    /// The commitment is computed from `spec_v2` locally and passed to
    /// market-core, so the reveal necessarily matches.
    #[allow(clippy::too_many_arguments)]
    pub fn create_and_reveal_signers(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
        spec_v2: ResolutionSpecV2,
    ) -> Result<u64, Error> {
        Self::create_and_reveal(
            &env,
            creator,
            question_hash,
            meta_uri,
            category,
            close_time,
            seed_amount,
            initial_yes_bps,
            &spec_v2,
        )
    }

    /// See [`Router::create_and_reveal_signers`] — same flow, price rule.
    #[allow(clippy::too_many_arguments)]
    pub fn create_and_reveal_price(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
        spec_v2: ResolutionSpecV2,
    ) -> Result<u64, Error> {
        Self::create_and_reveal(
            &env,
            creator,
            question_hash,
            meta_uri,
            category,
            close_time,
            seed_amount,
            initial_yes_bps,
            &spec_v2,
        )
    }

    /// Reveals a spec the creator committed to in a previous transaction
    /// (ADR 0001's commit-now/reveal-later path). Kept here so a creator can
    /// use one contract for both the atomic and the deferred flows.
    pub fn reveal_spec(env: Env, market_id: u64, spec_v2: ResolutionSpecV2) -> Result<(), Error> {
        let cfg = Self::load_config(&env)?;
        Self::verify_envelope(&env, &cfg, &spec_v2)?;
        Self::validate_rule(&spec_v2.rule)?;
        ResolverClient::new(&env, &cfg.resolver).register_spec_v2(&market_id, &spec_v2);
        Ok(())
    }

    /// Buys `outcome` shares through market-core and publishes a reasoning
    /// trace through the reasoning registry in the same transaction, so a
    /// trace cannot be skipped after a trade. The registry must be configured.
    #[allow(clippy::too_many_arguments)]
    pub fn buy_and_publish_trace(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
        action: String,
        trace_hash: BytesN<32>,
        ipfs_cid: String,
    ) -> Result<u64, Error> {
        if action.is_empty() || ipfs_cid.is_empty() {
            return Err(Error::InvalidTrace);
        }
        let cfg = Self::load_config(&env)?;
        let registry = cfg
            .reasoning_registry
            .clone()
            .ok_or(Error::NotInitialized)?;

        // Root authorization: market-core's `buy` and the registry's
        // `publish_trace` both call `require_auth` for `trader` deeper in the
        // tree, which needs the trader's signature anchored at the root.
        trader.require_auth();

        let shares = MarketCoreClient::new(&env, &cfg.market_core).buy(
            &trader,
            &market_id,
            &outcome,
            &collateral_in,
            &min_shares_out,
        );
        debug_assert!(shares >= 0);

        let trace_id = RegistryClient::new(&env, &registry).publish_trace(
            &trader,
            &market_id,
            &action,
            &trace_hash,
            &ipfs_cid,
        );
        BoughtAndPublishedTrace {
            market_id,
            trader,
            trace_id,
        }
        .publish(&env);
        Ok(trace_id)
    }

    // ----- views ----------------------------------------------------------

    pub fn config(env: Env) -> Result<RouterConfig, Error> {
        Self::load_config(&env)
    }

    // ----- internals ------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn create_and_reveal(
        env: &Env,
        creator: Address,
        question_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
        spec_v2: &ResolutionSpecV2,
    ) -> Result<u64, Error> {
        let cfg = Self::load_config(env)?;
        Self::verify_envelope(env, &cfg, spec_v2)?;
        Self::validate_rule(&spec_v2.rule)?;

        // Establish the creator's authorization at the router (the root
        // invocation). market-core's `create_market` calls `require_auth`
        // further down the call tree, which alone would be a non-root auth and
        // be rejected; requiring it here ties the whole tree to the creator's
        // signature.
        creator.require_auth();

        // The commitment is derived from the exact reveal we will register, so
        // the two can never disagree. Computing it locally (rather than trusting
        // a caller-supplied hash) is what makes the reveal authoritative.
        let resolution_hash = spec_v2_hash(env, spec_v2);

        let market_id = MarketCoreClient::new(env, &cfg.market_core).create_market(
            &creator,
            &question_hash,
            &resolution_hash,
            &meta_uri,
            &category,
            &close_time,
            &seed_amount,
            &initial_yes_bps,
        );

        ResolverClient::new(env, &cfg.resolver).register_spec_v2(&market_id, spec_v2);

        MarketCreatedAndRevealed {
            market_id,
            creator,
            spec_hash: resolution_hash,
        }
        .publish(env);
        Ok(market_id)
    }

    fn verify_envelope(
        env: &Env,
        cfg: &RouterConfig,
        spec: &ResolutionSpecV2,
    ) -> Result<(), Error> {
        if spec.version != SPEC_V2_VERSION || spec.salt == BytesN::from_array(env, &[0; 32]) {
            return Err(Error::InvalidConfig);
        }
        if spec.network_id != env.ledger().network_id() || spec.market_core != cfg.market_core {
            return Err(Error::DomainMismatch);
        }
        Ok(())
    }

    fn validate_rule(rule: &ResolutionSpec) -> Result<(), Error> {
        let ok = match rule {
            ResolutionSpec::Price(cfg) => cfg.threshold >= 0 && cfg.max_staleness != 0,
            ResolutionSpec::Signers(cfg) => {
                !cfg.signers.is_empty()
                    && cfg.threshold != 0
                    && cfg.threshold <= cfg.signers.len()
                    && cfg.dispute_window != 0
            }
            // The router only runs the two primary flows; the resolver still
            // accepts the other variants through its own entrypoints.
            _ => return Err(Error::UnsupportedRule),
        };
        if ok {
            Ok(())
        } else {
            Err(Error::InvalidConfig)
        }
    }

    fn load_config(env: &Env) -> Result<RouterConfig, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }
}

/// Hash a V2 commitment is checked against: `sha256(SPEC_DOMAIN || XDR(spec))`.
/// Mirrors `resolver::spec_v2_hash` (which is a plain fn, not a contract
/// entrypoint, so it is not part of the imported interface spec).
fn spec_v2_hash(env: &Env, spec: &ResolutionSpecV2) -> BytesN<32> {
    let mut preimage = Bytes::from_slice(env, SPEC_DOMAIN);
    preimage.append(&spec.clone().to_xdr(env));
    env.crypto().sha256(&preimage).into()
}

#[cfg(test)]
mod test;
