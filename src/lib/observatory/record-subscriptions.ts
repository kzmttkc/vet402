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
//
// 2026-09-28 監査（ダブルオプトイン）: 他人の宛先を書き込めば、その人に通知が
// 届いてしまう形だった。notify は受付時 pending（confirmed_at IS NULL）で、
// 確認メールを 1 通だけ送る。確定・配信停止はどちらも「GET で頁を開くだけでは
// 何も起きず、ボタンの POST で初めて変わる」——メールのリンクスキャナが踏んでも
// 確定しない。未確定・停止済みの宛先には通知を一切送らない（cron の SELECT で絞る）。
//   - 確認トークンは 32 byte 乱数。DB には sha256 だけ。有効 72 時間・1 回限り
//   - 配信停止トークンは行 id の HMAC（鍵は API_KEY_PEPPER から HKDF で導出）。
//     全通知に同じリンクを載せ続けるため、保存せず再計算する。鍵が無ければ
//     通知を送らない（停止できないメールを出さない）
//   - 確認メールの再送は宛先ごと 3 通 / 24 時間（IP 5/時とは別の桶）
//   - dispute は確認メールを送らない（人が読み、人が返信する。自動送信は無い）
// ============================================================
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { consumeIpRateLimit, type IpRateLimitResult } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { recordSubscriptions, x402Endpoints } from "@/lib/db/schema";
import { sendMail, type MailInput, type SendResult } from "@/lib/mail/send";
import { SITE_URL } from "@/lib/site-url";
import { SUPPORT_EMAIL } from "@/lib/support";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { publishedVerdict, MIN_CONSECUTIVE_FAILS_TO_PUBLISH } from "./l0-probe";

export const SUBSCRIBE_RL_LIMIT = 5;
export const SUBSCRIBE_RL_WINDOW_MS = 3_600_000;

/** 同じ宛先への確認メールは 24 時間で 3 通まで（IP を変えても宛先で止まる）。 */
export const CONFIRM_MAIL_LIMIT = 3;
export const CONFIRM_MAIL_WINDOW_MS = 24 * 3_600_000;
/** 確認リンクの有効期間（confirm_sent_at 起点）。 */
export const CONFIRM_TTL_HOURS = 72;

/** 確定・停止の POST（鍵なし）。トークン総当たりの桶。 */
export const TOKEN_POST_RL_LIMIT = 30;
export const TOKEN_POST_RL_WINDOW_MS = 3_600_000;

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

/** 宛先ごとのレート制限の桶鍵。ip_rate_limits に生のアドレスを置かない。 */
export function confirmMailBucket(email: string): string {
  return `record-confirm-mail:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 推測不能な確認トークン（32 byte → base64url 43 字）。 */
export function newConfirmToken(): string {
  return randomBytes(32).toString("base64url");
}

/** DB に置くのはこれだけ。 */
export function hashConfirmToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function unsubscribeKey(): Buffer | null {
  // webhooks.ts と同じく API_KEY_PEPPER（本番必須）を鍵材料にし、用途ごとに HKDF で分ける。
  const material = process.env.API_KEY_PEPPER?.trim();
  if (!material) return null;
  return Buffer.from(hkdfSync("sha256", material, "", "vet402/record-subscriptions/unsubscribe/v1", 32));
}

/** 行 id に対する配信停止トークン。鍵が無ければ null（その時は通知を送らない）。 */
export function unsubscribeToken(subscriptionId: string): string | null {
  const key = unsubscribeKey();
  if (!key) return null;
  return createHmac("sha256", key).update(`unsubscribe:${subscriptionId.toLowerCase()}`).digest("base64url");
}

export function verifyUnsubscribeToken(subscriptionId: string, token: string): boolean {
  if (!UUID_RE.test(subscriptionId) || !TOKEN_RE.test(token)) return false;
  const expected = unsubscribeToken(subscriptionId);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 本文の人向けリンク。トークンは # の後ろ——サーバのログにも解析のビーコンにも乗らない。 */
export function confirmPageUrl(token: string): string {
  return `${SITE_URL}/observatory/confirm#t=${token}`;
}

