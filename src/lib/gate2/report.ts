/**
 * Gate2 PMF judgement — shared core logic.
 *
 * Extracted from scripts/gate2-report.ts (2026-07-26) so the same report can
 * be produced two ways:
 *   1. CLI (`npm run gate2:report`) — requires a local DATABASE_URL, which is
 *      unavailable on this machine because the value is stored as a Vercel
 *      "Sensitive" env var (write-only, unreadable via CLI/dashboard/API
 *      once set).
 *   2. Production API route (`GET /api/admin/gate2`, ADMIN_SECRET-gated) —
 *      runs inside the Vercel serverless runtime where `process.env.DATABASE_URL`
 *      IS populated (Vercel injects Sensitive vars into the running function,
 *      it only blocks reading the raw value back out via tooling). This lets
 *      Gate2 be measured against the real production DB without ever needing
 *      the connection string locally. Mirrors the pattern already used for
 *      Soroi's `/api/internal/waitlist-count`.
 *
 * Gate2 (operational definition, from output/0715/vouch_pmf_launch_pack.md):
 *   PASS  = judgement A has >= 5 external accounts
 *           AND judgement C has >= 1 external key that is either
 *             (i)  active >= 5 distinct days AND >= 50 queries in the last 14 days, or
 *             (ii) has at least one x402_payments row (settlement write-back)
 *
 * Self-accounts (own test signups) are excluded from every count via
 * SELF_ACCOUNT_EMAILS (comma-separated). Unset means nothing is excluded: the
 * operator's addresses belong in the deployment's env, never in this file
 * (2026-09-07 repo hygiene — the default used to be a hard-coded address).
 */
import { and, eq, gt, inArray, isNull, notInArray, or } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "../db/client";
import { isMissingSchemaError } from "../db/pg-errors";
import { accounts, apiKeys, apiUsage, trustEvents, x402Payments } from "../db/schema";

const DEFAULT_SELF_EMAILS: string[] = [];
const ACTIVE_DAYS_THRESHOLD = 5;
const QUERY_COUNT_THRESHOLD = 50;
const WINDOW_DAYS = 14;

