extern crate std;

use super::{
    contains_literal, contains_purchase, Deposit, Error, Escrow, Refund, Release, StellarEscrow,
    StellarEscrowClient, ROW_SEARCH_LIMIT,
};
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, Events, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{symbol_short, Address, Bytes, BytesN, Env, Event, String, Vec};
use vet402_stellar_roots::{StellarRoots, StellarRootsClient};

// Leaf is sha256(0x00 || digest). An inner node is sha256(0x01 || min || max).
// An odd node at the end of a level is carried up with no sibling in the proof.
// This is the same rule as tools/roots.mjs and the roots contract.

const NOW: u32 = 1_000;
const DAY: u32 = 20_745;
const MINT: i128 = 1_000;

// Printed by tools/roots.mjs for five digests. The roots contract tests use the same vectors.
const ROOT: &str = "c965d55c9678de6fbb8f3febffd545019f27b3d09bf573ffd559d0d76ca20641";
const ROWS: [(&str, &[&str]); 5] = [
    (
        "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
        &[
            "3e38799b9247cb753e5086660491e0fe23dbc9a5de802a7fb2aced20ff7b49c6",
            "129d3796dad55daa465dc7fffe6206a2fa40023b153f3a5410198de36a2dcb17",
            "a4bc6f4788d002d1ae90997f5fd133258f8da99cc796d008314246e6d0d2b51e",
        ],
    ),
    (
        "0ab1a6d394cd30195f0642b67ae1180c375ffadf5dd7f39c390668b5fdb6da93",
        &[
            "99f1dca178a56705d03d47e75719615122fb66199487917faa038d7bb5e791b8",
            "129d3796dad55daa465dc7fffe6206a2fa40023b153f3a5410198de36a2dcb17",
            "a4bc6f4788d002d1ae90997f5fd133258f8da99cc796d008314246e6d0d2b51e",
        ],
    ),
    (
        "caba9cb06ac77da7781b8bbd7e0700c58ea69bc7d8b12f0b6695a2af6ee6a6b3",
        &[
            "d573d7b6813c1461e56dc7e4e27e769f1c9c86ffaf5e1c474343132a7cd13b6c",
            "22c2c40b353c0eaff2f5820615282acff0eaebf67a4bab8f9031a22868ef080f",
            "a4bc6f4788d002d1ae90997f5fd133258f8da99cc796d008314246e6d0d2b51e",
        ],
    ),
    (
        "6c85e6eeb8afd62135daab1df50380e6b116293be22d4fdd91f1bcf11912df8e",
        &[
            "55ce739da37c82f3fa48134e9864f174fc9366f6bcd8b73282d2f5396eac5cf3",
            "22c2c40b353c0eaff2f5820615282acff0eaebf67a4bab8f9031a22868ef080f",
            "a4bc6f4788d002d1ae90997f5fd133258f8da99cc796d008314246e6d0d2b51e",
        ],
    ),
    (
        "a7a117c48df42890649712d49619c13afed4ec25f5748a10989e1ec140d09dc5",
        &["a8d3e30ebbc6a92841a3a5166ae7a59deeff2429ee4948f4b8182b99bed56bab"],
    ),
];

struct Fix {
    env: Env,
    buyer: Address,
    seller: Address,
    token_addr: Address,
    token: TokenClient<'static>,
    roots: StellarRootsClient<'static>,
    escrow: StellarEscrowClient<'static>,
}

fn fix() -> Fix {
    let env = Env::default();
    env.ledger().set_sequence_number(NOW);
    env.mock_all_auths();
    let writer = Address::generate(&env);
    let roots_id = env.register(StellarRoots, (writer,));
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token_addr = sac.address();
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    StellarAssetClient::new(&env, &token_addr).mint(&buyer, &MINT);
    let escrow_id = env.register(StellarEscrow, (roots_id.clone(),));
    Fix {
        token: TokenClient::new(&env, &token_addr),
        roots: StellarRootsClient::new(&env, &roots_id),
        escrow: StellarEscrowClient::new(&env, &escrow_id),
        env,
        buyer,
        seller,
        token_addr,
    }
}

fn b32(env: &Env, hex: &str) -> BytesN<32> {
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
        i += 1;
    }
    BytesN::from_array(env, &out)
}

