// Pins the vendored cross-contract wasm to its committed sha256 (issue #58),
// so a stale copy is a compile error rather than a silent old interface.
include!("../../scripts/verify-wasm-hash.rs");

fn main() {
    verify_wasm_hash("market_core.wasm", "market_core.wasm.sha256");
}
