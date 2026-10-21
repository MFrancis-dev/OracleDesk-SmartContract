#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use fpmm_fuzz::widen;
use libfuzzer_sys::fuzz_target;
use market_core::math;

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);
    let Ok((seed_raw, p_raw, scale)) = <(u64, u16, u8)>::arbitrary(&mut u) else {
        return;
    };
    let seed = widen(seed_raw, scale);
    let p = (p_raw as u32) % 10_001;

    if let Ok(s) = math::seed_reserves(seed, p) {
        assert!(s.reserve_yes > 0);
        assert!(s.reserve_no > 0);
        assert!(s.creator_yes >= 0 && s.creator_no >= 0);
        assert!(s.creator_yes == 0 || s.creator_no == 0);
        assert_eq!(s.creator_yes + s.reserve_yes, seed);
        assert_eq!(s.creator_no + s.reserve_no, seed);
        if let Ok(price) = math::price_yes_bps(s.reserve_yes, s.reserve_no) {
            assert!(
                (price - p as i128).abs() <= 1,
                "p={p} price={price} reserves=({}, {})",
                s.reserve_yes,
                s.reserve_no
            );
        }
    }
});
