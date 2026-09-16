// Reproduce the facts document of Fixture A's holder offline from the recorded
// chain inputs and write fixtures/rwa/A.facts.json. The test pins the current
// code to this file so an unintended change in the document shows up as a diff.
//
// Run from the repo root: npx tsx packages/rwa/scripts/facts-fixture-a.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleFacts } from "../facts";
import { recordedPoolResolver } from "../pools";

const A = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.json"), "utf8"));
const CHAIN = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.chain.json"), "utf8"));

export function readFromFixtureA() {
  return {
    raw: BigInt(A.raw),
    uiMultiplier: BigInt(A.ui_multiplier),
    oraclePaused: A.oracle_paused as boolean,
    feedDecimals: A.feed.decimals as number,
    round: {
      roundId: BigInt(A.feed_round.round_id),
      answer: BigInt(A.feed_round.answer),
      startedAt: Number(A.feed_round.started_at),
      updatedAt: Number(A.feed_round.updated_at),
      answeredInRound: BigInt(A.feed_round.answered_in_round),
    },
  };
}

async function main() {
  const facts = await assembleFacts({
    address: A.holder.address,
    block: A.block,
    blockTimestamp: A.block_timestamp,
    receipts: CHAIN.receipts,
    read: readFromFixtureA(),
    resolver: recordedPoolResolver(CHAIN.pools),
  });
  const path = join(process.cwd(), "fixtures/rwa/A.facts.json");
  writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`);
  console.log(`wrote ${path}: r1 ${facts.r1_status}, usd ${facts.tokens[0].usd}, events ${JSON.stringify(facts.events_summary)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
