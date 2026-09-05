// ============================================================
// 売り手の署名付き異議（C8）——中立性の制度化。
//
// 申し立てられるのは endpoint の payTo を実際に握る者だけ（EIP-191。
// Solana payTo の Ed25519 は後続——v0 は 0x のみ）。受理と同時に本物の
// L0 を1回再測定し、**通常のプローブ行として**台帳へ書く——demo と違い
// これは正規の測定（売り手起点というだけ）で、公開判定の2連続fail
// ゲートも普段どおり適用される。申し立てで記録が消えることはない。
//
// メッセージ正規形（署名対象）は disputeMessage を参照。2026-09-05 に
// コロン区切りの1行から改行区切りの人間可読へ移し、1行目で vet402.com を
// 名乗り、2行目に domain 行を置き、reason の先頭200字を平文で畳み込んだ
// （それまでは sha256 しか入らず、署名画面で自分の主張が読めなかった）。
// reason 本文は台帳に原文保存（監査可能性）。旧形式は
// LEGACY_MESSAGE_ACCEPT_UNTIL まで受理する。
//
// 2026-08-22（監査残件）: v0 のメッセージには nonce も timestamp も無く、
// 公開された署名を拾った第三者が同じ申し立てを無限に再送できた（受理1件
// につき本物の L0 再測定＝外向きHTTPが1回走る）。payees/verify と
// agents/verify で 2026-08-18 に塞いだのと同じ方式——署名対象に `issued`
// を畳み込み、サーバ側で鮮度窓を検証する（src/lib/verify-message.ts の
// isValidIssuedAt が形を保証し、改行の混入で行を偽造できない）。
// 併せて同一メッセージの二重受理を拒否するので、窓の内側でも1回きり。
// 接頭辞を v1 へ上げたのは、台帳に残る過去の v0 原文と新形式を後から
// 取り違えないため。
// ============================================================
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { disputes, x402Endpoints, x402L0Probes } from "@/lib/db/schema";
import { isValidIssuedAt, matchSignatureForm, SIGNING_DOMAIN } from "@/lib/verify-message";
import { logAndSwallow } from "@/lib/util/log";
import { invalidateDecisionCache } from "@/lib/decision/cache";
import { probeEndpoint, type ProbeOptions } from "./l0-probe";
import { UUID_RE } from "@/lib/validation/uuid";
import { isDisputeRateLimited, recentDisputeTimes, recordCorrection } from "./corrections";
import { publishedVerdict } from "./l0-probe";

/**
 * 署名の `issued` がサーバ時刻からどれだけずれてよいか。payees/verify の
 * ISSUED_WINDOW_MS と同じ 10 分（両方向に効かせる——古すぎるのは再送、
 * 未来すぎるのは窓を先取りして貯め込む使い方）。
 */
const ISSUED_WINDOW_MS = 10 * 60_000;

const SUBJECTS = new Set(["l0", "l1", "listing"]);

/** 署名本文に畳み込む reason の平文の長さ（先頭から数えた文字数）。 */
const REASON_EXCERPT_CHARS = 200;

/**
 * reason の先頭 200 字を「1 行に潰した」平文。
 *
 * WHY (2026-09-05 S-6/E-d): v1 の本文は reason を sha256 でしか含まず、
 * 署名画面には自分の主張が 1 文字も出なかった——構造的なブラインド署名で、
 * UI の表示と別の本文を署名させる差し替えを、署名者は検出できなかった。
 * 平文を入れるが、reason は自由入力（最大 4000 字・改行あり）なので、
 * そのまま畳み込むと固定行の構造が壊れる。だから制御文字・行区切りを
 * 1 個の空白へ潰す——`name` を「弾く」のと違い、reason は正当に改行を
 * 含みうるので、ここは拒否ではなく決定的な正規化にする。原文は
 * `reason sha256` と台帳の原文保存が引き続き保証する。
 */
