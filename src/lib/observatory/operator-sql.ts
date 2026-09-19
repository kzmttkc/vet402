// ============================================================
// 自己除外の述語を **1 本**にする（2026-09-19 再レビュー V1）。
//
// 経緯: 「運営自身の endpoint を母数から外す」は 2026-08-23 から reader.ts に在ったが、
// 同じ WHERE 句が関数ごとに逐語で写されていた。写し忘れた関数——
// getObservatoryStatsByChain——だけが自社を数え続け、同じ頁の §1 と §2 が別の母集団を
// 数えていた（2026-09-19 独立レビュー W1）。写経を増やして直せば同じ事故がまた起きるので、
// 述語をここ 1 本にして全員に通す。**関門は経路に置く。**
//
// operator.ts は依存を持たない（drizzle を import しない）まま残す——公開の読み取り経路が
// 「これは我々のか？」を聞くのに L1 スタックを引きずり込まないための設計なので、
// SQL を作る役だけをこの薄い層へ分ける。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import { logServerError } from "@/lib/util/log";
import { operatorPayToDenylist } from "./operator";

/** SQL へ素で差し込む別名。呼び手は自分のコードの定数しか渡さないが、形は機械で縛る。 */
const SAFE_ALIAS = /^[a-z_][a-z0-9_]*$/;

function aliasSql(alias: string): SQL {
  if (!SAFE_ALIAS.test(alias)) throw new Error(`operator-sql: unsafe alias ${JSON.stringify(alias)}`);
  return sql.raw(alias);
}

let warnedEmptyDenylist = false;

/**
 * denylist が空であることを 1 プロセス 1 回だけ鳴らす（2026-09-19 再レビュー V2）。
 *
 * 2026-08-23 の事故の本体は「VET402_OPERATOR_PAYTO が本番で未設定＝完全な no-op」で、
 * **それに誰も気づけなかった**ことだった。読み取り経路には L1 ランナーが注入する
 * 導出アドレス（operator.ts の `derived`）が届かない（別プロセス）ので、ここで効くのは
 * 環境変数だけ。env が外れれば denylist は空になり、この関数が鳴る。
 *
 * **「空」だけを鳴らす。** env が設定されていて一致が 0 件なのは正常（vet402 が自分の
 * endpoint をカタログに載せていなければそうなる）。0 件一致で鳴らすと、正常な状態が
 * 恒常的に赤くなり、本当に外れた日の 1 行が埋もれる。
 */
function warnIfDenylistEmpty(): void {
  if (warnedEmptyDenylist) return;
  warnedEmptyDenylist = true;
  logServerError(
    "observatory.operator_denylist_empty",
    new Error(
      "VET402_OPERATOR_PAYTO is unset or empty, so the public read path excludes no operator endpoint. " +
        "Self-neutrality is not enforced on these aggregates until it is set.",
    ),
  );
}

/** テスト用。プロセス内の「もう鳴らした」フラグを戻す。 */
export function resetOperatorDenylistWarning(): void {
  warnedEmptyDenylist = false;
}

function denylistArray(list: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    list.map((a) => sql`${a}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * 「この行は運営自身のものではない」——母数から自社を外すための真偽式。
 *
 * `WHERE ${operatorExclusionPredicate("e")}` でも
 * `AND ${operatorExclusionPredicate("e")}` でも置けるように、句ではなく**式**を返す。
 * denylist が空なら `true`（no-op）を返し、同時に 1 回だけ鳴らす。
 */
export function operatorExclusionPredicate(alias: string): SQL {
  const list = operatorPayToDenylist();
  if (list.length === 0) {
    warnIfDenylistEmpty();
    return sql`true`;
  }
  const a = aliasSql(alias);
  return sql`(${a}.pay_to IS NULL OR lower(${a}.pay_to) <> ALL(${denylistArray(list)}))`;
}

/**
 * 上の否定——「この行は運営自身のもの」。除外が**今日何件取り除いているか**を
 * 数えて公開面に出すために使う（効いていない除外を、効いている保証のように書かないため）。
 */
export function operatorMatchPredicate(alias: string): SQL {
  const list = operatorPayToDenylist();
  if (list.length === 0) return sql`false`;
  const a = aliasSql(alias);
  return sql`(${a}.pay_to IS NOT NULL AND lower(${a}.pay_to) = ANY(${denylistArray(list)}))`;
}
