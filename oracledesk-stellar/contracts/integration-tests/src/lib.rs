//! This crate ships no contract. Its tests drive several contracts together
//! from the wasm artifacts in `wasm/`: see `tests/treasury_queue.rs`,
//! `tests/auth_matrix.rs`, `tests/system_model.rs` and
//! `tests/treasury_caps_exhaustive/`. `world` is the shared deployed world.

#[allow(clippy::too_many_arguments)]
pub mod market_core {
    soroban_sdk::contractimport!(file = "wasm/market_core.wasm");
}
#[allow(clippy::too_many_arguments)]
pub mod resolver {
    soroban_sdk::contractimport!(file = "wasm/resolver.wasm");
}
#[allow(clippy::too_many_arguments)]
pub mod treasury {
    soroban_sdk::contractimport!(file = "wasm/treasury.wasm");
}
#[allow(clippy::too_many_arguments)]
pub mod reasoning_registry {
    soroban_sdk::contractimport!(file = "wasm/reasoning_registry.wasm");
}

pub mod world;
