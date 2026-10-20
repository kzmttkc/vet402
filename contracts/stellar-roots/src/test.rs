extern crate std;

use super::{DayRoot, Error, StellarRoots, StellarRootsClient};
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{vec, Address, BytesN, Env, IntoVal, Vec};

// Printed by tools/roots.mjs (the separate Node implementation) for
// [{"a":1},{"b":2},{"c":3},{"d":4},{"e":5}]: five rows, so the last node is carried up twice.
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

const DAY: u32 = 20_745; // 2026-10-19

fn b32(env: &Env, hex: &str) -> BytesN<32> {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    BytesN::from_array(env, &out)
}

fn proof(env: &Env, hexes: &[&str]) -> Vec<BytesN<32>> {
    let mut v = Vec::new(env);
    for h in hexes {
        v.push_back(b32(env, h));
    }
    v
}

fn setup() -> (Env, Address, StellarRootsClient<'static>) {
    let env = Env::default();
    let writer = Address::generate(&env);
    let id = env.register(StellarRoots, (writer.clone(),));
    let client = StellarRootsClient::new(&env, &id);
    (env, writer, client)
}

#[test]
fn writer_commits_once_and_the_root_reads_back() {
    let (env, writer, client) = setup();
    env.mock_all_auths();
    assert_eq!(client.writer(), writer);
    assert_eq!(client.get_root(&DAY), None);
    client.commit_root(&DAY, &b32(&env, ROOT), &5);
    // The call was authorized by the writer, not by anyone else (auths() reads the last call).
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, writer);
    let got: DayRoot = client.get_root(&DAY).unwrap();
    assert_eq!(got.root, b32(&env, ROOT));
    assert_eq!(got.count, 5);
}

#[test]
fn a_day_cannot_be_committed_twice() {
    let (env, _writer, client) = setup();
    env.mock_all_auths();
    client.commit_root(&DAY, &b32(&env, ROOT), &5);
    let again = client.try_commit_root(&DAY, &b32(&env, ROWS[0].0), &1);
    assert_eq!(again, Err(Ok(Error::AlreadyCommitted)));
    assert_eq!(client.get_root(&DAY).unwrap().root, b32(&env, ROOT));
}

#[test]
fn an_empty_day_is_refused() {
    let (env, _writer, client) = setup();
    env.mock_all_auths();
    assert_eq!(client.try_commit_root(&DAY, &b32(&env, ROOT), &0), Err(Ok(Error::EmptyDay)));
    assert_eq!(client.get_root(&DAY), None);
}

#[test]
fn someone_other_than_the_writer_cannot_commit() {
    let (env, _writer, client) = setup();
    let stranger = Address::generate(&env);
    let root = b32(&env, ROOT);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "commit_root",
            args: (DAY, root.clone(), 5u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    // The refusal is the missing authorization, not anything else.
    let err = client.try_commit_root(&DAY, &root, &5).unwrap_err().unwrap_err();
    assert_eq!(err, soroban_sdk::InvokeError::Abort);
    assert_eq!(client.get_root(&DAY), None);
}

#[test]
fn every_row_verifies_with_its_proof_from_the_node_implementation() {
    let (env, _writer, client) = setup();
    env.mock_all_auths();
    client.commit_root(&DAY, &b32(&env, ROOT), &5);
    for (digest, p) in ROWS.iter() {
        assert!(client.verify(&DAY, &b32(&env, digest), &proof(&env, p)), "row {digest}");
    }
}

#[test]
fn a_changed_row_a_wrong_proof_or_another_day_does_not_verify() {
    let (env, _writer, client) = setup();
    env.mock_all_auths();
    client.commit_root(&DAY, &b32(&env, ROOT), &5);
    // A changed row: the digest of another row with the first row's proof.
    assert!(!client.verify(&DAY, &b32(&env, ROWS[1].0), &proof(&env, ROWS[0].1)));
    // One flipped bit in the digest.
    let mut flipped = b32(&env, ROWS[0].0).to_array();
    flipped[31] ^= 1;
    assert!(!client.verify(&DAY, &BytesN::from_array(&env, &flipped), &proof(&env, ROWS[0].1)));
    // A proof with a level missing.
    assert!(!client.verify(&DAY, &b32(&env, ROWS[0].0), &proof(&env, &ROWS[0].1[..2])));
    // The root itself is not a row.
    assert!(!client.verify(&DAY, &b32(&env, ROOT), &vec![&env]));
    // A day with no root.
    assert!(!client.verify(&(DAY + 1), &b32(&env, ROWS[0].0), &proof(&env, ROWS[0].1)));
}

#[test]
fn a_one_row_day_verifies_with_an_empty_proof() {
    // One row: the root is the leaf itself, sha256(0x00 || digest), and the proof is empty.
    let (env, _writer, client) = setup();
    env.mock_all_auths();
    let digest = b32(&env, ROWS[0].0);
    let mut buf = soroban_sdk::Bytes::new(&env);
    buf.push_back(0x00);
    buf.append(&soroban_sdk::Bytes::from_array(&env, &digest.to_array()));
    let leaf: BytesN<32> = env.crypto().sha256(&buf).into();
    client.commit_root(&DAY, &leaf, &1);
    assert!(client.verify(&DAY, &digest, &vec![&env]));
    // The leaf hash itself is not a row.
    assert!(!client.verify(&DAY, &leaf, &vec![&env]));
}
