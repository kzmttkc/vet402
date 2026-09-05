// ============================================================
// 許可不要 L0 コントリビューション v0（Phase 3.3・既定OFF）。
//
// v0 の約束は1つだけ:「署名付きの外部観測を、公開判定に混ぜずに保存する」。
// 公開 verdict の正典は自前プローブ（publishedVerdict）のまま動かさない。
// 外部観測が判定に効くのは、重み付け・sybil耐性・監査を設計した v1 から。
//
// 署名は EIP-191 personal_sign。メッセージは決定的な正規形（contributionMessage）
// で、保存時に原文ごと台帳へ残す——後から「何に署名したか」を検証できる。
// 2026-09-05 に改行区切りの人間可読へ移した（1行目で vet402.com を名乗り、
// 2行目に domain 行）。旧形式は LEGACY_MESSAGE_ACCEPT_UNTIL まで受理する。
//
// 2026-08-22（監査残件）: v0 のメッセージには nonce も timestamp も無く、
// 一度公開された署名は永久に再送可能な書き込み資格だった。既定OFFで公開
// verdict にも混ざらないとはいえ、欠陥の形は payees/verify・agents/verify
// で 2026-08-18 に塞いだものと同一なので、同じ方式で塞ぐ——署名対象に
// `issued` を畳み込み、鮮度窓（10分・両方向）を検証し、同一メッセージの
// 二重受理を拒否する。接頭辞は v1 へ（台帳の過去 v0 原文と混ぜない）。
// ——この v1 は「メッセージ形式のバージョン」であって、上段の
// 「外部観測が判定に効く v1」という機能フェーズとは別物。
// ============================================================
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { probeContributions } from "@/lib/db/schema";
import { isValidIssuedAt, matchSignatureForm, SIGNING_DOMAIN } from "@/lib/verify-message";
import { UUID_RE } from "@/lib/validation/uuid";

/** payees/verify の ISSUED_WINDOW_MS と同じ 10 分。 */
const ISSUED_WINDOW_MS = 10 * 60_000;

export function isContributionsEnabled(): boolean {
  return process.env.CONTRIBUTIONS_ENABLED === "true";
}

const VERDICTS = new Set(["pass", "fail", "unverified"]);
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** 未報告の欄も決定的な 1 語で埋める（空欄は「何を署名したか」を曖昧にする）。 */
const NOT_REPORTED = "not reported";

/**
 * 2026-09-05 (S-6/E-c): v1 は `vet402:contribution:v1:<uuid>:<verdict>:…` の
 * 単一行で、署名画面ではコロン区切りの塊にしか見えなかった——どの endpoint に
 * どの判定を出したのかが読めない以上、UI の表示と別の verdict を署名させる
 * 差し替えを署名者は検出できない。改行区切りの人間可読へ移し、1 行目に
 * 名乗り、2 行目に domain を置く。値はすべて整数・uuid・enum で検証済みなので
 * 行の偽造面は無い。
 */
export function contributionMessage(input: {
  endpointId: string;
  verdict: string;
  httpStatus: number | null;
  latencyMs: number | null;
  issued: string;
}): string {
  return [
    `${SIGNING_DOMAIN} — external observation`,
    `domain: ${SIGNING_DOMAIN}`,
    `endpoint: ${input.endpointId}`,
    `verdict: ${input.verdict}`,
    `http status: ${input.httpStatus ?? NOT_REPORTED}`,
    `latency: ${input.latencyMs === null ? NOT_REPORTED : `${input.latencyMs} ms`}`,
    `issued: ${input.issued} (valid 10 minutes)`,
    "Recorded in the public ledger. Not counted in the published verdict (v0).",
  ].join("\n");
}

/** LEGACY (〜2026-09-05, delete after LEGACY_MESSAGE_ACCEPT_UNTIL). Frozen. */
export function legacyContributionMessage(input: {
  endpointId: string;
  verdict: string;
  httpStatus: number | null;
  latencyMs: number | null;
  issued: string;
}): string {
  return `vet402:contribution:v1:${input.endpointId}:${input.verdict}:${input.httpStatus ?? ""}:${input.latencyMs ?? ""}:${input.issued}`;
}

export type ContributionResult =
  | { ok: true; id: string; legacyMessage: boolean }
  | {
      ok: false;
      reason:
        | "contributions_disabled"
        | "invalid_input"
        | "invalid_signature"
        | "signature_expired"
        | "signature_message_legacy_expired"
        | "replayed"
        | "db_unavailable";
    };

export async function submitContribution(input: {
  endpointId: string;
  verdict: string;
  httpStatus: number | null;
  latencyMs: number | null;
  /** 署名者が畳み込んだ発行時刻（Date#toISOString() の厳密な形）。 */
  issued: string;
  address: string;
  signature: string;
}): Promise<ContributionResult> {
  if (!isContributionsEnabled()) return { ok: false, reason: "contributions_disabled" };
  if (!UUID_RE.test(input.endpointId)) return { ok: false, reason: "invalid_input" };
  if (!VERDICTS.has(input.verdict)) return { ok: false, reason: "invalid_input" };
  if (!ADDR_RE.test(input.address)) return { ok: false, reason: "invalid_input" };
  if (input.httpStatus !== null && !Number.isInteger(input.httpStatus)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (input.latencyMs !== null && !Number.isInteger(input.latencyMs)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!isValidIssuedAt(input.issued)) return { ok: false, reason: "invalid_input" };
  if (Math.abs(Date.now() - Date.parse(input.issued)) > ISSUED_WINDOW_MS) {
    return { ok: false, reason: "signature_expired" };
  }

  // 2026-09-05 (S-6): 現行形式が第一候補、旧形式は LEGACY_MESSAGE_ACCEPT_UNTIL
  // まで第二候補。受理した本文をそのまま台帳へ残す（監査可能性は形式が 2 つ
  // ある期間も同じ約束）。
  const current = contributionMessage(input);
  const legacy = legacyContributionMessage(input);
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

  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  // 鮮度窓の内側の再送も1回きり。message は issued を含むので、観測内容か
  // 時刻が違えば別メッセージになり、正当な連投は妨げない。
  const [replayed] = await db
    .select({ id: probeContributions.id })
    .from(probeContributions)
    .where(eq(probeContributions.message, message))
    .limit(1);
  if (replayed) return { ok: false, reason: "replayed" };

  const [row] = await db
    .insert(probeContributions)
    .values({
      endpointId: input.endpointId,
      submitter: input.address.toLowerCase(),
      verdict: input.verdict,
      httpStatus: input.httpStatus,
      latencyMs: input.latencyMs,
      message,
      signature: input.signature,
    })
    .returning();
  return { ok: true, id: row.id, legacyMessage };
}
