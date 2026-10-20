//! vet402 Stellar delivery roots.
//!
//! One Merkle root per UTC day over vet402's public purchase records on Stellar
//! (the `stellar:pubnet` rows of https://vet402.com/api/v1/observatory/export.csv).
//! Only the writer fixed at deploy time can commit, once per day, and a day's root
//! can never be replaced. Anyone can read a root and check a row against it.
//! The contract holds no funds.
//!
//! Tree (the same shape as vet402's Celo DeliveryRoots, with sha256):
//!   digest = sha256(canonical JSON of the row)   keys sorted, no whitespace
//!   leaf   = sha256(0x00 || digest)
//!   node   = sha256(0x01 || min(a, b) || max(a, b))
//!   an odd node at the end of a level is carried up unchanged.
#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Vec};

/// About 30 days of ledgers (5 s each). A root gets this much life when it is committed. After that it is kept
/// alive from outside (tools/commit-day.sh extends every committed day once a day, and anyone can extend it).
const ROOT_TTL_LEDGERS: u32 = 518_400;
const ROOT_TTL_THRESHOLD: u32 = ROOT_TTL_LEDGERS / 2;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Writer,
    Root(u32),
}

/// A committed day: the root, how many rows it covers, and the ledger it was written in.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DayRoot {
    pub root: BytesN<32>,
    pub count: u32,
    pub ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// This day already has a root. Roots are never replaced.
    AlreadyCommitted = 1,
    /// A root must cover at least one row.
    EmptyDay = 2,
}

#[contract]
pub struct StellarRoots;

fn hash_with_prefix(env: &Env, prefix: u8, parts: &[&BytesN<32>]) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.push_back(prefix);
    for p in parts {
        buf.append(&Bytes::from_array(env, &p.to_array()));
    }
    env.crypto().sha256(&buf).into()
}

#[contractimpl]
impl StellarRoots {
    /// The writer is fixed here and cannot be changed later.
    pub fn __constructor(env: Env, writer: Address) {
        env.storage().instance().set(&DataKey::Writer, &writer);
    }

    /// The address allowed to commit roots.
    pub fn writer(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Writer).unwrap()
    }

    /// Commit the root for `day` (days since 1970-01-01 UTC). Writer only, once per day.
    pub fn commit_root(env: Env, day: u32, root: BytesN<32>, count: u32) -> Result<(), Error> {
        let writer: Address = env.storage().instance().get(&DataKey::Writer).unwrap();
        writer.require_auth();
        if count == 0 {
            return Err(Error::EmptyDay);
        }
        let key = DataKey::Root(day);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyCommitted);
        }
        let entry = DayRoot { root: root.clone(), count, ledger: env.ledger().sequence() };
        env.storage().persistent().set(&key, &entry);
        env.storage().persistent().extend_ttl(&key, ROOT_TTL_THRESHOLD, ROOT_TTL_LEDGERS);
        env.storage().instance().extend_ttl(ROOT_TTL_THRESHOLD, ROOT_TTL_LEDGERS);
        #[allow(deprecated)]
        env.events().publish((symbol_short!("root"), day), (root, count));
        Ok(())
    }

    /// The committed root for `day`, if any.
    pub fn get_root(env: Env, day: u32) -> Option<DayRoot> {
        env.storage().persistent().get(&DataKey::Root(day))
    }

    /// True when `digest` (sha256 of the row's canonical JSON) is in the tree committed for `day`.
    /// `proof` lists the sibling of each level from the leaf up; levels where the node was
    /// carried up have no sibling and are skipped. False when the day has no root.
    pub fn verify(env: Env, day: u32, digest: BytesN<32>, proof: Vec<BytesN<32>>) -> bool {
        let committed: Option<DayRoot> = env.storage().persistent().get(&DataKey::Root(day));
        let Some(entry) = committed else {
            return false;
        };
        let mut node = hash_with_prefix(&env, 0x00, &[&digest]);
        for sibling in proof.iter() {
            node = if node.to_array() <= sibling.to_array() {
                hash_with_prefix(&env, 0x01, &[&node, &sibling])
            } else {
                hash_with_prefix(&env, 0x01, &[&sibling, &node])
            };
        }
        node == entry.root
    }
}

#[cfg(test)]
mod test;
