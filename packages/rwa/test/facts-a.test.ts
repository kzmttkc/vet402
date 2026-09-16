// Facts for the Fixture A holder, replayed offline from fixtures/rwa/A.chain.json
// (SPEC §5, §7). The mark must agree with fixtures/rwa/A.json; nothing may be
// dropped; there is no opinion field; realized is null; a stale feed refuses
// the mark.
//
// Run from the repo root: npx tsx --test packages/rwa/test/facts-a.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleFacts, sharesUi, usdString } from "../facts";
import { recordedPoolResolver } from "../pools";

const A = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.json"), "utf8"));
const CHAIN = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.chain.json"), "utf8"));

function read(overrides: Partial<{ updatedAt: number; oraclePaused: boolean }> = {}) {
  return {
    raw: BigInt(A.raw),
    uiMultiplier: BigInt(A.ui_multiplier),
    oraclePaused: overrides.oraclePaused ?? A.oracle_paused,
    feedDecimals: A.feed.decimals,
    round: {
      roundId: BigInt(A.feed_round.round_id),
      answer: BigInt(A.feed_round.answer),
      startedAt: Number(A.feed_round.started_at),
      updatedAt: overrides.updatedAt ?? Number(A.feed_round.updated_at),
      answeredInRound: BigInt(A.feed_round.answered_in_round),
    },
  };
}

const base = () => ({
  address: A.holder.address,
  block: A.block,
  blockTimestamp: A.block_timestamp,
  receipts: CHAIN.receipts,
  read: read(),
  resolver: recordedPoolResolver(CHAIN.pools),
});

test("the recorded chain inputs belong to fixture A", () => {
  assert.equal(CHAIN.holder, A.holder.address);
  assert.equal(CHAIN.to_block, A.block);
  assert.equal(CHAIN.token, A.token.address.toLowerCase());
});

test("facts for the A holder mark the balance with the fixture's expected cents", async () => {
  const f = await assembleFacts(base());
  assert.equal(f.tokens[0].raw, A.raw);
  assert.equal(f.tokens[0].usd, usdString(BigInt(A.expected.usd_cents)));
  assert.equal(f.unrealized_usd, f.tokens[0].usd);
  assert.equal(f.tokens[0].stale, false);
  assert.equal(f.tokens[0].shares_ui, sharesUi(BigInt(A.raw), BigInt(A.ui_multiplier)));
  assert.equal(f.as_of_block, A.block);
  assert.equal(f.r0, "present");
});

test("every canonical leg in the recording is classified and counted; none is dropped", async () => {
  const f = await assembleFacts(base());
  const me = A.holder.address.toLowerCase();
  const legs = CHAIN.transfer_logs.filter((l: { topics: string[] }) => {
    const from = `0x${l.topics[1].slice(-40)}`;
    const to = `0x${l.topics[2].slice(-40)}`;
    return (from === me || to === me) && from !== to;
  });
  const s = f.events_summary;
  assert.equal(s.transfer + s.univ3 + s.univ4 + s.other_unparsed, legs.length);
  assert.ok(legs.length > 0);
  assert.equal(f.evidence.txs.length, CHAIN.receipts.length);
});

test("the facts document carries no opinion and no realized figure", async () => {
  const f = await assembleFacts(base());
  const text = JSON.stringify(f);
  for (const banned of ["recommendation", "ALLOW", "WARN", "BLOCK", "rubric"]) assert.equal(text.includes(banned), false, banned);
  assert.equal(f.realized_usd, null);
  assert.equal(f.mdd_usd, null);
  assert.equal(f.r2, "no_declaration");
  assert.equal(f.identity_binding, "unknown");
  assert.equal(f.disclaimer, "Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens.");
});

test("a stale feed (26h+) refuses the USD mark but keeps the balance", async () => {
  const f = await assembleFacts({ ...base(), read: read({ updatedAt: A.block_timestamp - 26 * 3600 - 1 }) });
  assert.equal(f.tokens[0].stale, true);
  assert.deepEqual(f.tokens[0].stale_reasons, ["age"]);
  assert.equal(f.tokens[0].usd, null);
  assert.equal(f.unrealized_usd, null);
  assert.equal(f.tokens[0].raw, A.raw);
  assert.ok(f.gaps.includes("feed_stale"));
});

test("a paused oracle refuses the USD mark", async () => {
  const f = await assembleFacts({ ...base(), read: read({ oraclePaused: true }) });
  assert.equal(f.tokens[0].stale, true);
  assert.equal(f.tokens[0].usd, null);
});

test("shares_ui and usd strings are fixed-point, not floats", () => {
  assert.equal(sharesUi(10n ** 18n, 10n ** 18n), "1.00000000");
  assert.equal(sharesUi(BigInt(A.raw), BigInt(A.ui_multiplier)), "186.25399999");
  assert.equal(usdString(3985928n), "39859.28");
  assert.equal(usdString(5n), "0.05");
});

test("the reconstruction is deterministic", async () => {
  const [x, y] = await Promise.all([assembleFacts(base()), assembleFacts(base())]);
  assert.deepEqual(x, y);
});

test("the current code reproduces fixtures/rwa/A.facts.json exactly (regression pin; regenerate with packages/rwa/scripts/facts-fixture-a.ts)", async () => {
  const golden = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.facts.json"), "utf8"));
  const f = JSON.parse(JSON.stringify(await assembleFacts(base())));
  assert.deepEqual(f, golden);
});
