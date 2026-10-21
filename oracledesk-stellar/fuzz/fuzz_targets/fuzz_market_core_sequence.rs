#![no_main]

//! Structured state-machine fuzzer for market-core.
//!
//! Decodes a small byte-oriented program into create/buy/sell/resolve/void/
//! redeem/claim/sweep operations against a *natively* registered MarketCore,
//! then checks after every operation:
//!
//! * the AMM reserve invariant for every still-open market:
//!   `reserve_yes + Σ position.yes == sets_minted` (and the NO mirror);
//! * the contract's SEP-41 balance equals the harness's independently
//!   tracked inflow/outflow ledger.
//!
//! Native registration is deliberate (this target tests behaviour, not
//! metering); budget tests register wasm instead. Auth is mocked throughout:
//! auth is not what this target is testing.

use fpmm_fuzz::bounded;
use libfuzzer_sys::fuzz_target;
use market_core::{Category, MarketCore, MarketCoreArgs, MarketCoreClient, MarketStatus, Outcome};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, String,
};

const MAX_OPS: usize = 32;
const MAX_MARKETS: usize = 3;
const UNIT: i128 = 10_000_000; // 1 USDC in 7-decimal base units

#[derive(Debug)]
enum Op {
    Create {
        seed: u64,
        p: u16,
        close_in: u32,
    },
    Buy {
        who: u8,
        market: u8,
        yes: bool,
        amount: u64,
    },
    Sell {
        who: u8,
        market: u8,
        yes: bool,
        amount: u64,
    },
    Advance {
        secs: u32,
    },
    Resolve {
        market: u8,
        yes: bool,
    },
    Void {
        market: u8,
    },
    Redeem {
        who: u8,
        market: u8,
    },
    Claim {
        market: u8,
    },
    Sweep {
        market: u8,
    },
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }
    fn u8(&mut self) -> Option<u8> {
        let v = *self.data.get(self.at)?;
        self.at += 1;
        Some(v)
    }
    fn u16(&mut self) -> Option<u16> {
        let b = self.data.get(self.at..self.at + 2)?;
        self.at += 2;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        let b = self.data.get(self.at..self.at + 4)?;
        self.at += 4;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Option<u64> {
        let b = self.data.get(self.at..self.at + 8)?;
        self.at += 8;
        Some(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
}

fn parse(data: &[u8]) -> Vec<Op> {
    let mut r = Reader::new(data);
    let Some(count) = r.u8() else {
        return Vec::new();
    };
    let mut ops = Vec::new();
    for _ in 0..(count as usize).min(MAX_OPS) {
        let Some(tag) = r.u8() else { break };
        let op = match tag % 9 {
            0 => {
                let (Some(seed), Some(p), Some(close_in)) = (r.u64(), r.u16(), r.u32()) else {
                    break;
                };
                Op::Create { seed, p, close_in }
            }
            1 => {
                let (Some(who), Some(market), Some(yes), Some(amount)) =
                    (r.u8(), r.u8(), r.u8(), r.u64())
                else {
                    break;
                };
                Op::Buy {
                    who,
                    market,
                    yes: yes % 2 == 1,
                    amount,
                }
            }
            2 => {
                let (Some(who), Some(market), Some(yes), Some(amount)) =
                    (r.u8(), r.u8(), r.u8(), r.u64())
                else {
                    break;
                };
                Op::Sell {
                    who,
                    market,
                    yes: yes % 2 == 1,
                    amount,
                }
            }
            3 => {
                let Some(secs) = r.u32() else { break };
                Op::Advance { secs }
            }
            4 => {
                let (Some(market), Some(yes)) = (r.u8(), r.u8()) else {
                    break;
                };
                Op::Resolve {
                    market,
                    yes: yes % 2 == 1,
                }
            }
            5 => {
                let Some(market) = r.u8() else { break };
                Op::Void { market }
            }
            6 => {
                let (Some(who), Some(market)) = (r.u8(), r.u8()) else {
                    break;
                };
                Op::Redeem { who, market }
            }
            7 => {
                let Some(market) = r.u8() else { break };
                Op::Claim { market }
            }
            _ => {
                let Some(market) = r.u8() else { break };
                Op::Sweep { market }
            }
        };
        ops.push(op);
    }
    ops
}

struct Harness {
    env: Env,
    client: MarketCoreClient<'static>,
    contract_id: Address,
    token: Address,
    holders: [Address; 4], // creator + 3 traders
    markets: Vec<u64>,
    expected_balance: i128,
    paid_out: i128,
}

impl Harness {
    fn new() -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        // Auth is explicitly out of scope for this target.
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        env.ledger().set_timestamp(1_000);
        env.ledger().set_sequence_number(1);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver = Address::generate(&env);
        let creator = Address::generate(&env);
        let t1 = Address::generate(&env);
        let t2 = Address::generate(&env);
        let t3 = Address::generate(&env);

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let sac = StellarAssetClient::new(&env, &collateral.address());
        for h in [&creator, &t1, &t2, &t3] {
            sac.mint(h, &(1_000_000 * UNIT));
        }
        let contract_id = env.register(
            MarketCore,
            MarketCoreArgs::__constructor(
                &admin,
                &collateral.address(),
                &treasury,
                &resolver,
                &100u32,
                &10_000u32,
            ),
        );
        let client = MarketCoreClient::new(&env, &contract_id);
        let seed = 100 * UNIT;
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[1u8; 32]),
            &BytesN::from_array(&env, &[2u8; 32]),
            &String::from_str(&env, "ipfs://fuzz"),
            &Category::Crypto,
            &10_000,
            &seed,
            &5_000u32,
        );
        Self {
            env,
            client,
            contract_id,
            token: collateral.address(),
            holders: [creator, t1, t2, t3],
            markets: vec![market_id],
            expected_balance: seed,
            paid_out: 0,
        }
    }

    fn market_id(&self, index: u8) -> Option<u64> {
        self.markets
            .get(index as usize % self.markets.len().max(1))
            .copied()
    }

    fn holder(&self, index: u8) -> &Address {
        &self.holders[index as usize % self.holders.len()]
    }

    fn apply(&mut self, op: &Op) {
        match op {
            Op::Create { seed, p, close_in } => {
                if self.markets.len() >= MAX_MARKETS {
                    return;
                }
                let seed = 100 * UNIT + bounded(*seed as i128, 900 * UNIT);
                let p = 100 + (*p as u32 % 9_800);
                let close_time = self.env.ledger().timestamp() + 1 + (*close_in as u64 % 100_000);
                let creator = self.holders[0].clone();
                if let Ok(Ok(id)) = self.client.try_create_market(
                    &creator,
                    &BytesN::from_array(&self.env, &[3u8; 32]),
                    &BytesN::from_array(&self.env, &[4u8; 32]),
                    &String::from_str(&self.env, "ipfs://fuzz-created"),
                    &Category::Other,
                    &close_time,
                    &seed,
                    &p,
                ) {
                    self.markets.push(id);
                    self.expected_balance += seed;
                }
            }
            Op::Buy {
                who,
                market,
                yes,
                amount,
            } => {
                let Some(id) = self.market_id(*market) else {
                    return;
                };
                let amount = 1 + bounded(*amount as i128, 1_000 * UNIT);
                let outcome = if *yes { Outcome::Yes } else { Outcome::No };
                if let Ok(Ok(_)) =
                    self.client
                        .try_buy(self.holder(*who), &id, &outcome, &amount, &0i128)
                {
                    self.expected_balance += amount;
                }
            }
            Op::Sell {
                who,
                market,
                yes,
                amount,
            } => {
                let Some(id) = self.market_id(*market) else {
                    return;
                };
                let amount = 1 + bounded(*amount as i128, 1_000 * UNIT);
                let outcome = if *yes { Outcome::Yes } else { Outcome::No };
                if let Ok(Ok(_)) =
                    self.client
                        .try_sell(self.holder(*who), &id, &outcome, &amount, &i128::MAX)
                {
                    self.expected_balance -= amount;
                }
            }
            Op::Advance { secs } => {
                let now = self.env.ledger().timestamp();
                self.env
                    .ledger()
                    .set_timestamp(now + 1 + (*secs as u64 % 100_000));
            }
            Op::Resolve { market, yes } => {
                if let Some(id) = self.market_id(*market) {
                    let outcome = if *yes { Outcome::Yes } else { Outcome::No };
                    let _ = self.client.try_resolve(&id, &outcome);
                }
            }
            Op::Void { market } => {
                if let Some(id) = self.market_id(*market) {
                    let _ = self.client.try_void_market(&id);
                }
            }
            Op::Redeem { who, market } => {
                if let Some(id) = self.market_id(*market) {
                    if let Ok(Ok(payout)) = self.client.try_redeem(self.holder(*who), &id) {
                        self.expected_balance -= payout;
                        self.paid_out += payout;
                    }
                }
            }
            Op::Claim { market } => {
                if let Some(id) = self.market_id(*market) {
                    if let Ok(Ok(payout)) = self.client.try_claim_pool_remainder(&id) {
                        self.expected_balance -= payout;
                        self.paid_out += payout;
                    }
                }
            }
            Op::Sweep { market } => {
                if let Some(id) = self.market_id(*market) {
                    if let Ok(Ok(amount)) = self.client.try_sweep_fees(&id) {
                        self.expected_balance -= amount;
                        self.paid_out += amount;
                    }
                }
            }
        }
    }

    fn check(&self) {
        for id in &self.markets {
            let m = self.client.get_market(id);
            assert!(m.sets_minted >= 0);
            assert!(m.fees_accrued >= 0);
            if m.status == MarketStatus::Open {
                let mut yes = 0i128;
                let mut no = 0i128;
                for h in &self.holders {
                    let p = self.client.get_position(id, h);
                    assert!(p.yes >= 0 && p.no >= 0);
                    yes += p.yes;
                    no += p.no;
                }
                assert_eq!(
                    m.reserve_yes + yes,
                    m.sets_minted,
                    "market {id}: reserve_yes + positions != sets_minted"
                );
                assert_eq!(
                    m.reserve_no + no,
                    m.sets_minted,
                    "market {id}: reserve_no + positions != sets_minted"
                );
            }
        }
        let actual = TokenClient::new(&self.env, &self.token).balance(&self.contract_id);
        assert_eq!(
            actual, self.expected_balance,
            "token balance drifted: paid_out={} ",
            self.paid_out
        );
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        // `paid_out` is only used to explain a failure; keep it observable.
        let _ = self.paid_out;
    }
}

fn run(data: &[u8]) {
    let ops = parse(data);
    if ops.is_empty() {
        return;
    }
    let mut h = Harness::new();
    h.check();
    for op in &ops {
        h.apply(op);
        h.check();
    }
}

fuzz_target!(|data: &[u8]| run(data));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_short_inputs_are_ignored() {
        run(&[]);
        run(&[0]);
        run(&[1]);
    }

    #[test]
    fn seeded_sequence_runs() {
        // count=3: advance, buy, redeem (bytes are intentionally simple).
        let mut data = vec![3u8];
        data.extend_from_slice(&[3]);
        data.extend_from_slice(&10u32.to_le_bytes());
        data.extend_from_slice(&[1, 0, 0, 0]);
        data.extend_from_slice(&(UNIT as u64).to_le_bytes());
        data.extend_from_slice(&[6, 1, 0]);
        run(&data);
    }
}
