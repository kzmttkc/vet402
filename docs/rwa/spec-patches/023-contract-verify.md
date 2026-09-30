# SPEC patch 023: contract tests, hash material v2, key-less verification

Status: shipped on 2026-09-30 in `rwa-recon-0.3` (main `b9d9269c`), from branch
`rwa-w4-contract`. Merged into SPEC §9 (anchor) and §7 (facts routes).

## §9 Anchor: what changes

The contract does not change. `RwaAnchor` stays at
`0x1955137e7773f2459eb75fb88842026c6517c22d` on Robinhood Chain (4663), with no
owner, no upgrade path, one write function `anchor(bytes32,bytes32,uint32,uint64)`
and one counter `count()`. No read or view function is added (Decision 010).

### 9.x Hash material

The material is selected by the record's own `method_version`.

| method_version | methodVersion on chain | material |
|---|---|---|
| rwa-recon-0.1 | 1 | v1 |
| rwa-recon-0.2 | 2 | v1 |
| rwa-recon-0.3 | 3 | v2 |

v1: `keccak256(method_version \n address_lowercase \n as_of \n r1_status \n realized_usd_or_null)`.

v2: `keccak256(method_version \n address_lowercase \n as_of \n r1_status \n realized_usd_or_null \n facts_json_keccak)`,
where `facts_json_keccak` is `keccak256` of the UTF-8 bytes of the canonical
JSON of the whole facts record, written as a lower-case `0x` hex string.

Canonical JSON: object keys sorted by code unit at every depth, no whitespace,
arrays in order, strings, numbers and booleans as ECMAScript `JSON.stringify`
writes them, members whose value is `undefined` left out, the top-level `address`
lower-cased and nothing else changed. A non-finite number or a bigint is an error.

A method version missing from the table cannot be anchored
(`methodVersionNumber` throws). Adding a version means adding a row.

Why: v1 does not bind `tokens` or `evidence`, so two records with different
holdings or evidence could share one anchor. v2 binds every field. The 0.1 anchor
(tx `0x9b776d6a…72d7`) stays v1 and still verifies.

### 9.y Anchoring procedure

- New records are added to the existing contract with
  `packages/rwa/scripts/anchor.ts --mainnet --contract 0x1955…c22d`. A mainnet
  run without `--contract`, or with any other address, is refused. So is a
  contract whose runtime keccak256 differs from the pinned build.
- The script prints the plan and the gas estimate and sends only after the
  operator types `anchor`.
- Output: a new file `fixtures/rwa/anchors/<method_version>-<block>.json`, opened
  exclusively. `fixtures/rwa/anchor.json` is never written again.
- The operator runbook is in `docs/rwa/OPERATING.md`.

### 9.z Verification

A verifier accepts an anchor only if all of these hold:

1. The tx receipt has status success.
2. The `Anchored` log was emitted by `0x1955…c22d`. Logs from other addresses
   are ignored.
3. The runtime at that address hashes to
   `0x9032fa493b888a32b4773a18ae74814d4f492d136c4cd55ade593eb783f9b5b0`.
4. `anchoredBy` equals the operator the record names, or the one the reader requires.
5. `subject`, `factsHash`, `methodVersion` and `asOf` are recomputed from the JSON.

Two implementations exist and tests hold them to the same answers:
`packages/rwa/scripts/verify-record.mjs` (no dependencies, own keccak, Node 18+)
and `packages/rwa/scripts/anchor.ts --verify` (product code and viem).

### 9.w Contract tests

`packages/rwa/contracts` is a Foundry project (`foundry.toml`: solc 0.8.26,
optimizer 200 runs, EVM cancun, IPFS metadata). `forge test` covers reverts,
event fields, `count`, fuzz, invariants, the fixed selector list, the absence of
external-call, create and self-destruct opcodes, and a full bytecode match
(metadata tail included) against `packages/rwa/contracts/onchain.json`. CI runs it
in the `contracts` job.

Bytecode match, defined: "full" means keccak256 of `eth_getCode` equals keccak256
of the Foundry runtime including the CBOR metadata tail. "stripped" means the same
after removing the tail (its length is the last 2 bytes). Only a full match pins
the source text. On 2026-09-30 the match was full.

## §7 Facts routes: X-Facts-Hash

`GET /api/v1/rwa/facts/<address>` and `GET /api/v1/rwa/paid/facts/<address>`
send `X-Facts-Hash` on 200: the v2 hash of the returned record, whatever its
`method_version`. For `rwa-recon-0.3` and later it equals the value a v2 anchor
of that record carries. The JSON body is unchanged. Error responses and 402 carry
no such header. If the record cannot be hashed the header is left out and the
response is otherwise unchanged. On the paid route it is computed after the record
is built and before settle, and it never throws.

The header comes from vet402's server. It helps match a response to a log. It is
not a proof on its own.
