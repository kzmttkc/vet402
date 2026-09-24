// docs/rwa/SUBMISSION_DRAFT.md must still fit the HackQuest form once the
// placeholders are filled with real values of their longest shape, and must
// not claim anything outside /rwa (SPEC §13c).
//
// Run from the repo root: npx tsx --test packages/rwa/test/submission-draft.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const draft = readFileSync(join(process.cwd(), "docs/rwa/SUBMISSION_DRAFT.md"), "utf8");
const LONGEST = {
  "<RWA_ANCHOR_ADDRESS>": "0x" + "a".repeat(40),
  "<ANCHOR_TX>": "0x" + "b".repeat(64),
  "<CHAIN_ID>": "46630",
};
const answers = [...draft.matchAll(/^## (.+?)\n\n([\s\S]+?)(?=\n\n## |\s*$)/gm)].map((m) => ({ field: m[1], body: m[2].trim() }));

test("every form answer is present", () => {
  assert.equal(answers.length, 8);
});

test("every answer fits the 300-character field with placeholders at their longest", () => {
  for (const a of answers) {
    let filled = a.body;
    for (const [k, v] of Object.entries(LONGEST)) filled = filled.split(k).join(v);
    assert.ok(filled.length <= 300, `${a.field}: ${filled.length} chars`);
  }
});

test("the draft claims only /rwa and cites no other hackathon", () => {
  const body = answers.map((a) => a.body).join("\n");
  for (const banned of ["ETHOnline", "ETHGlobal", "Bazantic", "payOrRefuse", "pay_if_trusted", "resolve-then-pay", "Tokyo"]) {
    assert.equal(body.includes(banned), false, banned);
  }
  assert.match(body, /predates the event and is not claimed/);
});