fn hex_of(bytes: &BytesN<32>) -> std::string::String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = std::string::String::with_capacity(64);
    for byte in bytes.to_array() {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn hash_parts(env: &Env, prefix: u8, parts: &[BytesN<32>]) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.push_back(prefix);
    for part in parts {
        buf.append(&Bytes::from_array(env, &part.to_array()));
    }
    env.crypto().sha256(&buf).into()
}

fn merkle(
    env: &Env,
    digests: &[BytesN<32>],
) -> (BytesN<32>, std::vec::Vec<std::vec::Vec<BytesN<32>>>) {
    assert!(!digests.is_empty());
    let mut level: std::vec::Vec<BytesN<32>> = digests
        .iter()
        .map(|digest| hash_parts(env, 0x00, &[digest.clone()]))
        .collect();
    let mut proofs: std::vec::Vec<std::vec::Vec<BytesN<32>>> =
        digests.iter().map(|_| std::vec::Vec::new()).collect();
    let mut index: std::vec::Vec<usize> = (0..digests.len()).collect();
    while level.len() > 1 {
        let mut next = std::vec::Vec::new();
        let mut i = 0;
        while i < level.len() {
            if i + 1 == level.len() {
                next.push(level[i].clone());
            } else {
                let left = level[i].clone();
                let right = level[i + 1].clone();
                let (low, high) = if left.to_array() <= right.to_array() {
                    (left, right)
                } else {
                    (right, left)
                };
                next.push(hash_parts(env, 0x01, &[low, high]));
            }
            i += 2;
        }
        for r in 0..index.len() {
            let at = index[r];
            let sibling = if at % 2 == 0 { at + 1 } else { at - 1 };
            if sibling < level.len() {
                proofs[r].push(level[sibling].clone());
            }
            index[r] = at / 2;
        }
        level = next;
    }
    (level[0].clone(), proofs)
}

fn proof_of(env: &Env, siblings: &[BytesN<32>]) -> Vec<BytesN<32>> {
    let mut proof = Vec::new(env);
    for sibling in siblings {
        proof.push_back(sibling.clone());
    }
    proof
}

/// Canonical JSON of one export row. Keys are sorted and there is no whitespace.
fn canon(
    purchase_id: &str,
    status: &str,
    http_status_paid: &str,
    l2_reading: &str,
    latency_ms: &str,
) -> std::string::String {
    let mut out = std::string::String::new();
    out.push_str("{\"amount_units\":\"100\",\"attempted_at\":\"2026-10-19T00:00:00Z\",\"confirmed_units\":\"100\",\"held_reason\":\"\",\"http_status_paid\":\"");
    out.push_str(http_status_paid);
    out.push_str("\",\"l2_reading\":\"");
    out.push_str(l2_reading);
    out.push_str("\",\"l2_schema\":\"match\",\"latency_ms\":\"");
    out.push_str(latency_ms);
    out.push_str("\",\"network\":\"stellar:pubnet\",\"purchase_id\":\"");
    out.push_str(purchase_id);
    out.push_str("\",\"request_body\":\"declared\",\"request_body_sha256\":\"\",\"request_query\":\"empty\",\"request_query_sha256\":\"\",\"resource_key\":\"agent402.tools/api/moderate\",\"settlement_source\":\"seller_claim\",\"spent_units\":\"100\",\"status\":\"");
    out.push_str(status);
    out.push_str("\",\"tx_hash\":\"abc\"}");
    out
}

fn row_bytes(env: &Env, json: &str) -> Bytes {
    Bytes::from_slice(env, json.as_bytes())
}

fn commit(fix: &Fix, day: u32, rows: &[Bytes]) -> std::vec::Vec<Vec<BytesN<32>>> {
    let digests: std::vec::Vec<BytesN<32>> = rows
        .iter()
        .map(|row| fix.env.crypto().sha256(row).into())
        .collect();
    let (root, built) = merkle(&fix.env, &digests);
    fix.roots.commit_root(&day, &root, &(rows.len() as u32));
    let mut proofs = std::vec::Vec::new();
    for (i, siblings) in built.iter().enumerate() {
        let proof = proof_of(&fix.env, siblings);
        let digest: BytesN<32> = fix.env.crypto().sha256(&rows[i]).into();
        assert!(fix.roots.verify(&day, &digest, &proof));
        proofs.push(proof);
    }
    proofs
}

fn deposit_of(fix: &Fix, purchase_id: &str, amount: i128, deadline: u32) -> u64 {
    let pid = String::from_str(&fix.env, purchase_id);
    fix.escrow.deposit(
        &fix.buyer,
        &fix.token_addr,
        &fix.seller,
        &amount,
        &pid,
        &deadline,
    )
}

