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
    const { loadMonthlyDecisionUsage, parseMonthlyUsageQuery, monthlyPublicationError, MonthlyUsageRejected, recordDecisionUsage } =
      await import("@/lib/api/decision-usage");
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
    const checks = rows(
      await db.execute(sql`
        SELECT conname FROM pg_constraint
        WHERE conrelid IN ('api_keys'::regclass, 'decision_usage_daily'::regclass, 'decision_usage_monthly_published'::regclass)
          AND contype = 'c'
          AND conname IN (
            'api_keys_owner_relation_check',
            'decision_usage_daily_relation_snapshot_check',
            'decision_usage_monthly_published_relation_check'
          )
        ORDER BY conname
      `),
    ).map((row) => row.conname);
    assert.deepEqual(checks, [
      "api_keys_owner_relation_check",
      "decision_usage_daily_relation_snapshot_check",
      "decision_usage_monthly_published_relation_check",
    ]);
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
    await db.execute(sql`TRUNCATE client_usage_daily, decision_usage_daily, decision_usage_monthly_published, ip_rate_limits, x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_resource_aliases`);
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

    const externalAccounts = [];
    const externalKeys = [];
    for (let i = 0; i < 3; i += 1) {
      const email = i === 0 ? SECRET_EMAIL : `usage-secret-${i}@example.com`;
      const account = rows(await db.execute(sql`INSERT INTO accounts (email) VALUES (${email}) RETURNING id::text AS id`))[0];
      externalAccounts.push(account);
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
    await drain();
    assert.equal(
      rows(await db.execute(sql`SELECT count(*)::int AS n FROM decision_usage_daily`))[0]?.n,
      0,
      "keyless calls write no decision_usage_daily rows",
    );
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

    function shiftMonth(year: number, monthIndex: number, delta: number) {
      const index = year * 12 + (monthIndex - 1) + delta;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    }
    function padMonth(year: number, monthIndex: number) {
      return `${String(year).padStart(4, "0")}-${String(monthIndex).padStart(2, "0")}`;
    }
    function readyUsageMonths(clock: Date, count: number): string[] {
      const found: string[] = [];
      let year = clock.getUTCFullYear();
      let monthIndex = clock.getUTCMonth() + 1;
      for (let i = 0; i < 48 && found.length < count; i += 1) {
        const prev = shiftMonth(year, monthIndex, -1);
        year = prev.year;
        monthIndex = prev.month;
        if (year < 2026) break;
        const label = padMonth(year, monthIndex);
        const parsed = parseMonthlyUsageQuery("eip155:42220", label);
        if (parsed.ok && monthlyPublicationError(parsed, clock) === null) found.push(label);
      }
      if (found.length < count) throw new Error(`need ${count} publishable months, found ${found.join(",") || "none"}`);
      return found;
    }
    const clock = new Date();
    const ready = readyUsageMonths(clock, 9);
    const month = ready[0]!;
    const emptyMonth = ready[1]!;
    const current = clock.toISOString().slice(0, 7);
    type RelationRow = { owner_relation: string | null; owners: number | "<3"; calls?: number };
    const loadUsage = async (query: string) =>
      usageGET(new NextRequest(`http://localhost/api/v1/usage/monthly${query}`, { headers: { "x-forwarded-for": nextIp() } }));
    await db.execute(sql`UPDATE decision_usage_daily SET day = ${`${month}-15`}::date`);
    const open = await loadUsage(`?chain=eip155:42220&month=${current}`);
    assert.equal(open.status, 400);
    assert.equal((await open.json()).error, "month_not_closed");
    assert.equal(
      rows(await db.execute(sql`SELECT count(*)::int AS n FROM decision_usage_monthly_published WHERE month = ${`${current}-01`}::date`))[0]?.n,
      0,
    );
    const future = await loadUsage("?chain=eip155:42220&month=2099-01");
    assert.equal(future.status, 400);
    assert.equal((await future.json()).error, "month_not_closed");
    for (const bad of ["0050-01", "0000-01", "1999-01"]) {
      const rejected = await loadUsage(`?chain=eip155:42220&month=${bad}`);
      assert.equal(rejected.status, 400, bad);
      assert.equal((await rejected.json()).error, "month_invalid", bad);
    }
    const empty = await loadUsage(`?chain=eip155:42220&month=${emptyMonth}`);
    const emptyBody = await empty.json();
    assert.equal(empty.status, 200);
    assert.deepEqual(emptyBody.relations, []);
    assert.equal("keyless" in emptyBody, false);
    const usageRes = await loadUsage(`?chain=eip155:42220&month=${month}`);
    assert.equal(usageRes.status, 200);
    const body = (await usageRes.json()) as { chain: string; month: string; relations: RelationRow[] };
    assert.equal(body.chain, "eip155:42220");
    assert.equal(body.month, month);
    assert.equal("keyless" in body, false);
    assert.deepEqual(
      body.relations.find((row) => row.owner_relation === "external"),
      { owner_relation: "external", owners: 3, calls: 3 },
    );
    const selfRow = body.relations.find((row) => row.owner_relation === "self");
    assert.deepEqual(selfRow, { owner_relation: "self", owners: "<3" });
    assert.equal(selfRow !== undefined && "calls" in selfRow, false);
    const dumped = JSON.stringify(body);
    const secrets = [
      ...externalKeys.flatMap((key) => [key.key, key.id]),
      selfKey.key,
      selfKey.id,
      baseOnly.key,
      baseOnly.id,
      SECRET_EMAIL,
      "usage-secret-1@example.com",
      "usage-secret-2@example.com",
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
    const aliasBody = (await alias.json()) as { chain: string; relations: RelationRow[] };
    assert.equal(aliasBody.chain, "eip155:42220");
    assert.deepEqual(aliasBody.relations, body.relations);
    const prefixed = await loadUsage(`?chain=EIP155:42220&month=${month}`);
    assert.equal(prefixed.status, 200);
    const prefixedBody = (await prefixed.json()) as { chain: string; relations: RelationRow[] };
    assert.equal(prefixedBody.chain, "eip155:42220");
    assert.deepEqual(prefixedBody.relations, body.relations);

    const publishedBefore = rows(
      await db.execute(sql`
        SELECT relation, owners::int AS owners, calls::int AS calls, published_at::text AS published_at
        FROM decision_usage_monthly_published
        WHERE month = ${`${month}-01`}::date AND chain = 'eip155:42220'
        ORDER BY relation
      `),
    );
    assert.equal(publishedBefore.find((row) => row.relation === "external")?.owners, 3);
    assert.equal(publishedBefore.find((row) => row.relation === "external")?.calls, 3);
    for (const key of externalKeys) {
      await db.execute(sql`UPDATE api_keys SET owner_relation = 'related' WHERE id = ${key.id}::uuid`);
    }
    const shifted = await loadUsage(`?chain=eip155:42220&month=${month}`);
    const shiftedBody = (await shifted.json()) as { relations: RelationRow[] };
    assert.deepEqual(
      shiftedBody.relations.find((row) => row.owner_relation === "external"),
      { owner_relation: "external", owners: 3, calls: 3 },
    );
    assert.equal(shiftedBody.relations.some((row) => row.owner_relation === "related"), false);
    const publishedAfter = rows(
      await db.execute(sql`
        SELECT relation, owners::int AS owners, calls::int AS calls, published_at::text AS published_at
        FROM decision_usage_monthly_published
        WHERE month = ${`${month}-01`}::date AND chain = 'eip155:42220'
        ORDER BY relation
      `),
    );
    assert.deepEqual(publishedAfter, publishedBefore);
    for (const key of externalKeys) {
      await db.execute(sql`UPDATE api_keys SET owner_relation = 'external' WHERE id = ${key.id}::uuid`);
    }

    const element = await pageMod.default({ searchParams: Promise.resolve({ chain: "eip155:42220", month }) });
    const html = renderToStaticMarkup(element);
    assert.match(html, /Calls made without a key are not counted per chain/);
    assert.match(html, /&lt;3/);
    assert.match(html, /withheld/);
    assert.match(html, />external</);
    assert.doesNotMatch(html, /Keyless calls/);
    assert.doesNotMatch(html, /key-\d+/);
    assert.doesNotMatch(html, /SECRET-OWNER-NAME|usage-secret/);
    assert.match(html, /Owners/);
    for (const secret of secrets) assert.equal(html.includes(secret), false);
    const closedPage = await pageMod.default({ searchParams: Promise.resolve({ chain: "eip155:42220", month: current }) });
    const closedHtml = renderToStaticMarkup(closedPage);
    assert.match(closedHtml, /month is still open/);

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
    for (const account of externalAccounts) {
      runOps(fence("## アカウント").replaceAll("__ACCOUNT_ID__", String(account.id)));
    }
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
      { owner_relation: "external", owners: 3, calls: 3 },
    );
    const selfAfter = afterBody.relations.find((row) => row.owner_relation === "self");
    assert.deepEqual(selfAfter, { owner_relation: "self", owners: "<3" });
    assert.equal(afterBody.relations.some((row) => row.owner_relation === null), false);

    const insertDaily = async (apiKeyId: string, label: string, count: number) => {
      await db.execute(sql`
        INSERT INTO decision_usage_daily (day, api_key_id, chain, count)
        VALUES (${`${label}-10`}::date, ${apiKeyId}::uuid, 'eip155:42220', ${count})
      `);
    };

    await t.test("one owner with three keys stays under 3 and hides calls", async () => {
      const label = ready[2]!;
      const owner = rows(
        await db.execute(sql`INSERT INTO accounts (email) VALUES ('usage-h1@example.com') RETURNING id::text AS id`),
      )[0];
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const key = await createApiKey({ name: "h1-owner", userId: String(owner?.id) });
        ids.push(key.id);
        await db.execute(sql`UPDATE api_keys SET owner_relation = 'external' WHERE id = ${key.id}::uuid`);
        await insertDaily(key.id, label, 4);
      }
      const res = await loadUsage(`?chain=eip155:42220&month=${label}`);
      assert.equal(res.status, 200);
      const published = (await res.json()) as { relations: RelationRow[] };
      assert.deepEqual(published.relations, [{ owner_relation: "external", owners: "<3" }]);
      const stored = rows(
        await db.execute(sql`
          SELECT owners::int AS owners, calls::int AS calls
          FROM decision_usage_monthly_published
          WHERE month = ${`${label}-01`}::date AND chain = 'eip155:42220' AND relation = 'external'
        `),
      );
      assert.deepEqual(stored, [{ owners: 1, calls: 12 }]);
      for (const id of ids) {
        await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${id}::uuid`);
        await db.execute(sql`DELETE FROM api_keys WHERE id = ${id}::uuid`);
      }
      await db.execute(sql`DELETE FROM accounts WHERE id = ${String(owner?.id)}::uuid`);
    });

    await t.test("unclassified shows <3 without calls, and hides calls at 3 owners", async () => {
      const small = ready[3]!;
      const large = ready[4]!;
      const smallOwner = rows(
        await db.execute(sql`INSERT INTO accounts (email) VALUES ('usage-unclass-small@example.com') RETURNING id::text AS id`),
      )[0];
      const smallKey = await createApiKey({ name: "unclass-small", userId: String(smallOwner?.id) });
      await insertDaily(smallKey.id, small, 7);
      const smallRes = await loadUsage(`?chain=eip155:42220&month=${small}`);
      assert.equal(smallRes.status, 200);
      const smallBody = (await smallRes.json()) as { relations: RelationRow[] };
      assert.deepEqual(smallBody.relations, [{ owner_relation: null, owners: "<3" }]);
      assert.equal("calls" in (smallBody.relations[0] ?? {}), false);

      const largeIds: string[] = [];
      const largeAccounts: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const owner = rows(
          await db.execute(
            sql`INSERT INTO accounts (email) VALUES (${`usage-unclass-${i}@example.com`}) RETURNING id::text AS id`,
          ),
        )[0];
        largeAccounts.push(String(owner?.id));
        const key = await createApiKey({ name: "unclass-large", userId: String(owner?.id) });
        largeIds.push(key.id);
        await insertDaily(key.id, large, 2);
      }
      const largeRes = await loadUsage(`?chain=eip155:42220&month=${large}`);
      assert.equal(largeRes.status, 200);
      const largeBody = (await largeRes.json()) as { relations: RelationRow[] };
      assert.deepEqual(largeBody.relations, [{ owner_relation: null, owners: 3 }]);
      assert.equal("calls" in (largeBody.relations[0] ?? {}), false);
      const storedCalls = rows(
        await db.execute(sql`
          SELECT calls::int AS calls FROM decision_usage_monthly_published
          WHERE month = ${`${large}-01`}::date AND chain = 'eip155:42220' AND relation = 'unclassified'
        `),
      );
      assert.equal(storedCalls[0]?.calls, 6);

      await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${smallKey.id}::uuid`);
      await db.execute(sql`DELETE FROM api_keys WHERE id = ${smallKey.id}::uuid`);
      await db.execute(sql`DELETE FROM accounts WHERE id = ${String(smallOwner?.id)}::uuid`);
      for (const id of largeIds) {
        await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${id}::uuid`);
        await db.execute(sql`DELETE FROM api_keys WHERE id = ${id}::uuid`);
      }
      for (const id of largeAccounts) await db.execute(sql`DELETE FROM accounts WHERE id = ${id}::uuid`);
    });

    await t.test("EIP155 prefix is stored and queried as eip155", async () => {
      const label = ready[5]!;
      const key = await createApiKey({ name: "prefix-case" });
      recordDecisionUsage(key.id, "EIP155:42220", new Date(`${label}-15T12:00:00.000Z`));
      await drain();
      const stored = rows(
        await db.execute(sql`SELECT chain FROM decision_usage_daily WHERE api_key_id = ${key.id}::uuid`),
      );
      assert.deepEqual(stored, [{ chain: "eip155:42220" }]);
      const res = await loadUsage(`?chain=EIP155:42220&month=${label}`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { chain: string }).chain, "eip155:42220");
      await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${key.id}::uuid`);
      await db.execute(sql`DELETE FROM api_keys WHERE id = ${key.id}::uuid`);
    });

    await t.test("a deleted account with three keys still counts as one owner", async () => {
      const label = ready[6]!;
      const owner = rows(
        await db.execute(sql`INSERT INTO accounts (email) VALUES ('usage-detached@example.com') RETURNING id::text AS id`),
      )[0];
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const key = await createApiKey({ name: "detached", userId: String(owner?.id) });
        ids.push(key.id);
        await db.execute(sql`UPDATE api_keys SET owner_relation = 'external' WHERE id = ${key.id}::uuid`);
        await insertDaily(key.id, label, 3);
      }
      runOps(fence("## アカウント").replaceAll("__ACCOUNT_ID__", String(owner?.id)));
      const res = await loadUsage(`?chain=eip155:42220&month=${label}`);
      assert.equal(res.status, 200);
      const published = (await res.json()) as { relations: RelationRow[] };
      assert.deepEqual(published.relations.find((row) => row.owner_relation === "external"), {
        owner_relation: "external",
        owners: "<3",
      });
      const owners = rows(
        await db.execute(
          sql`SELECT count(DISTINCT owner_snapshot)::int AS n, count(*) FILTER (WHERE owner_snapshot IS NULL)::int AS missing,
                     count(*) FILTER (WHERE owner_snapshot = ${String(owner?.id)}::uuid)::int AS linked
              FROM decision_usage_daily WHERE day >= ${label + "-01"}::date AND day < (${label + "-01"}::date + interval '1 month')`,
        ),
      )[0];
      assert.deepEqual(owners, { n: 1, missing: 0, linked: 0 });
      for (const id of ids) {
        await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${id}::uuid`);
        await db.execute(sql`DELETE FROM api_keys WHERE id = ${id}::uuid`);
      }
      await db.execute(sql`DELETE FROM accounts WHERE id = ${String(owner?.id)}::uuid`);
    });

    await t.test("prezenti_grantee: the 2026-10-28 SQL widens the checks, keeps published rows, and follows the <3 rule", async () => {
      const sql1028 = join(process.cwd(), "scripts/sql/2026-10-28-owner-relation-prezenti-grantee.sql");
      const defs = async () =>
        rows(
          await db.execute(sql`
            SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname IN ('api_keys_owner_relation_check', 'decision_usage_daily_relation_snapshot_check',
                              'decision_usage_monthly_published_relation_check')
            ORDER BY conname
          `),
        );
      // 本番の今の形（2026-10-26 の SQL だけ）に戻す。前の小試験が新しいコードで固定した月の 0 人の行も、旧コードは書かない。
      await db.execute(sql`DELETE FROM decision_usage_monthly_published WHERE relation = 'prezenti_grantee'`);
      await db.execute(sql`ALTER TABLE api_keys DROP CONSTRAINT api_keys_owner_relation_check`);
      await db.execute(sql`ALTER TABLE api_keys ADD CONSTRAINT api_keys_owner_relation_check CHECK (owner_relation IS NULL OR owner_relation IN ('self', 'related', 'external'))`);
      await db.execute(sql`ALTER TABLE decision_usage_daily DROP CONSTRAINT decision_usage_daily_relation_snapshot_check`);
      await db.execute(sql`ALTER TABLE decision_usage_daily ADD CONSTRAINT decision_usage_daily_relation_snapshot_check CHECK (relation_snapshot IS NULL OR relation_snapshot IN ('self', 'related', 'external'))`);
      await db.execute(sql`ALTER TABLE decision_usage_monthly_published DROP CONSTRAINT decision_usage_monthly_published_relation_check`);
      await db.execute(sql`ALTER TABLE decision_usage_monthly_published ADD CONSTRAINT decision_usage_monthly_published_relation_check CHECK (relation IN ('self', 'related', 'external', 'unclassified'))`);
      for (const row of await defs()) assert.equal(String(row.def).includes("prezenti_grantee"), false, String(row.conname));

      const small = ready[7]!;
      const large = ready[8]!;
      const created: { accounts: string[]; keys: string[] } = { accounts: [], keys: [] };
      const ownerKey = async (email: string, relation: string | null, label: string, count: number) => {
        const account = rows(await db.execute(sql`INSERT INTO accounts (email) VALUES (${email}) RETURNING id::text AS id`))[0];
        created.accounts.push(String(account?.id));
        const key = await createApiKey({ name: "prezenti", userId: String(account?.id) });
        created.keys.push(key.id);
        if (relation) await db.execute(sql`UPDATE api_keys SET owner_relation = ${relation} WHERE id = ${key.id}::uuid`);
        await insertDaily(key.id, label, count);
        return key.id;
      };

      // 古い制約のままでは、この値は入らない。
      const early = await ownerKey("usage-prezenti-early@example.com", null, small, 5);
      await assert.rejects(() => db.execute(sql`UPDATE api_keys SET owner_relation = 'prezenti_grantee' WHERE id = ${early}::uuid`));
      // 新しいアプリが SQL より先に出ると、固定の INSERT が落ち、何も書かない（だから SQL を先に流す）。
      const tooEarly = await loadUsage(`?chain=eip155:42220&month=${small}`);
      assert.notEqual(tooEarly.status, 200);
      assert.equal(
        rows(await db.execute(sql`SELECT count(*)::int AS n FROM decision_usage_monthly_published WHERE month = ${`${small}-01`}::date`))[0]?.n,
        0,
      );

      // 旧コードが 4 区分で固定した月（ready[1]）。SQL のあとも行は消えず、作り直されない。
      const oldMonth = ready[1]!;
      await db.execute(sql`DELETE FROM decision_usage_monthly_published WHERE month = ${`${oldMonth}-01`}::date`);
      await db.execute(sql`
        INSERT INTO decision_usage_monthly_published (month, chain, relation, owners, calls, published_at)
        VALUES (${`${oldMonth}-01`}::date, 'eip155:42220', 'self', 0, 0, '2026-10-03T00:00:00Z'),
               (${`${oldMonth}-01`}::date, 'eip155:42220', 'related', 0, 0, '2026-10-03T00:00:00Z'),
               (${`${oldMonth}-01`}::date, 'eip155:42220', 'external', 4, 10, '2026-10-03T00:00:00Z'),
               (${`${oldMonth}-01`}::date, 'eip155:42220', 'unclassified', 0, 0, '2026-10-03T00:00:00Z')
      `);
      const oldBefore = rows(
        await db.execute(sql`SELECT relation, owners::int AS owners, calls::int AS calls, published_at::text AS published_at
                             FROM decision_usage_monthly_published WHERE month = ${`${oldMonth}-01`}::date ORDER BY relation`),
      );

      execFileSync("psql", [TEST_DB, "-v", "ON_ERROR_STOP=1", "-f", sql1028], { stdio: "pipe" });
      execFileSync("psql", [TEST_DB, "-v", "ON_ERROR_STOP=1", "-f", sql1028], { stdio: "pipe" });
      const after = await defs();
      assert.equal(after.length, 3);
      for (const row of after) {
        const def = String(row.def);
        assert.ok(def.includes("prezenti_grantee"), String(row.conname));
        for (const kept of ["self", "related", "external"]) assert.ok(def.includes(`'${kept}'`), `${String(row.conname)} keeps ${kept}`);
      }
      assert.ok(String(after.find((row) => row.conname === "decision_usage_monthly_published_relation_check")?.def).includes("'unclassified'"));
      await assert.rejects(() => db.execute(sql`UPDATE api_keys SET owner_relation = 'prezenti' WHERE id = ${early}::uuid`));

      // 1 人の採択者と 3 人の external。採択者の行は <3 で件数なし。external の行に採択者は入らない。
      await db.execute(sql`UPDATE api_keys SET owner_relation = 'prezenti_grantee' WHERE id = ${early}::uuid`);
      for (let i = 0; i < 3; i += 1) await ownerKey(`usage-prezenti-ext-${i}@example.com`, "external", small, 2);
      // 旧コードで固定した月に採択者の行を足しても、公開の行は動かない。
      await insertDaily(early, oldMonth, 9);
      const oldRes = await loadUsage(`?chain=eip155:42220&month=${oldMonth}`);
      assert.equal(oldRes.status, 200);
      assert.deepEqual(((await oldRes.json()) as { relations: RelationRow[] }).relations, [{ owner_relation: "external", owners: 4, calls: 10 }]);
      const oldAfter = rows(
        await db.execute(sql`SELECT relation, owners::int AS owners, calls::int AS calls, published_at::text AS published_at
                             FROM decision_usage_monthly_published WHERE month = ${`${oldMonth}-01`}::date ORDER BY relation`),
      );
      assert.deepEqual(oldAfter, oldBefore);

      const smallRes = await loadUsage(`?chain=eip155:42220&month=${small}`);
      assert.equal(smallRes.status, 200);
      const smallBody = (await smallRes.json()) as { relations: RelationRow[] };
      assert.deepEqual(smallBody.relations, [
        { owner_relation: "external", owners: 3, calls: 6 },
        { owner_relation: "prezenti_grantee", owners: "<3" },
      ]);
      const storedSmall = rows(
        await db.execute(sql`SELECT relation, owners::int AS owners, calls::int AS calls FROM decision_usage_monthly_published
                             WHERE month = ${`${small}-01`}::date AND chain = 'eip155:42220' ORDER BY relation`),
      );
      assert.deepEqual(
        storedSmall.map((row) => row.relation),
        ["external", "prezenti_grantee", "related", "self", "unclassified"],
      );
      assert.deepEqual(storedSmall.find((row) => row.relation === "prezenti_grantee"), { relation: "prezenti_grantee", owners: 1, calls: 5 });

      // 3 人の採択者は人数と件数を出す。ページの表にも同じ値。
      for (let i = 0; i < 3; i += 1) await ownerKey(`usage-prezenti-${i}@example.com`, "prezenti_grantee", large, 4);
      const largeRes = await loadUsage(`?chain=eip155:42220&month=${large}`);
      assert.equal(largeRes.status, 200);
      assert.deepEqual(((await largeRes.json()) as { relations: RelationRow[] }).relations, [
        { owner_relation: "prezenti_grantee", owners: 3, calls: 12 },
      ]);
      const page = renderToStaticMarkup(await pageMod.default({ searchParams: Promise.resolve({ chain: "eip155:42220", month: large }) }));
      assert.match(page, /<td>prezenti_grantee<\/td><td>3<\/td><td>12<\/td>/);
      const pageSmall = renderToStaticMarkup(await pageMod.default({ searchParams: Promise.resolve({ chain: "eip155:42220", month: small }) }));
      assert.match(pageSmall, /<td>prezenti_grantee<\/td><td>&lt;3<\/td><td>withheld<\/td>/);
      assert.doesNotMatch(pageSmall, /usage-prezenti/);

      // アカウントを消すと、区分は relation_snapshot に残る（広げた CHECK を通る）。
      runOps(fence("## アカウント").replaceAll("__ACCOUNT_ID__", created.accounts[0]!));
      assert.equal(
        rows(await db.execute(sql`SELECT count(*)::int AS n FROM decision_usage_daily WHERE relation_snapshot = 'prezenti_grantee'`))[0]?.n,
        2,
      );

      for (const id of created.keys) {
        await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${id}::uuid`);
        await db.execute(sql`DELETE FROM api_keys WHERE id = ${id}::uuid`);
      }
      for (const id of created.accounts) await db.execute(sql`DELETE FROM accounts WHERE id = ${id}::uuid`);
    });

    await t.test("a closed month before the 3rd day writes nothing", async () => {
      const parsed = parseMonthlyUsageQuery("eip155:42220", "2099-11");
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      await assert.rejects(
        () => loadMonthlyDecisionUsage(parsed, new Date("2099-12-02T00:00:00.000Z")),
        (error: unknown) => error instanceof MonthlyUsageRejected && error.code === "month_not_published_yet",
      );
      assert.equal(
        rows(await db.execute(sql`SELECT count(*)::int AS n FROM decision_usage_monthly_published WHERE month = '2099-11-01'::date`))[0]?.n,
        0,
      );
    });

    await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${baseOnly.id}::uuid`);
    await db.execute(sql`DELETE FROM decision_usage_daily`);
    await db.execute(sql`DELETE FROM decision_usage_monthly_published`);
    await db.execute(sql`DELETE FROM api_keys WHERE id = ${baseOnly.id}::uuid`);
    for (const account of externalAccounts) {
      await db.execute(sql`DELETE FROM accounts WHERE id = ${String(account.id)}::uuid`);
    }
  });
}
