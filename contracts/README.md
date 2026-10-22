# vet402 contracts on Stellar (testnet)

Two Soroban contracts, built on 2026-10-20. Both run on the Stellar testnet and hold testnet tokens only.
Who wrote and who checked them: [AI_USAGE.md](AI_USAGE.md).
How they fit with the Stellar payer and the public record, and the planned work: [docs/stellar/technical-architecture.md](../docs/stellar/technical-architecture.md).

| Contract | Testnet id | What it does | Details |
|---|---|---|---|
| stellar-roots | `CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB` | One Merkle root per UTC day over vet402's public Stellar purchase records. Writer only, once per day. `verify` checks one row | [stellar-roots/README.md](stellar-roots/README.md) |
| stellar-escrow | `CBWZJ6IF25ZCPBSEP4YGZOJL4MS43Q2QDWN7PWRDP6AQKOXEXURUS7BG` | Releases a deposit to the payee named at deposit only when the row for that purchase shows settled, HTTP 200 and a schema match, else refunds the depositor after the deadline | [stellar-escrow/README.md](stellar-escrow/README.md) |

Transactions on testnet (2026-10-20):

- root commits: 2026-10-18 (3 rows) https://stellar.expert/explorer/testnet/tx/49cd6604e0dc6a19acc79aee8e80aea8a6ebad7896f10333fb9c3d6964267e33 and 2026-10-19 (17 rows) https://stellar.expert/explorer/testnet/tx/1df1de96620bc0208e8bd3989a3ee90ed87f4ed9955126c4a30c4ec01b401535. Later days are committed by a daily job.
- escrow release for a delivered row: https://stellar.expert/explorer/testnet/tx/488eac7623d699f16f06964f3ba2f641a07ee712607e4e0ddbcdd8263630d7bc
- escrow refund after the deadline for a failed row: https://stellar.expert/explorer/testnet/tx/c9d167d83982b62bb091bc8ebee15b3aedde10b5524e3e8d923530c25911cde2

Each README has the steps to check a row and to compare the deployed wasm with this source.
MIT.
