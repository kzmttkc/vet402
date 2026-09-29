import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, count, desc, eq, isNull, or, sql } from "drizzle-orm";
import { isProduction } from "@/lib/config/env";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { secureCompare } from "@/lib/util/secure-compare";
import { getDb } from "./client";
import { apiKeys } from "./schema";

export type ApiKeyRecord = {
  id: string;
  plan: string;
  name: string | null;
  /**
   * 鍵の持ち主（api_keys.user_id・無ければ鍵 id そのもの——ensureOwnerUserId と同じ規則）。1 人が最大
   * MAX_KEYS_PER_OWNER 本の鍵を持てるので、「別々の呼び手」を数えるのはこの単位（lookup-caller.ts・2026-09-29）。
   */
  ownerId: string;
};

const VALID_PLANS = new Set(["free", "pro", "scale"]);
export const MAX_KEYS_PER_OWNER = 10;

export function hashApiKey(key: string): string {
  const pepper = process.env.API_KEY_PEPPER;
  if (pepper) {
    return createHmac("sha256", pepper).update(key).digest("hex");
  }
  return createHash("sha256").update(key).digest("hex");
}

function hashApiKeyLegacy(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function safeCompare(a: string, b: string): boolean {
  return secureCompare(a, b);
}

export function generateApiKey(): string {
  return `vouch_live_${randomBytes(24).toString("hex")}`;
}

export function normalizePlan(plan: string): string {
  return VALID_PLANS.has(plan) ? plan : "free";
}

export async function verifyApiKey(token: string): Promise<ApiKeyRecord | null> {
  const db = getDb();
  if (!db) return null;

  const primaryHash = hashApiKey(token);
  const legacyHash = hashApiKeyLegacy(token);

  const rows = await db
    .select({
      id: apiKeys.id,
      plan: apiKeys.plan,
      name: apiKeys.name,
      keyHash: apiKeys.keyHash,
      userId: apiKeys.userId,
    })
    .from(apiKeys)
    .where(
      and(
        or(eq(apiKeys.keyHash, primaryHash), eq(apiKeys.keyHash, legacyHash)),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);

  const record = rows[0];

  if (!record) return null;

  if (
    process.env.API_KEY_PEPPER &&
    safeCompare(record.keyHash, legacyHash) &&
    !safeCompare(record.keyHash, primaryHash)
  ) {
    void db
      .update(apiKeys)
      .set({ keyHash: hashApiKey(token) })
      .where(eq(apiKeys.id, record.id))
      .catch((error) => logServerErrorSafe("api_key_rehash", error));
  }

  const expected = record.keyHash;
  const candidate = safeCompare(expected, primaryHash)
    ? primaryHash
    : safeCompare(expected, legacyHash)
      ? legacyHash
      : null;

  if (!candidate) return null;

  void touchApiKeyUsage(record.id).catch((error) => logServerErrorSafe("api_key_last_used", error));

  return {
    id: record.id,
    plan: normalizePlan(record.plan),
    name: record.name,
    ownerId: record.userId ?? record.id,
  };
}

/**
 * 認証が通ったキーの「最後に使った時刻」と「初めて使った時刻」を 1 本の UPDATE で書く
 * （2026-09-28 PMF 計測: 外部キーが実際に使われ始めたかを数える列）。
 * first_used_at は NULL のときだけ入る（COALESCE）。ホットパスのクエリ本数は増やさない。
 * 列は scripts/sql/2026-09-28-api-keys-first-used.sql（デプロイより先に適用する）。
 */
export async function touchApiKeyUsage(id: string, now: Date = new Date()): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now, firstUsedAt: sql`COALESCE(${apiKeys.firstUsedAt}, ${now.toISOString()}::timestamptz)` })
    .where(eq(apiKeys.id, id));
}

export async function createApiKey(params: {
  plan?: string;
  name?: string;
  userId?: string;
}): Promise<{ id: string; key: string; plan: string }> {
  const db = getDb();
  if (!db) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (isProduction() && !process.env.API_KEY_PEPPER) {
    throw new Error("API_KEY_PEPPER is required in production");
  }

  if (params.userId) {
    const active = await countActiveKeysForOwner(params.userId);
    if (active >= MAX_KEYS_PER_OWNER) {
      throw new Error("key_limit_reached");
    }
  }

  const key = generateApiKey();
  const plan = normalizePlan(params.plan ?? "free");

  const [row] = await db
    .insert(apiKeys)
    .values({
      keyHash: hashApiKey(key),
      plan,
      name: params.name ?? null,
      userId: params.userId ?? null,
    })
    .returning();

  return { id: row.id, key, plan: normalizePlan(row.plan) };
}

export async function getApiKeyById(id: string) {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      plan: apiKeys.plan,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      userId: apiKeys.userId,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return { ...row, plan: normalizePlan(row.plan) };
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning();

  return result.length > 0;
}

export async function ensureOwnerUserId(apiKeyId: string): Promise<string> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  const key = await getApiKeyById(apiKeyId);
  if (!key) throw new Error("api_key_not_found");
  if (key.userId) return key.userId;

  await db.update(apiKeys).set({ userId: apiKeyId }).where(eq(apiKeys.id, apiKeyId));
  return apiKeyId;
}

export async function listApiKeysForOwner(apiKeyId: string) {
  const db = getDb();
  if (!db) return [];

  const userId = await ensureOwnerUserId(apiKeyId);

  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      plan: apiKeys.plan,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));

  return rows.map((row) => ({ ...row, plan: normalizePlan(row.plan) }));
}

export async function canManageApiKey(actorKeyId: string, targetKeyId: string): Promise<boolean> {
  const actor = await getApiKeyById(actorKeyId);
  const target = await getApiKeyById(targetKeyId);
  if (!actor || !target || target.revokedAt) return false;
  if (!actor.userId || !target.userId) return actorKeyId === targetKeyId;
  return actor.userId === target.userId;
}

export async function countActiveKeysForOwner(userId: string): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const rows = await db
    .select({ value: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));

  return rows[0]?.value ?? 0;
}