fn assert_balances(fix: &Fix, buyer: i128, contract: i128, seller: i128) {
    assert_eq!(fix.token.balance(&fix.buyer), buyer);
    assert_eq!(fix.token.balance(&fix.escrow.address), contract);
    assert_eq!(fix.token.balance(&fix.seller), seller);
}

fn contract_err<T>(result: Result<T, Result<Error, soroban_sdk::InvokeError>>) -> Error
where
    T: core::fmt::Debug,
{
    match result {
        Err(Ok(error)) => error,
        other => panic!("expected a contract error, got {other:?}"),
    }
}

#[test]
fn the_merkle_tree_matches_the_roots_reference_vectors() {
    let env = Env::default();
    env.mock_all_auths();
    let digests: std::vec::Vec<BytesN<32>> =
        ROWS.iter().map(|(digest, _)| b32(&env, digest)).collect();
    let (root, proofs) = merkle(&env, &digests);
    assert_eq!(hex_of(&root), ROOT);
    for (i, (_, expected)) in ROWS.iter().enumerate() {
        assert_eq!(proofs[i].len(), expected.len());
        for (got, want) in proofs[i].iter().zip(expected.iter()) {
            assert_eq!(hex_of(got), *want);
        }
    }
    let writer = Address::generate(&env);
    let roots_id = env.register(StellarRoots, (writer,));
    let roots = StellarRootsClient::new(&env, &roots_id);
    roots.commit_root(&DAY, &root, &5);
    for (i, (digest, _)) in ROWS.iter().enumerate() {
        assert!(roots.verify(&DAY, &b32(&env, digest), &proof_of(&env, &proofs[i])));
    }
}

#[test]
fn substring_checks_need_the_whole_pair() {
    let env = Env::default();
    let hay = Bytes::from_slice(
        &env,
        b"{\"l2_reading\":\"mismatch\",\"purchase_id\":\"p-ab\",\"status\":\"settled_extra\",\"http_status_paid\":\"2000\"}",
    );
    assert!(!contains_literal(&env, &hay, b"\"l2_reading\":\"match\""));
    assert!(!contains_literal(&env, &hay, b"\"purchase_id\":\"p-a\""));
    assert!(!contains_literal(&env, &hay, b"\"status\":\"settled\""));
    assert!(!contains_literal(
        &env,
        &hay,
        b"\"http_status_paid\":\"200\""
    ));
    assert!(contains_literal(&env, &hay, b"\"l2_reading\":\"mismatch\""));
    assert!(contains_literal(
        &env,
        &hay,
        b"\"status\":\"settled_extra\""
    ));
}

#[test]
fn release_pays_the_seller_exactly_the_amount_and_then_closes() {
    let fix = fix();
    let deadline = NOW + 40;
    let paid = row_bytes(&fix.env, &canon("p-pay", "settled", "200", "match", "10"));
    let decoy = row_bytes(&fix.env, &canon("p-other", "settled", "200", "match", "11"));
    let proofs = commit(&fix, DAY, &[paid.clone(), decoy]);
    let amount = 40_i128;
    let purchase_id = String::from_str(&fix.env, "p-pay");
    let id = fix.escrow.deposit(
        &fix.buyer,
        &fix.token_addr,
        &fix.seller,
        &amount,
        &purchase_id,
        &deadline,
    );
    assert_eq!(id, 1);

    let auths = fix.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, fix.buyer);
    let AuthorizedFunction::Contract((contract, name, _)) = &auths[0].1.function else {
        panic!("deposit auth is missing");
    };
    assert_eq!(contract, &fix.escrow.address);
    assert_eq!(name, &symbol_short!("deposit"));

    let deposited = Deposit {
        id,
        buyer: fix.buyer.clone(),
        token: fix.token_addr.clone(),
        seller: fix.seller.clone(),
        amount,
        purchase_id: purchase_id.clone(),
        deadline_ledger: deadline,
    };
    assert_eq!(
        fix.env
            .events()
            .all()
            .filter_by_contract(&fix.escrow.address),
        [deposited.to_xdr(&fix.env, &fix.escrow.address)]
    );
    assert_eq!(
        fix.escrow.get(&id),
        Some(Escrow {
            buyer: fix.buyer.clone(),
            token: fix.token_addr.clone(),
            seller: fix.seller.clone(),
            amount,
            purchase_id: purchase_id.clone(),
            deadline_ledger: deadline,
            open: true,
        })
    );
    assert_balances(&fix, MINT - amount, amount, 0);

    fix.escrow.release(&id, &DAY, &paid, &proofs[0]);
    let released = Release {
        id,
        seller: fix.seller.clone(),
        amount,
    };
    assert_eq!(
        fix.env
            .events()
            .all()
            .filter_by_contract(&fix.escrow.address),
        [released.to_xdr(&fix.env, &fix.escrow.address)]
    );
    assert_balances(&fix, MINT - amount, 0, amount);
    let closed = fix.escrow.get(&id).unwrap();
    assert!(!closed.open);
    assert_eq!(closed.amount, amount);
    assert_eq!(closed.seller, fix.seller);

    assert_eq!(
        contract_err(fix.escrow.try_release(&id, &DAY, &paid, &proofs[0])),
        Error::Closed
    );
    assert_eq!(contract_err(fix.escrow.try_refund(&id)), Error::Closed);
    assert_balances(&fix, MINT - amount, 0, amount);
    assert_eq!(
        contract_err(fix.escrow.try_deposit(
            &fix.buyer,
            &fix.token_addr,
            &fix.seller,
            &amount,
            &purchase_id,
            &deadline,
        )),
        Error::DuplicatePurchase
    );
    assert_balances(&fix, MINT - amount, 0, amount);
}