function reasonExcerpt(reason: string): string {
  let out = "";
  for (const ch of [...reason].slice(0, REASON_EXCERPT_CHARS)) {
    const c = ch.codePointAt(0)!;
    const isControl = c <= 0x1f || (c >= 0x7f && c <= 0x9f);
    out += isControl || ch === "\u2028" || ch === "\u2029" ? " " : ch;
  }
  return out.trim();
}

export function disputeMessage(input: {
  endpointId: string;
  subject: string;
  reason: string;
  issued: string;
}): string {
  const reasonHash = createHash("sha256").update(input.reason, "utf8").digest("hex");
  return [
    `${SIGNING_DOMAIN} — measurement dispute`,
    `domain: ${SIGNING_DOMAIN}`,
    `endpoint: ${input.endpointId}`,
    `subject: ${input.subject}`,
    `reason (first ${REASON_EXCERPT_CHARS} chars): ${reasonExcerpt(input.reason)}`,
    `reason sha256: ${reasonHash}`,
    `issued: ${input.issued} (valid 10 minutes)`,
    // 再測定の結果は不利でも公開される。提出前に読める場所はここしかない。
    "Filing this will trigger a re-measurement whose result is published, including if it confirms the original verdict.",
  ].join("\n");
}

/** LEGACY (〜2026-09-05, delete after LEGACY_MESSAGE_ACCEPT_UNTIL). Frozen. */
export function legacyDisputeMessage(input: {
  endpointId: string;
  subject: string;
  reason: string;
  issued: string;
}): string {
  const reasonHash = createHash("sha256").update(input.reason, "utf8").digest("hex");
  return `vet402:dispute:v1:${input.endpointId}:${input.subject}:${reasonHash}:${input.issued}`;
}

export type DisputeResult =
  | { ok: true; id: string; remeasureVerdict: string | null; legacyMessage: boolean }
  | {
      ok: false;
      reason:
        | "invalid_input"
        | "endpoint_not_found"
        | "not_payto_signer"
        | "invalid_signature"
        | "signature_expired"
        | "signature_message_legacy_expired"
        | "replayed"
        | "unsupported_payto"
        | "rate_limited"
        | "db_unavailable";
    };

