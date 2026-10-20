//! vet402 Stellar escrow.
//!
//! A testnet sample that pays a seller only for a call the public record shows
//! was delivered. The buyer locks tokens here. `release` pays the seller when
//! a row in the fixed stellar-roots contract proves delivery. `refund` returns
//! the tokens to the buyer after the deadline. The contract holds no real funds.
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Bytes, BytesN, Env, String, Vec,
};

/// About 30 days of ledgers (5 s each), the same horizon as stellar-roots.
/// Bumped on deposit, release, and refund so a testnet entry does not archive at once.
const ESCROW_TTL_LEDGERS: u32 = 518_400;
const ESCROW_TTL_THRESHOLD: u32 = ESCROW_TTL_LEDGERS / 2;

// `contains` searches only a haystack of this size or smaller. Export rows are
// a few hundred bytes. A longer row does not match.
const ROW_SEARCH_LIMIT: usize = 4096;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Roots,
    NextId,
    Escrow(u64),
    ByPurchase(String),
}

/// One locked payment. `open` is false after release or refund, and the record stays.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub buyer: Address,
    pub token: Address,
    pub seller: Address,
    pub amount: i128,
    pub purchase_id: String,
    pub deadline_ledger: u32,
    pub open: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// No escrow has this id.
    NotFound = 1,
    /// The escrow was already released or refunded.
    Closed = 2,
    /// `amount` must be greater than zero.
    BadAmount = 3,
    /// `deadline_ledger` must be after the current ledger.
    BadDeadline = 4,
    /// This purchase_id already has an escrow.
    DuplicatePurchase = 5,
    /// The deadline has passed, so release is refused.
    Expired = 6,
    /// The deadline has not passed, so refund is refused.
    NotYetExpired = 7,
    /// The row is not in the committed root for that day.
    NotInRecord = 8,
    /// The row is not for this escrow's purchase_id.
    WrongPurchase = 9,
    /// The record does not show status settled, HTTP 200, and l2_reading match.
    NotDelivered = 10,
    /// `purchase_id` must be 1 to 64 bytes of [0-9a-z-].
    BadPurchaseId = 11,
}

/// Emitted when a buyer locks tokens.
#[contractevent]
pub struct Deposit {
    #[topic]
    pub id: u64,
    pub buyer: Address,
    pub token: Address,
    pub seller: Address,
    pub amount: i128,
    pub purchase_id: String,
    pub deadline_ledger: u32,
}

/// Emitted when the seller is paid.
#[contractevent]
pub struct Release {
    #[topic]
    pub id: u64,
    pub seller: Address,
    pub amount: i128,
}

/// Emitted when the buyer is refunded.
#[contractevent]
pub struct Refund {
    #[topic]
    pub id: u64,
    pub buyer: Address,
    pub amount: i128,
}

/// Client for the fixed stellar-roots contract. Same `verify` signature as that contract.
/// The generated client is what calls `verify`. The trait item itself is not named again.
#[allow(dead_code)]
#[contractclient(name = "RootsClient")]
trait RootsContract {
    fn verify(env: Env, day: u32, digest: BytesN<32>, proof: Vec<BytesN<32>>) -> bool;
}

