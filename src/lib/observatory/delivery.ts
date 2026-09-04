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

/** 有料リクエストの応答が「届いた」と数えられる形か。 */
export function isDelivered(row: { status: string; httpStatusPaid: number | null }): boolean {
  if (row.status !== "settled") return false;
  const code = row.httpStatusPaid;
  if (code === null || code === undefined) return false;
  return code >= DELIVERED_HTTP_MIN && code <= DELIVERED_HTTP_MAX;
}

/**
 * 同じ判定の SQL 述語。alias は呼び出し側のコードが決める識別子だけを許す
 * （利用者入力は通らないが、境界を式で伸ばせないことを型でなく検査で固定する）。
 */
export function deliveredPredicate(alias = ""): string {
  if (alias !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`deliveredPredicate: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  }
  const p = alias === "" ? "" : `${alias}.`;
  return `${p}status = 'settled' AND ${p}http_status_paid BETWEEN ${DELIVERED_HTTP_MIN} AND ${DELIVERED_HTTP_MAX}`;
}
