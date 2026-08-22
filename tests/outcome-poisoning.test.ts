// ============================================================
// 2026-08-23 監査 C-2: APIキー1つで、任意の正直な売り手を BLOCK に固定できた。
//
// 経路:
//   1. /v1/wallets/{任意アドレス}/score → persistScoreResult が trust_events に
//      行を書く。**この経路だけ signals に kind が無かった**（payee 側は
//      kind:"payee_score" を付ける）。
//   2. outcome-detector の監視集合は `kind IS DISTINCT FROM 'payee_score'` という
//      **否定形の除外**なので、kind を名乗らないこの行は監視対象に入る。
//   3. 検出器の repeatedWithdrawals は `outgoing.length >= 2` だけで
//      **金額下限が無い**（下限 0.005 ETH は比率側の枝にのみ適用）。
//      `outgoing` は value > 0 しか要求しないのでダストで足りる。
//   4. rug_pull_outflow が source:"auto" で記録され、outcome-adjustment の
//      `!isPartnerSource` が無条件 trusted → Math.min(score, 15) → BLOCK固定。
//
// ここで固定するのは、その連鎖の各リンクが切れていること。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

test("リンク1: 買い手側の永続化も kind を名乗る", () => {
  const src = read("src", "lib", "db", "persistence.ts");
  assert.match(
    src,
    /signals: \{ kind: "seller_score", \.\.\.result\.signals \}/,
    "kind を名乗らない行は、否定形の除外をすり抜けて監視対象に入る",
  );
});

test("リンク2: 監視集合は肯定形で名指している（否定形へ戻ったら落ちる）", () => {
  const src = read("src", "lib", "db", "outcome-writer.ts");
  assert.match(
    src,
    /\(\$\{trustEvents\.signals\}->>'kind'\) = 'seller_score'/,
    "監視対象は肯定形で名指すこと——否定形は『知らない種類を全部監視する』の意",
  );
  assert.doesNotMatch(
    src,
    /IS DISTINCT FROM 'payee_score'/,
    "否定形の除外が復活している",
  );
});

test("リンク3: rug_pull の回数トリガにも金額下限が掛かっている", () => {
  const src = read("src", "lib", "indexer", "outcome-detector.ts");
  const m = src.match(
    /const repeatedWithdrawals =[\s\S]{0,200}?;/,
  );
  assert.ok(m, "repeatedWithdrawals の定義が見つからない");
  assert.match(
    m![0],
    /outgoingValueTotal >= RUG_PULL_MIN_DRAIN_VALUE_WEI/,
    "回数だけで rug_pull を宣言している——ダスト送金2回で正直な売り手を潰せる",
  );
});

test("金額下限の値が 0 に緩められていない", () => {
  const src = read("src", "lib", "indexer", "outcome-detector.ts");
  const m = src.match(/RUG_PULL_MIN_DRAIN_VALUE_WEI = (\d[\d_]*)n/);
  assert.ok(m, "下限定数が見つからない");
  const value = BigInt(m![1].replace(/_/g, ""));
  assert.ok(value > 0n, "下限が0では意味がない");
});