export function unsubscribePageUrl(subscriptionId: string, token: string): string {
  return `${SITE_URL}/observatory/unsubscribe#id=${subscriptionId}&t=${token}`;
}

/** RFC 8058 の one-click 先。メールソフトがここへ POST する（GET では何も起きない）。 */
export function unsubscribeOneClickUrl(subscriptionId: string, token: string): string {
  return `${SITE_URL}/api/v1/observatory/subscriptions/unsubscribe?id=${subscriptionId}&t=${token}`;
}

/** 全通知メールに付けるヘッダ（RFC 2369 / RFC 8058）。 */
export function listUnsubscribeHeaders(subscriptionId: string, token: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeOneClickUrl(subscriptionId, token)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
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

export type ConfirmationOutcome =
  /** dispute: 確認メールは無い（人が読み、人が返信する） */
  | "not_required"
  /** 確定済みの購読。何も変えず、何も送らない（第三者の再送信で基準判定を動かさせない） */
  | "already_confirmed"
  | "sent"
  /** 宛先の桶が尽きた。前に送ったリンクを生かすため、トークンは差し替えない */
  | "rate_limited"
  | "mail_unset"
  | "mail_failed";

export type SubmitResult =
  | { ok: true; id: string; receipt: string; lastVerdict: Verdict; confirmation: ConfirmationOutcome }
  | { ok: false; reason: "db_unavailable" | "endpoint_not_found" };

export type SubmitDeps = {
  consumeLimit?: (key: string, limit: number, windowMs: number) => Promise<Pick<IpRateLimitResult, "allowed">>;
  send?: (input: MailInput) => Promise<SendResult>;
};

function idOf(rows: unknown[]): string {
  // AppDatabase は neon-http / postgres-js の合併型で、引数つき returning() の
  // オーバーロードが畳めない。列指定なしで受け、id だけ読む。
  return String((rows[0] as { id?: unknown } | undefined)?.id ?? "");
}

export async function submitSubscription(
  value: SubscriptionInput,
  ip: string,
  deps: SubmitDeps = {},
): Promise<SubmitResult> {
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
  const target = [recordSubscriptions.endpointId, recordSubscriptions.email, recordSubscriptions.kind];

  if (value.kind === "dispute") {
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
        target,
        set: { reason: value.reason, lastVerdict, ipHash, createdAt: sql`now()` },
      })
      .returning();
    const id = idOf(rows);
    return { ok: true, id, receipt: id.slice(0, 8), lastVerdict, confirmation: "not_required" };
  }

  // notify: 確定済みの行には触らない。
  const existing = await db
    .select({
      id: recordSubscriptions.id,
      confirmedAt: recordSubscriptions.confirmedAt,
      unsubscribedAt: recordSubscriptions.unsubscribedAt,
    })
    .from(recordSubscriptions)
    .where(
      and(
        eq(recordSubscriptions.endpointId, value.endpointId),
        eq(recordSubscriptions.email, value.email),
        eq(recordSubscriptions.kind, "notify"),
      ),
    )
    .limit(1);
  const prior = existing[0] as { id?: unknown; confirmedAt?: unknown; unsubscribedAt?: unknown } | undefined;
  if (prior?.id && prior.confirmedAt && !prior.unsubscribedAt) {
    const id = String(prior.id);
    return { ok: true, id, receipt: id.slice(0, 8), lastVerdict, confirmation: "already_confirmed" };
  }

  const consume = deps.consumeLimit ?? consumeIpRateLimit;
  const bucket = await consume(confirmMailBucket(value.email), CONFIRM_MAIL_LIMIT, CONFIRM_MAIL_WINDOW_MS);
  const token = bucket.allowed ? newConfirmToken() : null;

  // pending（新規・未確定・停止済みからの再登録）。確定済みの行は setWhere で守る
  // （SELECT と UPSERT の間に確定された場合も、未確定へ戻さない）。
  const pendingSet = {
    lastVerdict,
    ipHash,
    createdAt: sql`now()`,
    confirmedAt: null,
    unsubscribedAt: null,
    ...(token ? { confirmTokenHash: hashConfirmToken(token), confirmSentAt: null } : {}),
  };
  const rows = await db
    .insert(recordSubscriptions)
    .values({
      endpointId: value.endpointId,
      email: value.email,
      kind: "notify",
      reason: null,
      lastVerdict,
      ipHash,
      ...(token ? { confirmTokenHash: hashConfirmToken(token) } : {}),
    })
    .onConflictDoUpdate({
      target,
      set: pendingSet,
      setWhere: sql`${recordSubscriptions.confirmedAt} IS NULL OR ${recordSubscriptions.unsubscribedAt} IS NOT NULL`,
    })
    .returning();
  let id = idOf(rows);
  if (!id) {
    // setWhere が弾いた＝この瞬間に確定済みだった。
    const again = await db
      .select({ id: recordSubscriptions.id })
      .from(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.endpointId, value.endpointId),
          eq(recordSubscriptions.email, value.email),
          eq(recordSubscriptions.kind, "notify"),
        ),
      )
      .limit(1);
    id = String((again[0] as { id?: unknown } | undefined)?.id ?? "");
    return { ok: true, id, receipt: id.slice(0, 8), lastVerdict, confirmation: "already_confirmed" };
  }
  if (!token) return { ok: true, id, receipt: id.slice(0, 8), lastVerdict, confirmation: "rate_limited" };

  const send = deps.send ?? sendMail;
  const result = await send(confirmationMail(value.email, value.endpointId, token));
  if ("skipped" in result) return { ok: true, id, receipt: id.slice(0, 8), lastVerdict, confirmation: "mail_unset" };
  if (!result.sent) return { ok: true, id, receipt: id.slice(0, 8), lastVerdict, confirmation: "mail_failed" };
  // 実際に出た時だけ有効期限を始める。NULL のままの行は確定できない。
  await db
    .update(recordSubscriptions)
    .set({ confirmSentAt: sql`now()` })
    .where(eq(recordSubscriptions.id, id));
  return { ok: true, id, receipt: id.slice(0, 8), lastVerdict, confirmation: "sent" };
}

