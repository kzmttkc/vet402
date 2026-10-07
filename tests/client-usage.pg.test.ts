// ============================================================
// client_usage_daily（2026-10-07）— 本物の DB で、ルートまで通す。
//
//  1. scripts/sql/2026-10-07-client-usage-daily.sql は再実行してよい
//  2. UA が vet402-hermes/ の /resolve と /decision（判定を返した 200）は (UTC 日, vet402-hermes/<版>, ルート) を 1 ずつ増やす
//  3. 他の UA は何も書かない
//  4. 表の中に URL・クエリ・IP・resource_id は入らない
//  5. UA を名乗るだけでは書き込みを増やせない: 枠で断った呼び出し・枠を戻す decision の 400/404 は数えない。
//     版を変えながら叩いても、1 日の client の種類は MAX_CLIENTS_PER_DAY（＋ other）で止まる
//  6. 表が無い（書き込みが失敗する）ときも、応答の status・本文・ヘッダは数えないときと同じ
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/client-usage.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("client usage daily (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("client usage daily", async (t) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { getDb } = await import("@/lib/db/client");
    const { setAfterResponseSchedulerForTest } = await import("@/lib/util/after-response");
    const { MAX_CLIENTS_PER_DAY, HERMES_OTHER_VERSION } = await import("@/lib/api/client-usage");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { decisionCache } = await import("@/lib/decision/cache");
    const { GET: resolveGET } = await import("@/app/api/v1/resolve/route");
    const { GET: decisionGET, DECISION_KEYLESS_LIMIT } = await import("@/app/api/v1/resources/[resourceId]/decision/route");
    const { NextRequest } = await import("next/server");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = (raw: unknown) =>
      [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[])].map((r) => ({ ...r }));
    const migration = readFileSync(join(process.cwd(), "scripts/sql/2026-10-07-client-usage-daily.sql"), "utf8");

    // 応答の後の処理を捕まえ、テストの中で待つ
    const pending: Array<() => Promise<void>> = [];
    setAfterResponseSchedulerForTest((task) => pending.push(task));
    const drain = async () => {
      while (pending.length) await pending.shift()!();
    };
    process.env.PROXY_HEADER_SOURCE = "generic";

    await db.execute(sql.raw(migration));
    await db.execute(sql.raw(migration)); // 再実行してよい
    await db.execute(
      sql`TRUNCATE client_usage_daily, ip_rate_limits, x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_resource_aliases`,
    );

    // 掲載 1 件（decision が 200 を返す相手）
    const TARGET = "https://mcp.zensched.com/x402/tools/event_list";
    const accepts = [{ amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453", payTo: "0x" + "33".repeat(20) }];
    await syncCatalog({
      fetchResult: { items: [parseCatalogItem({ resource: TARGET, accepts })], totalCount: 1, fetchedCount: 1, complete: true },
      today: new Date().toISOString().slice(0, 10),
    });
    const listed = rows(await db.execute(sql`SELECT id::text AS id, resource_id FROM x402_endpoints WHERE canonical_url = ${TARGET}`))[0];
    const RID = String(listed.resource_id);
    const OBS = String(listed.id);
    const UNKNOWN_RID = "d".repeat(64);
    const seedDecision = () =>
      decisionCache.set(`${OBS}|payer|-|0|0|0`, {
        result: { recommendation: "ALLOW", reason_codes: ["l0_pass"], facts: {}, evidence: [], rules_version: "test", degraded: false } as never,
        expiresAt: Date.now() + 60_000,
      });

    const today = new Date().toISOString().slice(0, 10);
    let ipSeq = 0;
    const nextIp = () => `198.51.100.${++ipSeq}`;
    const headersFor = (ua: string | null, ip: string) => {
      const h: Record<string, string> = { "x-forwarded-for": ip };
      if (ua) h["user-agent"] = ua;
      return h;
    };
    const resolve = async (ua: string | null, ip = nextIp()) => {
      const res = await resolveGET(new NextRequest(`http://localhost/api/v1/resolve?q=${encodeURIComponent(TARGET)}`, { headers: headersFor(ua, ip) }));
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const decision = async (ua: string | null, rid = RID, ip = nextIp()) => {
      seedDecision();
      const res = await decisionGET(
        new NextRequest(`http://localhost/api/v1/resources/${rid}/decision?role=payer&url=${encodeURIComponent(TARGET)}`, { headers: headersFor(ua, ip) }),
        { params: Promise.resolve({ resourceId: rid }) },
      );
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const table = async () =>
      rows(await db.execute(sql`SELECT day::text AS day, client, route, count::int AS count FROM client_usage_daily ORDER BY route, client`));
    const total = async (route: string) =>
      Number(rows(await db.execute(sql`SELECT coalesce(sum(count), 0)::int AS n FROM client_usage_daily WHERE route = ${route}`))[0].n);
    const reset = async () => db.execute(sql`TRUNCATE client_usage_daily, ip_rate_limits`);

    try {
      await t.test("vet402-hermes の resolve と decision（200）はルートごとに 1 ずつ増える", async () => {
        assert.equal((await resolve("vet402-hermes/0.1.0")).status, 200);
        await resolve("vet402-hermes/0.1.0");
        const d = await decision("vet402-hermes/0.1.0");
        assert.equal(d.status, 200);
        await drain();
        assert.deepEqual(await table(), [
          { day: today, client: "vet402-hermes/0.1.0", route: "decision", count: 1 },
          { day: today, client: "vet402-hermes/0.1.0", route: "resolve", count: 2 },
        ]);
      });

      await t.test("他の UA・UA 無しは数えない", async () => {
        const before = await table();
        await resolve("curl/8.7.1");
        await resolve(null);
        await decision("Mozilla/5.0 vet402-hermes/0.1.0");
        await decision(null);
        await drain();
        assert.deepEqual(await table(), before);
      });

      await t.test("表に URL・クエリ・IP・resource_id は入らない", async () => {
        const dump = JSON.stringify(rows(await db.execute(sql`SELECT * FROM client_usage_daily`)));
        assert.doesNotMatch(dump, /zensched|https?:|198\.51\.100\./);
        assert.ok(!dump.includes(RID));
        const cols = rows(
          await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'client_usage_daily' ORDER BY ordinal_position`),
        ).map((r) => r.column_name);
        assert.deepEqual(cols, ["day", "client", "route", "count"]);
      });

      await t.test("decision の 400/404（枠を戻す）は数えない・同じ IP の繰り返しは枠の数で止まる", async () => {
        await reset();
        const ip = "203.0.113.50";
        const statuses = new Set<number>();
        for (let i = 0; i < DECISION_KEYLESS_LIMIT + 5; i++) {
          statuses.add((await decision("vet402-hermes/0.1.0", "x", ip)).status);
          statuses.add((await decision("vet402-hermes/0.1.0", UNKNOWN_RID, ip)).status);
        }
        await drain();
        assert.deepEqual([...statuses].sort(), [400, 404]);
        assert.equal(await total("decision"), 0);

        const ip2 = "203.0.113.51";
        const ok: number[] = [];
        for (let i = 0; i < DECISION_KEYLESS_LIMIT + 5; i++) ok.push((await decision("vet402-hermes/0.1.0", RID, ip2)).status);
        await drain();
        assert.ok(ok.includes(429));
        assert.equal(await total("decision"), ok.filter((s) => s === 200).length);
        assert.ok((await total("decision")) <= DECISION_KEYLESS_LIMIT);
      });

      await t.test("resolve の枠で断った呼び出しは数えない", async () => {
        await reset();
        const ip = "203.0.113.60";
        const statuses: number[] = [];
        for (let i = 0; i < 65; i++) statuses.push((await resolve("vet402-hermes/0.1.0", ip)).status);
        await drain();
        assert.ok(statuses.includes(429));
        assert.equal(await total("resolve"), statuses.filter((s) => s !== 429 && s !== 503).length);
        assert.ok((await total("resolve")) <= 60);
      });

      await t.test("版を変えながら叩いても 1 日の client の種類は上限＋other で止まる", async () => {
        await reset();
        for (let i = 0; i < MAX_CLIENTS_PER_DAY + 8; i++) await resolve(`vet402-hermes/0.0.${i}`);
        await drain();
        const clients = rows(await db.execute(sql`SELECT DISTINCT client FROM client_usage_daily WHERE day = ${today}::date`)).map((r) => String(r.client));
        assert.equal(clients.length, MAX_CLIENTS_PER_DAY + 1);
        assert.ok(clients.includes(HERMES_OTHER_VERSION));
        assert.equal(await total("resolve"), MAX_CLIENTS_PER_DAY + 8);
        // 既にある版は上限の後も自分の行に足される
        await resolve("vet402-hermes/0.0.0");
        await drain();
        const zero = rows(await db.execute(sql`SELECT count::int AS n FROM client_usage_daily WHERE client = 'vet402-hermes/0.0.0'`))[0];
        assert.equal(zero.n, 2);
      });

      await t.test("書き込みが失敗しても応答は数えないときと同じ", async () => {
        await reset();
        const strip = (h: Headers) => [...h.entries()].filter(([k]) => !/^(x-)?ratelimit/i.test(k));
        await db.execute(sql`ALTER TABLE client_usage_daily RENAME TO client_usage_daily_moved`);
        try {
          const plainResolve = await resolve("curl/8.7.1");
          const hermesResolve = await resolve("vet402-hermes/0.1.0");
          const plainDecision = await decision("curl/8.7.1");
          const hermesDecision = await decision("vet402-hermes/0.1.0");
          await drain(); // 失敗は握りつぶされ、ここで投げない
          assert.equal(hermesResolve.status, plainResolve.status);
          assert.deepEqual(hermesResolve.body, plainResolve.body);
          assert.deepEqual(strip(hermesResolve.headers), strip(plainResolve.headers));
          assert.equal(hermesDecision.status, 200);
          assert.equal(hermesDecision.status, plainDecision.status);
          assert.deepEqual(hermesDecision.body, plainDecision.body);
          assert.deepEqual(
            strip(hermesDecision.headers).filter(([k]) => k !== "server-timing"),
            strip(plainDecision.headers).filter(([k]) => k !== "server-timing"),
          );
        } finally {
          await db.execute(sql`ALTER TABLE client_usage_daily_moved RENAME TO client_usage_daily`);
        }
      });
    } finally {
      setAfterResponseSchedulerForTest(null);
      await db.execute(
        sql`TRUNCATE client_usage_daily, ip_rate_limits, x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_resource_aliases`,
      );
    }
  });
}
