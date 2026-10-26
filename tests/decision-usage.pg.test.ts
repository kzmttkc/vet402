// 判定のチェーン集計、公開表に鍵やメールが出ないこと、external だけを数えられること。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_test_celo \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/decision-usage.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("decision usage by chain (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("decision usage records chain, hides the key, and sums external", async (t) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { getDb } = await import("@/lib/db/client");
    const { setAfterResponseSchedulerForTest } = await import("@/lib/util/after-response");
    const { createApiKey } = await import("@/lib/db/api-keys");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { decisionCache } = await import("@/lib/decision/cache");
    const { payeeId } = await import("@/lib/ids/canonical");
    const { GET: decisionGET } = await import("@/app/api/v1/resources/[resourceId]/decision/route");
    const { GET: resolveGET } = await import("@/app/api/v1/resolve/route");
    const { GET: usageGET } = await import("@/app/api/v1/usage/monthly/route");
    const pageMod = await import("@/app/usage/monthly/page");
    const { NextRequest } = await import("next/server");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = (raw: unknown) =>
      [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[])];

    const sqlFile = join(process.cwd(), "scripts/sql/2026-10-26-decision-usage-chain.sql");
    execFileSync("psql", [TEST_DB, "-v", "ON_ERROR_STOP=1", "-f", sqlFile], { stdio: "pipe" });
    execFileSync("psql", [TEST_DB, "-v", "ON_ERROR_STOP=1", "-f", sqlFile], { stdio: "pipe" });
    assert.ok(readFileSync(sqlFile, "utf8").includes("decision_usage_daily"));

    const pending: Array<() => Promise<void>> = [];
    setAfterResponseSchedulerForTest((task) => pending.push(task));
    t.after(() => setAfterResponseSchedulerForTest(null));
    const drain = async () => {
      while (pending.length) await pending.shift()!();
    };
    process.env.PROXY_HEADER_SOURCE = "generic";

    const SECRET_EMAIL = "usage-secret@example.com";
    const SECRET_NAME = "SECRET-OWNER-NAME";
    const CELO_URL = "https://usage-celo.example/api";
    const BASE_URL = "https://usage-base.example/api";
    const celoAccepts = [{ amount: "1000", asset: "0x" + "ce".repeat(20), network: "eip155:42220", payTo: "0x" + "11".repeat(20) }];
    const baseAccepts = [{ amount: "1000", asset: "0x" + "ab".repeat(20), network: "eip155:8453", payTo: "0x" + "22".repeat(20) }];
    await db.execute(sql`TRUNCATE client_usage_daily, decision_usage_daily, ip_rate_limits, x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_resource_aliases`);
    await syncCatalog({
      fetchResult: {
        items: [
          parseCatalogItem({ resource: CELO_URL, accepts: celoAccepts, extensions: { bazaar: { info: { input: { method: "GET" } } } } }),
          parseCatalogItem({ resource: BASE_URL, accepts: baseAccepts, extensions: { bazaar: { info: { input: { method: "GET" } } } } }),
        ],
        totalCount: 2,
        fetchedCount: 2,
        complete: true,
      },
      today: "2026-10-26",
    });
    const listed = rows(await db.execute(sql`SELECT id::text AS id, resource_id, resource_url, network FROM x402_endpoints ORDER BY resource_url`));
    const celo = listed.find((row) => row.resource_url === CELO_URL);
    const base = listed.find((row) => row.resource_url === BASE_URL);
    assert.ok(celo && base);
    assert.equal(celo.network, "eip155:42220");
    assert.equal(base.network, "eip155:8453");
    const seed = (obs: string) => {
      const result = { recommendation: "ALLOW", reason_codes: ["l0_pass"], facts: {}, evidence: [], rules_version: "test", degraded: false };
      decisionCache.set(`${obs}|payer|-|0|0|0`, { result: result as never, expiresAt: Date.now() + 60_000 });
    };
    const payerRaw = "0x" + "ab".repeat(20);
    const payerId = payeeId("eip155:8453", payerRaw);
    decisionCache.set(`${String(celo.id)}|payee|${payerId}|0|0`, {
      result: { recommendation: "ALLOW", reason_codes: ["l0_pass"], facts: { sybil: { unavailable: [] } }, evidence: [], rules_version: "test", degraded: false, role: "payee", payer: payerId } as never,
      expiresAt: Date.now() + 60_000,
    });

    let ipSeq = 0;
    const nextIp = () => `198.51.100.${++ipSeq}`;
    const decision = async (rid: string, extra: Record<string, string> = {}, query = "role=payer") => {
      const headers: Record<string, string> = { "x-forwarded-for": nextIp(), "user-agent": "curl/8.0.0", ...extra };
      const res = await decisionGET(
        new NextRequest(`http://localhost/api/v1/resources/${rid}/decision?${query}`, { headers }),
        { params: Promise.resolve({ resourceId: rid }) },
      );
      return { status: res.status, body: await res.json(), text: "" };
    };

    const account = rows(await db.execute(sql`INSERT INTO accounts (email) VALUES (${SECRET_EMAIL}) RETURNING id::text AS id`))[0];
    const external = await createApiKey({ name: SECRET_NAME, userId: String(account.id) });
    const selfKey = await createApiKey({ name: SECRET_NAME });
    const baseOnly = await createApiKey({ name: SECRET_NAME });
    await db.execute(sql`UPDATE api_keys SET owner_relation = 'external' WHERE id = ${external.id}::uuid`);
    await db.execute(sql`UPDATE api_keys SET owner_relation = 'self' WHERE id = ${selfKey.id}::uuid`);
    await assert.rejects(
      () => db.execute(sql`UPDATE api_keys SET owner_relation = 'nope' WHERE id = ${external.id}::uuid`),
    );

    seed(String(celo.id));
    seed(String(base.id));
    assert.equal((await decision(String(celo.resource_id))).status, 200);
    assert.equal((await decision(String(celo.resource_id))).status, 200);
    assert.equal((await decision(String(base.resource_id))).status, 200);
    assert.equal((await decision(String(celo.resource_id), {}, `role=payee&payer=${payerRaw}`)).status, 200);
    assert.equal((await decision("not-a-resource")).status, 400);
    assert.equal(
      (await decision(String(celo.resource_id), { authorization: `Bearer ${external.key}` })).status,
      200,
    );
    assert.equal(
      (await decision(String(celo.resource_id), { authorization: `Bearer ${external.key}` })).status,
      200,
    );
    assert.equal(
      (await decision(String(celo.resource_id), { authorization: `Bearer ${selfKey.key}`, "idempotency-key": "usage-replay-1" })).status,
      200,
    );
    assert.equal(
      (await decision(String(celo.resource_id), { authorization: `Bearer ${selfKey.key}`, "idempotency-key": "usage-replay-1" })).status,
      200,
    );
    assert.equal(
      (await decision(String(base.resource_id), { authorization: `Bearer ${baseOnly.key}` })).status,
      200,
    );
    const resolveRes = await resolveGET(
      new NextRequest(`http://localhost/api/v1/resolve?q=${encodeURIComponent(CELO_URL)}`, {
        headers: { "x-forwarded-for": nextIp(), "user-agent": "curl/8.0.0" },
      }),
    );
    assert.equal(resolveRes.status, 200);
    await drain();

    const keyless = rows(
      await db.execute(
        sql`SELECT chain, client, route, count::int AS count FROM client_usage_daily WHERE route = 'decision' ORDER BY chain, client`,
      ),
    );
    assert.deepEqual(keyless, [
      { chain: "eip155:42220", client: "other", route: "decision", count: 3 },
      { chain: "eip155:8453", client: "other", route: "decision", count: 1 },
    ]);
    const resolveChain = rows(await db.execute(sql`SELECT chain FROM client_usage_daily WHERE route = 'resolve'`));
    assert.deepEqual(resolveChain.map((row) => row.chain), [""]);

    const keyed = rows(
      await db.execute(
        sql`SELECT k.owner_relation, d.chain, d.count::int AS count
            FROM decision_usage_daily d JOIN api_keys k ON k.id = d.api_key_id
            ORDER BY d.chain, k.owner_relation NULLS LAST`,
      ),
    );
    assert.deepEqual(keyed, [
      { owner_relation: "external", chain: "eip155:42220", count: 2 },
      { owner_relation: "self", chain: "eip155:42220", count: 1 },
      { owner_relation: null, chain: "eip155:8453", count: 1 },
    ]);
    const billed = rows(await db.execute(sql`SELECT coalesce(sum(count), 0)::int AS n FROM api_usage WHERE api_key_id = ${external.id}::uuid`));
    assert.ok(Number(billed[0]?.n) >= 1);

    const month = new Date().toISOString().slice(0, 7);
    const usageRes = await usageGET(
      new NextRequest(`http://localhost/api/v1/usage/monthly?chain=eip155:42220&month=${month}`, {
        headers: { "x-forwarded-for": nextIp() },
      }),
    );
    assert.equal(usageRes.status, 200);
    const body = (await usageRes.json()) as {
      chain: string;
      month: string;
      keyed: { label: string; owner_relation: string | null; calls: number }[];
      keyless: { client: string; calls: number }[];
      external_calls: number;
    };
    assert.equal(body.chain, "eip155:42220");
    assert.equal(body.month, month);
    assert.equal(body.external_calls, 2);
    assert.deepEqual(
      body.keyed.map((row) => row.owner_relation).sort(),
      ["external", "self"],
    );
    assert.equal(body.keyed.find((row) => row.owner_relation === "external")?.calls, 2);
    assert.ok(body.keyed.every((row) => /^key-\d+$/.test(row.label)));
    assert.deepEqual(body.keyless, [{ client: "other", calls: 3 }]);
    const dumped = JSON.stringify(body);
    for (const secret of [external.key, selfKey.key, baseOnly.key, SECRET_EMAIL, SECRET_NAME, external.id, selfKey.id, baseOnly.id]) {
      assert.equal(dumped.includes(secret), false, secret.slice(0, 8));
    }
    const missing = await usageGET(new NextRequest("http://localhost/api/v1/usage/monthly", { headers: { "x-forwarded-for": nextIp() } }));
    assert.equal(missing.status, 400);
    const empty = await usageGET(
      new NextRequest("http://localhost/api/v1/usage/monthly?chain=eip155:42220&month=1999-01", { headers: { "x-forwarded-for": nextIp() } }),
    );
    const emptyBody = await empty.json();
    assert.equal(empty.status, 200);
    assert.equal(emptyBody.external_calls, 0);
    assert.deepEqual(emptyBody.keyed, []);
    assert.deepEqual(emptyBody.keyless, []);

    const element = await pageMod.default({ searchParams: Promise.resolve({ chain: "eip155:42220", month }) });
    const html = renderToStaticMarkup(element);
    assert.match(html, /External relation calls: 2/);
    assert.match(html, /key-\d+/);
    assert.match(html, />external</);
    assert.doesNotMatch(html, /SECRET-OWNER-NAME|usage-secret@example\.com/);
    for (const secret of [external.key, selfKey.key, external.id]) assert.equal(html.includes(secret), false);

    await db.execute(sql`DELETE FROM api_usage WHERE api_key_id IN (${external.id}::uuid, ${selfKey.id}::uuid, ${baseOnly.id}::uuid)`);
    await db.execute(sql`DELETE FROM decision_usage_daily WHERE api_key_id IN (${external.id}::uuid, ${selfKey.id}::uuid, ${baseOnly.id}::uuid)`);
    await db.execute(sql`DELETE FROM api_keys WHERE id IN (${external.id}::uuid, ${selfKey.id}::uuid, ${baseOnly.id}::uuid)`);
    await db.execute(sql`DELETE FROM accounts WHERE id = ${account.id}::uuid`);
  });
}