// Substring search over the raw row bytes.
//
// Sound for these fields because `row` is canonical JSON of string values.
// Keys are sorted, there is no whitespace, and every value is a JSON string.
// A quote inside a value is escaped as \", so the exact bytes "key":"value"
// occur only as that pair. The export key names are fixed, and the leading
// quote keeps a longer key such as "x_status" from matching "status".
// The closing quote keeps a longer value such as "settled_extra" or "2000"
// from matching "settled" or "200".
// `deposit` accepts a purchase_id only when it is 1 to 64 bytes of [0-9a-z-].
// vet402 purchase ids are lowercase UUIDs and fit that alphabet. The id
// therefore cannot contain a quote or any other JSON syntax. The needle
// "purchase_id":"<id>" stays one field and cannot match a longer span of
// another row, such as the span from purchase_id through request_body.
//
// This does not parse the row. It does not, on its own, prove the bytes are
// the row that was committed. roots.verify does that, since the digest is
// sha256 of these same bytes. It also does not prove the seller returned a
// correct answer, that the buyer received it, or that the escrow amount
// equals amount_units. It only shows that the published record contains
// these fields.
fn contains(hay: &Bytes, needle: &Bytes) -> bool {
    let n = hay.len();
    let m = needle.len();
    if m == 0 || m > n || n as usize > ROW_SEARCH_LIMIT {
        return false;
    }
    let mut hay_buf = [0u8; ROW_SEARCH_LIMIT];
    let mut needle_buf = [0u8; ROW_SEARCH_LIMIT];
    hay.copy_into_slice(&mut hay_buf[..n as usize]);
    needle.copy_into_slice(&mut needle_buf[..m as usize]);
    hay_buf[..n as usize]
        .windows(m as usize)
        .any(|window| window == &needle_buf[..m as usize])
}

// Lowercase UUID alphabet, 1 to 64 bytes. A quote in the id would let the
// purchase_id needle swallow later fields of a different row.
fn purchase_id_ok(purchase_id: &String) -> bool {
    let n = purchase_id.len();
    if n == 0 || n > 64 {
        return false;
    }
    let mut buf = [0u8; 64];
    purchase_id.copy_into_slice(&mut buf[..n as usize]);
    let mut i = 0usize;
    while i < n as usize {
        let byte = buf[i];
        let digit = byte >= b'0' && byte <= b'9';
        let lower = byte >= b'a' && byte <= b'z';
        if !digit && !lower && byte != b'-' {
            return false;
        }
        i += 1;
    }
    true
}

fn contains_literal(env: &Env, hay: &Bytes, literal: &[u8]) -> bool {
    contains(hay, &Bytes::from_slice(env, literal))
}

fn contains_purchase(env: &Env, hay: &Bytes, purchase_id: &String) -> bool {
    let mut needle = Bytes::from_slice(env, b"\"purchase_id\":\"");
    needle.append(&purchase_id.to_bytes());
    needle.push_back(b'"');
    contains(hay, &needle)
}

fn is_delivered(env: &Env, row: &Bytes) -> bool {
    contains_literal(env, row, b"\"status\":\"settled\"")
        && contains_literal(env, row, b"\"http_status_paid\":\"200\"")
        && contains_literal(env, row, b"\"l2_reading\":\"match\"")
}

fn bump(env: &Env, id: u64, purchase_id: &String) {
    env.storage().persistent().extend_ttl(
        &DataKey::Escrow(id),
        ESCROW_TTL_THRESHOLD,
        ESCROW_TTL_LEDGERS,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::ByPurchase(purchase_id.clone()),
        ESCROW_TTL_THRESHOLD,
        ESCROW_TTL_LEDGERS,
    );
    env.storage()
        .instance()
        .extend_ttl(ESCROW_TTL_THRESHOLD, ESCROW_TTL_LEDGERS);
}

fn load(env: &Env, id: u64) -> Result<Escrow, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Escrow(id))
        .ok_or(Error::NotFound)
}

fn load_open(env: &Env, id: u64) -> Result<Escrow, Error> {
    let escrow = load(env, id)?;
    if !escrow.open {
        return Err(Error::Closed);
    }
    Ok(escrow)
}

/// Mark the escrow closed, then move the tokens. The write happens first so a
/// token contract that calls back cannot be paid a second time. A failed transfer
/// rolls the write back with the transaction.
fn close_and_transfer(env: &Env, id: u64, escrow: &Escrow, to: &Address) {
    let mut closed = escrow.clone();
    closed.open = false;
    env.storage()
        .persistent()
        .set(&DataKey::Escrow(id), &closed);
    bump(env, id, &escrow.purchase_id);
    token::TokenClient::new(env, &escrow.token).transfer(
        &env.current_contract_address(),
        to,
        &escrow.amount,
    );
}

#[contract]
pub struct StellarEscrow;

