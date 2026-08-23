// ============================================================
// 2026-08-23 監査: assessSybilRisk の `flags.length >= 3` が、
// **主体の行いではないフラグ**を無条件 BLOCK の票に数えていた。
//
//   owner_index_stale — 我々の索引が遅れているだけ。相手に非はない。
//     chain/config.ts:28-40 は自らこれを "a SOFT `owner_index_stale` flag" と
//     定義し、owner_count_unavailable（読み取り自体の失敗）より "milder" だと
//     書いている。それが無条件BLOCKの1票になっていた。
//   multi_agent_owner — 3体以上を運用する正当な運営者。単独では通常の構成で、
//     sybil を示すのは funding_cluster との同時成立（別途 high にしている）。
//
// 結果、「索引が少し遅れている + 複数エージェント + 新しい運用ウォレット」の
// **何も悪いことをしていない運営者**が、スコアに関係なく BLOCK になった。
// 「柔らかい不確実性」を「高リスク確定」に変換するのは、この製品が
// C-1〜C-4 で直してきた欠陥と同じ形。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessSybilRisk, countHardFlags } from "@/lib/scoring/verdict";

test("正当な運営者の3本はBLOCKにならない（今回の主眼）", () => {
  const flags = ["multi_agent_owner", "owner_index_stale", "new_burner_wallet"];
  assert.equal(countHardFlags(flags), 1, "主体についての所見は new_burner_wallet だけ");
  assert.notEqual(
    assessSybilRisk(flags),
    "high",
    "索引遅延と複数エージェント運用で正直な運営者をBLOCKにしている",
  );
});

test("主体についての所見が3本ならこれまで通り high", () => {
  const flags = ["new_burner_wallet", "funding_cluster", "review_velocity_anomaly"];
  assert.equal(countHardFlags(flags), 3);
  assert.equal(assessSybilRisk(flags), "high", "本物の3本は従来どおり止める");
});

test("ソフトフラグを混ぜても、硬い所見が3本あれば high のまま", () => {
  const flags = [
    "new_burner_wallet",
    "funding_cluster",
    "review_velocity_anomaly",
    "owner_index_stale",
    "multi_agent_owner",
  ];
  assert.equal(assessSybilRisk(flags), "high", "ソフト除外が抜け穴になっている");
});

test("既存の明示ルールは無傷（funding_cluster + multi_agent_owner）", () => {
  // multi_agent_owner を票数から外しても、sybil を実際に示す組み合わせは
  // 明示ルールが捕まえる。ここが壊れると除外が本当の穴になる。
  assert.equal(assessSybilRisk(["funding_cluster", "multi_agent_owner"]), "high");
});

test("既存の明示ルールは無傷（no_bound_wallet + review_velocity_anomaly）", () => {
  assert.equal(assessSybilRisk(["no_bound_wallet", "review_velocity_anomaly"]), "high");
});

test("*_unavailable はクラス一致で high のまま（ソフト除外の影響を受けない）", () => {
  assert.equal(assessSybilRisk(["wallet_metrics_unavailable"]), "high");
  assert.equal(assessSybilRisk(["owner_index_stale", "some_new_thing_unavailable"]), "high");
});

test("ソフトフラグだけなら medium 止まり（開示はされるがBLOCKではない）", () => {
  const r = assessSybilRisk(["owner_index_stale", "multi_agent_owner"]);
  assert.notEqual(r, "high");
  assert.equal(r, "medium", "フラグが立っている以上 low ではない——開示は続ける");
});

test("除外は denylist（新しいフラグは既定で数える＝fail-closed）", () => {
  // 将来 flag が増えたとき、数え漏れではなく数えすぎに倒れること。
  const unknown = ["brand_new_flag_a", "brand_new_flag_b", "brand_new_flag_c"];
  assert.equal(countHardFlags(unknown), 3);
  assert.equal(assessSybilRisk(unknown), "high");
});
