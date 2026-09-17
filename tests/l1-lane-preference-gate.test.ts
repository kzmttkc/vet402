// ============================================================
// レーンの accept 優先の関門（2026-09-17 独立レビュー C2 / C4 / W1 / W5）— 原文で固定。
//
//  C2  優先はレーン枠から来た候補（candidate.laneChain）にだけ渡す。主候補には掛けない。
//      バッチ内でレーン支出を加算し、別枠を使い切ったら渡さない（laneOpen）。
//  C4  settled 判定は settled / settle_claimed。非決済（settle_failed / delivered_no_receipt /
//      settle_claim_refuted）が 1 度でも出た endpoint は優先と secondary 枠から外す。
//  W1  枠の NOT EXISTS は LANE_SECONDARY_ACCEPTS のレーン（Arc）の secondary の枝にだけ掛ける。
//  W5  raw_accepts の network は実行時と同じ完全一致（`arc` スラグを寄せない）——コメントで明記。
// 挙動は tests/l1-lane-preference-gate.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src", "lib", "observatory", "l1-runner.ts"), "utf8");

test("C2: preferNetworks は candidate.laneChain のある候補にだけ、laneOpen（別枠が残る）のときだけ", () => {
  assert.match(src, /const laneNetwork = candidate\.laneChain !== null \? LANE_NETWORK\[candidate\.laneChain\] : undefined;/);
  assert.match(src, /candidate\.laneChain !== null &&\s*\n\s*laneNetwork !== undefined &&\s*\n\s*laneOpen\(candidate\.laneChain\) &&/);
  assert.doesNotMatch(src, /selectableLaneNetworks/, "全候補に掛ける旧経路が残っている");
  assert.match(src, /const laneOpen = \(chain: CappedChain\): boolean =>\s*\n\s*laneSelectable\.get\(chain\) === true && \(laneSpent\.get\(chain\) \?\? chainDailyCapUnits\(chain\)\) < chainDailyCapUnits\(chain\);/);
  assert.match(src, /laneSpent\.set\(outcomeLane, \(laneSpent\.get\(outcomeLane\) \?\? 0n\) \+ outcome\.spent\)/, "バッチ内のレーン支出を加算していない");
  assert.match(src, /laneChain: lane\.chain \}/, "laneFloorCandidates が候補にレーンを付けていない");
});

test("C4: settled は settled / settle_claimed、failed は 3 つの非決済。どちらも優先から外す", () => {
  assert.match(src, /s\.status IN \('settled', 'settle_claimed'\) AND s\.network IS NOT NULL\) AS settled_networks/);
  assert.match(src, /s\.status IN \('settle_failed', 'delivered_no_receipt', 'settle_claim_refuted'\)\s*\n\s*AND s\.network IS NOT NULL\) AS failed_networks/);
  assert.match(src, /!candidate\.settledNetworks\.includes\(laneNetwork\) &&\s*\n\s*!candidate\.failedNetworks\.includes\(laneNetwork\)/);
});

test("W1: 枠の NOT EXISTS は secondary の枝（LANE_SECONDARY_ACCEPTS）の内側だけ。主ネットワーク一致の枝には無い", () => {
  const m = /lane\s*\n\s*\? sql`AND \(e\.network LIKE \$\{lane\.networkLike\}\$\{\s*\n\s*LANE_SECONDARY_ACCEPTS\[lane\.chain\]\s*\n\s*\? sql` OR \(jsonb_typeof\(e\.raw_accepts\) = 'array'\s*\n\s*AND EXISTS \(SELECT 1 FROM jsonb_array_elements\(e\.raw_accepts\) a WHERE a->>'network' LIKE \$\{lane\.networkLike\} \$\{LANE_SECONDARY_ACCEPT_FILTER\[lane\.chain\] \?\? sql``\}\)\s*\n\s*AND NOT EXISTS \(/.exec(src);
  assert.ok(m, "secondary の枝の中に NOT EXISTS が無い");
  // 2026-09-18（XRPL の secondary accept）: 枝の EXISTS にはレーンごとの accept 条件が足せる。XRPL は RLUSD + 固定発行者だけ。
  assert.match(src, /xrpl: sql`AND \(upper\(a->>'asset'\) = \$\{RLUSD_CURRENCY_HEX\} OR a->>'asset' = 'RLUSD'\) AND a->'extra'->>'issuer' = \$\{RLUSD_ISSUER\}`/);
  // 枝を閉じた後（`: sql``\n })`）に NOT EXISTS が続かない。
  assert.match(src, /: sql``\s*\n\s*\}\)`\s*\n\s*: sql``\s*\n\s*\}/, "枝の外側にレーン共通の NOT EXISTS が残っている");
  assert.match(src, /ls\.status IN \('settled', 'settle_claimed', 'settle_failed', 'delivered_no_receipt', 'settle_claim_refuted'\)/);
});

test("W5: raw_accepts の network は実行時と同じ完全一致で、理由がコメントにある", () => {
  assert.match(src, /raw_accepts の network は実行時（x402-payer normalizeNetwork）と同じ\*\*完全一致\*\*で見る/);
  assert.match(src, /a->>'network' LIKE \$\{lane\.networkLike\}/);
  assert.doesNotMatch(src, /lower\(a->>'network'\)/, "SQL 側だけがスラグを寄せている");
});
