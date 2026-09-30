// The anchored commitment (SPEC §9). The test that matters is that an outsider
// can recompute the hash from the published JSON alone.
//
// Run from the repo root: npx tsx --test packages/rwa/test/anchor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import {
  anchorPreimage,
  asOfSeconds,
  canonicalFactsJson,
  canonicalJson,
  factsHash,
  factsHashV2,
  hashMaterial,
  methodVersionNumber,
  preimageString,
  subjectHash,
} from "../anchor";
import type { RwaFacts } from "../facts";

// Fixture A read as a v1 record (rwa-recon-0.2), whatever version the fixture file carries later.
const facts = { ...JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.facts.json"), "utf8")), method_version: "rwa-recon-0.2" } as RwaFacts;
/** factsHash of fixtures/rwa/anchor.json's facts with method_version set to rwa-recon-0.3. Computed once on 2026-09-30; a change here changes every v2 anchor. */
const V2_PINNED = "0xa52de757b0aa60e19fb5810af2e1e829e8a447971cd1850fe53990924f75bc8f";

test("the preimage is the five fields SPEC §9 names, verbatim from the JSON", () => {
  const p = anchorPreimage(facts);
  assert.deepEqual(p, {
    method_version: facts.method_version,
    address: facts.address.toLowerCase(),
    as_of: facts.as_of,
    r1_status: facts.r1_status,
    realized_usd: "null",
  });
  assert.equal(preimageString(p).split("\n").length, 5);
});

test("a reader with only the facts JSON recomputes the same hash", () => {
  const byHand = keccak256(
    toHex([facts.method_version, facts.address.toLowerCase(), facts.as_of, facts.r1_status, "null"].join("\n")),
  );
  assert.equal(factsHash(facts), byHand);
});

test("a realized figure changes the hash, and null is the word null", () => {
  const withRealized = { ...facts, realized_usd: "-113.98" } as RwaFacts;
  assert.notEqual(factsHash(withRealized), factsHash(facts));
  assert.match(preimageString(anchorPreimage(facts)), /\nnull$/);
  // An empty realized string must not collide with the null case.
  assert.notEqual(factsHash({ ...facts, realized_usd: "" } as RwaFacts), factsHash(facts));
});

test("the subject is the keccak of the lower-cased address, however it is cased", () => {
  assert.equal(subjectHash("0xE9B08727131E34010B34006C660D4C1B436EC25F"), subjectHash("0xe9b08727131e34010b34006c660d4c1b436ec25f"));
});

test("an unknown method version refuses to be anchored as a number", () => {
  assert.equal(methodVersionNumber("rwa-recon-0.1"), 1);
  assert.equal(methodVersionNumber("rwa-recon-0.2"), 2);
  assert.equal(methodVersionNumber("rwa-recon-0.3"), 3);
  assert.throws(() => methodVersionNumber("rwa-recon-0.4"), /unknown method_version/);
});

test("the hash material follows method_version: 0.1 and 0.2 are v1, 0.3 is v2", () => {
  assert.equal(hashMaterial("rwa-recon-0.1"), 1);
  assert.equal(hashMaterial("rwa-recon-0.2"), 1);
  assert.equal(hashMaterial("rwa-recon-0.3"), 2);
  assert.throws(() => hashMaterial("rwa-recon-9"), /unknown method_version/);
});

// The record anchored on Robinhood Chain on 2026-09-27 (tx 0x9b776d6a…72d7). Its
// hash is on chain, so it can never change: v1 must keep producing it.
const anchored = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/anchor.json"), "utf8"));

test("v1 is pinned: the live 0.1 record still hashes to the value in the Anchored event", () => {
  assert.equal(anchored.facts.method_version, "rwa-recon-0.1");
  assert.equal(factsHash(anchored.facts), "0xd155c8b1b71125aa922fcb517f047e1a42a0aaf6d028f2cf3470ad1372c8f579");
  assert.equal(factsHash(anchored.facts), anchored.facts_hash);
  assert.equal(preimageString(anchorPreimage(anchored.facts)), anchored.preimage);
  assert.equal(subjectHash(anchored.facts.address), anchored.subject.keccak);
});

test("v2 is pinned: six fields, the sixth is keccak of the canonical record", () => {
  const f = { ...anchored.facts, method_version: "rwa-recon-0.3" } as RwaFacts;
  const p = anchorPreimage(f);
  assert.equal(p.facts_json_keccak, keccak256(toHex(canonicalFactsJson(f))));
  const s = preimageString(p);
  assert.equal(s.split("\n").length, 6);
  assert.equal(s.split("\n")[5], p.facts_json_keccak);
  assert.equal(factsHash(f), keccak256(toHex(s)));
  assert.equal(factsHash(f), factsHashV2(f));
  assert.equal(factsHash(f), V2_PINNED);
  // v2 of a 0.2 record is what X-Facts-Hash sends before the version bump; it is not the v1 hash.
  assert.notEqual(factsHashV2(anchored.facts), factsHash(anchored.facts));
});

test("canonical JSON: sorted keys at every depth, no whitespace, lower-cased top-level address only", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: "x", c: null }], e: undefined }), '{"a":[{"c":null,"d":"x"}],"b":1}');
  assert.equal(canonicalJson([undefined, true]), "[null,true]");
  assert.throws(() => canonicalJson({ n: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ n: 1n }), /cannot encode/);
  const c = canonicalFactsJson({ address: "0xAbC", tokens: [{ token: "0xDeF" }] });
  assert.equal(c, '{"address":"0xabc","tokens":[{"token":"0xDeF"}]}');
});

test("as_of becomes unix seconds", () => {
  assert.equal(asOfSeconds(facts), BigInt(Math.floor(Date.parse(facts.as_of) / 1000)));
});

test("the committed artifact is the compiled contract and exposes the SPEC §9 signature", () => {
  const artifact = JSON.parse(readFileSync(join(process.cwd(), "packages/rwa/contracts/RwaAnchor.json"), "utf8"));
  const fn = artifact.abi.find((e: { name?: string }) => e.name === "anchor");
  assert.deepEqual(fn.inputs.map((i: { type: string }) => i.type), ["bytes32", "bytes32", "uint32", "uint64"]);
  assert.ok(artifact.bytecode.startsWith("0x") && artifact.bytecode.length > 200);
  // The source in the tree is the source that was compiled.
  const src = readFileSync(join(process.cwd(), "packages/rwa/contracts/RwaAnchor.sol"), "utf8");
  const sha = createHash("sha256").update(src).digest("hex");
  assert.equal(artifact.sourceSha256, sha, "RwaAnchor.sol changed since it was compiled; recompile before deploying");
  // Nothing upgradeable, no owner, no token (SPEC §9).
  for (const banned of ["owner", "upgradeTo", "initialize", "transfer", "mint"]) {
    assert.equal(artifact.abi.some((e: { name?: string }) => e.name === banned), false, banned);
  }
});
