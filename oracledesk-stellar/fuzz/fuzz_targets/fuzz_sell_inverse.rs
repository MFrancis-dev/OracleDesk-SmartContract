#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use fpmm_fuzz::inverse;
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

    // 1. The inverse never panics and, when it succeeds, returns a gross
    //    strictly inside the pool.
    if let Ok(gross) = inverse::gross_for_shares(r_sold, r_other, 1, fee_bps) {
        assert!(gross > 0 && gross < r_other);
    }

    // 2. A real forward sell can be inverted back within one share of
    //    rounding. This is the property the Python/TS mirrors assert.
    let Ok(fwd) = math::calc_sell(r_sold, r_other, collateral_out, fee_bps) else {
        return;
    };
    let Ok(est) = inverse::collateral_out_for_shares(r_sold, r_other, fwd.shares_in, fee_bps)
    else {
        return;
    };
    if est <= 0 {
        return;
    }
    let Ok(back) = math::calc_sell(r_sold, r_other, est, fee_bps) else {
        panic!("inverse produced collateral_out={est} that calc_sell rejects");
    };
    assert!(
        back.shares_in <= fwd.shares_in + 1,
        "forward={fwd:?} back={back:?}"
    );
});
