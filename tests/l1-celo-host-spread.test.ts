// Celo レーンだけ、取得 LIMIT の前にホストあたり 2 件へ絞る。他レーンの並び文は残す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAID_ATTEMPT_STATUSES } from "@/lib/observatory/reader";
import {
  CELO_HOST_ATTEMPT_STATUSES,
  CELO_LANE_MAX_LISTINGS_PER_HOST,
  celoLaneUsesHostSpread,
} from "@/lib/observatory/l1-runner";

const OTHER_LANES = ["solana", "arc", "arc_gateway", "tempo", "xrpl", "bnb", "arbitrum", "avalanche", "stellar", "base"] as const;

test("Celo のホスト幅は celo レーンだけに掛かり、試行 status は PAID_ATTEMPT_STATUSES と同じ", () => {
  assert.equal(CELO_LANE_MAX_LISTINGS_PER_HOST, 2);
  assert.deepEqual([...CELO_HOST_ATTEMPT_STATUSES], [...PAID_ATTEMPT_STATUSES]);
  assert.equal(celoLaneUsesHostSpread({ chain: "celo" }, false), true);
  assert.equal(celoLaneUsesHostSpread({ chain: "celo" }, true), false);
  assert.equal(celoLaneUsesHostSpread(undefined, false), false);
  for (const chain of OTHER_LANES) {
    assert.equal(celoLaneUsesHostSpread({ chain }, false), false, chain);
  }

  const src = readFileSync("src/lib/observatory/l1-runner.ts", "utf8");
  assert.match(src, /celoLaneUsesHostSpread\(lane, census !== undefined\)/);
  assert.match(src, /return celoLane && lane \? celoDiversifiedCandidatesSql\(query, lane\.limit\) : query/);
  const sharedOrder = src.match(/e\.quality_payers_30d DESC NULLS LAST, e\.quality_calls_30d DESC NULLS LAST/g) ?? [];
  assert.equal(sharedOrder.length, 1, "他レーンの ORDER BY は 1 箇所のまま");
});
