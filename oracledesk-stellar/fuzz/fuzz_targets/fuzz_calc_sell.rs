#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use fpmm_fuzz::widen;
use libfuzzer_sys::fuzz_target;
use market_core::math;

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);
    let Ok((rs, ro, out, fee, scale)) = <(u64, u64, u64, u16, u8)>::arbitrary(&mut u) else {
        return;
    };
    let r_sold = widen(rs, scale);
    let r_other = widen(ro, scale);
    let collateral_out = widen(out, scale);
    let fee_bps = (fee as u32) % 10_000;

    if let Ok(q) = math::calc_sell(r_sold, r_other, collateral_out, fee_bps) {
        assert!(q.shares_in > 0);
        assert!(q.gross > collateral_out);
        assert_eq!(q.fee, q.gross - collateral_out);
        assert_eq!(q.new_reserve_other, r_other - q.gross);
        let expected_gross =
            math::mul_div_ceil(collateral_out, math::BPS, math::BPS - fee_bps as i128).unwrap();
        assert_eq!(q.gross, expected_gross);
        if let (Some(k0), Some(k1)) = (
            r_sold.checked_mul(r_other),
            q.new_reserve_sold.checked_mul(q.new_reserve_other),
        ) {
            assert!(k1 >= k0, "k decreased: {k0} -> {k1}");
        }
    }
});
