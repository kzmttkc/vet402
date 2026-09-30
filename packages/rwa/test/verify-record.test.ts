// The key-less checker (packages/rwa/scripts/verify-record.mjs) repeats the
// hashing of packages/rwa/anchor.ts with its own keccak so a reader can audit one
// file. These tests hold the two to the same answers, and run the full check
// offline against the real 0.1 anchor receipt (fixtures/rwa/anchor-receipt.json).
//
// Run from the repo root: npx tsx --test packages/rwa/test/verify-record.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatTransactionReceipt, keccak256 as viemKeccak } from "viem";
import { canonicalFactsJson, factsHash, RWA_ANCHOR_ADDRESS, subjectHash } from "../anchor";
import type { RwaFacts } from "../facts";
import { verifyRecord } from "../scripts/anchor";
import * as cli from "../scripts/verify-record.mjs";

const root = process.cwd();
const anchorRecord = JSON.parse(readFileSync(join(root, "fixtures/rwa/anchor.json"), "utf8"));
const live = JSON.parse(readFileSync(join(root, "fixtures/rwa/anchor-receipt.json"), "utf8"));
const factsA = JSON.parse(readFileSync(join(root, "fixtures/rwa/A.facts.json"), "utf8")) as RwaFacts;
const onchain = JSON.parse(readFileSync(join(root, "packages/rwa/contracts/onchain.json"), "utf8"));
const row = (r: { rows: cli.Row[] }, name: string) => r.rows.find((x) => x.name === name)?.detail ?? "";