#[test]
fn release_refuses_a_row_that_is_not_a_delivered_call() {
    let fix = fix();
    let deadline = NOW + 40;
    let amount = 15_i128;
    let cases = [
        ("settle_failed", "200", "match", "21"),
        ("settled", "500", "match", "22"),
        ("settled", "200", "no_declaration", "23"),
        ("settled", "200", "mismatch", "24"),
        ("settled_extra", "200", "match", "25"),
        ("settled", "2000", "match", "26"),
        ("settled", "200", "match_partial", "28"),
    ];
    let mut jsons = std::vec::Vec::new();
    for (status, http, l2, latency) in cases {
        jsons.push(canon("p-same", status, http, l2, latency));
    }
    let good = canon("p-same", "settled", "200", "match", "27");
    jsons.push(good.clone());
    let rows: std::vec::Vec<Bytes> = jsons.iter().map(|json| row_bytes(&fix.env, json)).collect();
    let proofs = commit(&fix, DAY, &rows);
    let id = deposit_of(&fix, "p-same", amount, deadline);
    assert_balances(&fix, MINT - amount, amount, 0);

    for i in 0..cases.len() {
        assert_eq!(
            contract_err(fix.escrow.try_release(&id, &DAY, &rows[i], &proofs[i])),
            Error::NotDelivered
        );
        assert!(fix.escrow.get(&id).unwrap().open);
        assert_balances(&fix, MINT - amount, amount, 0);
    }

    let good_at = rows.len() - 1;
    fix.escrow
        .release(&id, &DAY, &rows[good_at], &proofs[good_at]);
    assert_balances(&fix, MINT - amount, 0, amount);
    assert!(!fix.escrow.get(&id).unwrap().open);
}

#[test]
fn release_refuses_the_wrong_purchase_a_bad_proof_another_day_or_a_changed_row() {
    let fix = fix();
    let deadline = NOW + 40;
    let amount = 28_i128;
    let row_a = canon("p-a", "settled", "200", "match", "10");
    let row_b = canon("p-ab", "settled", "200", "match", "11");
    let row_c = canon("p-c", "settled", "200", "match", "12");
    let bytes_a = row_bytes(&fix.env, &row_a);
    let bytes_b = row_bytes(&fix.env, &row_b);
    let bytes_c = row_bytes(&fix.env, &row_c);
    let changed = row_bytes(
        &fix.env,
        &row_a.replace("\"latency_ms\":\"10\"", "\"latency_ms\":\"99\""),
    );
    let proofs = commit(&fix, DAY, &[bytes_a.clone(), bytes_b.clone()]);
    let id = deposit_of(&fix, "p-a", amount, deadline);
    assert_balances(&fix, MINT - amount, amount, 0);

    assert_eq!(
        contract_err(fix.escrow.try_release(&id, &DAY, &bytes_b, &proofs[1])),
        Error::WrongPurchase
    );
    assert_eq!(
        contract_err(fix.escrow.try_release(&id, &DAY, &bytes_a, &proofs[1])),
        Error::NotInRecord
    );
    assert_eq!(
        contract_err(
            fix.escrow
                .try_release(&id, &(DAY + 1), &bytes_a, &proofs[0])
        ),
        Error::NotInRecord
    );
    assert_eq!(
        contract_err(fix.escrow.try_release(&id, &DAY, &bytes_c, &proofs[0])),
        Error::NotInRecord
    );
    assert_eq!(
        contract_err(fix.escrow.try_release(&id, &DAY, &changed, &proofs[0])),
        Error::NotInRecord
    );
    assert!(fix.escrow.get(&id).unwrap().open);
    assert_balances(&fix, MINT - amount, amount, 0);

    fix.escrow.release(&id, &DAY, &bytes_a, &proofs[0]);
    assert_balances(&fix, MINT - amount, 0, amount);
    assert_eq!(
        contract_err(fix.escrow.try_release(&id, &DAY, &bytes_a, &proofs[0])),
        Error::Closed
    );
}

