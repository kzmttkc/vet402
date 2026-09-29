import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, refundRateLimitUnits, withRateLimitHeaders, type AuthorizedContext } from "@/lib/api/guard";
import { publicRateLimit } from "@/lib/api/public-route";
import { refundIpRateLimit } from "@/lib/api/ip-rate-limit";
import { isDecisionKeylessReadEnabled } from "@/lib/config/env";
import { getIdempotentResponse, idempotencyKeyHash, saveIdempotentResponse } from "@/lib/api/idempotency";
import { lookupManualList } from "@/lib/db/customer-lists";
import { decide, presentDecision, type DecisionResult } from "@/lib/decision/decide";
import { evaluateCallerPolicy, parseCallerPolicy, type CallerPolicyInput } from "@/lib/decision/caller-policy";
import { SHA256_HEX_RE, parsePartyId, payeeId as toPartyId } from "@/lib/ids/canonical";
import { getResource, hostListingSummary } from "@/lib/resolve/lookup";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { lookupCallerMaterial } from "@/lib/decision/lookup-caller";

// §9.1: GET /api/v1/resources/{resource_id}/decision?role=payer|payee&caller_dialect=v1|v2
//   role=payer  「このURLは今、宣言どおり届くか」→ 売り手事実 + 判定
//   role=payee  「この支払元を通してよいか」→ payer 必須。買い手事実 + 判定
// facts と recommendation は同じ応答に同居する。facts を省く経路は無い。
// Idempotency-Key（§9.3）: 同一 (キー, resource, role, payer, key) の再試行は
// 10 分間、レート単位を二重に消費せず、**保存した応答をそのまま返す**（再計算しない）。
// 2026-09-04 監査 B・P2: 以前はプロセス内 Map で「見た」ことだけを覚え、再送は毎回
// 再計算していた。Vercel の別インスタンスに落ちた再送は初回扱いになり同じキーで
// 違う応答が返り得た。保存先は decision_idempotency（src/lib/api/idempotency.ts）。
// 鍵なし読み取り（AQ-053・2026-09-07 Takeshi 承認）: Authorization ヘッダが**無い**呼び出しは
// IP ごと DECISION_KEYLESS_LIMIT 回/分で答える（census/summary と同じ publicRateLimit・語彙は
// `rate_limited`）。本文は鍵ありと同一。鍵ありは従来の月次プラン枠のままで、この IP 枠には
// 掛からない。ヘッダはあるが鍵が違う呼び出しは匿名に**落とさず** 401 のまま——落とすと
// 鍵を打ち間違えた顧客の WL/BL（§13 私的ポリシー）が黙って外れた答えを受け取る。
// 鍵なしでは Idempotency-Key を扱わない（月次単位の二重消費という守る対象が無い）。
// DECISION_KEYLESS_READ=0 で従来の 401 に戻す。
// 早期 return（400 / 404 / 503・2026-09-07 監査 A7＋追加3）: admit 以降のどの return も `fail()` → `finish()` を
// 通す。以前は 404 と 400 が枠のヘッダ無しで返り、鍵なしは refund の経路も無く枠だけ消費していた。
// 規則は鍵ありに揃える——鍵ありが月次単位を refund するのと同じく、鍵なしも IP 枠の 1 回分を戻す。
// 呼び手の policy（2026-09-07・WINDOW_PLAN §16.3）: `amount_usd` / `max_per_tx_usd` / `min_l1_deliveries`
// を受けると、判定と同じ文書に `caller_policy` を足し、SDK と同じ語（`price_above_ceiling` 等）で
// 答える。§16.3 の A/B で「ツールが返さない語は Recipe があっても出ない」ことが実測されたので、
// 語を製品側で返す。判定（`recommendation`）は書き換えない。クエリが無ければ何も足さない。
// role=payee には当てない（価格と売り手の床は role=payer の問い。SDK も payer しか引かない）。
// Idempotency-Key の材料にも policy を含める——同じキーで違う policy を送った再送に、
// 別の policy で保存した応答を返さない。保存するのは判定本体だけで、policy は取り出すたびに当てる
// （純関数なので同じ材料には同じ答えが出る）。
// 移行期の score（2026-09-29.3・監査 6 周目）: 既定の応答には載せない。`include_score=1` のときだけ
// `score`（superseded_by: "recommendation"・判定には使わない）を返す。SDK と MCP は判定の score を読まない。
// 保存（冪等）とキャッシュは score 付きの全体で持ち、配る直前に presentDecision を通す。
// 表記の揺れ（2026-09-29 監査 7 周目・高）: resource_id の完全一致が無ければ別名の表で正規の id に直す
// （getResource・src/lib/resolve/aliases.ts）。それでも無い 404 は、`url=` があればそのホストに掲載があるかを
// `host_known` で返す（notFoundBody）。`error` の語は `not_found` のまま。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ resourceId: string }> };

