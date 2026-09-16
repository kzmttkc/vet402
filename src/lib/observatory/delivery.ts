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
//
// 売り手の不履行として数えない行（Issue #29・2026-09-17）。
//
// 2026-09-05 の inconclusive は「決済が成立したうえで有料応答が 4xx」だけだった。
// ところが売り手が**決済する前に**我々の要求を検証して 4xx で断ると、行は
// `settle_failed`・tx なしで記録され、厳しい箱に入る——誠実に事前検証する売り手ほど
// 悪く見える逆転（公開 export 2026-09-16 取得・直近 30 日: settle_failed・tx なし・
// 402 以外の 4xx が 2,487 行、決済後 4xx の 266 行の 9 倍）。ラベルは理由に従う
// （我々が要求を組めなかった）のであって、金が動いたかどうかには従わない。
//
// もう 1 つは我々自身の資金切れ（PAYER_UNFUNDED_WINDOWS）。その期間に売り手が
// 402 で断ったのは我々の支払いに中身が無かったからで、売り手の記録ではない。
//
// 理由（HeldReason）:
//   settled_4xx     settled かつ有料応答 4xx（2026-09-05 からの既存規則のまま）
//   unsettled_4xx   settle_failed・tx なし・有料応答 4xx（402 を除く）
//   payer_unfunded  settle_failed・tx なし・402 または 5xx・Base・資金切れ期間の内側
// 期間の外の 5xx は救わない（売り手側の障害は我々の要求の形で説明がつかない）。期間の外の
// 402 は「売り手が我々の支払いを受け付けなかった」事実として従来どおり数える。
//
// 注意（2026-09-17 実測）: `settle_failed`・4xx・tx なしで書かれた行の一部は、売り手が
// 後から決済していて recover-late.ts が settle_claimed → settled へ戻す（09-11〜16 の
// 遅延回収 27 行のうち 15 行が 4xx）。だから unsettled_4xx は「決済前に断られた」と
// 断定する語ではなく「決済レシートが返らずに 4xx」を指す。回収されれば settled_4xx に
// 移るので、どちらの時点でも同じく保留に入る（途中の settle_claimed の間だけは保留に入らない）。
//
// 行は消さない。公開面の件数（n_attempts / attempts）には入ったまま、判定の分母
// （rules.ts の conclusive = n_attempts − n_inconclusive）と delivered の分母から外す。
// JS（heldReasonOf）と SQL（heldReasonSql）は同じ定数から作り、DB テスト
// （tests/l1-held-rows.pg.test.ts）が同じ台帳を両方から数えて一致を固定する。
// ------------------------------------------------------------
export const INCONCLUSIVE_HTTP_MIN = 400;
export const INCONCLUSIVE_HTTP_MAX = 499;
/** 402 は「支払いが受け付けられなかった」であって要求の形の問題ではない（A から除く）。 */
export const PAYMENT_REQUIRED_HTTP = 402;
/** 資金切れ期間に payer_unfunded として保留にする 5xx の範囲。 */
export const SERVER_ERROR_HTTP_MIN = 500;
export const SERVER_ERROR_HTTP_MAX = 599;

export type HeldReason = "settled_4xx" | "unsettled_4xx" | "payer_unfunded";
export const HELD_REASONS: readonly HeldReason[] = ["settled_4xx", "unsettled_4xx", "payer_unfunded"];

/**
 * 我々の購入元ウォレットの USDC が尽きていた期間。[from, until)。
 *
 * Base の購入元 0xc9c7b38C0942914fC8EA12063BC92dcd3b581670 の USDC 残高は 2026-09-16 の
 * 実測で 0.000275 USDC。公開 export（2026-09-16 取得）では 2026-09-13 の最初のバッチから
 * 支払い付き要求が 402 で断られ始め（09-12 は 402 が 0 件、09-13/14/15 は 314/313/352 件）、
 * 補充後の最初の成立は 2026-09-15T23:49Z（手動実行）。期間内の settle_failed・402・tx なしは
 * 972 行・965 エンドポイント、うち 57 エンドポイントが「納品 0・署名 3 件以上」で BLOCK に
 * 届きうる状態だった。
 *
 * 5xx も同じ期間に含める（2026-09-17 独立検証役の実測・公開 export）: Base の支払い付き要求への
 * 5xx（settle_failed・tx なし）が 09-13/14/15 に 17/27/17 件、前後の日は 0〜11 件（09-12 は 11、
 * 09-16 は 3）。期間内 60 行・60 エンドポイント（500×50・503×8・502×2）。中身の無い支払いを
 * 検証できずに落ちる売り手の実装が 5xx を返したと読むのが自然で、期間の外の 5xx とは区別する。
 * 以後は l1-runner の残高の関門（payer-funds.ts）が署名の前に止めるので、
 * この表に行を足す運用にはしない。
 */
export const PAYER_UNFUNDED_WINDOWS: readonly { networks: readonly string[]; from: string; until: string }[] = [
  { networks: ["eip155:8453", "base"], from: "2026-09-13T00:00:00Z", until: "2026-09-15T23:49:00Z" },
];