#[test]
fn release_and_refund_follow_the_deadline() {
    let fix = fix();
    let deadline = NOW + 10;
    let amount_a = 40_i128;
    let amount_b = 25_i128;
    let row_a = row_bytes(&fix.env, &canon("p-a", "settled", "200", "match", "10"));
    let row_b = row_bytes(&fix.env, &canon("p-b", "settled", "200", "match", "11"));
    let proofs = commit(&fix, DAY, &[row_a.clone(), row_b.clone()]);
    let id_a = deposit_of(&fix, "p-a", amount_a, deadline);
    let id_b = deposit_of(&fix, "p-b", amount_b, deadline);
    assert_eq!(id_b, id_a + 1);
    assert_balances(&fix, MINT - amount_a - amount_b, amount_a + amount_b, 0);

    assert_eq!(
        contract_err(fix.escrow.try_refund(&id_a)),
        Error::NotYetExpired
    );
    assert_balances(&fix, MINT - amount_a - amount_b, amount_a + amount_b, 0);

    fix.env.ledger().set_sequence_number(deadline);
    assert_eq!(
        contract_err(fix.escrow.try_refund(&id_a)),
        Error::NotYetExpired
    );
    fix.escrow.release(&id_a, &DAY, &row_a, &proofs[0]);
    assert_balances(&fix, MINT - amount_a - amount_b, amount_b, amount_a);

    fix.env.ledger().set_sequence_number(deadline + 1);
    assert_eq!(
        contract_err(fix.escrow.try_release(&id_b, &DAY, &row_b, &proofs[1])),
        Error::Expired
    );
    assert_balances(&fix, MINT - amount_a - amount_b, amount_b, amount_a);
    assert!(fix.escrow.get(&id_b).unwrap().open);

    fix.escrow.refund(&id_b);
    let refunded = Refund {
        id: id_b,
        buyer: fix.buyer.clone(),
        amount: amount_b,
    };
    assert_eq!(
        fix.env
            .events()
            .all()
            .filter_by_contract(&fix.escrow.address),
        [refunded.to_xdr(&fix.env, &fix.escrow.address)]
    );
    assert_balances(&fix, MINT - amount_a, 0, amount_a);
    assert!(!fix.escrow.get(&id_b).unwrap().open);
    assert_eq!(contract_err(fix.escrow.try_refund(&id_b)), Error::Closed);
    assert_eq!(
        contract_err(fix.escrow.try_release(&id_b, &DAY, &row_b, &proofs[1])),
        Error::Closed
    );
    assert_balances(&fix, MINT - amount_a, 0, amount_a);
}

