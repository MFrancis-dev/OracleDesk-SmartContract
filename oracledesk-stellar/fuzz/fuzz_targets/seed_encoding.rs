//! Byte encoders shared by `gen_corpus.rs` and documented in the target
//! files. This module is never compiled into a fuzz target; `gen_corpus.rs`
//! includes it with `#[path]`.

pub fn push_u8(out: &mut Vec<u8>, v: u8) {
    out.push(v);
}

pub fn push_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn push_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// `<u64, u64, u64, u16, u8>` for the buy/sell/inverse math targets.
pub fn math_seed(a: u64, b: u64, c: u64, fee: u16, scale: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(27);
    push_u64(&mut out, a);
    push_u64(&mut out, b);
    push_u64(&mut out, c);
    push_u16(&mut out, fee);
    push_u8(&mut out, scale);
    out
}

/// `<u64, u16, u8>` for `fuzz_seed_reserves`.
pub fn seed_seed(seed: u64, p: u16, scale: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(11);
    push_u64(&mut out, seed);
    push_u16(&mut out, p);
    push_u8(&mut out, scale);
    out
}

/// `<u64, u64, u64, u8>` for `fuzz_mul_div`.
pub fn mul_div_seed(a: u64, b: u64, c: u64, scale: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(25);
    push_u64(&mut out, a);
    push_u64(&mut out, b);
    push_u64(&mut out, c);
    push_u8(&mut out, scale);
    out
}

const CREATE: u8 = 0;
const BUY: u8 = 1;
const SELL: u8 = 2;
const ADVANCE: u8 = 3;
const RESOLVE: u8 = 4;
const VOID: u8 = 5;
const REDEEM: u8 = 6;
const CLAIM: u8 = 7;
const SWEEP: u8 = 8;

fn op_create(out: &mut Vec<u8>, seed: u64, p: u16, close_in: u32) {
    push_u8(out, CREATE);
    push_u64(out, seed);
    push_u16(out, p);
    push_u32(out, close_in);
}

fn op_buy(out: &mut Vec<u8>, who: u8, market: u8, yes: bool, amount: u64) {
    push_u8(out, BUY);
    push_u8(out, who);
    push_u8(out, market);
    push_u8(out, u8::from(yes));
    push_u64(out, amount);
}

fn op_sell(out: &mut Vec<u8>, who: u8, market: u8, yes: bool, amount: u64) {
    push_u8(out, SELL);
    push_u8(out, who);
    push_u8(out, market);
    push_u8(out, u8::from(yes));
    push_u64(out, amount);
}

fn op_advance(out: &mut Vec<u8>, secs: u32) {
    push_u8(out, ADVANCE);
    push_u32(out, secs);
}

fn op_resolve(out: &mut Vec<u8>, market: u8, yes: bool) {
    push_u8(out, RESOLVE);
    push_u8(out, market);
    push_u8(out, u8::from(yes));
}

fn op_void(out: &mut Vec<u8>, market: u8) {
    push_u8(out, VOID);
    push_u8(out, market);
}

fn op_redeem(out: &mut Vec<u8>, who: u8, market: u8) {
    push_u8(out, REDEEM);
    push_u8(out, who);
    push_u8(out, market);
}

fn op_claim(out: &mut Vec<u8>, market: u8) {
    push_u8(out, CLAIM);
    push_u8(out, market);
}

fn op_sweep(out: &mut Vec<u8>, market: u8) {
    push_u8(out, SWEEP);
    push_u8(out, market);
}

pub fn sequence_seed() -> Vec<(&'static str, Vec<u8>)> {
    let unit = 10_000_000u64;
    let mut out = Vec::new();

    let mut data = vec![3u8];
    op_buy(&mut data, 1, 0, true, 100 * unit);
    op_sell(&mut data, 1, 0, true, 50 * unit);
    op_redeem(&mut data, 1, 0);
    out.push(("buy_sell_redeem", data));

    let mut data = vec![3u8];
    op_advance(&mut data, 20_000);
    op_resolve(&mut data, 0, true);
    op_redeem(&mut data, 0, 0);
    out.push(("resolve_redeem", data));

    let mut data = vec![4u8];
    op_advance(&mut data, 20_000);
    op_void(&mut data, 0);
    op_claim(&mut data, 0);
    op_redeem(&mut data, 0, 0);
    out.push(("void_claim_redeem", data));

    let mut data = vec![4u8];
    op_create(&mut data, 100 * unit, 100, 1);
    op_buy(&mut data, 2, 1, false, unit);
    op_sweep(&mut data, 1);
    op_advance(&mut data, 1_000);
    out.push(("create_boundary", data));

    out
}
