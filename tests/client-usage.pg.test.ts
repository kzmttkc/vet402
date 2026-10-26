// ============================================================
// client_usage_daily（2026-10-07・2026-10-11 に鍵なしの全部へ）— 本物の DB で、ルートまで通す。
//
//  1. scripts/sql/2026-10-07-client-usage-daily.sql は再実行してよい
//  2. 鍵なしで 200 を返した /resolve と /decision は (UTC 日, client, ルート) を 1 ずつ増やす。
//     client は決まった名前（vet402-hermes|sdk|mcp/<版>・self-monitor・crawler・site・browser・other）のどれか
//  3. 自社の監視（self-monitor）は別の行になり、利用の数字から除ける
//  4. 表の中に UA の生の文字列・URL・クエリ・IP・resource_id は入らない
//  5. 鍵つき（Authorization ヘッダが付いた）呼び出しは、resolve も decision も数えない
//  6. UA を名乗るだけでは書き込みを増やせない: 枠で断った呼び出し・resolve の 400・枠を戻す decision の 400/404 は
//     数えない。版を変えながら叩いても、1 日の版つきの client の種類は MAX_CLIENTS_PER_DAY で止まる
//     （決まった名前と <名前>/other はその数に入らない）
//  7. 表が無い（書き込みが失敗する）ときも、応答の status・本文・ヘッダは書き込めたときと同じ
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
    const { MAX_CLIENTS_PER_DAY, HERMES_OTHER_VERSION, FIXED_CLIENTS, DISTRIBUTED_CLIENTS } = await import("@/lib/api/client-usage");
    const { createApiKey } = await import("@/lib/db/api-keys");
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
    const headersFor = (ua: string | null, ip: string, extra: Record<string, string> = {}) => {
      const h: Record<string, string> = { "x-forwarded-for": ip, ...extra };
      if (ua) h["user-agent"] = ua;
      return h;
    };
    const resolve = async (ua: string | null, ip = nextIp(), extra: Record<string, string> = {}, query = `q=${encodeURIComponent(TARGET)}`) => {
      const res = await resolveGET(new NextRequest(`http://localhost/api/v1/resolve?${query}`, { headers: headersFor(ua, ip, extra) }));
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const decision = async (ua: string | null, rid = RID, ip = nextIp(), extra: Record<string, string> = {}) => {
      seedDecision();
      const res = await decisionGET(
        new NextRequest(`http://localhost/api/v1/resources/${rid}/decision?role=payer&url=${encodeURIComponent(TARGET)}`, { headers: headersFor(ua, ip, extra) }),
        { params: Promise.resolve({ resourceId: rid }) },
      );
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    const CANARY = "vet402-surface-consistency-canary";
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

      await t.test("他の UA・UA 無しは決まった名前に寄せて数える（自社の監視は self-monitor の行）", async () => {
        await reset();
        await resolve("curl/8.7.1");
        await resolve(null);
        await resolve("node");
        await resolve(CHROME);
        await resolve(CHROME, nextIp(), { "sec-fetch-site": "same-origin" });
        await resolve("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
        await resolve(CANARY);
        await resolve("kizuna-grant-figures/1");
        await resolve("vet402-hermes/0.1.0");
        assert.equal((await decision("Mozilla/5.0 vet402-hermes/0.1.0")).status, 200);
        assert.equal((await decision(null)).status, 200);
        assert.equal((await decision(CHROME, RID, nextIp(), { referer: `https://vet402.com/sellers/mcp.zensched.com?x=${RID}` })).status, 200);
        assert.equal((await decision(CANARY)).status, 200);
        await drain();
        assert.deepEqual(await table(), [
          { day: today, client: "browser", route: "decision", count: 1 },
          { day: today, client: "other", route: "decision", count: 1 },
          { day: today, client: "self-monitor", route: "decision", count: 1 },
          { day: today, client: "site", route: "decision", count: 1 },
          { day: today, client: "browser", route: "resolve", count: 1 },
          { day: today, client: "crawler", route: "resolve", count: 1 },
          { day: today, client: "other", route: "resolve", count: 3 },
          { day: today, client: "self-monitor", route: "resolve", count: 2 },
          { day: today, client: "site", route: "resolve", count: 1 },
          { day: today, client: "vet402-hermes/0.1.0", route: "resolve", count: 1 },
        ]);
        // CHANGELOG に添えた週の数え方（自社の監視を除く）は、self-monitor の行だけを落とす
        const external = rows(
          await db.execute(
            sql`SELECT route, sum(count)::int AS calls FROM client_usage_daily WHERE day >= current_date - 7 AND client <> 'self-monitor' GROUP BY 1 ORDER BY 1`,
          ),
        );
        assert.deepEqual(external, [
          { route: "decision", calls: 3 },
          { route: "resolve", calls: 7 },
        ]);
      });

      await t.test("表に UA の生の文字列・URL・クエリ・IP・resource_id は入らない", async () => {
        const all = rows(await db.execute(sql`SELECT * FROM client_usage_daily`));
        const dump = JSON.stringify(all);
        assert.doesNotMatch(dump, /zensched|https?:|198\.51\.100\.|Mozilla|Chrome|Googlebot|curl|kizuna|canary|grant-figures|"node"/);
        assert.ok(!dump.includes(RID));
        const allowed = (v: string) => FIXED_CLIENTS.includes(v) || /^vet402-(hermes|sdk|mcp)\/(\d{1,3}\.\d{1,3}\.\d{1,3}|other)$/.test(v);
        for (const r of all) assert.ok(allowed(String(r.client)), String(r.client));
        const cols = rows(
          await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'client_usage_daily' ORDER BY ordinal_position`),
        ).map((r) => r.column_name);
        assert.deepEqual(cols, ["day", "client", "route", "count", "chain"]);
      });

      await t.test("鍵つきの decision は数えない（誤った鍵の 401 も数えない）", async () => {
        await reset();
        const issued = await createApiKey({ name: "client-usage-test" });
        const keyed = await decision("vet402-hermes/0.1.0", RID, nextIp(), { authorization: `Bearer ${issued.key}` });
        assert.equal(keyed.status, 200);
        const keyedBrowser = await decision(CHROME, RID, nextIp(), { authorization: `Bearer ${issued.key}` });
        assert.equal(keyedBrowser.status, 200);
        const wrong = await decision("vet402-hermes/0.1.0", RID, nextIp(), { authorization: "Bearer vk_live_not_a_key" });
        assert.equal(wrong.status, 401);
        await drain();
        assert.equal(await total("decision"), 0);
        // 同じ UA の鍵なしは数える
        assert.equal((await decision("vet402-hermes/0.1.0")).status, 200);
        await drain();
        assert.deepEqual(await table(), [{ day: today, client: "vet402-hermes/0.1.0", route: "decision", count: 1 }]);
        await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${issued.id}`);
        await db.execute(sql`DELETE FROM api_keys WHERE id = ${issued.id}`);
      });

      await t.test("鍵つきの resolve は数えない（SDK と MCP サーバは鍵があれば resolve にも Authorization を付ける）", async () => {
        await reset();
        const issued = await createApiKey({ name: "client-usage-test-resolve" });
        // 有効な鍵・誤った鍵・Bearer でない Authorization のどれも、答えは同じ 200 で、鍵なしの数には入らない
        for (const auth of [`Bearer ${issued.key}`, "Bearer vk_live_not_a_key", "Basic abc"]) {
          for (const ua of ["node", "vet402-sdk/0.6.0", "vet402-hermes/0.1.0", CHROME, null]) {
            assert.equal((await resolve(ua, nextIp(), { authorization: auth })).status, 200);
          }
        }
        await drain();
        assert.deepEqual(await table(), []);
        // 同じ UA の鍵なしは数える。空白だけの Authorization も鍵なし
        assert.equal((await resolve("node")).status, 200);
        assert.equal((await resolve("node", nextIp(), { authorization: "  " })).status, 200);
        assert.equal((await resolve("vet402-sdk/0.6.0")).status, 200);
        await drain();
        assert.deepEqual(await table(), [
          { day: today, client: "other", route: "resolve", count: 2 },
          { day: today, client: "vet402-sdk/0.6.0", route: "resolve", count: 1 },
        ]);
        await db.execute(sql`DELETE FROM api_usage WHERE api_key_id = ${issued.id}`);
        await db.execute(sql`DELETE FROM api_keys WHERE id = ${issued.id}`);
      });

      await t.test("resolve の 400 は数えない（枠は消費したまま。数えるのは 200 だけ）", async () => {
        await reset();
        const ip = "203.0.113.70";
        const bad = [
          await resolve("curl/8.7.1", ip, {}, ""),
          await resolve("curl/8.7.1", ip, {}, "q="),
          await resolve("vet402-hermes/0.1.0", ip, {}, `q=${encodeURIComponent(TARGET)}&method=NOT-A-METHOD`),
          await resolve(CHROME, ip, {}, `q=${encodeURIComponent("x".repeat(3000))}`),
        ];
        assert.deepEqual(bad.map((r) => r.status), [400, 400, 400, 400]);
        await drain();
        assert.deepEqual(await table(), []);
        // 400 は枠を戻さない: 同じ IP で 400 を重ねると 429 になる。その間も 1 件も数えない
        const statuses: number[] = [];
        for (let i = 0; i < 62; i++) statuses.push((await resolve("curl/8.7.1", ip, {}, "")).status);
        await drain();
        assert.ok(statuses.includes(429));
        assert.equal(statuses.filter((x) => x === 400).length, 60 - bad.length);
        assert.deepEqual(await table(), []);
        // 別の IP の 200 は数える
        assert.equal((await resolve("curl/8.7.1")).status, 200);
        await drain();
        assert.deepEqual(await table(), [{ day: today, client: "other", route: "resolve", count: 1 }]);
      });

      await t.test("decision の 400/404（枠を戻す）は数えない・同じ IP の繰り返しは枠の数で止まる", async () => {
        await reset();
        const ip = "203.0.113.50";
        const statuses = new Set<number>();
        for (let i = 0; i < DECISION_KEYLESS_LIMIT + 5; i++) {
          statuses.add((await decision("vet402-hermes/0.1.0", "x", ip)).status);
          statuses.add((await decision("vet402-hermes/0.1.0", UNKNOWN_RID, ip)).status);
        }
        // 名前がどれでも同じ（鍵なしの全部を数えるようになっても、枠を戻す応答は数えない）
        for (const ua of ["curl/8.7.1", CHROME, CANARY, null]) {
          statuses.add((await decision(ua, "x")).status);
          statuses.add((await decision(ua, UNKNOWN_RID)).status);
        }
        await drain();
        assert.deepEqual([...statuses].sort(), [400, 404]);
        assert.equal(await total("decision"), 0);
        assert.deepEqual(await table(), []);

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
        for (let i = 0; i < 65; i++) statuses.push((await resolve(i % 2 ? "vet402-hermes/0.1.0" : "curl/8.7.1", ip)).status);
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
        // 上限に達した後も、決まった名前は自分の行に足される（配布物の other に混ざらない）
        const otherBefore = rows(await db.execute(sql`SELECT count::int AS n FROM client_usage_daily WHERE client = ${HERMES_OTHER_VERSION}`))[0].n;
        await resolve("curl/8.7.1");
        await resolve(CHROME);
        await resolve(CHROME);
        await resolve(CANARY);
        await drain();
        const after = Object.fromEntries(
          rows(await db.execute(sql`SELECT client, count::int AS n FROM client_usage_daily WHERE day = ${today}::date AND route = 'resolve'`)).map((r) => [String(r.client), Number(r.n)]),
        );
        assert.equal(after["other"], 1);
        assert.equal(after["browser"], 2);
        assert.equal(after["self-monitor"], 1);
        assert.equal(after[HERMES_OTHER_VERSION], otherBefore);
        // UA をどう変えても、1 日の client の種類は 上限 + 配布物の other + 決まった名前 を超えない
        for (let i = 0; i < 12; i++) await resolve(`vet402-hermes/9.9.${i}`);
        for (let i = 0; i < 12; i++) await resolve(`made-up-agent-${i}/1.0.${i}`);
        for (let i = 0; i < 6; i++) await resolve(`vet402-made-up-${i}/1.0.${i}`);
        await drain();
        const kinds = rows(await db.execute(sql`SELECT DISTINCT client FROM client_usage_daily WHERE day = ${today}::date`)).map((r) => String(r.client));
        assert.ok(kinds.length <= MAX_CLIENTS_PER_DAY + DISTRIBUTED_CLIENTS.length + FIXED_CLIENTS.length, String(kinds.length));
        assert.ok(!kinds.some((k) => k.includes("made-up") || k.startsWith("vet402-hermes/9.9.")));
      });

      await t.test("上限に数えるのは版つきの client だけ（決まった名前と <名前>/other が先に並んでも、版の枠は減らない）", async () => {
        await reset();
        // 日付が変わった直後に、決まった名前の全部と、版の形でない配布物の UA が先に来る
        await resolve("curl/8.7.1");
        await resolve(CHROME);
        await resolve(CHROME, nextIp(), { "sec-fetch-site": "same-origin" });
        await resolve("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
        await resolve(CANARY);
        await resolve("vet402-hermes/not-a-version");
        await resolve("vet402-sdk/next");
        await resolve("vet402-mcp/");
        await drain();
        const kindsOf = async () =>
          rows(await db.execute(sql`SELECT DISTINCT client FROM client_usage_daily WHERE day = ${today}::date`)).map((r) => String(r.client)).sort();
        assert.deepEqual(await kindsOf(), ["browser", "crawler", "other", "self-monitor", "site", "vet402-hermes/other", "vet402-mcp/other", "vet402-sdk/other"]);
        // それでも版つきの client は上限の数だけ、自分の行を持てる（配布物の名前をまたいで合わせて上限）
        const versioned: string[] = [];
        for (let i = 0; i < MAX_CLIENTS_PER_DAY; i++) versioned.push(`${DISTRIBUTED_CLIENTS[i % DISTRIBUTED_CLIENTS.length]}/1.0.${i}`);
        for (const v of versioned) await resolve(v);
        await drain();
        const kinds = await kindsOf();
        for (const v of versioned) assert.ok(kinds.includes(v), v);
        assert.equal(kinds.length, 8 + MAX_CLIENTS_PER_DAY);
        // 上限の次の版は、その配布物の other へ（ほかの配布物の other や決まった名前には混ざらない）
        const before = Object.fromEntries(rows(await db.execute(sql`SELECT client, count::int AS n FROM client_usage_daily WHERE route = 'resolve'`)).map((r) => [String(r.client), Number(r.n)]));
        await resolve("vet402-sdk/7.7.7");
        await resolve("vet402-mcp/7.7.7");
        await resolve("vet402-mcp/7.7.8");
        await drain();
        const after = Object.fromEntries(rows(await db.execute(sql`SELECT client, count::int AS n FROM client_usage_daily WHERE route = 'resolve'`)).map((r) => [String(r.client), Number(r.n)]));
        assert.equal(after["vet402-sdk/other"], before["vet402-sdk/other"] + 1);
        assert.equal(after["vet402-mcp/other"], before["vet402-mcp/other"] + 2);
        assert.equal(after["vet402-hermes/other"], before["vet402-hermes/other"]);
        assert.equal(after["other"], before["other"]);
        assert.equal((await kindsOf()).length, 8 + MAX_CLIENTS_PER_DAY);
        assert.equal(await total("resolve"), 8 + MAX_CLIENTS_PER_DAY + 3);
      });

      await t.test("書き込みが失敗しても応答は書き込めたときと同じ", async () => {
        await reset();
        const strip = (h: Headers) => [...h.entries()].filter(([k]) => !/^(x-)?ratelimit/i.test(k) && k !== "server-timing");
        // 表があるとき（書き込める）
        const okResolve = await resolve("curl/8.7.1");
        const okDecision = await decision("curl/8.7.1");
        await drain();
        assert.equal(await total("resolve"), 1);
        assert.equal(await total("decision"), 1);
        await db.execute(sql`ALTER TABLE client_usage_daily RENAME TO client_usage_daily_moved`);
        try {
          for (const ua of ["curl/8.7.1", "vet402-hermes/0.1.0", CHROME, CANARY, null]) {
            const r = await resolve(ua);
            const d = await decision(ua);
            await drain(); // 失敗は握りつぶされ、ここで投げない
            assert.equal(r.status, okResolve.status);
            assert.deepEqual(r.body, okResolve.body);
            assert.deepEqual(strip(r.headers), strip(okResolve.headers));
            assert.equal(d.status, 200);
            assert.deepEqual(d.body, okDecision.body);
            assert.deepEqual(strip(d.headers), strip(okDecision.headers));
          }
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
