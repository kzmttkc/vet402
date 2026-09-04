// ============================================================
// 段 2「名前を取る」（2026-09-02 敵対的監査 F6 / F7）。
//
// endpoint 記録頁で価値を受け取った直後に email を受け取る。対価はページごと:
//   notify  — この記録の公開判定が変わったら 1 通
//   dispute — この記録への異議（理由つき）。support へ転送し、人が読む
// 固定する性質:
//   - 同一 email × endpoint × kind は upsert（二重登録しない）
//   - 受付番号は id の先頭 8 桁（人が support に問い合わせる時の鍵）
//   - IP は生で保存しない（sha256 の先頭 32 桁）
//   - 通知は last_verdict と現在の公開判定が違う行だけ。公開判定の規則は
//     観測所の一覧と同じ publishedVerdict()（単発 fail は unverified）
//   - 送信が未設定（RESEND_API_KEY / MAIL_FROM 無し）なら last_verdict を
//     進めない——設定された日に、溜まった変更が届く
// ============================================================
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { recordSubscriptions, x402Endpoints } from "@/lib/db/schema";
import { sendMail } from "@/lib/mail/send";
import { SITE_URL } from "@/lib/site-url";
import { SUPPORT_EMAIL } from "@/lib/support";
import { logServerError } from "@/lib/util/log";
import { publishedVerdict, MIN_CONSECUTIVE_FAILS_TO_PUBLISH } from "./l0-probe";

export const SUBSCRIBE_RL_LIMIT = 5;
export const SUBSCRIBE_RL_WINDOW_MS = 3_600_000;

export const REASON_MIN = 20;
export const REASON_MAX = 2_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export type SubscriptionKind = "notify" | "dispute";
export type Verdict = "pass" | "fail" | "unverified";

export type SubscriptionInput = {
  endpointId: string;
  email: string;
  kind: SubscriptionKind;
  reason: string | null;
};

export type ValidationFailure =
  | "honeypot"
  | "invalid_endpoint"
  | "invalid_email"
  | "invalid_kind"
  | "reason_required"
  | "reason_length";

export type ValidationResult =
  | { ok: true; value: SubscriptionInput }
  | { ok: false; reason: ValidationFailure };

/** Pure. Normalizes email (trim + lower) and reason (trim); rejects everything else. */
export function validateSubscription(raw: Record<string, unknown>): ValidationResult {
  // honeypot: a field no human sees. Anything in it is a bot.
  if (typeof raw.website === "string" && raw.website.trim() !== "") {
    return { ok: false, reason: "honeypot" };
  }
  const endpointId = typeof raw.endpointId === "string" ? raw.endpointId.trim() : "";
  if (!UUID_RE.test(endpointId)) return { ok: false, reason: "invalid_endpoint" };
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, reason: "invalid_email" };
  const kind = raw.kind;
  if (kind !== "notify" && kind !== "dispute") return { ok: false, reason: "invalid_kind" };
  let reason: string | null = null;
  if (kind === "dispute") {
    const text = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (text === "") return { ok: false, reason: "reason_required" };
    if (text.length < REASON_MIN || text.length > REASON_MAX) return { ok: false, reason: "reason_length" };
    reason = text;
  }
  return { ok: true, value: { endpointId: endpointId.toLowerCase(), email, kind, reason } };
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

type Db = NonNullable<ReturnType<typeof getDb>>;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

/** Public verdict for one endpoint — the same rule the register applies. */
async function readPublishedVerdict(db: Db, endpointId: string): Promise<Verdict> {
  const raw = await db.execute(sql`
    SELECT array_agg(v.verdict) AS verdicts
    FROM (
      SELECT verdict FROM x402_l0_probes
      WHERE endpoint_id = ${endpointId}::uuid
      ORDER BY probed_at DESC
      LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
    ) v
  `);
  const verdicts = (rowsOf(raw)[0]?.verdicts as string[] | null) ?? [];
  return publishedVerdict(verdicts);
}