const IDEMPOTENCY_TTL_MS = 10 * 60_000;
export const DECISION_KEYLESS_LIMIT = 10;
const DECISION_KEYLESS_WINDOW_MS = 60_000;

/** 鍵あり（月次枠）か鍵なし（IP 枠）かで、返金と応答ヘッダの付け方が変わる。 */
type Caller =
  | { kind: "keyed"; ctx: AuthorizedContext }
  | { kind: "keyless"; headers: Record<string, string>; bucketKey: string };

function hasAuthorizationHeader(request: NextRequest): boolean {
  return (request.headers.get("authorization") ?? "").trim() !== "";
}

async function admit(request: NextRequest): Promise<{ ok: true; caller: Caller } | { ok: false; error: NextResponse }> {
  if (isDecisionKeylessReadEnabled() && !hasAuthorizationHeader(request)) {
    const gate = await publicRateLimit(request, "decision", DECISION_KEYLESS_LIMIT, DECISION_KEYLESS_WINDOW_MS);
    if (!gate.ok) return { ok: false, error: gate.response };
    return { ok: true, caller: { kind: "keyless", headers: gate.headers, bucketKey: gate.bucketKey } };
  }
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return { ok: false, error: auth.error };
  return { ok: true, caller: { kind: "keyed", ctx: auth.ctx } };
}

function refund(caller: Caller): void {
  if (caller.kind === "keyed") void refundRateLimitUnits(caller.ctx, 1);
  else void refundIpRateLimit(caller.bucketKey);
}

/** 判定応答の Cache-Control は従来どおり付けない（鍵ありと同じ）。枠のヘッダだけ経路ごとに変える。 */
function finish(caller: Caller, res: NextResponse): NextResponse {
  if (caller.kind === "keyed") return withRateLimitHeaders(res, caller.ctx.rateLimit);
  for (const [k, v] of Object.entries(caller.headers)) res.headers.set(k, v);
  return res;
}

/** 早期 return の唯一の形: 枠を戻し、枠のヘッダを付けて、エラー語を返す（A7）。`finish` を通らない return を書かない。 */
// 2026-09-29 ペルソナ監査: エラーの語だけでは次に何をすればよいか分からない。`error` の語は変えず（SDK が読む）、
// 何が起きたかと次の一手を `message` に足す。
const FAIL_MESSAGES: Record<string, string> = {
  invalid_resource_id:
    "resource_id must be 64 lowercase hex characters (sha256). Get it from a URL with GET /api/v1/resolve?q=<the URL that answers 402>, then call this path again.",
};

function fail(caller: Caller, status: number, error: string): NextResponse {
  refund(caller);
  const message = FAIL_MESSAGES[error];
  return finish(caller, NextResponse.json(message ? { error, message } : { error }, { status }));
}