function getSelfEmails(): string[] {
  const raw = process.env.SELF_ACCOUNT_EMAILS;
  if (!raw) return DEFAULT_SELF_EMAILS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type Gate2Report = {
  generatedAt: string;
  windowDays: number;
  selfEmailsExcluded: string[];
  judgementA: {
    externalSignups: number;
    pass: boolean;
    accounts: { email: string; createdAt: Date | null; lastApiUse: Date | null }[];
  };
  judgementB: {
    rows: { period: string; apiKeyId: string; email: string; count: number }[];
  };
  judgementC: {
    continuousUsage: {
      apiKeyId: string;
      email: string;
      queries: number;
      activeDays: number;
      firstSeen: Date;
      lastSeen: Date;
    }[];
    settlementWriteback: {
      apiKeyId: string | null;
      email: string;
      attested: number;
      first: Date;
      last: Date;
    }[];
    pass: boolean;
  };
  gate2Pass: boolean;
};

export class Gate2NotConfiguredError extends Error {}
export class Gate2SchemaMissingError extends Error {}

export async function buildGate2Report(): Promise<Gate2Report> {
  const selfEmails = getSelfEmails();

  if (!isDatabaseConfigured()) {
    throw new Gate2NotConfiguredError("DATABASE_URL not configured");
  }
  const db = getDb();
  if (!db) {
    throw new Gate2NotConfiguredError("DATABASE_URL not configured");
  }

  let selfAccountIds: string[];
  let externalAccounts: { id: string; email: string; createdAt: Date | null }[];
  try {
    const selfRows = selfEmails.length
      ? await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(inArray(accounts.email, selfEmails))
      : [];
    selfAccountIds = selfRows.map((r) => r.id);

    externalAccounts = await db
      .select({ id: accounts.id, email: accounts.email, createdAt: accounts.createdAt })
      .from(accounts)
      .where(selfEmails.length ? notInArray(accounts.email, selfEmails) : undefined)
      .orderBy(accounts.createdAt);
  } catch (error) {
    if (isMissingSchemaError(error)) {
      throw new Gate2SchemaMissingError("accounts table doesn't exist in this database yet");
    }
    throw error;
  }

  const externalIds = externalAccounts.map((a) => a.id);
  const keyRows = externalIds.length
    ? await db
        .select({ userId: apiKeys.userId, lastUsedAt: apiKeys.lastUsedAt })
        .from(apiKeys)
        .where(inArray(apiKeys.userId, externalIds))
    : [];
  const lastUseByUser = new Map<string, number>();
  for (const k of keyRows) {
    if (!k.userId || !k.lastUsedAt) continue;
    const t = new Date(k.lastUsedAt).getTime();
    const prev = lastUseByUser.get(k.userId) ?? 0;
    if (t > prev) lastUseByUser.set(k.userId, t);
  }
  const judgementA = externalAccounts.map((a) => ({
    email: a.email,
    createdAt: a.createdAt,
    lastApiUse: lastUseByUser.has(a.id) ? new Date(lastUseByUser.get(a.id)!) : null,
  }));

  const notSelfKeyFilter = selfAccountIds.length
    ? or(isNull(apiKeys.userId), notInArray(apiKeys.userId, selfAccountIds))
    : undefined;
  const usageRows = await db
    .select({
      period: apiUsage.period,
      apiKeyId: apiUsage.apiKeyId,
      count: apiUsage.count,
      userId: apiKeys.userId,
    })
    .from(apiUsage)
    .innerJoin(apiKeys, eq(apiKeys.id, apiUsage.apiKeyId))
    .where(notSelfKeyFilter);
  const accountEmailById = new Map(externalAccounts.map((a) => [a.id, a.email]));
  const judgementB = usageRows
    .map((u) => ({
      period: u.period,
      apiKeyId: u.apiKeyId,
      email: u.userId ? (accountEmailById.get(u.userId) ?? "(self or unknown)") : "(no account)",
      count: u.count,
    }))
    .sort((x, y) => (x.period < y.period ? 1 : -1) || y.count - x.count);

  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const recentEvents = await db
    .select({
      apiKeyId: trustEvents.apiKeyId,
      userId: apiKeys.userId,
      createdAt: trustEvents.createdAt,
    })
    .from(trustEvents)
    .innerJoin(apiKeys, eq(apiKeys.id, trustEvents.apiKeyId))
    .where(
      notSelfKeyFilter
        ? and(gt(trustEvents.createdAt, windowStart), notSelfKeyFilter)
        : gt(trustEvents.createdAt, windowStart),
    );
  const byKey = new Map<
    string,
    { userId: string | null; days: Set<string>; queries: number; first: Date; last: Date }
  >();
  for (const e of recentEvents) {
    if (!e.apiKeyId || !e.createdAt) continue;
    const created = new Date(e.createdAt);
    const entry = byKey.get(e.apiKeyId) ?? {
      userId: e.userId,
      days: new Set<string>(),
      queries: 0,
      first: created,
      last: created,
    };
    entry.days.add(dayKey(created));
    entry.queries += 1;
    if (created < entry.first) entry.first = created;
    if (created > entry.last) entry.last = created;
    byKey.set(e.apiKeyId, entry);
  }
  const judgementCi = [...byKey.entries()]
    .map(([apiKeyId, v]) => ({
      apiKeyId,
      email: v.userId ? (accountEmailById.get(v.userId) ?? "(self or unknown)") : "(no account)",
      queries: v.queries,
      activeDays: v.days.size,
      firstSeen: v.first,
      lastSeen: v.last,
    }))
    .filter((r) => r.activeDays >= ACTIVE_DAYS_THRESHOLD && r.queries >= QUERY_COUNT_THRESHOLD);

  let judgementCii: {
    apiKeyId: string | null;
    email: string;
    attested: number;
    first: Date;
    last: Date;
  }[] = [];
  try {
    const paymentRows = await db
      .select({
        apiKeyId: x402Payments.apiKeyId,
        userId: apiKeys.userId,
        createdAt: x402Payments.createdAt,
      })
      .from(x402Payments)
      .innerJoin(apiKeys, eq(apiKeys.id, x402Payments.apiKeyId))
      .where(notSelfKeyFilter);
    const byPaymentKey = new Map<
      string,
      { userId: string | null; count: number; first: Date; last: Date }
    >();
    for (const p of paymentRows) {
      if (!p.apiKeyId || !p.createdAt) continue;
      const created = new Date(p.createdAt);
      const entry = byPaymentKey.get(p.apiKeyId) ?? {
        userId: p.userId,
        count: 0,
        first: created,
        last: created,
      };
      entry.count += 1;
      if (created < entry.first) entry.first = created;
      if (created > entry.last) entry.last = created;
      byPaymentKey.set(p.apiKeyId, entry);
    }
    judgementCii = [...byPaymentKey.entries()].map(([apiKeyId, v]) => ({
      apiKeyId,
      email: v.userId ? (accountEmailById.get(v.userId) ?? "(self or unknown)") : "(no account)",
      attested: v.count,
      first: v.first,
      last: v.last,
    }));
  } catch (error) {
    if (!isMissingSchemaError(error)) {
      throw error;
    }
    // x402_payments table not present yet — judgement C-ii treated as 0 rows.
  }

  const gate2Pass = judgementA.length >= 5 && (judgementCi.length > 0 || judgementCii.length > 0);

  return {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    selfEmailsExcluded: selfEmails,
    judgementA: {
      externalSignups: judgementA.length,
      pass: judgementA.length >= 5,
      accounts: judgementA,
    },
    judgementB: { rows: judgementB },
    judgementC: {
      continuousUsage: judgementCi,
      settlementWriteback: judgementCii,
      pass: judgementCi.length > 0 || judgementCii.length > 0,
    },
    gate2Pass,
  };
}
