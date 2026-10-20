# vet402 Stellar delivery roots (Soroban)

One Merkle root per UTC day over vet402's public purchase records on Stellar: the `stellar:pubnet` rows of
https://vet402.com/api/v1/observatory/export.csv. Only the writer fixed at deploy time can commit, once per day, and a
day's root can never be replaced. Anyone can read a root and check a row against it. The contract holds no funds.

The same shape as vet402's Solana observation roots and Celo DeliveryRoots, with sha256:

```
digest = sha256(canonical JSON of the row)      keys sorted, no whitespace, every value as the export prints it
leaf   = sha256(0x00 || digest)
node   = sha256(0x01 || min(a, b) || max(a, b))
an odd node at the end of a level is carried up unchanged
```

## Testnet

- Contract: `CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB`
  (https://stellar.expert/explorer/testnet/contract/CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB)
- Writer: `GDAUF55VCANOEOLIT547GRH2FEIALYIOWNUHSSGWSWWHVNO53V5DCJIW` (a testnet key, set at deploy, never changes)
- Days committed: `days/<YYYY-MM-DD>.json` holds the rows the root covers, each row's digest and proof, and the root.
  The export keeps changing (a `settle_claimed` row later becomes `settled`), so the snapshot is the record, not a
  later export.

The Stellar testnet is reset from time to time. After a reset the contract is deployed again and the days in `days/`
are committed again; the files here stay the same.

## Functions

| Function | Who | What |
|---|---|---|
| `commit_root(day: u32, root: BytesN<32>, count: u32)` | writer | the root of `day` (days since 1970-01-01 UTC). Once per day. `count` > 0 |
| `get_root(day: u32) -> Option<DayRoot>` | anyone | `{ root, count, ledger }` |
| `verify(day: u32, digest: BytesN<32>, proof: Vec<BytesN<32>>) -> bool` | anyone | true when the row with that digest is in the day's tree |
| `writer() -> Address` | anyone | the writer |

## Check a row yourself

```bash
# 1. pick a row from days/2026-10-19.json and recompute its digest from the row itself
node -e 'const {digestOf}=await import("./tools/roots.mjs");const d=JSON.parse(require("fs").readFileSync("days/2026-10-19.json"));console.log(digestOf(d.rows[0].row).toString("hex"))' --input-type=module
# 2. ask the contract (the proof is in the same file)
stellar contract invoke --id CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB --network testnet --source <any funded testnet key> \
  -- verify --day 20745 --digest <digest> --proof '["<proof[0]>", "<proof[1]>", ...]'
# true. Change any field of the row, recompute the digest, and the same call returns false.
```

## Build and test

```bash
cargo test                 # 6 tests; vectors from tools/roots.mjs, a separate Node implementation
stellar contract build     # target/wasm32v1-none/release/vet402_stellar_roots.wasm
node tools/day.mjs export.csv 2026-10-19 days/2026-10-19.json   # one day's snapshot and root
```

MIT.