/** Public verdict + name for many endpoints (the cron's one read). */
async function readPublishedVerdicts(
  db: Db,
  endpointIds: string[],
): Promise<Map<string, { verdict: Verdict; resourceKey: string }>> {
  const out = new Map<string, { verdict: Verdict; resourceKey: string }>();
  if (endpointIds.length === 0) return out;
  const raw = await db.execute(sql`
    SELECT e.id, e.resource_key, lp.verdicts
    FROM x402_endpoints e
    LEFT JOIN LATERAL (
      SELECT array_agg(v.verdict) AS verdicts
      FROM (
        SELECT verdict FROM x402_l0_probes p
        WHERE p.endpoint_id = e.id
        ORDER BY probed_at DESC
        LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
      ) v
    ) lp ON true
    WHERE e.id IN (${sql.join(endpointIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  for (const r of rowsOf(raw)) {
    out.set(String(r.id), {
      verdict: publishedVerdict(((r.verdicts as string[] | null) ?? []) as string[]),
      resourceKey: String(r.resource_key),
    });
  }
  return out;
}

export type SubmitResult =
  | { ok: true; id: string; receipt: string; lastVerdict: Verdict }
  | { ok: false; reason: "db_unavailable" | "endpoint_not_found" };

export async function submitSubscription(value: SubscriptionInput, ip: string): Promise<SubmitResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };
  const found = await db
    .select({ id: x402Endpoints.id })
    .from(x402Endpoints)
    .where(eq(x402Endpoints.id, value.endpointId))
    .limit(1);
  if (found.length === 0) return { ok: false, reason: "endpoint_not_found" };

  const lastVerdict = await readPublishedVerdict(db, value.endpointId);
  const ipHash = hashIp(ip);
  const rows = await db
    .insert(recordSubscriptions)
    .values({
      endpointId: value.endpointId,
      email: value.email,
      kind: value.kind,
      reason: value.reason,
      lastVerdict,
      ipHash,
    })
    .onConflictDoUpdate({
      target: [recordSubscriptions.endpointId, recordSubscriptions.email, recordSubscriptions.kind],
      // 再登録は「今から」の意思表示。基準判定と理由を今の値にし、通知の起点を進める。
      set: { reason: value.reason, lastVerdict, ipHash, createdAt: sql`now()` },
    })
    // AppDatabase は neon-http / postgres-js の合併型で、引数つき returning() の
    // オーバーロードが畳めない。列指定なしで受け、id だけ読む。
    .returning();
  const id = String((rows[0] as { id?: unknown } | undefined)?.id ?? "");
  return { ok: true, id, receipt: id.slice(0, 8), lastVerdict };
}

/** Forward a dispute to the support inbox. Never throws; never blocks the receipt. */
export async function forwardDispute(input: {
  receipt: string;
  endpointId: string;
  email: string;
  reason: string;
  lastVerdict: Verdict;
}): Promise<void> {
  const url = `${SITE_URL}/observatory/e/${input.endpointId}`;
  const text = [
    `Record dispute ${input.receipt}`,
    ``,
    `Record:   ${url}`,
    `Verdict:  ${input.lastVerdict} (public, at submission)`,
    `From:     ${input.email}`,
    ``,
    `Reason:`,
    input.reason,
    ``,
    `Records are never deleted on dispute. Re-measure through the normal gate; publish a correction if the record was wrong.`,
  ].join("\n");
  try {
    await sendMail({
      to: SUPPORT_EMAIL,
      subject: `[vet402] Record dispute ${input.receipt}`,
      text,
      replyTo: input.email,
    });
  } catch (error) {
    logServerError("record-subscriptions.forwardDispute", error);
  }
}

export type NotifyCandidate = { id: string; endpointId: string; email: string; lastVerdict: string };

/** Pure. Rows whose public verdict differs from the one they were last told. */
export function subscriptionsToNotify<T extends NotifyCandidate>(
  subs: readonly T[],
  current: ReadonlyMap<string, string>,
): (T & { currentVerdict: string })[] {
  const out: (T & { currentVerdict: string })[] = [];
  for (const s of subs) {
    const now = current.get(s.endpointId);
    if (now === undefined || now === s.lastVerdict) continue;
    out.push({ ...s, currentVerdict: now });
  }
  return out;
}

export type NotifyRun = {
  checked: number;
  changed: number;
  sent: number;
  skipped: number;
  failed: number;
};

/** The cron body: read every notify row once, mail the changed ones, advance last_verdict only after a real send. */
export async function notifySubscribers(limit = 500): Promise<NotifyRun | { skipped: "db_unavailable" }> {
  const db = getDb();
  if (!db) return { skipped: "db_unavailable" };
  const cap = Math.min(Math.max(Math.trunc(limit) || 0, 1), 5_000);
  const subs = await db
    .select({
      id: recordSubscriptions.id,
      endpointId: recordSubscriptions.endpointId,
      email: recordSubscriptions.email,
      lastVerdict: recordSubscriptions.lastVerdict,
    })
    .from(recordSubscriptions)
    .where(eq(recordSubscriptions.kind, "notify"))
    .limit(cap);
  const ids = [...new Set(subs.map((s) => s.endpointId))];
  const detail = await readPublishedVerdicts(db, ids);
  const current = new Map<string, string>();
  for (const [id, d] of detail) current.set(id, d.verdict);
  const due = subscriptionsToNotify(subs, current);

  const run: NotifyRun = { checked: subs.length, changed: due.length, sent: 0, skipped: 0, failed: 0 };
  for (const s of due) {
    const name = detail.get(s.endpointId)?.resourceKey ?? s.endpointId;
    const url = `${SITE_URL}/observatory/e/${s.endpointId}`;
    const text = [
      `The public verdict of the endpoint record you follow has changed.`,
      ``,
      `Endpoint: ${name}`,
      `Was:      ${s.lastVerdict}`,
      `Now:      ${s.currentVerdict}`,
      `Record:   ${url}`,
      ``,
      `pass / fail / unverified are measurements, not ratings; a fail is published only after two consecutive failing probes. Definitions: ${SITE_URL}/observatory/methodology`,
      ``,
      `You asked for this email on the record page. To stop, reply to this message and say so. Nothing automated reads that reply: one person does, and removes you by hand within 7 days. If you would rather not wait, mail ${SUPPORT_EMAIL} and it is the same inbox.`,
    ].join("\n");
    const result = await sendMail({
      to: s.email,
      subject: `[vet402] ${name}: ${s.lastVerdict} → ${s.currentVerdict}`,
      text,
      replyTo: SUPPORT_EMAIL,
    });
    if ("skipped" in result) {
      run.skipped++;
      continue;
    }
    if (!result.sent) {
      run.failed++;
      continue;
    }
    await db
      .update(recordSubscriptions)
      .set({ lastVerdict: s.currentVerdict, notifiedAt: sql`now()` })
      .where(eq(recordSubscriptions.id, s.id));
    run.sent++;
  }
  if (run.skipped > 0) {
    logServerError(
      "notify-subscribers",
      new Error(`mail_unset: ${run.skipped} verdict change(s) not sent (RESEND_API_KEY / MAIL_FROM)`),
    );
  }
  return run;
}
