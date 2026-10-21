#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use fpmm_fuzz::widen;
use libfuzzer_sys::fuzz_target;
use market_core::math;

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);
    let Ok((rb, ro, amt, fee, scale)) = <(u64, u64, u64, u16, u8)>::arbitrary(&mut u) else {
        return;
    };
    let r_bought = widen(rb, scale);
    let r_other = widen(ro, scale);
    let collateral_in = widen(amt, scale);
    // Deliberately wider than the contract's 1_000 bps cap so the pure math
    // is explored outside its production domain too.
    let fee_bps = (fee as u32) % 10_001;

    if let Ok(q) = math::calc_buy(r_bought, r_other, collateral_in, fee_bps) {
        assert!(q.shares_out > 0);
        assert!(q.fee >= 0);
        assert_eq!(q.net, collateral_in - q.fee);
        assert!(q.net > 0);
        assert_eq!(q.new_reserve_other, r_other + q.net);
        let expected_fee = math::mul_div_ceil(collateral_in, fee_bps as i128, math::BPS).unwrap();
        assert_eq!(q.fee, expected_fee);
        if let (Some(k0), Some(k1)) = (
            r_bought.checked_mul(r_other),
            q.new_reserve_bought.checked_mul(q.new_reserve_other),
        ) {
            assert!(k1 >= k0, "k decreased: {k0} -> {k1}");
        }
        if let Ok((protocol, lp)) = math::split_fee(q.fee, fee_bps.min(10_000)) {
            assert_eq!(protocol + lp, q.fee);
        }
    }
});
