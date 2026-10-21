//! Deployable Reflector-shaped oracle for the local end-to-end harness only.
//!
//! It exists so `scripts/e2e-local.sh` can exercise the resolver's price mode
//! on a hermetic network. It is deliberately *not* part of the testnet deploy
//! path: nobody should be able to commit a real market to a fake oracle.
//!
//! The layout of `OracleAsset` and `PriceData` matches
//! `contracts/resolver/src/lib.rs` (field order is part of the XDR contract).

#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Price(OracleAsset, u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidPrice = 3,
}

#[contract]
pub struct TestOracle;

#[contractimpl]
impl TestOracle {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Admin-only because a local oracle that anyone can move is not a useful
    /// auth fixture. The E2E harness calls this with the deployer key.
    pub fn set_price(
        env: Env,
        asset: OracleAsset,
        timestamp: u64,
        price: i128,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if price <= 0 {
            return Err(Error::InvalidPrice);
        }
        env.storage().persistent().set(
            &DataKey::Price(asset, timestamp),
            &PriceData { price, timestamp },
        );
        Ok(())
    }

    pub fn price(env: Env, asset: OracleAsset, timestamp: u64) -> Option<PriceData> {
        env.storage()
            .persistent()
            .get(&DataKey::Price(asset, timestamp))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Env, IntoVal,
    };

    fn setup() -> (Env, TestOracleClient<'static>, Address, Address) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let id = env.register(TestOracle, (admin.clone(),));
        (env.clone(), TestOracleClient::new(&env, &id), id, admin)
    }

    #[test]
    fn price_lookup_round_trips() {
        let (env, client, id, admin) = setup();
        let asset = OracleAsset::Other(Symbol::new(&env, "XLM"));
        env.mock_all_auths();
        client.set_price(&asset, &123u64, &2_100_i128);
        assert_eq!(
            TestOracleClient::new(&env, &id).price(&asset, &123u64),
            Some(PriceData {
                price: 2_100,
                timestamp: 123
            })
        );
        assert_eq!(client.price(&asset, &124u64), None);
        let _ = admin;
    }

    #[test]
    fn wrong_caller_cannot_set_price() {
        let (env, client, id, admin) = setup();
        let attacker = Address::generate(&env);
        let asset = OracleAsset::Other(Symbol::new(&env, "XLM"));
        env.set_auths(&[]);
        let result = client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &id,
                    fn_name: "set_price",
                    args: (asset.clone(), 123u64, 2_100_i128).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_price(&asset, &123u64, &2_100_i128);
        assert!(result.is_err());
        // The admin still can.
        env.set_auths(&[]);
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &id,
                    fn_name: "set_price",
                    args: (asset.clone(), 123u64, 2_100_i128).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_price(&asset, &123u64, &2_100_i128);
    }
}
