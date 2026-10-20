# vet402 Stellar delivery roots (Soroban)

One Merkle root per UTC day over vet402's public purchase records on Stellar: the `stellar:pubnet` rows of
https://vet402.com/api/v1/observatory/export.csv. Only the writer fixed at deploy time can commit, once per day, and a
day's root can never be replaced. Anyone can read a root and check a row against it. The contract holds no funds.

The same tree as vet402's Celo DeliveryRoots (https://vet402.com/data/celo-roots/2026-10-16/README.txt), with sha256:

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
are committed again. The files here stay the same.

## Functions

| Function | Who | What |
|---|---|---|
| `commit_root(day: u32, root: BytesN<32>, count: u32)` | writer | the root of `day` (days since 1970-01-01 UTC). Once per day. `count` > 0 |
| `get_root(day: u32) -> Option<DayRoot>` | anyone | `{ root, count, ledger }` |
| `verify(day: u32, digest: BytesN<32>, proof: Vec<BytesN<32>>) -> bool` | anyone | true when the row with that digest is in the day's tree |
| `writer() -> Address` | anyone | the writer |

## Check a row yourself

Run these in `contracts/stellar-roots`. `--source` can be any testnet account address (G...). A read needs no key and sends nothing.

```bash
# 1. recompute the digest of a row from the row itself (here the first row of 2026-10-19)
node --input-type=module -e 'import {digestOf} from "./tools/roots.mjs"; import {readFileSync} from "node:fs"; const d = JSON.parse(readFileSync("days/2026-10-19.json", "utf8")); console.log(digestOf(d.rows[0].row).toString("hex"), JSON.stringify(d.rows[0].proof))'
# 2. ask the contract with that digest and the proof printed next to it (a read, nothing is sent)
stellar contract invoke --id CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB --network testnet --source <any testnet G address> --send=no \
  -- verify --day 20745 --digest <digest> --proof '<proof>'
# true. Change any field of the row, recompute the digest, and the same call returns false.
```

`day` is days since 1970-01-01 UTC (2026-10-19 is 20745). `get_root --day 20745` returns the root and row count. The contract does not check `count`. Count the rows in `days/<date>.json` to check it.

## How long a root stays

A committed root lives in persistent storage with a time to live. The contract instance and its wasm code have a time to live too. The daily job extends the instance, the code and every committed day each run (`stellar contract extend`, about 180 days, capped by the network). Anyone can extend or restore an entry too. An archived root makes `verify` fail until it is restored, so a `false` on an old day is worth one restore before reading it as a mismatch.

## Check the deployed code

The contract on testnet runs the wasm built from this directory:

```bash
stellar contract fetch --id CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB --network testnet -o onchain.wasm
stellar contract build      # rust 1.99.1 (rust-toolchain.toml), stellar-cli 28.1.0
shasum -a 256 onchain.wasm target/wasm32v1-none/release/vet402_stellar_roots.wasm
# both 4ff8e33502298ebf9bc4e8434a6c74fce26f96b7a9bc14c193739207390b0c07
```

## Build and test

```bash
cargo test                 # vectors from tools/roots.mjs, a separate Node implementation
stellar contract build     # target/wasm32v1-none/release/vet402_stellar_roots.wasm
node tools/day.mjs export.csv 2026-10-19 days/2026-10-19.json   # one day's snapshot and root
tools/commit-day.sh 2026-10-19   # build the snapshot from the live export and commit it (writer key only)
```

A job runs `tools/commit-day.sh` every hour. Before 14:30 UTC it does nothing. After that it commits every day from the one after the last committed day up to yesterday (UTC), once each, because vet402 re-checks settlements at 14:00 UTC. A day missed while the machine was off is picked up on the next run. A root on chain that differs from the snapshot stops it, is not marked committed, and is reported.

MIT.
