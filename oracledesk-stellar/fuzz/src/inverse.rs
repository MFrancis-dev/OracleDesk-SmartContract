//! Rust port of the off-chain "sell N shares" inverse.
//!
//! Mirrors `model/fpmm_model.py::gross_for_shares` /
//! `collateral_out_for_shares` and `agents/core/fpmm.ts`'s BigInt versions.
//! This lives in the fuzz crate (not on-chain) so the target can compare it
//! with `market_core::math::calc_sell` without changing the contract.

pub const BPS: i128 = 10_000;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum InverseError {
    Overflow,
    InvalidInput,
    InsufficientLiquidity,
}

/// Integer square root by Newton's method (same algorithm as the TS mirror).
pub fn isqrt(n: i128) -> Result<i128, InverseError> {
    if n < 0 {
        return Err(InverseError::InvalidInput);
    }
    if n < 2 {
        return Ok(n);
    }
    let mut x = n;
    let mut y = x / 2 + x % 2; // (x + 1) / 2 without overflowing at i128::MAX
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    Ok(x)
}

/// Solve `(shares + r_sold - x)(r_other - x) = r_sold * r_other` for the
/// smaller root, returning the number of complete sets (`gross`) to burn.
pub fn gross_for_shares(
    r_sold: i128,
    r_other: i128,
    shares_in: i128,
    fee_bps: u32,
) -> Result<i128, InverseError> {
    if shares_in <= 0 || r_sold <= 0 || r_other <= 0 || fee_bps as i128 >= BPS {
        return Err(InverseError::InvalidInput);
    }
    let a = shares_in
        .checked_add(r_sold)
        .ok_or(InverseError::Overflow)?;
    let b = a.checked_add(r_other).ok_or(InverseError::Overflow)?;
    let b_sq = b.checked_mul(b).ok_or(InverseError::Overflow)?;
    let four_rs = 4i128
        .checked_mul(
            r_other
                .checked_mul(shares_in)
                .ok_or(InverseError::Overflow)?,
        )
        .ok_or(InverseError::Overflow)?;
    let disc = b_sq.checked_sub(four_rs).ok_or(InverseError::Overflow)?;
    if disc < 0 {
        return Err(InverseError::InsufficientLiquidity);
    }
    let root = isqrt(disc)?;
    let gross = (b - root) / 2;
    if gross <= 0 || gross >= r_other {
        return Err(InverseError::InsufficientLiquidity);
    }
    Ok(gross)
}

/// `collateral_out` for selling `shares_in` shares, rounded down so the
/// on-chain `sell` does not need more shares than requested.
pub fn collateral_out_for_shares(
    r_sold: i128,
    r_other: i128,
    shares_in: i128,
    fee_bps: u32,
) -> Result<i128, InverseError> {
    let gross = gross_for_shares(r_sold, r_other, shares_in, fee_bps)?;
    let numerator = gross
        .checked_mul(BPS - fee_bps as i128)
        .ok_or(InverseError::Overflow)?;
    Ok(numerator / BPS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use market_core::math;

    #[test]
    fn inverse_matches_python_example() {
        // 1000/1000, sell 100 collateral out -> 212 shares; inverse -> 100.
        assert_eq!(gross_for_shares(1_000, 1_000, 212, 0).unwrap(), 100);
        assert_eq!(
            collateral_out_for_shares(1_000, 1_000, 212, 0).unwrap(),
            100
        );
    }

    #[test]
    fn isqrt_exact_squares() {
        for n in [0i128, 1, 2, 3, 4, 9, 15, 16, 17, 10_000, 10_000_000_000] {
            let r = isqrt(n).unwrap();
            assert!(r * r <= n && (r + 1) * (r + 1) > n);
        }
    }

    #[test]
    fn isqrt_max_discriminant() {
        // (3e15)^2 ~ 9e30, the largest discriminant the inverse can see for
        // in-domain reserves and share counts.
        let n = 9_000_000_000_000_000_000_000_000_000_000i128;
        let r = isqrt(n).unwrap();
        assert!(r * r <= n && (r + 1) * (r + 1) > n);
    }

    #[test]
    fn inverse_round_trips_forward_sells() {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            x >> 33
        };
        let mut checked = 0;
        for _ in 0..2_000 {
            let rs = 1_000_000 + (next() % 1_000_000_000) as i128;
            let ro = 1_000_000 + (next() % 1_000_000_000) as i128;
            let fee = (next() % 300) as u32;
            let out = 1 + (next() % (ro / 4) as u64) as i128;
            let Ok(fwd) = math::calc_sell(rs, ro, out, fee) else {
                continue;
            };
            let Ok(est) = collateral_out_for_shares(rs, ro, fwd.shares_in, fee) else {
                continue;
            };
            if est <= 0 {
                continue;
            }
            let back = math::calc_sell(rs, ro, est, fee).unwrap();
            assert!(
                back.shares_in <= fwd.shares_in + 1,
                "forward={fwd:?} back={back:?}"
            );
            checked += 1;
        }
        assert!(checked > 500);
    }
}
