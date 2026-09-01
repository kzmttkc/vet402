// ============================================================
// 売り手の署名付き異議（C8）——中立性の制度化。
//
// 申し立てられるのは endpoint の payTo を実際に握る者だけ（EIP-191。
// Solana payTo の Ed25519 は後続——v0 は 0x のみ）。受理と同時に本物の
// L0 を1回再測定し、**通常のプローブ行として**台帳へ書く——demo と違い
// これは正規の測定（売り手起点というだけ）で、公開判定の2連続fail
// ゲートも普段どおり適用される。申し立てで記録が消えることはない。
//
// メッセージ正規形（署名対象）:
//   vet402:dispute:v1:{endpointId}:{subject}:{sha256(reason)}:{issued}
// reason 本文は台帳に原文保存（監査可能性）。
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
import { verifyMessage } from "viem";
import { getDb } from "@/lib/db/client";
import { disputes, x402Endpoints, x402L0Probes } from "@/lib/db/schema";
import { isValidIssuedAt } from "@/lib/verify-message";
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

export function disputeMessage(input: {
  endpointId: string;
  subject: string;
  reason: string;
  issued: string;
}): string {
  const reasonHash = createHash("sha256").update(input.reason, "utf8").digest("hex");
  return `vet402:dispute:v1:${input.endpointId}:${input.subject}:${reasonHash}:${input.issued}`;
}

export type DisputeResult =
  | { ok: true; id: string; remeasureVerdict: string | null }
  | {
      ok: false;
      reason:
        | "invalid_input"
        | "endpoint_not_found"
        | "not_payto_signer"
        | "invalid_signature"
        | "signature_expired"
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

  const message = disputeMessage(input);
  let valid = false;
  try {
    valid = await verifyMessage({
      address: input.address as `0x${string}`,
      message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "invalid_signature" };

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
      }).catch(() => null);
    }
  } catch {
    /* dispute stands; remeasure can be retried by ops */
  }

  return { ok: true, id: row.id, remeasureVerdict };
}
