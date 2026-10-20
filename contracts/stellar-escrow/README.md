# vet402 Stellar escrow (Soroban)

A testnet sample that pays a seller only for a call the public record shows was delivered.

## Who deposits, and for what

The row a release checks is one of vet402's own purchases. When it says `settled`, vet402 has already paid that seller
the price over x402. So the deposit here is not the price. It is a separate payment on top of it, for example a fund
that rewards Stellar x402 sellers only for calls that vet402's public record shows were delivered.

In the code, `buyer` is the depositor (who gets a refund) and `seller` is the payee named at deposit (who gets a
release). The record does not name either one.

The contract holds the deposited tokens until release or refund. It is a sample for a test network and holds no real
funds. Do not put tokens that have value in it.

The stellar-roots contract is fixed in the constructor and never changes. Each `purchase_id` has one escrow, including after that escrow is closed.

Anyone can deposit first for a purchase_id, and the real buyer then gets DuplicatePurchase. The squatter can only pay a seller of their own choosing or get their own deposit back.

## Release rule

`release` pays `amount` of `token` to `seller` when every condition below holds.

- The escrow is open and the current ledger is at or before `deadline_ledger`.
- `row` is the canonical JSON bytes of one export row, and `roots.verify(day, sha256(row), proof)` is true.
- The row bytes contain `"purchase_id":"<the escrow purchase_id>"`. `deposit` accepts that id only when it is 1 to 64 bytes of `[0-9a-z-]`.
- The row bytes contain `"status":"settled"`, `"http_status_paid":"200"` and `"l2_reading":"match"`.

Anyone may call `release` and `refund`. A release pays only the seller stored at deposit. A refund pays only the buyer stored at deposit. After either call the escrow is closed and cannot pay again.

`refund` returns `amount` to the buyer once `deadline_ledger` has passed and the escrow is still open. On the deadline ledger itself, release still works and refund is refused.

## What this does not prove

The check reads the public record vet402 published. That record is one Merkle root per UTC day in the stellar-roots contract. A matching row means the record says the call settled, the paid HTTP status was 200, and the l2 reading was match.

It does not prove the seller returned a correct answer. It does not prove the buyer received that answer. It does not compare `amount` with `amount_units`. The buyer, the seller, and the token are whatever `deposit` stored. The row does not name them.

It trusts vet402's writer key. The stellar-roots writer can commit a root over any rows, so a release is only as good as the record that key wrote. The rows each root covers are published next to the contract (`contracts/stellar-roots/days/`) for anyone to rebuild and compare.

The field checks are exact `"key":"value"` byte sequences. They are sound for this record because the row is canonical JSON of string values, with keys sorted and no whitespace, and a quote inside a value is escaped. `deposit` accepts a `purchase_id` only when it is 1 to 64 bytes of `[0-9a-z-]`. vet402 purchase ids are lowercase UUIDs and fit that alphabet, so the id cannot contain a quote that would let one delivered row match two escrows. They do not parse JSON. They do not by themselves prove that the bytes are the committed row. The Merkle check does that.

## Testnet

- Contract: `CBWZJ6IF25ZCPBSEP4YGZOJL4MS43Q2QDWN7PWRDP6AQKOXEXURUS7BG`, reading the roots contract
  `CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB`. Wasm sha256
  `48417bb9da0df0cdc1c95365ade45272ee856a14379b1ffa74bff896d73774b5`. The token is testnet XLM. No real funds.
- Paid (2026-10-20): 1 XLM deposited for purchase `1fb9b73c-09bc-4de7-879c-5bae20a41841`
  (https://stellar.expert/explorer/testnet/tx/54f18e27f2f418ba2e65b41c1c36f3906faea50650a42c097199ca2a096639ab), then released
  to the seller with that purchase's row from `contracts/stellar-roots/days/2026-10-19.json` (settled, HTTP 200, l2 match)
  and its proof against the 2026-10-19 root
  (https://stellar.expert/explorer/testnet/tx/488eac7623d699f16f06964f3ba2f641a07ee712607e4e0ddbcdd8263630d7bc).
- Refused (2026-10-20): 1 XLM deposited for a purchase whose row says `settle_failed`
  (https://stellar.expert/explorer/testnet/tx/375a34f263b86ea3186fd4c433b06c29a091974a8365d4465bee08b9ada44811). `release`
  with that row and its valid proof returns `Error(Contract, #10)`, NotDelivered. After the deadline, `refund` returned it to
  the buyer (https://stellar.expert/explorer/testnet/tx/c9d167d83982b62bb091bc8ebee15b3aedde10b5524e3e8d923530c25911cde2).
- A row longer than 4096 bytes cannot be released (the search stops there). vet402's rows are under 700 bytes today. Such
  an escrow can only be refunded.

## Storage

Persistent entries are bumped by about 30 days of ledgers on deposit, release, and refund. An entry that archives can be restored. The tokens stay in the contract until a successful release or refund.

## Functions

| Function | Who | What |
|---|---|---|
| `__constructor(roots)` | deployer | fixes the stellar-roots contract |
| `roots()` | anyone | the stellar-roots contract fixed in the constructor |
| `deposit(buyer, token, seller, amount, purchase_id, deadline_ledger)` | buyer | locks `amount` and returns the escrow id. `purchase_id` must be 1 to 64 bytes of `[0-9a-z-]` |
| `release(id, day, row, proof)` | anyone | pays the seller when the record shows delivery |
| `refund(id)` | anyone | returns the tokens to the buyer after the deadline |
| `get(id)` | anyone | the escrow, if it was created, including a closed one |

## Build and test

```bash
cargo test
stellar contract build
```

MIT.
