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
    const cols = rows(
      await db.execute(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'client_usage_daily' ORDER BY ordinal_position`,
      ),
    ).map((row) => row.column_name);
    assert.deepEqual(cols, ["day", "client", "route", "count"]);
    const oldUpsert = sql`
      INSERT INTO client_usage_daily (day, client, route, count)
      VALUES ('2020-01-02'::date, 'other', 'resolve', 1)
      ON CONFLICT (day, client, route) DO UPDATE SET count = client_usage_daily.count + 1
    `;
    await db.execute(oldUpsert);
    await db.execute(oldUpsert);
    assert.equal(
      rows(await db.execute(sql`SELECT count::int AS count FROM client_usage_daily WHERE day = '2020-01-02'::date`))[0]?.count,
      2,
    );
    const oldKey = rows(
      await db.execute(
        sql`INSERT INTO api_keys (key_hash, plan) VALUES ('old-code-shape-usage', 'free') RETURNING id::text AS id, owner_relation`,
      ),
    )[0];
    assert.equal(oldKey?.owner_relation ?? null, null);
    await db.execute(sql`DELETE FROM api_keys WHERE id = ${String(oldKey?.id)}::uuid`);

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
    await db.execute(sql`UPDATE x402_endpoints SET network = 'celo' WHERE id = ${String(celo.id)}::uuid`);
    assert.equal(
      rows(await db.execute(sql`SELECT network FROM x402_endpoints WHERE id = ${String(celo.id)}::uuid`))[0]?.network,
      "celo",
    );
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
    const externalKeys = [];
    for (let i = 0; i < 3; i += 1) {
      const key = await createApiKey({ name: SECRET_NAME, userId: String(account.id) });
      await db.execute(sql`UPDATE api_keys SET owner_relation = 'external' WHERE id = ${key.id}::uuid`);
      externalKeys.push(key);
    }
    const external = externalKeys[0]!;
    const selfKey = await createApiKey({ name: SECRET_NAME });
    const baseOnly = await createApiKey({ name: SECRET_NAME });
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
    for (const key of externalKeys) {
      assert.equal(
        (await decision(String(celo.resource_id), { authorization: `Bearer ${key.key}` })).status,
        200,
      );
    }
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

    await assert.rejects(() => db.execute(sql`SELECT chain FROM client_usage_daily`));
    const keyless = rows(
      await db.execute(
        sql`SELECT client, route, count::int AS count FROM client_usage_daily WHERE route = 'decision' ORDER BY client`,
      ),
    );
    assert.deepEqual(keyless, [{ client: "other", route: "decision", count: 4 }]);
    const resolveRows = rows(
      await db.execute(sql`SELECT client, count::int AS count FROM client_usage_daily WHERE route = 'resolve'`),
    );
    assert.deepEqual(resolveRows, [{ client: "other", count: 1 }]);

    const keyed = rows(
      await db.execute(
        sql`SELECT k.owner_relation, d.chain, d.count::int AS count
            FROM decision_usage_daily d JOIN api_keys k ON k.id = d.api_key_id
            ORDER BY d.chain, k.owner_relation NULLS LAST, d.count`,
      ),
    );
    assert.deepEqual(keyed, [
      { owner_relation: "external", chain: "eip155:42220", count: 1 },
      { owner_relation: "external", chain: "eip155:42220", count: 1 },
      { owner_relation: "external", chain: "eip155:42220", count: 1 },
      { owner_relation: "self", chain: "eip155:42220", count: 1 },
      { owner_relation: null, chain: "eip155:8453", count: 1 },
    ]);
    const billed = rows(await db.execute(sql`SELECT coalesce(sum(count), 0)::int AS n FROM api_usage WHERE api_key_id = ${external.id}::uuid`));
    assert.ok(Number(billed[0]?.n) >= 1);

    const month = new Date().toISOString().slice(0, 7);
    type RelationRow = { owner_relation: string | null; keys: number | "<3"; calls?: number };
    const loadUsage = async (query: string) =>
      usageGET(new NextRequest(`http://localhost/api/v1/usage/monthly${query}`, { headers: { "x-forwarded-for": nextIp() } }));
    const usageRes = await loadUsage(`?chain=eip155:42220&month=${month}`);
    assert.equal(usageRes.status, 200);
    const body = (await usageRes.json()) as { chain: string; month: string; relations: RelationRow[] };
    assert.equal(body.chain, "eip155:42220");
    assert.equal(body.month, month);
    assert.equal("keyless" in body, false);
    assert.deepEqual(
      body.relations.find((row) => row.owner_relation === "external"),
      { owner_relation: "external", keys: 3, calls: 3 },
    );
    const selfRow = body.relations.find((row) => row.owner_relation === "self");
    assert.deepEqual(selfRow, { owner_relation: "self", keys: "<3" });
    assert.equal(selfRow !== undefined && "calls" in selfRow, false);
    const dumped = JSON.stringify(body);
    const secrets = [
      ...externalKeys.flatMap((key) => [key.key, key.id]),
      selfKey.key,
      selfKey.id,
      baseOnly.key,
      baseOnly.id,
      SECRET_EMAIL,
      SECRET_NAME,
    ];
    for (const secret of secrets) assert.equal(dumped.includes(secret), false, secret.slice(0, 8));
    const missing = await loadUsage("");
    assert.equal(missing.status, 400);
    const unlisted = await loadUsage(`?chain=eip155:8453&month=${month}`);
    assert.equal(unlisted.status, 400);
    assert.equal((await unlisted.json()).error, "chain_unlisted");
    const alias = await loadUsage(`?chain=celo&month=${month}`);
    assert.equal(alias.status, 200);
    assert.equal((await alias.json()).chain, "eip155:42220");
    const empty = await loadUsage("?chain=eip155:42220&month=1999-01");
    const emptyBody = await empty.json();
    assert.equal(empty.status, 200);
    assert.deepEqual(emptyBody.relations, []);
    assert.equal("keyless" in emptyBody, false);

    const element = await pageMod.default({ searchParams: Promise.resolve({ chain: "eip155:42220", month }) });
    const html = renderToStaticMarkup(element);
    assert.match(html, /Calls made without a key are not counted per chain/);
    assert.match(html, /&lt;3/);
    assert.match(html, /withheld/);
    assert.match(html, />external</);
    assert.doesNotMatch(html, /Keyless calls/);
    assert.doesNotMatch(html, /key-\d+/);
    assert.doesNotMatch(html, /SECRET-OWNER-NAME|usage-secret@example\.com/);
    for (const secret of secrets) assert.equal(html.includes(secret), false);

    const doc = readFileSync(join(process.cwd(), "docs/operations/account-deletion.md"), "utf8");
    const fence = (heading: string) => {
      const at = doc.indexOf(heading);
      assert.ok(at >= 0, heading);
      const start = doc.indexOf("```sql", at);
      const end = doc.indexOf("```", start + 6);
      return doc.slice(start + 6, end).trim();
    };
    const runOps = (script: string) => {
      execFileSync("psql", [TEST_DB, "-v", "ON_ERROR_STOP=1"], { input: script, stdio: ["pipe", "pipe", "pipe"] });
    };
    runOps(fence("## アカウント").replaceAll("__ACCOUNT_ID__", String(account.id)));
    const detached = rows(
      await db.execute(
        sql`SELECT api_key_id::text AS id, relation_snapshot, count::int AS count
            FROM decision_usage_daily WHERE chain = 'eip155:42220' AND relation_snapshot = 'external'
            ORDER BY api_key_id`,
      ),
    );
    assert.equal(detached.length, 3);
    assert.deepEqual(
      detached.map((row) => row.relation_snapshot),
      ["external", "external", "external"],
    );
    const originalIds = new Set(externalKeys.map((key) => key.id));
    for (const row of detached) assert.equal(originalIds.has(String(row.id)), false);
    for (const key of externalKeys) {
      await db.execute(sql`UPDATE api_keys SET owner_relation = 'self' WHERE id = ${key.id}::uuid`);
    }
    runOps(fence("## 鍵 1 本").replaceAll("__API_KEY_ID__", selfKey.id));
    for (const key of [...externalKeys, selfKey]) {
      await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${key.id}::uuid`);
      await db.execute(sql`DELETE FROM api_keys WHERE id = ${key.id}::uuid`);
    }
    const afterDelete = await loadUsage(`?chain=eip155:42220&month=${month}`);
    const afterBody = (await afterDelete.json()) as { relations: RelationRow[] };
    assert.deepEqual(
      afterBody.relations.find((row) => row.owner_relation === "external"),
      { owner_relation: "external", keys: 3, calls: 3 },
    );
    const selfAfter = afterBody.relations.find((row) => row.owner_relation === "self");
    assert.deepEqual(selfAfter, { owner_relation: "self", keys: "<3" });
    assert.equal(afterBody.relations.some((row) => row.owner_relation === null), false);

    await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${baseOnly.id}::uuid`);
    await db.execute(sql`DELETE FROM decision_usage_daily`);
    await db.execute(sql`DELETE FROM api_keys WHERE id = ${baseOnly.id}::uuid`);
    await db.execute(sql`DELETE FROM accounts WHERE id = ${account.id}::uuid`);
  });
}
