// ============================================================
// settled と delivered（2026-09-04 外部監査 E・P0-3）。
//
//   settled   — vet402 がチェーンで転送を読み直した。金は動いた。
//   delivered — settled であり、かつ有料リクエストが 2xx を返した。品も来た。
//
// この 2 語を分けるまで、公開面は settled だけを出していた。本番実測
// （2026-09-04）では settled 1,452 件のうち 120 件が非 2xx で、api.exa.ai/search は
// 「10/10 settled」と描かれながら 10 件すべてが HTTP 400 だった。LP §2 は L1 を
// "Does payment settle and a response arrive?" と定義しているので、片方だけを
// 出すのは自分の定義に対して偽になる。
//
// 判定はこのファイルに 1 つだけ置く。SQL 側の述語も同じ定数から組み立てるので、
// TS と SQL で 2xx の境界が食い違うことがない。
// ============================================================

export const DELIVERED_HTTP_MIN = 200;
export const DELIVERED_HTTP_MAX = 299;

// ------------------------------------------------------------
// inconclusive（2026-09-05）。
//
// 方法論 §2 は既に正しい原則を持っていた——「我々が正しく組めなかったリクエスト
// から返る 400 は、**我々の限界であって売り手の不履行ではない**」。ただし適用先は
// `path_template`（URL に `{id}` が残っていて要求を出していない場合）だけだった。
//
// 原則は URL に限らない。**ボディも認証ヘッダも同じ**。我々の L1 は POST に `{}` を
// 送り、API キーを一切持たずに買う。だから支払い後の `400`（要求が不正）・`401`
// （未認証）・`403`・`404`・`422`（実体が不正）は、**売り手が納品しなかった証拠に
// ならない**。2026-09-05 の実測: settled 1,669 行のうち支払い後 4xx/5xx が 180 行、
// うち 157 行(87%)が 4xx。api.exa.ai は `10/10 settled · 0 delivered` と配布されて
// いた——実名の会社が「金を取って納品しなかった」と読める形で。
//
// 行は**消さない**。delivered の判定から外し、理由をつけて保留にする。5xx は
// 売り手側の障害なので保留にしない（我々の要求の形では説明できない）。
// ------------------------------------------------------------
export const INCONCLUSIVE_HTTP_MIN = 400;
export const INCONCLUSIVE_HTTP_MAX = 499;

/** 有料リクエストの応答が「届いた」と数えられる形か。 */
export function isDelivered(row: { status: string; httpStatusPaid: number | null }): boolean {
  if (row.status !== "settled") return false;
  const code = row.httpStatusPaid;
  if (code === null || code === undefined) return false;
  return code >= DELIVERED_HTTP_MIN && code <= DELIVERED_HTTP_MAX;
}

/**
 * 支払いは通ったが、有料応答が 4xx だった行。**我々が正しいリクエストを組めなかった
 * 可能性が消せない**ので、delivered の判定を保留にする（売り手の不履行として数えない）。
 */
export function isInconclusive(row: { status: string; httpStatusPaid: number | null }): boolean {
  if (row.status !== "settled") return false;
  const code = row.httpStatusPaid;
  if (code === null || code === undefined) return false;
  return code >= INCONCLUSIVE_HTTP_MIN && code <= INCONCLUSIVE_HTTP_MAX;
}

function assertAlias(fn: string, alias: string): string {
  if (alias !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`${fn}: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  }
  return alias === "" ? "" : `${alias}.`;
}

/**
 * 同じ判定の SQL 述語。alias は呼び出し側のコードが決める識別子だけを許す
 * （利用者入力は通らないが、境界を式で伸ばせないことを型でなく検査で固定する）。
 */
export function deliveredPredicate(alias = ""): string {
  const p = assertAlias("deliveredPredicate", alias);
  return `${p}status = 'settled' AND ${p}http_status_paid BETWEEN ${DELIVERED_HTTP_MIN} AND ${DELIVERED_HTTP_MAX}`;
}

/** `isInconclusive` と同じ規則の SQL 述語。 */
export function inconclusivePredicate(alias = ""): string {
  const p = assertAlias("inconclusivePredicate", alias);
  return `${p}status = 'settled' AND ${p}http_status_paid BETWEEN ${INCONCLUSIVE_HTTP_MIN} AND ${INCONCLUSIVE_HTTP_MAX}`;
}