/**
 * Pure. 確認メール。第三者が決める文字列（カタログの resource_key 等）は載せない——
 * 任意の宛先に届きうる唯一のメールを、他人の宣伝文の運び屋にしない。
 */
export function confirmationMail(email: string, endpointId: string, token: string): MailInput {
  const record = `${SITE_URL}/observatory/e/${endpointId}`;
  return {
    to: email,
    subject: "[vet402] Confirm your email for an endpoint record",
    text: [
      `Someone (probably you) asked vet402 to email this address when the public verdict of one endpoint record changes.`,
      ``,
      `Record:  ${record}`,
      ``,
      `To start, open this page and press "Confirm":`,
      confirmPageUrl(token),
      ``,
      `Opening the page changes nothing on its own; only the button does. The link works for ${CONFIRM_TTL_HOURS} hours.`,
      ``,
      `If you did not ask for this, ignore this message. Nothing else is sent to this address unless the button is pressed.`,
    ].join("\n"),
    replyTo: SUPPORT_EMAIL,
  };
}

export type TokenActionResult =
  | { ok: true }
  | { ok: false; reason: "db_unavailable" | "invalid_token" };

/** POST でだけ呼ぶ。有効・未使用・72 時間以内のトークンなら確定し、トークンを消す（1 回限り）。 */
export async function confirmSubscription(token: string): Promise<TokenActionResult> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, reason: "invalid_token" };
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };
  const rows = await db
    .update(recordSubscriptions)
    .set({ confirmedAt: sql`now()`, confirmTokenHash: null })
    .where(
      and(
        eq(recordSubscriptions.confirmTokenHash, hashConfirmToken(token)),
        eq(recordSubscriptions.kind, "notify"),
        isNull(recordSubscriptions.confirmedAt),
        isNotNull(recordSubscriptions.confirmSentAt),
        gt(recordSubscriptions.confirmSentAt, sql`now() - make_interval(hours => ${CONFIRM_TTL_HOURS})`),
      ),
    )
    .returning();
  return rows.length > 0 ? { ok: true } : { ok: false, reason: "invalid_token" };
}