test("the script's keccak equals viem's on every length around the 136-byte block", () => {
  const lengths = [0, 1, 31, 32, 33, 134, 135, 136, 137, 271, 272, 273, 1000, 5000];
  for (let i = 0; i < 40; i++) lengths.push(Math.floor(Math.random() * 3000));
  for (const n of lengths) {
    const b = new Uint8Array(randomBytes(n));
    assert.equal(cli.keccak256(b), viemKeccak(b), `length ${n}`);
  }
  assert.equal(cli.keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(cli.keccak256("Anchored(bytes32,bytes32,uint32,uint64,address)"), cli.ANCHORED_TOPIC);
});

test("the script's constants are the ones the contract tests and anchor.ts pin", () => {
  assert.equal(cli.RWA_ANCHOR_ADDRESS, RWA_ANCHOR_ADDRESS);
  assert.equal(cli.RWA_ANCHOR_ADDRESS, onchain.address);
  assert.equal(cli.RUNTIME_KECCAK, onchain.runtime_keccak256);
  assert.equal(cli.keccak256(cli.hexToBytes(live.code)), onchain.runtime_keccak256, "fixture code is the pinned code");
});

test("canonical JSON and the commitment agree with anchor.ts, for v1 and v2 records", () => {
  for (const mv of ["rwa-recon-0.1", "rwa-recon-0.2", "rwa-recon-0.3"]) {
    const f = { ...factsA, method_version: mv, address: "0xE9B08727131E34010b34006c660D4c1B436EC25f" } as RwaFacts;
    assert.equal(cli.canonicalJson({ ...f, address: f.address.toLowerCase() }), canonicalFactsJson(f), mv);
    const c = cli.commitment(f);
    assert.equal(c.hash, factsHash(f), mv);
    assert.equal(c.material, mv === "rwa-recon-0.3" ? 2 : 1, mv);
  }
  assert.equal(cli.subjectHash(factsA.address), subjectHash(factsA.address));
});

test("the real 0.1 anchor verifies offline: contract, code, operator, subject, hash, version, as_of", () => {
  const r = cli.checkRecord({ record: anchorRecord, receipt: live.receipt, code: live.code });
  assert.equal(r.ok, true, JSON.stringify(r.rows, null, 1));
  assert.deepEqual(
    r.rows.map((x) => x.name),
    ["tx status", "contract", "contract code", "anchoredBy", "subject", "factsHash", "record facts_hash", "methodVersion", "asOf"],
  );
  assert.equal(r.commitment?.material, 1);
});

test("a bare facts JSON verifies too, and says the operator was not compared unless asked", () => {
  const r = cli.checkRecord({ record: anchorRecord.facts, receipt: live.receipt, code: live.code });
  assert.equal(r.ok, true);
  assert.match(row(r, "anchoredBy"), /not compared/);
  const wrongOp = cli.checkRecord({ record: anchorRecord.facts, receipt: live.receipt, code: live.code, operator: "0x000000000000000000000000000000000000dEaD" });
  assert.equal(wrongOp.ok, false);
});

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

test("an Anchored log from any other contract is ignored, so a look-alike cannot pass", () => {
  const receipt = clone(live.receipt);
  receipt.logs[0].address = "0x000000000000000000000000000000000000bEEF";
  const r = cli.checkRecord({ record: anchorRecord, receipt, code: live.code });
  assert.equal(r.ok, false);
  assert.match(row(r, "contract"), /1 from other addresses ignored/);
});

test("a different anchoredBy, a changed field, a failed tx or different code each fail", () => {
  const byOther = clone(live.receipt);
  byOther.logs[0].topics[3] = `0x${"0".repeat(24)}${"ab".repeat(20)}`;
  assert.equal(cli.checkRecord({ record: anchorRecord, receipt: byOther, code: live.code }).ok, false);

  const edited = clone(anchorRecord);
  edited.facts.r1_status = "reconstructed";
  assert.equal(cli.checkRecord({ record: edited, receipt: live.receipt, code: live.code }).ok, false);

  const failed = clone(live.receipt);
  failed.status = "0x0";
  assert.equal(cli.checkRecord({ record: anchorRecord, receipt: failed, code: live.code }).ok, false);

  assert.equal(cli.checkRecord({ record: anchorRecord, receipt: live.receipt, code: `${live.code.slice(0, -2)}34` }).ok, false);
  assert.equal(cli.checkRecord({ record: anchorRecord, receipt: live.receipt, code: "0x" }).ok, false);
});

test("v1 does not bind tokens or evidence (why v2 exists); v2 binds every byte", () => {
  const v1 = clone(anchorRecord.facts) as RwaFacts;
  const v1Tampered = { ...clone(v1), evidence: { txs: [], fixture_ids: [] } } as RwaFacts;
  assert.equal(factsHash(v1Tampered), factsHash(v1), "v1: evidence is not in the preimage");

  const v2 = { ...clone(v1), method_version: "rwa-recon-0.3" } as RwaFacts;
  const base = factsHash(v2);
  const mutations: ((f: RwaFacts) => void)[] = [
    (f) => (f.evidence.txs = f.evidence.txs.slice(1)),
    (f) => (f.tokens[0].raw = "1"),
    (f) => (f.tokens[0].symbol = "NVDX"),
    (f) => (f.events_summary.other_unparsed += 1),
    (f) => (f.gaps = []),
    (f) => (f.disclaimer = `${f.disclaimer} `),
  ];
  for (const m of mutations) {
    const g = clone(v2);
    m(g);
    assert.notEqual(factsHash(g), base, m.toString());
  }
  // Key order and the address's case do not matter; the API shows EIP-55, the store lower-case.
  const reordered = Object.fromEntries(Object.entries(clone(v2)).reverse()) as RwaFacts;
  assert.equal(factsHash(reordered), base);
  assert.equal(factsHash({ ...clone(v2), address: "0xE9B08727131E34010b34006c660D4c1B436EC25f" } as RwaFacts), base);
});

test("anchor.ts --verify checks the emitter, anchoredBy and the hash, not only the hash", () => {
  const receipt = formatTransactionReceipt(live.receipt);
  assert.deepEqual(verifyRecord(anchorRecord, receipt), []);

  const spoofed = formatTransactionReceipt(clone(live.receipt));
  spoofed.logs[0].address = "0x000000000000000000000000000000000000beef";
  assert.match(verifyRecord(anchorRecord, spoofed).join(), /0 Anchored logs from 0x1955.*1 from other addresses ignored/);

  assert.match(verifyRecord({ ...anchorRecord, anchored_by: "0x000000000000000000000000000000000000dEaD" }, receipt).join(), /anchoredBy/);
  assert.match(verifyRecord({ ...anchorRecord, contract: "0x000000000000000000000000000000000000beef" }, receipt).join(), /not RwaAnchor/);
  const edited = clone(anchorRecord);
  edited.facts.realized_usd = "-113.97";
  assert.match(verifyRecord(edited, receipt).join(), /factsHash .* != recomputed/);
});