export type HeldRowInput = {
  status: string;
  httpStatusPaid: number | null;
  txHash: string | null;
  /** Date、ISO8601、または Postgres の timestamptz::text。読めなければ期間の外として扱う。 */
  attemptedAt: string | Date | null;
  network: string | null;
};

function epochMs(v: string | Date | null): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

function is4xx(code: number | null | undefined): code is number {
  return typeof code === "number" && code >= INCONCLUSIVE_HTTP_MIN && code <= INCONCLUSIVE_HTTP_MAX;
}

/** 売り手の不履行として数えない理由。数える行は null。 */
export function heldReasonOf(row: HeldRowInput): HeldReason | null {
  const code = row.httpStatusPaid;
  if (row.status === "settled") return is4xx(code) ? "settled_4xx" : null;
  if (row.status !== "settle_failed" || (row.txHash !== null && row.txHash !== undefined)) return null;
  if (is4xx(code) && code !== PAYMENT_REQUIRED_HTTP) return "unsettled_4xx";
  const unfundedShape =
    code === PAYMENT_REQUIRED_HTTP ||
    (typeof code === "number" && code >= SERVER_ERROR_HTTP_MIN && code <= SERVER_ERROR_HTTP_MAX);
  if (!unfundedShape) return null;
  const at = epochMs(row.attemptedAt);
  if (at === null) return null;
  for (const w of PAYER_UNFUNDED_WINDOWS) {
    if (!w.networks.includes(row.network ?? "")) continue;
    if (at >= Date.parse(w.from) && at < Date.parse(w.until)) return "payer_unfunded";
  }
  return null;
}

/**
 * 判定を保留にした行（`heldReasonOf` が理由を返す行）。**我々が正しいリクエストを
 * 組めなかった、または我々の支払いに中身が無かった可能性が消せない**ので、
 * 売り手の不履行として数えない。
 */
export function isInconclusive(row: HeldRowInput): boolean {
  return heldReasonOf(row) !== null;
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

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function sqlStringList(values: readonly string[]): string {
  for (const v of values) {
    if (!/^[A-Za-z0-9:_-]+$/.test(v)) throw new Error(`delivery: unexpected network literal ${JSON.stringify(v)}`);
  }
  return values.map((v) => `'${v}'`).join(", ");
}

/** `heldReasonOf` と同じ規則の SQL 式（理由の文字列、数える行は NULL）。 */
export function heldReasonSql(alias = ""): string {
  const p = assertAlias("heldReasonSql", alias);
  const windows = PAYER_UNFUNDED_WINDOWS.map((w) => {
    if (!ISO_RE.test(w.from) || !ISO_RE.test(w.until)) throw new Error("delivery: PAYER_UNFUNDED_WINDOWS must be ISO8601 UTC");
    return `(${p}network IN (${sqlStringList(w.networks)}) AND ${p}attempted_at >= '${w.from}'::timestamptz AND ${p}attempted_at < '${w.until}'::timestamptz)`;
  });
  const inWindow = windows.length ? windows.join(" OR ") : "false";
  const fourxx = `${p}http_status_paid BETWEEN ${INCONCLUSIVE_HTTP_MIN} AND ${INCONCLUSIVE_HTTP_MAX}`;
  return (
    `CASE` +
    ` WHEN ${p}status = 'settled' AND ${fourxx} THEN 'settled_4xx'` +
    ` WHEN ${p}status = 'settle_failed' AND ${p}tx_hash IS NULL AND ${fourxx} AND ${p}http_status_paid <> ${PAYMENT_REQUIRED_HTTP} THEN 'unsettled_4xx'` +
    ` WHEN ${p}status = 'settle_failed' AND ${p}tx_hash IS NULL AND (${p}http_status_paid = ${PAYMENT_REQUIRED_HTTP} OR ${p}http_status_paid BETWEEN ${SERVER_ERROR_HTTP_MIN} AND ${SERVER_ERROR_HTTP_MAX}) AND (${inWindow}) THEN 'payer_unfunded'` +
    ` END`
  );
}

/** `isInconclusive` と同じ規則の SQL 述語。 */
export function inconclusivePredicate(alias = ""): string {
  assertAlias("inconclusivePredicate", alias);
  return `(${heldReasonSql(alias)}) IS NOT NULL`;
}

/**
 * payer_unfunded ではない行（2026-09-17 Issue #29 の独立検証）。status を直接読む公開面
 * （/decisions の損失・backtest の事前シグナル・受取スコアの天井）が、我々の資金切れの行を
 * 売り手や支出の事実として数えないために使う。
 */
export function notPayerUnfundedPredicate(alias = ""): string {
  assertAlias("notPayerUnfundedPredicate", alias);
  return `(${heldReasonSql(alias)}) IS DISTINCT FROM 'payer_unfunded'`;
}

/** settled のうち保留にした行（delivered の分母から外す分）。 */
export function inconclusiveSettledPredicate(alias = ""): string {
  assertAlias("inconclusiveSettledPredicate", alias);
  return `(${heldReasonSql(alias)}) = 'settled_4xx'`;
}