/** POST でだけ呼ぶ。冪等（停止済みでも ok）。行が無くても ok を返し、購読の有無を漏らさない。 */
export async function unsubscribeSubscription(subscriptionId: string, token: string): Promise<TokenActionResult> {
  if (!verifyUnsubscribeToken(subscriptionId, token)) return { ok: false, reason: "invalid_token" };
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };
  await db
    .update(recordSubscriptions)
    .set({ unsubscribedAt: sql`now()` })
    .where(and(eq(recordSubscriptions.id, subscriptionId.toLowerCase()), isNull(recordSubscriptions.unsubscribedAt)));
  return { ok: true };
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
    logServerErrorSafe("record-subscriptions.forwardDispute", error);
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

/**
 * The cron body: read every CONFIRMED, not-unsubscribed notify row once, mail the changed ones,
 * advance last_verdict only after a real send. Pending rows are never read, so they are never mailed.
 */
export async function notifySubscribers(
  limit = 500,
  deps: Pick<SubmitDeps, "send"> = {},
): Promise<NotifyRun | { skipped: "db_unavailable" }> {
  const db = getDb();
  if (!db) return { skipped: "db_unavailable" };
  const send = deps.send ?? sendMail;
  const cap = Math.min(Math.max(Math.trunc(limit) || 0, 1), 5_000);
  const subs = await db
    .select({
      id: recordSubscriptions.id,
      endpointId: recordSubscriptions.endpointId,
      email: recordSubscriptions.email,
      lastVerdict: recordSubscriptions.lastVerdict,
    })
    .from(recordSubscriptions)
    .where(
      and(
        eq(recordSubscriptions.kind, "notify"),
        // 2026-09-28 監査: 確定前・停止後の宛先には送らない。ここで絞るので、下のループは
        // pending の行を見ることすらない。
        isNotNull(recordSubscriptions.confirmedAt),
        isNull(recordSubscriptions.unsubscribedAt),
      ),
    )
    .limit(cap);
  const ids = [...new Set(subs.map((s) => s.endpointId))];
  const detail = await readPublishedVerdicts(db, ids);
  const current = new Map<string, string>();
  for (const [id, d] of detail) current.set(id, d.verdict);
  const due = subscriptionsToNotify(subs, current);

  const run: NotifyRun = { checked: subs.length, changed: due.length, sent: 0, skipped: 0, failed: 0 };
  let keyUnset = 0;
  for (const s of due) {
    const unsub = unsubscribeToken(s.id);
    if (!unsub) {
      // 停止リンクを作れないメールは出さない。last_verdict も進めない（鍵が入った日に届く）。
      run.skipped++;
      keyUnset++;
      continue;
    }
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
      `You asked for this email on the record page and confirmed it. To stop, open this page and press "Unsubscribe" (opening it alone changes nothing):`,
      unsubscribePageUrl(s.id, unsub),
      `Questions: ${SUPPORT_EMAIL}`,
    ].join("\n");
    const result = await send({
      to: s.email,
      subject: `[vet402] ${name}: ${s.lastVerdict} → ${s.currentVerdict}`,
      text,
      replyTo: SUPPORT_EMAIL,
      headers: listUnsubscribeHeaders(s.id, unsub),
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
  if (keyUnset > 0) {
    logServerErrorSafe(
      "notify-subscribers",
      new Error(`unsubscribe_key_unset: ${keyUnset} verdict change(s) not sent (API_KEY_PEPPER)`),
    );
  }
  if (run.skipped > keyUnset) {
    logServerErrorSafe(
      "notify-subscribers",
      new Error(`mail_unset: ${run.skipped - keyUnset} verdict change(s) not sent (RESEND_API_KEY / MAIL_FROM)`),
    );
  }
  return run;
}
