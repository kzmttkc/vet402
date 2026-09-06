import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, refundRateLimitUnits, withRateLimitHeaders, type AuthorizedContext } from "@/lib/api/guard";
import { publicRateLimit } from "@/lib/api/public-route";
import { isDecisionKeylessReadEnabled } from "@/lib/config/env";
import { getIdempotentResponse, idempotencyKeyHash, saveIdempotentResponse } from "@/lib/api/idempotency";
import { lookupManualList } from "@/lib/db/customer-lists";
import { decide } from "@/lib/decision/decide";
import { SHA256_HEX_RE, parsePartyId, payeeId as toPartyId } from "@/lib/ids/canonical";
import { getResource } from "@/lib/resolve/lookup";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";
import { logServerError } from "@/lib/util/log";

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
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ resourceId: string }> };

const IDEMPOTENCY_TTL_MS = 10 * 60_000;
export const DECISION_KEYLESS_LIMIT = 10;
const DECISION_KEYLESS_WINDOW_MS = 60_000;

/** 鍵あり（月次枠）か鍵なし（IP 枠）かで、返金と応答ヘッダの付け方が変わる。 */
type Caller =
  | { kind: "keyed"; ctx: AuthorizedContext }
  | { kind: "keyless"; headers: Record<string, string> };

function hasAuthorizationHeader(request: NextRequest): boolean {
  return (request.headers.get("authorization") ?? "").trim() !== "";
}

async function admit(request: NextRequest): Promise<{ ok: true; caller: Caller } | { ok: false; error: NextResponse }> {
  if (isDecisionKeylessReadEnabled() && !hasAuthorizationHeader(request)) {
    const gate = await publicRateLimit(request, "decision", DECISION_KEYLESS_LIMIT, DECISION_KEYLESS_WINDOW_MS);
    if (!gate.ok) return { ok: false, error: gate.response };
    return { ok: true, caller: { kind: "keyless", headers: gate.headers } };
  }
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return { ok: false, error: auth.error };
  return { ok: true, caller: { kind: "keyed", ctx: auth.ctx } };
}

function refund(caller: Caller): void {
  if (caller.kind === "keyed") void refundRateLimitUnits(caller.ctx, 1);
}

/** 判定応答の Cache-Control は従来どおり付けない（鍵ありと同じ）。枠のヘッダだけ経路ごとに変える。 */
function finish(caller: Caller, res: NextResponse): NextResponse {
  if (caller.kind === "keyed") return withRateLimitHeaders(res, caller.ctx.rateLimit);
  for (const [k, v] of Object.entries(caller.headers)) res.headers.set(k, v);
  return res;
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
  if (!SHA256_HEX_RE.test(resourceId)) {
    refund(caller);
    return NextResponse.json({ error: "invalid_resource_id" }, { status: 400 });
  }
  const params = request.nextUrl.searchParams;
  const roleRaw = params.get("role") ?? "payer";
  if (roleRaw !== "payer" && roleRaw !== "payee") {
    refund(caller);
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }
  const dialectRaw = params.get("caller_dialect");
  if (dialectRaw !== null && dialectRaw !== "v1" && dialectRaw !== "v2") {
    refund(caller);
    return NextResponse.json({ error: "invalid_caller_dialect" }, { status: 400 });
  }
  let payerId: string | null = null;
  if (roleRaw === "payee") {
    const p = params.get("payer");
    payerId = p ? normalizePayer(p) : null;
    if (!payerId) {
      refund(caller);
      return NextResponse.json({ error: "payer_required" }, { status: 400 });
    }
  }
  const allowWithoutL1 = params.get("allow_without_l1") === "true";

  const idemKey = request.headers.get("idempotency-key");
  const idemHash =
    idemKey && apiKeyId ? idempotencyKeyHash([apiKeyId, resourceId, roleRaw, payerId ?? "-", idemKey.slice(0, 128)]) : null;
  if (idemHash) {
    const saved = await getIdempotentResponse(idemHash);
    if (saved !== null) {
      refund(caller);
      const res = finish(caller, NextResponse.json(saved));
      res.headers.set("Idempotent-Replay", "true");
      return res;
    }
  }

  try {
    const ref = await getResource(resourceId);
    if (!ref) {
      refund(caller);
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // 顧客の WL/BL は私的ポリシー（§13）。判定に効かせるが facts には混ぜない。
    const listSubject = roleRaw === "payer" ? ref.payee_id ? parsePartyId(ref.payee_id)?.address ?? null : null : parsePartyId(payerId!)?.address ?? null;
    const list = await lookupManualList(apiKeyId, listSubject && listSubject.startsWith("0x") ? listSubject : null);
    const operatorBlacklist = list === "blacklist";

    const result =
      roleRaw === "payer"
        ? await decide({ role: "payer", observatoryId: ref.observatory_id, callerDialect: dialectRaw ?? undefined, allowWithoutL1, operatorBlacklist })
        : await decide({ role: "payee", observatoryId: ref.observatory_id, payerId: payerId!, operatorBlacklist });
    if (!result) {
      refund(caller);
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // 2026-09-02: §12 の SLO（p95 < 200ms・キャッシュヒット）はサーバ内時間で測る。東京からの
    // 壁時計（0.44–0.77s）では往復が混ざるので、計算時間を Server-Timing で返す。
    // 成功応答だけ保存する（404/503 は再送で再計算してよい——直った可能性がある）。
    if (idemHash) await saveIdempotentResponse(idemHash, result, IDEMPOTENCY_TTL_MS);
    const res = finish(caller, NextResponse.json(result));
    res.headers.set("Server-Timing", `decision;dur=${(performance.now() - t0).toFixed(1)}`);
    return res;
  } catch (error) {
    logServerError("decision", error);
    refund(caller);
    return NextResponse.json({ error: "decision_unavailable" }, { status: 503 });
  }
}
