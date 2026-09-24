// The anchored commitment (SPEC §9). The test that matters is that an outsider
// can recompute the hash from the published JSON alone.
//
// Run from the repo root: npx tsx --test packages/rwa/test/anchor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { anchorPreimage, asOfSeconds, factsHash, methodVersionNumber, preimageString, subjectHash } from "../anchor";
import type { RwaFacts } from "../facts";

const facts = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.facts.json"), "utf8")) as RwaFacts;

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
  assert.throws(() => methodVersionNumber("rwa-recon-0.2"), /unknown method_version/);
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
  const sha = require("node:crypto").createHash("sha256").update(src).digest("hex");
  assert.equal(artifact.sourceSha256, sha, "RwaAnchor.sol changed since it was compiled; recompile before deploying");
  // Nothing upgradeable, no owner, no token (SPEC §9).
  for (const banned of ["owner", "upgradeTo", "initialize", "transfer", "mint"]) {
    assert.equal(artifact.abi.some((e: { name?: string }) => e.name === banned), false, banned);
  }
});
