//! Deterministic, in-repo resource-budget regression tests.
//!
//! Every scenario registers the real contract **from wasm** (native
//! registration is not metered like wasm) and measures exactly one top-level
//! entrypoint call with `env.cost_estimate().resources()`. The committed
//! baseline lives in `docs/budgets/baseline.json`; set `BUDGET_UPDATE=1` (or
//! run `make budget-update`) to regenerate it intentionally.
//!
//! Run with:
//!     make build
//!     cargo test --manifest-path contracts/budget-tests/Cargo.toml -- --test-threads=1

#![allow(clippy::too_many_arguments)]

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub mod market_core_wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/market_core.wasm");
}
pub mod resolver_wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/resolver.wasm");
}
pub mod treasury_wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/treasury.wasm");
}
pub mod registry_wasm {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/reasoning_registry.wasm"
    );
}

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Metrics {
    pub cpu_insns: u64,
    pub mem_bytes: u64,
    pub read_entries: u32,
    pub write_entries: u32,
    pub read_bytes: u32,
    pub write_bytes: u32,
    pub events_bytes: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Tolerance {
    pub cpu_insns: f64,
    pub mem_bytes: f64,
    pub read_entries: f64,
    pub write_entries: f64,
    pub read_bytes: f64,
    pub write_bytes: f64,
    pub events_bytes: f64,
}

impl Default for Tolerance {
    fn default() -> Self {
        Self {
            // CPU/memory vary slightly with the host toolchain and optimizer.
            cpu_insns: 0.02,
            mem_bytes: 0.02,
            // Entry counts are structural: any change is a footprint change.
            read_entries: 0.0,
            write_entries: 0.0,
            read_bytes: 0.01,
            write_bytes: 0.01,
            events_bytes: 0.0,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Meta {
    pub soroban_sdk: String,
    pub rustc: String,
    pub stellar_cli: String,
    #[serde(default)]
    pub wasm_bytes: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Baseline {
    pub meta: Meta,
    pub tolerance: Tolerance,
    pub scenarios: BTreeMap<String, Metrics>,
}

impl Baseline {
    #[cfg(test)]
    fn empty() -> Self {
        Self {
            meta: Meta {
                soroban_sdk: "27.0.6".into(),
                ..Default::default()
            },
            tolerance: Tolerance::default(),
            scenarios: BTreeMap::new(),
        }
    }
}

/// Measure exactly one top-level contract invocation.
///
/// Setup (contract registration, minting, creating the market used by the
/// scenario) must happen before this is called: `resources()` reports the
/// last top-level invocation only.
pub fn measure<R, F: FnOnce() -> R>(env: &soroban_sdk::Env, f: F) -> Metrics {
    let mut budget = env.cost_estimate().budget();
    budget.reset_default();
    let _ = f();
    let r = env.cost_estimate().resources();
    Metrics {
        cpu_insns: r.instructions.max(0) as u64,
        mem_bytes: r.mem_bytes.max(0) as u64,
        // Live entries are reported separately from entries restored from
        // disk; both are part of the transaction footprint.
        read_entries: r.memory_read_entries.saturating_add(r.disk_read_entries),
        write_entries: r.write_entries,
        read_bytes: r.disk_read_bytes,
        write_bytes: r.write_bytes,
        events_bytes: r.contract_events_size_bytes,
    }
}

pub fn compile_time_rustc() -> String {
    // The committed baseline records the compiler used to produce it. The
    // test only skips CPU/memory comparison when the running compiler
    // differs, so toolchain churn is visible but not a hard failure.
    std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.split_whitespace().nth(1).map(ToString::to_string))
        .unwrap_or_else(|| "unknown".into())
}

pub fn stellar_cli_version() -> String {
    std::process::Command::new("stellar")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .unwrap_or_else(|| "unknown".into())
}

pub fn baseline_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/budgets/baseline.json")
}

pub fn wasm_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/wasm32v1-none/release")
        .join(name)
}

pub fn wasm_bytes() -> BTreeMap<String, u64> {
    [
        ("market_core.wasm", "market_core.wasm"),
        ("resolver.wasm", "resolver.wasm"),
        ("treasury.wasm", "treasury.wasm"),
        ("reasoning_registry.wasm", "reasoning_registry.wasm"),
    ]
    .into_iter()
    .map(|(label, file)| {
        let size = std::fs::metadata(wasm_path(file))
            .map(|m| m.len())
            .unwrap_or(0);
        (label.to_string(), size)
    })
    .collect()
}

pub fn load_baseline() -> Option<Baseline> {
    let text = std::fs::read_to_string(baseline_path()).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_baseline(b: &Baseline) {
    let path = baseline_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, serde_json::to_string_pretty(b).unwrap() + "\n").unwrap();
}
