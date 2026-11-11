import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";
import * as schema from "./schema";

type AppDatabase = NeonHttpDatabase<typeof schema> | PostgresJsDatabase<typeof schema>;

let db: AppDatabase | null = null;

/**
 * The HTTP driver speaks Neon's proxy protocol — it works ONLY against
 * *.neon.tech. Keying on "is this Neon" (not "is this localhost") makes every
 * other Postgres — docker-compose の `postgres` サービス名、社内ホスト名 —
 * take the TCP driver, instead of silently failing fetch against a host that
 * has no HTTP proxy (docker compose self-host, 2026-08-20 実測).
 */
function isNeonDatabaseUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * 試験の中から本物の DB に届かせない関門（2026-11-11）。
 *
 * 事故: tests/spending-halt-route.test.ts の POST は本物の setSpendingHalt を呼ぶ。本番の DATABASE_URL が環境に
 * 入ったシェルで流れて、本番の runtime_flags.l1_spending_halt を書き（2026-11-10 21:31Z・"stop the money"）、
 * 全チェーンの購入が約 17 時間止まった。
 *
 * 決まり: node:test の中（NODE_TEST_CONTEXT、または入口が tests/ か *.test.* のファイル）では、
 *   1. 本番の Neon の endpoint には、どの変数から来ても繋がない
 *   2. DATABASE_URL は TEST_DATABASE_URL と同じときだけ使う（DB の試験は自分で代入してから繋ぐ）
 * 拒んだら例外で落とす。黙って null にしない。本番（Vercel）と運用のスクリプトは試験の中ではないので変わらない。
 */
const PRODUCTION_NEON_ENDPOINT_SHA256 = new Set([
  // 本番の Neon の endpoint id（ホスト名の最初のラベルから -pooler を外したもの）の sha256。値そのものは置かない。
  "bc1f6a14aba5fbac2749443ea21591075ffb84a41f4af735eb02f1ece5c8bb36",
]);

export function isProductionDatabaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (!host.endsWith(".neon.tech")) return false;
    const label = host.split(".")[0] ?? "";
    const endpoint = label.endsWith("-pooler") ? label.slice(0, -"-pooler".length) : label;
    return PRODUCTION_NEON_ENDPOINT_SHA256.has(createHash("sha256").update(endpoint, "utf8").digest("hex"));
  } catch {
    return false;
  }
}

type TestRunEnv = { NODE_TEST_CONTEXT?: string; TEST_DATABASE_URL?: string };

/** 名前を決めて読む（process.env を丸ごと渡さない。読む env 名の集合を試験で固定している面がある）。 */
function readTestRunEnv(): TestRunEnv {
  return { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL };
}

export function isInsideTestRun(env: TestRunEnv = readTestRunEnv(), argv: readonly string[] = process.argv): boolean {
  if (env.NODE_TEST_CONTEXT) return true;
  const entry = argv[1] ?? "";
  return /(^|[\\/])tests?[\\/]/.test(entry) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry);
}

/** 試験の中でこの接続先を拒む理由。拒まないなら null。 */
export function testRunDatabaseRefusal(
  url: string,
  env: TestRunEnv = readTestRunEnv(),
  argv: readonly string[] = process.argv,
): string | null {
  if (!isInsideTestRun(env, argv)) return null;
  if (isProductionDatabaseUrl(url)) return "the production database is refused inside a test run";
  if (url !== env.TEST_DATABASE_URL) return "inside a test run DATABASE_URL must equal TEST_DATABASE_URL";
  return null;
}

let testDbOverride: AppDatabase | null = null;

/**
 * TEST-ONLY seam. Lets a test inject an in-memory fake so the owner-scoping in
 * the data layer (removeWatch / deleteWebhook filter by apiKeyId) can be
 * exercised without a live Postgres. Never called on any production path.
 */
export function __setDbForTests(fake: unknown): void {
  testDbOverride = (fake as AppDatabase) ?? null;
}

export function getDb(): AppDatabase | null {
  if (testDbOverride) return testDbOverride;
  if (!process.env.DATABASE_URL) return null;

  if (!db) {
    const url = process.env.DATABASE_URL;
    const refusal = testRunDatabaseRefusal(url);
    if (refusal) throw new Error(`db: ${refusal}`);
    if (isNeonDatabaseUrl(url)) {
      const sql = neon(url);
      db = drizzleNeon(sql, { schema });
    } else {
      const client = postgres(url, { max: 10 });
      db = drizzlePostgres(client, { schema });
    }
  }

  return db;
}
