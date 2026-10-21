#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use fpmm_fuzz::widen;
use libfuzzer_sys::fuzz_target;
use market_core::math;

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);
    let Ok((a_raw, b_raw, c_raw, scale)) = <(u64, u64, u64, u8)>::arbitrary(&mut u) else {
        return;
    };
    let a = widen(a_raw, scale);
    let b = widen(b_raw, scale);
    let c = widen(c_raw, scale);

    let floor = math::mul_div_floor(a, b, c);
    let ceil = math::mul_div_ceil(a, b, c);
    match (floor, ceil) {
        (Ok(f), Ok(ce)) => {
            assert!(f <= ce);
            assert!(ce - f <= 1, "floor={f} ceil={ce}");
            if let Some(ab) = a.checked_mul(b) {
                if let Some(fc) = f.checked_mul(c) {
                    assert!(fc <= ab);
                }
                if let Some(cc) = ce.checked_mul(c) {
                    assert!(ab <= cc);
                }
                assert_eq!(ce - f, i128::from(ab % c != 0));
            }
        }
        // Validation is shared, so both must succeed or both must fail.
        (Err(e1), Err(e2)) => assert_eq!(e1, e2),
        _ => panic!("floor and ceil disagree on validity: {floor:?} {ceil:?}"),
    }
});