/**
 * 404 の本文（2026-09-29 監査 7 周目・高）。`error: "not_found"` は従来どおり（凍結中の SDK はこの語だけを読む）。
 * `url=` を受けたら、その URL と同じホスト（サブドメインは含めない）に**掲載中**の出品があるかを `host_known`、
 * その受取人の人数を `host_sellers` で返す。取り下げ済みだけのホストは false。url が無い・正規形にならないときは null。
 * 受取人が 1 人のホストの未掲載の URL は、その売り手の掲載の別の書き方かもしれない（MCP は払わない）。
 * 共有ホスト（受取人 2 人以上）の未掲載の売り手は、判定なし（MCP の resource_unresolved）。
 */
async function notFoundBody(rawUrl: string | null): Promise<Record<string, unknown>> {
  let summary: { known: boolean; sellers: number } | null = null;
  if (rawUrl && rawUrl.length <= 2048) {
    try {
      summary = await hostListingSummary(rawUrl);
    } catch (error) {
      logServerErrorSafe("decision.host_known", error);
      summary = null;
    }
  }
  const hostKnown = summary ? summary.known : null;
  const resolveUrl = `https://vet402.com/api/v1/resolve?q=${encodeURIComponent(rawUrl && summary ? rawUrl : "<url>")}`;
  const message =
    summary?.known === true
      ? summary.sellers > 1
        ? `No listing has this resource_id. vet402 has listings from ${summary.sellers} sellers on this URL's host, so an unlisted URL there is judged by nothing here; ` +
          "resolve the URL with /api/v1/resolve (add &method=<METHOD>) before you pay."
        : "No listing has this resource_id, but vet402 has a live listing on this URL's host, so the id may be another spelling of a listed URL. " +
          "Resolve the URL with /api/v1/resolve (add &method=<METHOD>) and read that listing's decision before you pay. Do not treat this seller as unlisted."
      : summary?.known === false
        ? "No listing has this resource_id and vet402 has no live listing on this URL's host: the seller is not in vet402's catalog."
        : 'No listing has this resource_id. resource_id is sha256("<METHOD> <canonical url>"): resolve the URL with /api/v1/resolve before you pay. ' +
          "Pass url=<the URL> here to learn whether vet402 has live listings on its host (host_known).";
  return { error: "not_found", host_known: hostKnown, host_sellers: summary ? summary.sellers : null, message, next: resolveUrl };
}

