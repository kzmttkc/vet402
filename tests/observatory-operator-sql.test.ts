// ============================================================
// 自己除外の述語（2026-09-19 再レビュー V1・V2）。
//
// 2026-08-23: VET402_OPERATOR_PAYTO が本番で未設定＝除外が完全な no-op だったのに
// 誰も気づけなかった。2026-09-19: 同じ述語が関数ごとに写されていて、写し忘れた
// getObservatoryStatsByChain だけが自社を数え続けていた。直したのは 2 つ:
//   1. 述語を 1 本にして全員が通る（写し忘れが起きる場所を消す）
//   2. denylist が空なら 1 回だけ鳴らす（env が外れたことに気づける）
// **「空」だけを鳴らす。** env が入っていて一致が 0 件なのは正常なので鳴らさない
// ——正常が恒常的に赤いと、本当に外れた日の 1 行が埋もれる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  operatorExclusionPredicate,
  operatorMatchPredicate,
  resetOperatorDenylistWarning,
} from "@/lib/observatory/operator-sql";
import { resetDerivedOperatorAddresses } from "@/lib/observatory/operator";

const SELF = `0x${"e".repeat(40)}`;

function withEnv(value: string | undefined, run: () => void): void {
  const saved = process.env.VET402_OPERATOR_PAYTO;
  if (value === undefined) delete process.env.VET402_OPERATOR_PAYTO;
  else process.env.VET402_OPERATOR_PAYTO = value;
  resetDerivedOperatorAddresses();
  resetOperatorDenylistWarning();
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env.VET402_OPERATOR_PAYTO;
    else process.env.VET402_OPERATOR_PAYTO = saved;
    resetDerivedOperatorAddresses();
    resetOperatorDenylistWarning();
  }
}

function capturingStderr(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

test("denylist に値があれば除外の式を返す（句ではなく式——WHERE にも AND にも置ける）", () => {
  withEnv(SELF, () => {
    const sqlChunks = JSON.stringify(operatorExclusionPredicate("e"));
    assert.match(sqlChunks, /pay_to/, "pay_to を見る式であること");
    assert.doesNotMatch(sqlChunks, /WHERE/i, "句を返してはいけない（AND で継げなくなる）");
  });
});

test("denylist が空なら no-op の式を返し、1 プロセス 1 回だけ鳴らす", () => {
  withEnv("", () => {
    let predicate: unknown;
    const first = capturingStderr(() => {
      predicate = operatorExclusionPredicate("e");
    });
    // 2026-09-19 最終確認 Note: l1-runner の候補 SQL は以前「句ごと空」だった。
    // いまは `AND ${predicate}` を継ぐので、空のとき **ちょうど `true`** でなければ
    // 買い手の候補集合が変わってしまう。動作が変わらないことをここで縛る。
    assert.match(JSON.stringify(predicate), /"true"/);
    assert.equal(first.length, 1, "空の denylist は必ず鳴らす（2026-08-23 の事故の本体）");
    assert.match(first[0], /operator_denylist_empty/);
    const second = capturingStderr(() => operatorExclusionPredicate("e"));
    assert.deepEqual(second, [], "同じプロセスで 2 度は鳴らさない（本当の 1 行が埋もれる）");
  });
});

test("denylist に値があれば鳴らさない——一致 0 件は正常で、空とは別の状態", () => {
  withEnv(SELF, () => {
    const lines = capturingStderr(() => {
      operatorExclusionPredicate("e");
      // 一致が 0 件かどうかはこの述語では分からない（数えるのは呼び手）。
      operatorMatchPredicate("e");
    });
    assert.deepEqual(lines, []);
  });
});

test("別名は機械で縛る（SQL へ素で差し込むため）", () => {
  withEnv(SELF, () => {
    assert.throws(() => operatorExclusionPredicate("e; DROP TABLE x402_endpoints --"), /unsafe alias/);
    assert.throws(() => operatorMatchPredicate("1bad"), /unsafe alias/);
  });
});

test("match は exclusion の否定——denylist が空なら何にも一致しない", () => {
  withEnv("", () => {
    const empty = JSON.stringify(operatorMatchPredicate("e"));
    assert.doesNotMatch(empty, /pay_to/, "空なら pay_to を見ずに false を返す");
  });
});
