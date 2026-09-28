// ============================================================
// retest（公平な買い直し）の 1 段目の問い合わせと、census の売り手の単位（ホスト名）の SQL 式。
//
// 2026-09-28: l1-runner.ts から**そのまま**移した（文は 1 文字も変えていない）。/sellers の公開頁が
// 同じ問い合わせを読むので、支払いの依存（viem・@solana/web3.js・payer-funds …）を持つ l1-runner を
// 頁が import しなくて済むようにする。l1-runner はここから import して使う。このファイルに支払いの
// 依存を足さない（tests/sellers-no-payment-imports.test.ts が /sellers からの import の到達を検査する）。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import { heldReasonSql } from "./delivery";
import { bodyNotSentOnOurSideSql } from "./request-body";
import { queryNotSentOnOurSideSql } from "./request-query";

/**
 * census（2026-09-28）の「売り手」の単位＝ホスト名。resource_key は host+path に正規化済み
 * （catalog-source normalizeResourceKey）なので、最初の `/` の前を取り、末尾の `:ポート` を落として
 * 小文字にする（独立レビュー 2026-09-28: 本番では api.verigrace.com:4449/4450/4451 が 3 つの売り手として
 * 数えられ 3 回買われるところだった）。JS 側の censusHostOf と同じ規則。
 */
export const censusHostSql = (resourceKey: SQL) => sql`lower(regexp_replace(split_part(${resourceKey}, '/', 1), ':[0-9]+$', ''))`;

/**
 * 公平な買い直し（retest・2026-09-28）の対象の売り手（ポートを除いたホスト名）。その売り手の**最新の**
 * L1 行（全エンドポイントを通して attempted_at が最も新しい 1 行）が、こちらの側の理由で失敗しているもの:
 *
 *  (a) held_reason が payer_unfunded（delivery.ts heldReasonSql と同じ式——こちらの購入元の残高切れの期間に
 *      402 / 5xx で決済されなかった Base の行）;
 *  (b) 支払い付きの POST が HTTP 400・415 または 422 で決済されず（settle_failed・tx なし）、宣言された本文を送る実装より前
 *      （DECLARED_BODY_SENT_SINCE より前で、行に requestBody の記録も無い＝`{}` を送った）で、かつ今のカタログの
 *      そのエンドポイントが本文を宣言している（declared_schema の properties.input.properties.body がある、または
 *      2026-09-29 から declared_input.body = declared＝送る規則なら宣言の本文を送る）。
 *      宣言が無いなら、`{}` で断られたのはこちらの落ち度とは言えないので対象にしない。GET は本文を送らない
 *      （今も送らない）ので対象にしない。422 は `{}` を検証で弾く実装が多い（レビュー 2026-09-28・本番 26 売り手）。
 *      401・403 は認可の話で本文とは言えないので入れない。
 *
 *  (c) Base（eip155:8453 / base）の支払い付き要求が HTTP 400 または 422 で決済されず（settle_failed・tx なし）、
 *      Base で宣言クエリを送り始めた時刻（request-query.ts BASE_DECLARED_QUERY_SINCE）より前で、行に requestQuery の
 *      記録が無い（または empty）、かつ今のカタログのそのエンドポイントが**必須の**クエリを宣言している
 *      （declared_schema の properties.input.properties.queryParams.required が空でない・2026-09-28）か、送る規則なら宣言の
 *      クエリを足す（declared_input.query = declared・2026-09-29。見本値だけで宣言する売り手を拾う）。XRPL は 2026-09-21 から
 *      送っていたので (c) に入らない。メソッドは問わない（クエリは GET にも POST にも足す）。
 *
 * 返すのは売り手ごとに host・reason（"unfunded" | "body" | "query"）・その最新の行の endpoint_id。(b)(c) では失敗した
 * 出品そのものを優先して買い直す（runL1Batch の retest の段）。
 *
 * これは**単独の問い合わせ**として 1 回だけ流し、結果（ホストと優先する出品の id）を候補の問い合わせへ JSON の
 * パラメータで渡す（独立レビュー W3・2026-09-28）: 以前は候補の WHERE に `IN (この問い合わせ)` として埋めていて、
 * プランナーが行数を 49 と見誤り、ネストループの中でホストの正規表現を「ホスト数 × 出品数」回計算していた
 * （本番の EXPLAIN で 5,041 ms・census は 172 ms）。
 */
// (b)(c) の判定は request-body.ts / request-query.ts が正典（/sellers と共有・JS の述語と SQL の断片の組）。
// 2026-09-29: 宣言の有無は送る規則と同じ情報源（declared_input）でも見る。本文は 415 も入る。
const RETEST_BODY_COND = sql.raw(bodyNotSentOnOurSideSql({ row: "lr", method: "lr.method", schema: "lr.declared_schema", input: "lr.declared_input" }));
const RETEST_QUERY_COND = sql.raw(queryNotSentOnOurSideSql({ row: "lr", schema: "lr.declared_schema", input: "lr.declared_input" }));
export const RETEST_SELLERS_SQL = sql`
  SELECT lr.host,
         CASE WHEN lr.held = 'payer_unfunded' THEN 'unfunded' WHEN ${RETEST_BODY_COND} THEN 'body' ELSE 'query' END AS reason,
         lr.endpoint_id::text AS endpoint_id
  FROM (
    SELECT DISTINCT ON (${censusHostSql(sql`te.resource_key`)})
           ${censusHostSql(sql`te.resource_key`)} AS host,
           (${sql.raw(heldReasonSql("tp"))}) AS held,
           tp.endpoint_id, tp.network, tp.status, tp.tx_hash, tp.http_status_paid, tp.attempted_at, tp.raw_response_meta,
           te.method, te.declared_schema, te.declared_input
    FROM x402_l1_purchases tp JOIN x402_endpoints te ON te.id = tp.endpoint_id
    ORDER BY ${censusHostSql(sql`te.resource_key`)}, tp.attempted_at DESC, tp.id DESC
  ) lr
  WHERE lr.held = 'payer_unfunded' OR ${RETEST_BODY_COND} OR ${RETEST_QUERY_COND}`;