#[test]
fn deposit_refuses_a_bad_amount_a_past_deadline_and_a_duplicate_purchase() {
    let fix = fix();
    let deadline = NOW + 20;
    let purchase_id = String::from_str(&fix.env, "p-one");
    assert_balances(&fix, MINT, 0, 0);

    assert_eq!(
        contract_err(fix.escrow.try_deposit(
            &fix.buyer,
            &fix.token_addr,
            &fix.seller,
            &0,
            &purchase_id,
            &deadline,
        )),
        Error::BadAmount
    );
    assert_eq!(
        contract_err(fix.escrow.try_deposit(
            &fix.buyer,
            &fix.token_addr,
            &fix.seller,
            &-1,
            &purchase_id,
            &deadline,
        )),
        Error::BadAmount
    );
    assert_eq!(
        contract_err(fix.escrow.try_deposit(
            &fix.buyer,
            &fix.token_addr,
            &fix.seller,
            &10,
            &purchase_id,
            &NOW,
        )),
        Error::BadDeadline
    );
    assert_eq!(
        contract_err(fix.escrow.try_deposit(
            &fix.buyer,
            &fix.token_addr,
            &fix.seller,
            &10,
            &purchase_id,
            &(NOW - 1),
        )),
        Error::BadDeadline
    );
    assert_balances(&fix, MINT, 0, 0);
    assert_eq!(fix.escrow.get(&1), None);
    assert_eq!(
        contract_err(
            fix.escrow
                .try_release(&1, &DAY, &Bytes::new(&fix.env), &Vec::new(&fix.env))
        ),
        Error::NotFound
    );
    assert_eq!(contract_err(fix.escrow.try_refund(&1)), Error::NotFound);

    let id = fix.escrow.deposit(
        &fix.buyer,
        &fix.token_addr,
        &fix.seller,
        &10,
        &purchase_id,
        &deadline,
    );
    assert_eq!(id, 1);
    assert_balances(&fix, MINT - 10, 10, 0);
    assert_eq!(
        contract_err(fix.escrow.try_deposit(
            &fix.buyer,
            &fix.token_addr,
            &fix.seller,
            &10,
            &purchase_id,
            &deadline,
        )),
        Error::DuplicatePurchase
    );
    assert_balances(&fix, MINT - 10, 10, 0);
    let second = deposit_of(&fix, "p-two", 7, deadline);
    assert_eq!(second, 2);
    assert_balances(&fix, MINT - 17, 17, 0);
    assert!(fix.escrow.get(&1).unwrap().open);
    assert_eq!(fix.escrow.get(&1).unwrap().purchase_id, purchase_id);
    assert_eq!(fix.escrow.get(&99), None);
}

#[test]
fn deposit_needs_the_buyer_auth() {
    // mock_all_auths records the tree. The root must be this buyer authorizing
    // deposit on the escrow contract. Without that require_auth the token
    // transfer is not tied to a root authorization, and the host panics with
    // an auth error before these assertions run.
    let fix = fix();
    let purchase_id = String::from_str(&fix.env, "p-auth");
    let id = fix.escrow.deposit(
        &fix.buyer,
        &fix.token_addr,
        &fix.seller,
        &10,
        &purchase_id,
        &(NOW + 5),
    );
    assert_eq!(id, 1);
    let auths = fix.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, fix.buyer);
    let AuthorizedFunction::Contract((contract, name, _)) = &auths[0].1.function else {
        panic!("deposit auth is missing");
    };
    assert_eq!(contract, &fix.escrow.address);
    assert_eq!(name, &symbol_short!("deposit"));
}

#[test]
fn deposit_refuses_a_quoted_purchase_id() {
    let fix = fix();
    let deadline = NOW + 20;
    assert_eq!(fix.escrow.roots(), fix.roots.address);
    let bad = [
        "p-a\",\"request_body\":\"declared",
        "",
        "A",
        "p_a",
        "p a",
    ];
    for id in bad {
        assert_eq!(
            contract_err(fix.escrow.try_deposit(
                &fix.buyer,
                &fix.token_addr,
                &fix.seller,
                &10,
                &String::from_str(&fix.env, id),
                &deadline,
            )),
            Error::BadPurchaseId,
            "{id}"
        );
    }
    let long = "a".repeat(65);
    assert_eq!(
        contract_err(fix.escrow.try_deposit(
            &fix.buyer,
            &fix.token_addr,
            &fix.seller,
            &10,
            &String::from_str(&fix.env, &long),
            &deadline,
        )),
        Error::BadPurchaseId
    );
    assert_balances(&fix, MINT, 0, 0);
    assert_eq!(fix.escrow.get(&1), None);

    let uuid = "1fb9b73c-09bc-4de7-879c-5bae20a41841";
    let id = deposit_of(&fix, uuid, 10, deadline);
    assert_eq!(id, 1);
    assert_eq!(
        fix.escrow.get(&id).unwrap().purchase_id,
        String::from_str(&fix.env, uuid)
    );
    let wide = "c".repeat(64);
    let id_wide = deposit_of(&fix, &wide, 10, deadline);
    assert_eq!(id_wide, 2);
    assert_eq!(fix.escrow.get(&id_wide).unwrap().purchase_id.len(), 64);
    assert_balances(&fix, MINT - 20, 20, 0);
}