#[contractimpl]
impl StellarEscrow {
    /// `roots` is the stellar-roots contract. It is fixed here and cannot be changed.
    pub fn __constructor(env: Env, roots: Address) {
        env.storage().instance().set(&DataKey::Roots, &roots);
        env.storage().instance().set(&DataKey::NextId, &1u64);
    }

    /// Lock `amount` of `token` from `buyer`, payable to `seller`, until `deadline_ledger`.
    /// One escrow per `purchase_id`. `purchase_id` must be 1 to 64 bytes of [0-9a-z-].
    /// Returns the new id.
    pub fn deposit(
        env: Env,
        buyer: Address,
        token: Address,
        seller: Address,
        amount: i128,
        purchase_id: String,
        deadline_ledger: u32,
    ) -> Result<u64, Error> {
        buyer.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        if deadline_ledger <= env.ledger().sequence() {
            return Err(Error::BadDeadline);
        }
        if !purchase_id_ok(&purchase_id) {
            return Err(Error::BadPurchaseId);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::ByPurchase(purchase_id.clone()))
        {
            return Err(Error::DuplicatePurchase);
        }
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap();
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        let escrow = Escrow {
            buyer: buyer.clone(),
            token: token.clone(),
            seller: seller.clone(),
            amount,
            purchase_id: purchase_id.clone(),
            deadline_ledger,
            open: true,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(id), &escrow);
        env.storage()
            .persistent()
            .set(&DataKey::ByPurchase(purchase_id.clone()), &id);
        bump(&env, id, &purchase_id);
        token::TokenClient::new(&env, &token).transfer(
            &buyer,
            &env.current_contract_address(),
            &amount,
        );
        Deposit {
            id,
            buyer,
            token,
            seller,
            amount,
            purchase_id,
            deadline_ledger,
        }
        .publish(&env);
        Ok(id)
    }

    /// Pay `seller` when the public record for `day` shows this purchase was delivered.
    /// Anyone may call this. Only `seller` receives the tokens.
    pub fn release(
        env: Env,
        id: u64,
        day: u32,
        row: Bytes,
        proof: Vec<BytesN<32>>,
    ) -> Result<(), Error> {
        let escrow = load_open(&env, id)?;
        if env.ledger().sequence() > escrow.deadline_ledger {
            return Err(Error::Expired);
        }
        let digest: BytesN<32> = env.crypto().sha256(&row).into();
        let roots: Address = env.storage().instance().get(&DataKey::Roots).unwrap();
        if !RootsClient::new(&env, &roots).verify(&day, &digest, &proof) {
            return Err(Error::NotInRecord);
        }
        if !contains_purchase(&env, &row, &escrow.purchase_id) {
            return Err(Error::WrongPurchase);
        }
        if !is_delivered(&env, &row) {
            return Err(Error::NotDelivered);
        }
        let seller = escrow.seller.clone();
        let amount = escrow.amount;
        close_and_transfer(&env, id, &escrow, &seller);
        Release { id, seller, amount }.publish(&env);
        Ok(())
    }

    /// Return `amount` to `buyer` after `deadline_ledger` if the escrow is still open.
    /// Anyone may call this. Only `buyer` receives the tokens.
    pub fn refund(env: Env, id: u64) -> Result<(), Error> {
        let escrow = load_open(&env, id)?;
        if env.ledger().sequence() <= escrow.deadline_ledger {
            return Err(Error::NotYetExpired);
        }
        let buyer = escrow.buyer.clone();
        let amount = escrow.amount;
        close_and_transfer(&env, id, &escrow, &buyer);
        Refund { id, buyer, amount }.publish(&env);
        Ok(())
    }

    /// The escrow, if this id was created. A closed escrow is still returned.
    pub fn get(env: Env, id: u64) -> Option<Escrow> {
        env.storage().persistent().get(&DataKey::Escrow(id))
    }

    /// The stellar-roots contract fixed in the constructor.
    pub fn roots(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Roots).unwrap()
    }
}

#[cfg(test)]
mod test;
