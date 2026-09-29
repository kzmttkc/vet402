// ============================================================
// 2026-09-29 監査 6 周目（攻撃者の立場）の DB を使う検査。
//
// 守ること（お金）:
//  1. サブドメインと payTo を分けても、同じ登録ドメイン（eTLD+1）への当日の支出は DOMAIN_DAILY_CAP_USD（既定 $3）まで。
//     超える予約はしない・**行を書かない**・支払い付きの要求を出さない。受取先・ホストの $2 はそのまま。
//  2. 翌バッチ（同じ UTC 日）は上限に届いた登録ドメインの出品に 402 も取りに行かない（候補 SQL）。
//  3. 共有ドメイン（workers.dev 等）の別の持ち主は別の単位（正直な売り手を巻き込まない）。トンネル・動的 DNS
//     （trycloudflare.com 等）はサフィックスごとに 1 枠（名前を無料で増やせる・独立レビュー）。
//  4. JS（registeredDomainOf）と SQL（registeredDomainSql）が同じ単位を返す（候補 SQL と予約が別の単位を数えない）。
//  5. 環境変数で変えられる（0 で誰にも払わない）。同時の 2 バッチでも超えるのは同時の 1 件ぶんまで。
// その他:
//  6. C2 の「問い合わせ多」は別々の鍵の持ち主 3 以上 かつ 別々の日 2 以上（IP の行・鍵 id の k1: の行は数えない）。
//     同じ持ち主の鍵 3 本では上がらない（独立レビュー: 1 人が鍵を 10 本持てる）。
//  7. export の同時実行の枠（全体で 1 本・期限つき・自分の貸し出しだけ返す）。
//  8. corrections の暦に無いカーソルは 400（503 にならない）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test_r6d \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/audit-r6-security.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("audit r6 security (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(20)}`;

  test("audit r6 security", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { registeredDomainOf, registeredDomainSql } = await import("@/lib/observatory/registered-domain");
    const { censusHostSql } = await import("@/lib/observatory/retest-sellers-sql");
    const { loadCoverageTiers } = await import("@/lib/observatory/coverage");
    const { recordDecisionLookup } = await import("@/lib/decision/decide");
    const { lookupCallerMaterial } = await import("@/lib/decision/lookup-caller");
    const { acquireExportSlot, EXPORT_SLOT_KEY } = await import("@/lib/api/export-guard");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      cap: process.env.L1_SELLER_DAILY_CAP_USD,
      dcap: process.env.L1_DOMAIN_DAILY_CAP_USD,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("L1_SELLER_DAILY_CAP_USD", saved.cap);
      restore("L1_DOMAIN_DAILY_CAP_USD", saved.dcap);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.L1_SELLER_DAILY_CAP_USD; // 既定 $2
    delete process.env.L1_DOMAIN_DAILY_CAP_USD; // 既定 $3

    let txCounter = 0;
    type Listing = { url: string; payTo: string; amount: string; calls?: number };
    const rows = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    const wall = (listings: Listing[]) => {
      const seen: { url: string; paid: boolean }[] = [];
      const byUrl = new Map(listings.map((l) => [l.url, l]));
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid });
        const l = byUrl.get(url);
        if (!l) return new Response("nope", { status: 404 });
        if (!paid) {
          return new Response(
            JSON.stringify({
              x402Version: 2,
              accepts: [{ scheme: "exact", network: "eip155:8453", amount: l.amount, asset: BASE_USDC, payTo: l.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${(++txCounter).toString(16).padStart(64, "0")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    async function seed(listings: Listing[]) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({
        fetchResult: {
          items: listings.map((l) =>
            parseCatalogItem({
              resource: l.url,
              accepts: [{ amount: l.amount, asset: BASE_USDC, network: "eip155:8453", payTo: l.payTo }],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
              quality: { l30DaysTotalCalls: l.calls ?? 100, l30DaysUniquePayers: 10 },
            }),
          ),
          totalCount: listings.length,
          fetchedCount: listings.length,
          complete: true,
        },
        today: "2026-09-29",
      });
      await runL0ProbeBatch({ limit: 50, concurrency: 2, fetchImpl: wall(listings).fetchImpl });
    }

    const spentOnDomain = async (domain: string) => {
      const raw = await db.execute(sql`
        SELECT coalesce(sum(pu.spent_units::numeric), 0)::text AS s FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE ${registeredDomainSql(censusHostSql(sql`e.resource_key`))} = ${domain}`);
      return BigInt(String(rows(raw)[0].s).split(".")[0]);
    };
    const ledgerCount = async (urlLike: string) =>
      Number(
        rows(await db.execute(sql`
          SELECT count(*)::int AS n FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url LIKE ${urlLike}`))[0].n,
      );
    const run = (w: ReturnType<typeof wall>, limit = 50) => runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit, fetchImpl: w.fetchImpl });

    await t.test("JS と SQL の登録ドメインが一致する（本番の形・IP・ポート・サフィックスそのもの）", async () => {
      const hosts = [
        "a1.evil.com",
        "evil.com",
        "x.y.evil.com",
        "aegis-api.kadopi.workers.dev",
        "workers.dev",
        "402timezones.vercel.app",
        "a2a-verifier-production.up.railway.app",
        "foo.railway.app",
        "ai-data-marketplace-1042299154756.us-central1.run.app",
        "artifactguard-kl4hfo6j2q-as.a.run.app",
        "ari001.tailb4ac3a.ts.net",
        "agent.atinamos.co.uk",
        "co.uk",
        "location-resolver.victoriousbush-c7c267a1.westus2.azurecontainerapps.io",
        "atq6wtkp6k.execute-api.us-east-1.amazonaws.com",
        "x.lambda-url.us-east-1.on.aws",
        "abc.elb.amazonaws.com",
        "abc.us-east-1.elb.amazonaws.com",
        "prance-mounting-watch.ngrok-free.dev",
        "x-y-z.trycloudflare.com",
        "a.b.trycloudflare.com",
        "trycloudflare.com",
        "146-190-76-192.sslip.io",
        "10.0.0.1.nip.io",
        "abc.loca.lt",
        "x.serveo.net",
        "921273c0412589.lhr.life",
        "apiwitchcraft.duckdns.org",
        "a.xtrycloudflare.com",
        "a.trycloudflare.com.evil.com",
        "api.evil.com..",
        "93.184.216.34",
        "[2001:db8::1]",
        "localhost",
        "a.b.c.d.e.example",
        "x-y.github.io",
      ];
      for (const h of hosts) {
        const key = `${h}:8443/p`;
        const got = rows(await db.execute(sql`SELECT ${registeredDomainSql(censusHostSql(sql`${key}::text`))} AS d`))[0].d;
        assert.equal(got, registeredDomainOf(h), h);
      }
    });

    await t.test("サブドメインと payTo を分けた $1 の出品 6 件: 登録ドメインで $3 に止まり、4 件目以降は行を書かず払わない", async () => {
      const listings: Listing[] = [1, 2, 3, 4, 5, 6].map((n) => ({ url: `https://a${n}.evil.com/api`, payTo: payToFor(n), amount: "1000000", calls: 5000 }));
      listings.push({ url: "https://honest.example/api", payTo: payToFor(200), amount: "3000" });
      await seed(listings);
      const w = wall(listings);
      const summary = await run(w);
      assert.equal(await spentOnDomain("evil.com"), 3_000_000n, "登録ドメインへの当日の支出は $3 ちょうど");
      assert.equal(w.seen.filter((s) => s.paid && s.url.includes("evil.com")).length, 3, "支払い付きの要求は 3 回だけ");
      assert.equal(await ledgerCount("https://a%.evil.com/%"), 3, "上限で断った出品には行を書かない（翌日また候補）");
      assert.ok(summary.sellerCapped >= 1, `sellerCapped=${summary.sellerCapped}`);
      // 断った 1 件の後は、同じ登録ドメインの残りに 402 も取りに行かない。
      assert.equal(w.seen.filter((s) => !s.paid && s.url.includes("evil.com")).length, 4, "無償の要求は買えた 3 件＋断った 1 件だけ");
      assert.ok(w.seen.some((s) => s.paid && s.url === "https://honest.example/api"), "他の売り手は買う");
    });

    await t.test("トンネル（trycloudflare.com）の別々の名前と payTo の $1 の出品 6 件: サフィックスで 1 枠・$3 で止まる", async () => {
      const listings: Listing[] = [1, 2, 3, 4, 5, 6].map((n) => ({ url: `https://t${n}-x-y.trycloudflare.com/api`, payTo: payToFor(40 + n), amount: "1000000", calls: 5000 }));
      listings.push({ url: "https://honest.example/api", payTo: payToFor(201), amount: "3000" });
      await seed(listings);
      const w = wall(listings);
      await run(w);
      assert.equal(await spentOnDomain("trycloudflare.com"), 3_000_000n, "trycloudflare.com 全体への当日の支出は $3 ちょうど");
      assert.equal(w.seen.filter((s) => s.paid && s.url.includes("trycloudflare.com")).length, 3, "支払い付きの要求は 3 回だけ");
      assert.equal(await ledgerCount("https://t%.trycloudflare.com/%"), 3, "上限で断った出品には行を書かない");
      assert.ok(w.seen.some((s) => s.paid && s.url === "https://honest.example/api"), "他の売り手は買う");
      // 翌バッチ（同じ UTC 日）: 候補 SQL が同じ 1 枠で外す
      const w2 = wall(listings.filter((l) => l.url.includes("trycloudflare.com")));
      await run(w2);
      assert.equal(w2.seen.length, 0, JSON.stringify(w2.seen));
    });

    await t.test("翌バッチ（同じ UTC 日）: 上限に届いた登録ドメインの出品には 1 リクエストも出さない（候補 SQL）", async () => {
      const listings: Listing[] = [1, 2, 3, 4].map((n) => ({ url: `https://b${n}.evil.com/api`, payTo: payToFor(10 + n), amount: "1000000" }));
      await seed(listings);
      await run(wall(listings));
      assert.equal(await spentOnDomain("evil.com"), 3_000_000n);
      const w2 = wall(listings);
      const s2 = await run(w2);
      assert.equal(w2.seen.length, 0, JSON.stringify(w2.seen));
      assert.equal(s2.attempted, 0);
    });

    await t.test("上限ちょうどは通す（<=）・1 単位でも超えれば断る", async () => {
      const listings: Listing[] = [
        { url: "https://e1.edge.com/api", payTo: payToFor(21), amount: "1000000", calls: 900 },
        // 並び順に依らない形（1 件は $1 まで）: 既存の支出 2.000001 に、e2（0.999999）なら上限ちょうど 3.0、
        // e3（1.0）なら 1 単位超える。どちらが先でも e2 だけが通る。
        { url: "https://e2.edge.com/api", payTo: payToFor(22), amount: "999999", calls: 800 },
        { url: "https://e3.edge.com/api", payTo: payToFor(23), amount: "1000000", calls: 700 },
      ];
      await seed(listings);
      const ep = rows(await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = 'https://e1.edge.com/api'`))[0].id as string;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep,
        status: "settled",
        payer: "0x0000000000000000000000000000000000000001",
        network: "eip155:8453",
        asset: BASE_USDC,
        payTo: payToFor(21),
        amountUnits: "2000001",
        spentUnits: "2000001",
      });
      const w = wall(listings);
      await run(w);
      assert.equal(await spentOnDomain("edge.com"), 3_000_000n, "2.000001 + 0.999999 = 上限ちょうどは通る");
      assert.equal(await ledgerCount("https://e2.edge.com/%"), 1, "上限ちょうどは通る");
      assert.equal(await ledgerCount("https://e3.edge.com/%"), 0, "1 単位でも超える予約は断る（行なし）");
      assert.ok(!w.seen.some((s) => s.paid && s.url.includes("e3.edge.com")));
    });

    await t.test("共有ドメインの別の持ち主は別の単位（workers.dev の alice と bob）・同じ持ち主の別のワーカーは同じ単位", async () => {
      const listings: Listing[] = [
        ...[1, 2, 3, 4].map((n) => ({ url: `https://w${n}.alice.workers.dev/api`, payTo: payToFor(30 + n), amount: "1000000" })),
        ...[1, 2].map((n) => ({ url: `https://w${n}.bob.workers.dev/api`, payTo: payToFor(40 + n), amount: "1000000" })),
      ];
      await seed(listings);
      const w = wall(listings);
      await run(w);
      assert.equal(await spentOnDomain("alice.workers.dev"), 3_000_000n, "alice は $3 で止まる");
      assert.equal(await spentOnDomain("bob.workers.dev"), 2_000_000n, "bob は alice の上限に巻き込まれない");
    });

    await t.test("受取先・ホストの $2 は今までどおり（登録ドメインの $3 より先に止まる）", async () => {
      const listings: Listing[] = [1, 2, 3].map((n) => ({ url: `https://same.host.com/api/${n}`, payTo: payToFor(50 + n), amount: "1000000" }));
      await seed(listings);
      const w = wall(listings);
      await run(w);
      assert.equal(await spentOnDomain("host.com"), 2_000_000n, "同じホストは $2");
    });

    await t.test("別のバッチを同時に走らせても、超えるのは同時の 1 件ぶんまで", async () => {
      const listings: Listing[] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ url: `https://r${n}.race.com/api`, payTo: payToFor(60 + n), amount: "1000000" }));
      await seed(listings);
      await Promise.all([run(wall(listings)), run(wall(listings))]);
      const spent = await spentOnDomain("race.com");
      assert.ok(spent >= 3_000_000n && spent <= 4_000_000n, `同時実行でも $3 + 1 件（$1）まで: ${spent}`);
      const c = wall(listings);
      await run(c);
      assert.equal(c.seen.filter((s) => s.paid).length, 0, "同時実行の後のバッチは払わない");
    });

    await t.test("上限は環境変数で変えられる（0 で誰にも払わない）", async () => {
      process.env.L1_DOMAIN_DAILY_CAP_USD = "0";
      try {
        const listings: Listing[] = [{ url: "https://zero.example/api", payTo: payToFor(90), amount: "3000" }];
        await seed(listings);
        const w = wall(listings);
        await run(w);
        assert.equal(w.seen.filter((s) => s.paid).length, 0);
        assert.equal(await ledgerCount("https://zero.example/%"), 0);
      } finally {
        delete process.env.L1_DOMAIN_DAILY_CAP_USD;
      }
    });

    await t.test("C2（問い合わせ多）: 別々の鍵の持ち主 3 以上 かつ 別々の日 2 以上。IP の行・1 人の 5 日・1 日の 10 人・同じ持ち主の鍵 3 本は上げない", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, decision_lookups, decision_lookup_callers`);
      const mk = async () => {
        const id = randomUUID();
        await db.insert(schema.x402Endpoints).values({
          id,
          resourceKey: `${id}.example/api`,
          resourceUrl: `https://${id}.example/api`,
          method: "GET",
          network: "eip155:8453",
          payTo: payToFor(1),
          priceAmount: "10000",
          status: "active",
          lastSeenAt: new Date(),
        } as typeof schema.x402Endpoints.$inferInsert);
        return id;
      };
      const day = (ago: number) => new Date(Date.now() - ago * 86400_000).toISOString().slice(0, 10);
      const { lookupCallerHash } = await import("@/lib/decision/lookup-caller");
      const put = async (id: string, material: string, ago: number) =>
        db.execute(sql`INSERT INTO decision_lookup_callers (endpoint_id, day, caller_hash) VALUES (${id}::uuid, ${day(ago)}, ${lookupCallerHash(material, day(ago))}) ON CONFLICT DO NOTHING`);

      const promoted = await mk();
      await put(promoted, "owner:a", 0);
      await put(promoted, "owner:b", 0);
      await put(promoted, "owner:c", 1);
      const oneKeyFiveDays = await mk();
      for (let i = 0; i < 5; i++) await put(oneKeyFiveDays, "owner:solo", i);
      const tenKeysOneDay = await mk();
      for (let i = 0; i < 10; i++) await put(tenKeysOneDay, `owner:k${i}`, 0);
      const ipRows = await mk();
      for (let i = 0; i < 6; i++) await put(ipRows, `ip:198.51.100.${i}`, i % 3);
      const stale = await mk();
      await put(stale, "owner:a", 8);
      await put(stale, "owner:b", 9);
      await put(stale, "owner:c", 10);
      // 初版（鍵 id で数えた k1: の行）は、別々の鍵 3 本 × 2 日でも数えない
      const legacyKeyRows = await mk();
      await put(legacyKeyRows, "key:a", 0);
      await put(legacyKeyRows, "key:b", 0);
      await put(legacyKeyRows, "key:c", 1);

      // 独立レビュー（中）: 実際の鍵の発行と認証（createApiKey → verifyApiKey）を通した持ち主で数える。
      // 同じ持ち主の鍵 3 本 × 2 日では上がらない。別々の持ち主 3 人 × 2 日なら上がる。
      const { createApiKey, verifyApiKey } = await import("@/lib/db/api-keys");
      const ownerOf = async (userId?: string) => {
        const k = await createApiKey({ name: "r6h", userId });
        const rec = await verifyApiKey(k.key);
        assert.ok(rec);
        return rec;
      };
      const soloOwner = randomUUID();
      const soloKeys = [await ownerOf(soloOwner), await ownerOf(soloOwner), await ownerOf(soloOwner)];
      assert.equal(new Set(soloKeys.map((r) => r.id)).size, 3, "鍵は 3 本");
      assert.ok(soloKeys.every((r) => r.ownerId === soloOwner), "持ち主は api_keys.user_id");
      const sameOwnerThreeKeys = await mk();
      for (const [i, r] of soloKeys.entries()) {
        await put(sameOwnerThreeKeys, lookupCallerMaterial({ apiKeyId: r.id, ownerId: r.ownerId })!, i === 2 ? 1 : 0);
      }
      const threeOwners = [await ownerOf(randomUUID()), await ownerOf(randomUUID()), await ownerOf()];
      assert.equal(threeOwners[2].ownerId, threeOwners[2].id, "user_id の無い鍵は鍵 id そのものが持ち主");
      const threeOwnersTwoDays = await mk();
      for (const [i, r] of threeOwners.entries()) {
        await put(threeOwnersTwoDays, lookupCallerMaterial({ apiKeyId: r.id, ownerId: r.ownerId })!, i === 2 ? 1 : 0);
      }

      const tiers = await loadCoverageTiers([promoted, oneKeyFiveDays, tenKeysOneDay, ipRows, stale, legacyKeyRows, sameOwnerThreeKeys, threeOwnersTwoDays]);
      assert.equal(tiers.get(promoted), "C2");
      assert.equal(tiers.get(oneKeyFiveDays), "C1");
      assert.equal(tiers.get(tenKeysOneDay), "C1");
      assert.equal(tiers.get(ipRows), "C1");
      assert.equal(tiers.get(stale), "C1", "7 日の窓の外は数えない");
      assert.equal(tiers.get(legacyKeyRows), "C1", "鍵 id で数えた k1: の行は数えない");
      assert.equal(tiers.get(sameOwnerThreeKeys), "C1", "同じ持ち主の鍵 3 本では上がらない");
      assert.equal(tiers.get(threeOwnersTwoDays), "C2", "別々の持ち主 3 人なら上がる");

      // l0TierWhere("c2")（L1 の候補の条件）も同じ答え
      const { l1TierWhere } = await import("@/lib/observatory/coverage");
      const c2 = rows(await db.execute(sql`SELECT e.id::text AS id FROM x402_endpoints e WHERE ${l1TierWhere(false)}`)).map((r) => r.id);
      assert.deepEqual([...c2].sort(), [promoted, threeOwnersTwoDays].sort());

      // recordDecisionLookup の経路: 鍵なし・持ち主の分からない鍵は行を書かない・持ち主ありは k2: の行
      const viaApi = await mk();
      await recordDecisionLookup(viaApi, lookupCallerMaterial({ ip: "203.0.113.9" }));
      await recordDecisionLookup(viaApi, lookupCallerMaterial({ apiKeyId: "no-owner-key" }));
      await recordDecisionLookup(viaApi, lookupCallerMaterial({ apiKeyId: soloKeys[0].id, ownerId: soloKeys[0].ownerId }));
      await recordDecisionLookup(viaApi, lookupCallerMaterial({ apiKeyId: soloKeys[1].id, ownerId: soloKeys[1].ownerId }));
      const hashes = rows(await db.execute(sql`SELECT caller_hash FROM decision_lookup_callers WHERE endpoint_id = ${viaApi}::uuid`)).map((r) => String(r.caller_hash));
      assert.equal(hashes.length, 1, "同じ持ち主の 2 本の鍵は 1 行");
      assert.ok(hashes[0].startsWith("k2:"));
    });

    await t.test("export の枠: 全体で 1 本・返せばまた取れる・期限切れは取り直せる・他人の貸し出しは返さない", async () => {
      await db.execute(sql`DELETE FROM ip_rate_limits WHERE bucket_key = ${EXPORT_SLOT_KEY}`);
      const a = await acquireExportSlot();
      assert.equal(a.ok, true);
      const b = await acquireExportSlot();
      assert.deepEqual(b, { ok: false, unavailable: false }, "2 本目は取れない");
      const [c, d] = await Promise.all([acquireExportSlot(), acquireExportSlot()]);
      assert.equal(c.ok || d.ok, false, "同時の 2 本も取れない");
      if (a.ok) await a.release();
      const e = await acquireExportSlot();
      assert.equal(e.ok, true, "返した後は取れる");
      // 期限切れにする → 別の要求が取り直す → 古い貸し出しの release は新しい方を返さない
      await db.execute(sql`UPDATE ip_rate_limits SET reset_at = now() - interval '1 second' WHERE bucket_key = ${EXPORT_SLOT_KEY}`);
      const f = await acquireExportSlot();
      assert.equal(f.ok, true, "期限切れは取り直せる");
      if (e.ok) await e.release();
      const g = await acquireExportSlot();
      assert.equal(g.ok, false, "期限切れの古い貸し出しを返しても、新しい貸し出しは生きている");
      if (f.ok) await f.release();
      const h = await acquireExportSlot();
      assert.equal(h.ok, true);
      if (h.ok) await h.release();
    });

    await t.test("export の route: 枠が埋まっていれば 503・Retry-After（DB を読まない）", async () => {
      await db.execute(sql`DELETE FROM ip_rate_limits WHERE bucket_key = ${EXPORT_SLOT_KEY}`);
      const held = await acquireExportSlot();
      assert.equal(held.ok, true);
      try {
        const { NextRequest } = await import("next/server");
        const ledger = await import("@/app/api/v1/observatory/export.csv/route");
        const res = await ledger.GET(new NextRequest("http://localhost/api/v1/observatory/export.csv?days=7", { headers: { "x-real-ip": "203.0.113.50" } }));
        assert.equal(res.status, 503);
        assert.equal(res.headers.get("retry-after"), "5");
        assert.deepEqual(await res.json(), { error: "export_busy" });
      } finally {
        if (held.ok) await held.release();
      }
      const { NextRequest } = await import("next/server");
      const ledger = await import("@/app/api/v1/observatory/export.csv/route");
      const ok = await ledger.GET(new NextRequest("http://localhost/api/v1/observatory/export.csv?days=7", { headers: { "x-real-ip": "203.0.113.51" } }));
      assert.equal(ok.status, 200);
      const again = await acquireExportSlot();
      assert.equal(again.ok, true, "route は終わったら枠を返す");
      if (again.ok) await again.release();
    });

    await t.test("corrections: 暦に無い日付のカーソルは 400（503 にならない）", async () => {
      const { NextRequest } = await import("next/server");
      const route = await import("@/app/api/v1/observatory/corrections/route");
      const { encodeCorrectionCursor } = await import("@/lib/observatory/corrections");
      const cursor = encodeCorrectionCursor({ created_at: "2026-02-30 00:00:00+00", id: randomUUID() });
      const res = await route.GET(new NextRequest(`http://localhost/api/v1/observatory/corrections?cursor=${cursor}`, { headers: { "x-real-ip": "203.0.113.60" } }));
      assert.equal(res.status, 400);
      const good = encodeCorrectionCursor({ created_at: "2026-02-28 00:00:00+00", id: randomUUID() });
      const ok = await route.GET(new NextRequest(`http://localhost/api/v1/observatory/corrections?cursor=${good}`, { headers: { "x-real-ip": "203.0.113.61" } }));
      assert.equal(ok.status, 200);
    });
  });
}