export async function submitDispute(
  input: {
    endpointId: string;
    subject: string;
    reason: string;
    /** 署名者が畳み込んだ発行時刻（Date#toISOString() の厳密な形）。 */
    issued: string;
    address: string;
    signature: string;
  },
  probeOptions: ProbeOptions = {},
): Promise<DisputeResult> {
  if (!UUID_RE.test(input.endpointId)) return { ok: false, reason: "invalid_input" };
  if (!SUBJECTS.has(input.subject)) return { ok: false, reason: "invalid_input" };
  if (input.reason.trim().length === 0 || input.reason.length > 4000) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) return { ok: false, reason: "invalid_input" };
  // 形の検査が先、鮮度の判定は後（形が壊れていれば Date.parse は NaN）。
  if (!isValidIssuedAt(input.issued)) return { ok: false, reason: "invalid_input" };
  if (Math.abs(Date.now() - Date.parse(input.issued)) > ISSUED_WINDOW_MS) {
    return { ok: false, reason: "signature_expired" };
  }

  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const [ep] = await db
    .select()
    .from(x402Endpoints)
    .where(eq(x402Endpoints.id, input.endpointId))
    .limit(1);
  if (!ep) return { ok: false, reason: "endpoint_not_found" };
  if (!ep.payTo) return { ok: false, reason: "unsupported_payto" };
  if (!ep.payTo.startsWith("0x")) return { ok: false, reason: "unsupported_payto" };
  if (ep.payTo.toLowerCase() !== input.address.toLowerCase()) {
    return { ok: false, reason: "not_payto_signer" };
  }

  // 2026-09-05 (S-6): 現行形式が第一候補、旧形式は互換期限まで第二候補。
  // 受理した本文をそのまま台帳へ残す——「何に署名したか」を後から検証できる
  // という v1 からの約束は、形式が 2 つある期間でも変えない。
  const current = disputeMessage(input);
  const legacy = legacyDisputeMessage(input);
  const { matched } = await matchSignatureForm({
    address: input.address,
    signature: input.signature,
    current,
    legacy,
  });
  if (matched === "legacy_expired") {
    return { ok: false, reason: "signature_message_legacy_expired" };
  }
  if (matched === "none") return { ok: false, reason: "invalid_signature" };
  const legacyMessage = matched === "legacy";
  const message = legacyMessage ? legacy : current;

  // 鮮度窓の内側での再送も1回きりにする。message は issued を含むので
  // 「同一メッセージ = 同一署名の再提出」であり、正当な申し立ての重複には
  // ならない（内容か時刻が違えば別のメッセージになる）。
  const [replayed] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(eq(disputes.message, message))
    .limit(1);
  if (replayed) return { ok: false, reason: "replayed" };

  // §10: 覆らなければ原判定を維持し、連続異議のレート制限をかける（7 日 3 件）。
  if (isDisputeRateLimited(await recentDisputeTimes(ep.id), new Date())) {
    return { ok: false, reason: "rate_limited" };
  }

  // 再測定前の公開判定（before）。覆ったときだけ訂正ログに残す。
  const priorVerdicts = await db
    .select({ verdict: x402L0Probes.verdict })
    .from(x402L0Probes)
    .where(eq(x402L0Probes.endpointId, ep.id))
    .orderBy(desc(x402L0Probes.probedAt))
    .limit(5);
  const before = publishedVerdict(priorVerdicts.map((r) => r.verdict));

  const [row] = await db
    .insert(disputes)
    .values({
      endpointId: input.endpointId,
      subject: input.subject,
      reason: input.reason,
      signer: input.address.toLowerCase(),
      message,
      signature: input.signature,
    })
    .returning();

  // 再測定——正規のプローブ行として記帳（公開ゲートは普段どおり）。
  // 失敗しても dispute の受理は既に立っている（graceful）。
  let remeasureVerdict: string | null = null;
  try {
    const probe = await probeEndpoint(
      {
        resourceUrl: ep.resourceUrl,
        method: ep.method,
        payTo: ep.payTo,
        network: ep.network,
        priceAmount: ep.priceAmount,
        priceAsset: ep.priceAsset,
      },
      { ...probeOptions, recheck: true },
    );
    await db.insert(x402L0Probes).values({
      endpointId: ep.id,
      method: probe.method,
      verdict: probe.verdict,
      dialect: probe.dialect,
      httpStatus: probe.httpStatus,
      acceptsValid: probe.acceptsValid,
      priceConsistent: probe.priceConsistent,
      metadataConsistent: probe.metadataConsistent,
      latencyMs: probe.latencyMs,
      failReason: probe.failReason,
      rawResponseMeta: { ...probe.rawResponseMeta, trigger: "dispute", disputeId: row.id },
    });
    invalidateDecisionCache(ep.id); // 再測定は判定材料（このインスタンスのキャッシュのみ・cache.ts 参照）
    remeasureVerdict = probe.verdict;
    await db
      .update(disputes)
      .set({ status: "remeasured", remeasureVerdict })
      .where(eq(disputes.id, row.id));
    const after = publishedVerdict([probe.verdict, ...priorVerdicts.map((r) => r.verdict)]);
    if (after !== before) {
      await recordCorrection({
        subjectType: "endpoint",
        subjectId: ep.id,
        level: "l0",
        before: { publishedVerdict: before },
        after: { publishedVerdict: after, failReason: probe.failReason },
        reason: "dispute_remeasure",
        disputeId: row.id,
      }).catch(logAndSwallow("disputes.record_correction"));
    }
  } catch {
    /* dispute stands; remeasure can be retried by ops */
  }

  return { ok: true, id: row.id, remeasureVerdict, legacyMessage };
}
