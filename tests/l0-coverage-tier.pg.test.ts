// coverage の回（tier "coverage"・/api/cron/l0-coverage）を実 DB で回す（2026-11-11）。
// 3.6 の初回は DB の試験が手元で skip され、c1 の並びに coverage7d の 3 段を前置して CI で落ちた。
// ここでは coverage の回だけが持つ振る舞いを DB で固定し、従来の経路が頭打ちしないことも同じ DB で見る:
//   - 窓の内の更新（1 回 L0_COVERAGE7D_IN_WINDOW_PER_RUN 件まで）と窓の外を選び、1 登録ドメイン ceil(limit / レーン) 件で頭打ち。
//   - 頭打ちで落ちた枠は他のドメインで埋め、溢れたドメインの残りは次の回へ回す。
//   - 同じ出品の行は 1 回の実行で 1 行だけ。
//   - c1・c2・all の経路（1 回の LIMIT）は同じデータでも頭打ちせず、SQL の並び（未測定 → 古い順）のまま流す。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_test_l0cov \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l0-coverage-tier.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l0 coverage tier (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("coverage の回: 窓の内の更新と窓の外を選び、太いドメインは頭打ちして他のドメインで埋める。all は頭打ちしない", async () => {
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { randomUUID } = await import("node:crypto");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
    const day = 86_400_000;
    const mk = async (url: string, firstSeenDaysAgo: number) => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `GET ${url}`,
        resourceUrl: url,
        method: "GET",
        priceAmount: "1000",
        payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
        network: "eip155:8453",
        status: "active",
        lastSeenAt: new Date(),
        firstSeenAt: new Date(Date.now() - firstSeenDaysAgo * day),
      });
      return id;
    };
    const probe = (endpointId: string, agoDays: number) =>
      db.insert(schema.x402L0Probes).values({ endpointId, method: "GET", verdict: "pass", probedAt: new Date(Date.now() - agoDays * day) });

    // 窓の内（3 日前に測った）2 件・窓の外の細いドメイン 4 件（10 日前）・窓の外の太いドメイン 8 件（未測定）。
    for (const name of ["w1", "w2"]) await probe(await mk(`https://${name}.example/api`, 40), 3);
    for (let i = 0; i < 4; i++) await probe(await mk(`https://thin-${i}.example/api`, 40), 10);
    for (let i = 0; i < 8; i++) await mk(`https://fat.example/n/${i}`, 30 - i);

    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 500 });
    };
    // limit 10・レーン 5 → 1 登録ドメイン ceil(10 / 5) = 2 件まで。
    const s = await runL0ProbeBatch({ tier: "coverage", limit: 10, concurrency: 5, fetchImpl, skipPriority: true });
    const host = (u: string) => new URL(u).hostname;
    const fat = seen.filter((u) => host(u) === "fat.example");
    assert.equal(fat.length, 2, `太いドメインは頭打ち（${seen.join(", ")}）`);
    assert.deepEqual(fat.sort(), ["https://fat.example/n/0", "https://fat.example/n/1"], "ドメインの中は古い順");
    for (const name of ["w1", "w2", "thin-0", "thin-1", "thin-2", "thin-3"]) {
      assert.ok(seen.some((u) => host(u) === `${name}.example`), `${name} が選ばれていない（${seen.join(", ")}）`);
    }
    assert.equal(seen.length, 8, "頭打ちで落ちた枠は他のドメインで埋め、残りの太いドメインは次の回へ");
    assert.equal(new Set(seen).size, seen.length, "同じ出品を 1 回で 2 度測らない");
    assert.equal(s.probed, 8);
    assert.equal(s.normalAbandoned, 0);
    assert.deepEqual(s.capped, []);
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l0_probes WHERE probed_at > now() - interval '1 hour'`);
    const n = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as { n: number }[];
    assert.equal(Number(n[0]?.n), 8, "測った件数だけ行がある");

    // all（c1・c2 と同じ経路）は同じ DB でも頭打ちしない（従来の 1 回の LIMIT）。直近 1 時間の行は消して同じ状態から。
    await db.execute(sql`DELETE FROM x402_l0_probes WHERE probed_at > now() - interval '1 hour'`);
    seen.length = 0;
    await runL0ProbeBatch({ tier: "all", limit: 10, concurrency: 1, fetchImpl });
    const all = seen.map(host);
    assert.equal(all.filter((h) => h === "fat.example").length, 8, "all は頭打ちせず、未測定（NULLS FIRST）の太いドメインが先");
    assert.deepEqual(all.slice(0, 8), Array(8).fill("fat.example"), "all は SQL の並び（古い順）のまま流す");
  });
}