#[test]
fn one_delivered_row_cannot_pay_two_escrows() {
    let fix = fix();
    let deadline = NOW + 40;
    let amount = 30_i128;
    let attack = "p-a\",\"request_body\":\"declared";
    let row = row_bytes(&fix.env, &canon("p-a", "settled", "200", "match", "10"));
    let proofs = commit(&fix, DAY, &[row.clone()]);
    let attack_id = String::from_str(&fix.env, attack);
    let real_id = String::from_str(&fix.env, "p-a");
    // The delivered row of p-a contains the needle the attack id would build.
    assert!(contains_purchase(&fix.env, &row, &real_id));
    assert!(contains_purchase(&fix.env, &row, &attack_id));

    let id = deposit_of(&fix, "p-a", amount, deadline);
    assert_eq!(
        contract_err(fix.escrow.try_deposit(
            &fix.buyer,
            &fix.token_addr,
            &fix.seller,
            &amount,
            &attack_id,
            &deadline,
        )),
        Error::BadPurchaseId
    );
    assert_eq!(fix.escrow.get(&(id + 1)), None);
    assert_balances(&fix, MINT - amount, amount, 0);

    fix.escrow.release(&id, &DAY, &row, &proofs[0]);
    assert_balances(&fix, MINT - amount, 0, amount);
    assert!(!fix.escrow.get(&id).unwrap().open);
    assert_eq!(
        contract_err(fix.escrow.try_release(&id, &DAY, &row, &proofs[0])),
        Error::Closed
    );
    assert_balances(&fix, MINT - amount, 0, amount);
}

#[test]
fn a_row_longer_than_the_search_limit_does_not_match() {
    let env = Env::default();
    let needle = b"\"status\":\"settled\"";
    let mut within = std::vec![b'x'; ROW_SEARCH_LIMIT];
    let start = ROW_SEARCH_LIMIT - needle.len();
    within[start..].copy_from_slice(needle);
    assert!(contains_literal(
        &env,
        &Bytes::from_slice(&env, &within),
        needle
    ));
    let mut over = std::vec![b'x'; ROW_SEARCH_LIMIT + 1];
    over[..needle.len()].copy_from_slice(needle);
    assert!(!contains_literal(
        &env,
        &Bytes::from_slice(&env, &over),
        needle
    ));
}

#[test]
fn a_key_that_only_ends_with_a_checked_name_does_not_count() {
    // Canonical rows with extra keys whose names end in "status" and "purchase_id". Without the opening quote in the
    // needles, `x_status":"settled"` would pass for status and `x_purchase_id":"p-y"` for the purchase.
    let fix = fix();
    let deadline = NOW + 40;
    let amount = 9_i128;
    let status_trick = r#"{"http_status_paid":"200","l2_reading":"match","purchase_id":"p-x","status":"settle_failed","x_status":"settled"}"#;
    let purchase_trick = r#"{"http_status_paid":"200","l2_reading":"match","purchase_id":"p-other","status":"settled","x_purchase_id":"p-y"}"#;
    let rows = [row_bytes(&fix.env, status_trick), row_bytes(&fix.env, purchase_trick)];
    let proofs = commit(&fix, DAY, &rows);
    let x = deposit_of(&fix, "p-x", amount, deadline);
    let y = deposit_of(&fix, "p-y", amount, deadline);
    assert_eq!(contract_err(fix.escrow.try_release(&x, &DAY, &rows[0], &proofs[0])), Error::NotDelivered);
    assert_eq!(contract_err(fix.escrow.try_release(&y, &DAY, &rows[1], &proofs[1])), Error::WrongPurchase);
    assert_balances(&fix, MINT - 2 * amount, 2 * amount, 0);
}

#[test]
fn a_purchase_id_with_only_a_quote_is_refused() {
    let fix = fix();
    let deadline = NOW + 40;
    for bad in ["p-a\"", "\"", "p\"a"] {
        let r = fix.escrow.try_deposit(
            &fix.buyer,
            &fix.token_addr,
            &fix.seller,
            &5,
            &soroban_sdk::String::from_str(&fix.env, bad),
            &deadline,
        );
        assert_eq!(contract_err(r), Error::BadPurchaseId, "{bad}");
    }
}