function normalizePayer(raw: string): string | null {
  const v = raw.trim();
  if (parsePartyId(v)) return v.startsWith("eip155:") ? v.toLowerCase() : v;
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return toPartyId("eip155:8453", v);
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return toPartyId(SOLANA_MAINNET_CAIP2, v);
  return null;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const t0 = performance.now();
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.error;
  const { caller } = admitted;
  const apiKeyId = caller.kind === "keyed" ? caller.ctx.apiKeyId : undefined;

  const { resourceId } = await context.params;
  if (!SHA256_HEX_RE.test(resourceId)) return fail(caller, 400, "invalid_resource_id");
  const params = request.nextUrl.searchParams;
  const roleRaw = params.get("role") ?? "payer";
  if (roleRaw !== "payer" && roleRaw !== "payee") return fail(caller, 400, "invalid_role");
  const dialectRaw = params.get("caller_dialect");
  if (dialectRaw !== null && dialectRaw !== "v1" && dialectRaw !== "v2") return fail(caller, 400, "invalid_caller_dialect");
  let payerId: string | null = null;
  if (roleRaw === "payee") {
    const p = params.get("payer");
    payerId = p ? normalizePayer(p) : null;
    if (!payerId) return fail(caller, 400, "payer_required");
  }
  const allowWithoutL1 = params.get("allow_without_l1") === "true";
  const includeScoreRaw = params.get("include_score");
  if (includeScoreRaw !== null && includeScoreRaw !== "0" && includeScoreRaw !== "1") return fail(caller, 400, "invalid_include_score");
  const includeScore = includeScoreRaw === "1";
  const parsedPolicy = parseCallerPolicy(params);
  if (!parsedPolicy.ok) return fail(caller, 400, parsedPolicy.error);
  const callerPolicy: CallerPolicyInput | null = parsedPolicy.input;
  if (callerPolicy && roleRaw !== "payer") return fail(caller, 400, "invalid_policy");
  /** policy を頼まれたときだけ足す。頼まれていなければ判定本体をそのまま返す（キーも足さない）。 */
  const withCallerPolicy = (result: DecisionResult): DecisionResult =>
    presentDecision(callerPolicy ? { ...result, caller_policy: evaluateCallerPolicy(result, callerPolicy) } : result, { includeScore });

  const idemKey = request.headers.get("idempotency-key");
  const idemHash =
    idemKey && apiKeyId
      ? idempotencyKeyHash([
          apiKeyId,
          resourceId,
          roleRaw,
          payerId ?? "-",
          callerPolicy ? JSON.stringify(callerPolicy) : "-",
          idemKey.slice(0, 128),
        ])
      : null;
  if (idemHash) {
    const saved = await getIdempotentResponse(idemHash);
    if (saved !== null) {
      refund(caller);
      const res = finish(caller, NextResponse.json(withCallerPolicy(saved as DecisionResult)));
      res.headers.set("Idempotent-Replay", "true");
      return res;
    }
  }

  try {
    const ref = await getResource(resourceId);
    if (!ref) {
      const errorBody = await notFoundBody(params.get("url"));
      refund(caller);
      return finish(caller, NextResponse.json(errorBody, { status: 404 }));
    }
    // 顧客の WL/BL は私的ポリシー（§13）。判定に効かせるが facts には混ぜない。
    const listSubject = roleRaw === "payer" ? ref.payee_id ? parsePartyId(ref.payee_id)?.address ?? null : null : parsePartyId(payerId!)?.address ?? null;
    const list = await lookupManualList(apiKeyId, listSubject && listSubject.startsWith("0x") ? listSubject : null);
    const operatorBlacklist = list === "blacklist";

    // 2026-09-29 監査 5 周目: 問い合わせは呼び手 × endpoint × UTC 日で 1 回だけ数える。6 周目: 数えるのは鍵ありの
    // 呼び手だけ・別サイトから（Sec-Fetch-Site: cross-site）と売り手頁の自動の呼び出しは数えない（lookup-caller.ts）。
    // 独立レビュー（中）: 数える単位は鍵ではなく鍵の持ち主（1 人が 10 本まで鍵を持てる）。
    const ownerId = caller.kind === "keyed" ? caller.ctx.ownerId : undefined;
    const callerMaterial = lookupCallerMaterial({ apiKeyId, ownerId, headers: request.headers });
    const result =
      roleRaw === "payer"
        ? await decide({ role: "payer", observatoryId: ref.observatory_id, callerDialect: dialectRaw ?? undefined, allowWithoutL1, operatorBlacklist, callerMaterial })
        : await decide({ role: "payee", observatoryId: ref.observatory_id, payerId: payerId!, operatorBlacklist, callerMaterial });
    if (!result) return fail(caller, 404, "not_found");
    // 2026-09-02: §12 の SLO（p95 < 200ms・キャッシュヒット）はサーバ内時間で測る。東京からの
    // 壁時計（0.44–0.77s）では往復が混ざるので、計算時間を Server-Timing で返す。
    // 成功応答だけ保存する（404/503 は再送で再計算してよい——直った可能性がある）。
    if (idemHash) await saveIdempotentResponse(idemHash, result, IDEMPOTENCY_TTL_MS);
    const res = finish(caller, NextResponse.json(withCallerPolicy(result)));
    res.headers.set("Server-Timing", `decision;dur=${(performance.now() - t0).toFixed(1)}`);
    return res;
  } catch (error) {
    logServerErrorSafe("decision", error);
    return fail(caller, 503, "decision_unavailable");
  }
}
