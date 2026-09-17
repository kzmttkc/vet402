// ============================================================
// Tempo（MPP）の L0 → L1 — フラグ・別枠・残高・学習した受取先（2026-09-17）。
//
// 守ること:
//  1. L0 が MPP の壁（WWW-Authenticate: Payment …）を pass にし、directory に無い受取先を
//     pay_to IS NULL の行へ学習させる。翌日の再同期は学習した pay_to を消さない。
//  2. OBSERVATORY_TEMPO_L1_ENABLED が無ければ Tempo の候補には 1 リクエストも出さず、行も 0。
//  3. フラグ on: 支払い付きの要求は `Authorization: Payment …` を運び、行は network eip155:4217・
//     USDC.e・受取先・金額・Payment-Receipt の tx・raw_response_meta.protocol = "mpp"・
//     auth_nonce = 帰属 memo。
//  4. 別枠（既定 $2）に達した日は Tempo へ出さず、行も書かない（Base は買う）。
//  5. 残高が足りなければ署名せず、行も書かない。
//  6. 宣言と違う額の challenge は price_mismatch として記録し、支払い付きの要求は出ない。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-tempo-mpp.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 tempo mpp (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;
  const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
  const RECIPIENT = "0xca4e835F803cB0b7C428222B3A3B98518d4779Fe";
  const TEMPO = "eip155:4217";
  const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  /** 購入ごとに別の tx（部分一意 index x402_l1_purchases_tx_unique は同じ tx の再利用を弾く）。 */
  const txFor = (url: string) => `0x${(url.endsWith("/2") ? "ee" : "ef").repeat(32)}`;
  const TX = txFor("https://fal.mpp.tempo.example/model/1");

  test("Tempo MPP lane", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { syncMppDirectory } = await import("@/lib/observatory/mpp-directory");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { MPP_CLIENT_ID, encodeMppAttributionMemo } = await import("@/lib/observatory/mpp-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    // postgres-js の結果は Array の派生（count 等を持つ）なので、deepEqual 用に素の配列へ写す。
    const rows = <T,>(raw: unknown) => [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      tempoOn: process.env.OBSERVATORY_TEMPO_L1_ENABLED,
      cap: process.env.L1_TEMPO_DAILY_CAP_USD,
      solOn: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_TEMPO_L1_ENABLED", saved.tempoOn);
      restore("L1_TEMPO_DAILY_CAP_USD", saved.cap);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
    delete process.env.L1_TEMPO_DAILY_CAP_USD; // 既定 $2

    const directory = {
      version: "1",
      services: [
        {
          id: "fal",
          name: "fal.ai",
          serviceUrl: "https://fal.mpp.tempo.example",
          realm: "fal.mpp.tempo.example",
          endpoints: [1, 2].map((n) => ({
            method: "POST",
            path: `/model/${n}`,
            description: `model ${n}`,
            payment: { intent: "charge", method: "tempo", currency: USDC_E, decimals: 6, amount: "25000", unitType: "request" },
          })),
        },
      ],
    };
    const baseItem = parseCatalogItem({
      resource: "https://seller1.example/api",
      accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(1) }],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
      quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
    });

    const paymentChallenge = (amount = "25000", id = "p-1") =>
      `Payment id="${id}", realm="fal.mpp.tempo.example", method="tempo", intent="charge", request="${b64url({
        amount,
        currency: USDC_E,
        methodDetails: { chainId: 4217, feePayer: true },
        recipient: RECIPIENT,
      })}", description="model", expires="2099-01-01T00:00:00.000Z"`;
    const baseChallenge = JSON.stringify({
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(1), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
    });

    /** 402 → 支払い付きリトライは 200。どの URL にどのヘッダで来たかを記録する。 */
    const wall = (opts: { tempoAmount?: string } = {}) => {
      const seen: { url: string; paid: boolean; authorization: string | null; x402: boolean; body: string | null }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const authorization = headers.get("authorization");
        const x402 = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        const paid = x402 || (authorization?.startsWith("Payment ") ?? false);
        seen.push({ url, paid, authorization, x402, body: typeof init?.body === "string" ? init.body : null });
        const isTempo = url.includes("fal.mpp.tempo.example");
        if (!paid) {
          return isTempo
            ? new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "content-type": "application/json", "www-authenticate": paymentChallenge(opts.tempoAmount) } })
            : new Response(baseChallenge, { status: 402, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(isTempo
              ? { "payment-receipt": b64url({ method: "tempo", reference: txFor(url), status: "success", timestamp: "2026-09-17T10:49:00.000Z" }) }
              : {
                  "PAYMENT-RESPONSE": Buffer.from(
                    JSON.stringify({ success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }),
                  ).toString("base64"),
                }),
          },
        });
      };
      return { seen, fetchImpl };
    };

    const FUNDED = async () => 1_000_000_000n;
    const mppxCharge = async () => `Payment ${b64url({ challenge: { id: "p-1" }, payload: { type: "transaction", signature: "0x76aa" } })}`;

    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({ fetchResult: { items: [baseItem], totalCount: 1, fetchedCount: 1, complete: true }, today: "2026-09-17" });
      const { parseMppDirectory } = await import("@/lib/observatory/mpp-directory");
      const parsed = parseMppDirectory(directory);
      await syncMppDirectory({ fetchResult: { items: parsed.items, totalCount: parsed.endpointCount, fetchedCount: parsed.items.length, complete: true }, today: "2026-09-17" });
      const w = wall();
      await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl: w.fetchImpl });
    }

    const endpointRow = async (url: string) =>
      rows<{ id: string; pay_to: string | null; payee_id: string | null; source: string; network: string }>(
        await db.execute(sql`SELECT id::text AS id, pay_to, payee_id, source, network FROM x402_endpoints WHERE resource_url = ${url}`),
      )[0];
    const ledgerFor = async (url: string) =>
      rows<Record<string, unknown>>(
        await db.execute(sql`
          SELECT pu.status, pu.network, pu.asset, pu.pay_to, pu.amount_units, pu.spent_units, pu.tx_hash, pu.auth_nonce,
                 pu.raw_response_meta, pu.raw_settlement, pu.http_status_paid
          FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = ${url}`),
      );

    await t.test("L0: MPP wall passes with dialect mpp and the recipient is learned into pay_to; a resync keeps it", async () => {
      await seed();
      const ep = await endpointRow("https://fal.mpp.tempo.example/model/1");
      assert.equal(ep.source, "mpp_directory");
      assert.equal(ep.network, TEMPO);
      assert.equal(ep.pay_to, RECIPIENT.toLowerCase());
      assert.equal(ep.payee_id, `${TEMPO}:${RECIPIENT.toLowerCase()}`);
      const probe = rows<{ verdict: string; dialect: string }>(
        await db.execute(sql`SELECT verdict, dialect FROM x402_l0_probes WHERE endpoint_id = ${ep.id}::uuid ORDER BY probed_at DESC LIMIT 1`),
      )[0];
      assert.equal(probe.verdict, "pass");
      assert.equal(probe.dialect, "mpp");
      // 翌日の再同期（directory は pay_to を運ばない）
      const { parseMppDirectory } = await import("@/lib/observatory/mpp-directory");
      const parsed = parseMppDirectory(directory);
      await syncMppDirectory({ fetchResult: { items: parsed.items, totalCount: parsed.endpointCount, fetchedCount: parsed.items.length, complete: true }, today: "2026-09-18" });
      const after = await endpointRow("https://fal.mpp.tempo.example/model/1");
      assert.equal(after.pay_to, RECIPIENT.toLowerCase(), "learned pay_to survives the resync");
      assert.equal(after.payee_id, `${TEMPO}:${RECIPIENT.toLowerCase()}`);
      // Bazaar の行はそのまま
      const base = await endpointRow("https://seller1.example/api");
      assert.equal(base.source, "cdp_bazaar");
      assert.equal(base.pay_to, payToFor(1));
    });

    await t.test("flag off: Tempo endpoints get no request and no row; Base is still bought", async () => {
      await seed();
      delete process.env.OBSERVATORY_TEMPO_L1_ENABLED;
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl, mppxCharge });
      assert.ok(w.seen.every((s) => !s.url.includes("fal.mpp.tempo.example")), "no request to Tempo endpoints");
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base bought");
      assert.equal(summary.settled, 1);
      assert.deepEqual(await ledgerFor("https://fal.mpp.tempo.example/model/1"), []);
      assert.deepEqual(await ledgerFor("https://fal.mpp.tempo.example/model/2"), []);
    });

    await t.test("flag on: the paid request carries Authorization: Payment and the row records the MPP receipt", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl, mppxCharge });
      const paidTempo = w.seen.filter((s) => s.url.includes("fal.mpp.tempo.example") && s.paid);
      assert.ok(paidTempo.length >= 1, "a Tempo endpoint was bought");
      for (const p of paidTempo) {
        assert.match(p.authorization ?? "", /^Payment [A-Za-z0-9_-]+$/);
        assert.equal(p.x402, false, "no x402 payment header on an MPP wall");
        assert.equal(p.body, "{}", "no declared schema → {}");
      }
      assert.equal(summary.settled, 3, `settled ${summary.settled} (2 Tempo + 1 Base)`);
      assert.equal((await ledgerFor("https://fal.mpp.tempo.example/model/2"))[0]?.status, "settle_claimed");
      const ledger = await ledgerFor("https://fal.mpp.tempo.example/model/1");
      assert.equal(ledger.length, 1);
      const row = ledger[0];
      assert.equal(row.status, "settle_claimed");
      assert.equal(row.network, TEMPO);
      assert.equal(row.asset, USDC_E);
      assert.equal(row.pay_to, RECIPIENT.toLowerCase());
      assert.equal(row.amount_units, "25000");
      assert.equal(row.spent_units, "25000");
      assert.equal(row.tx_hash, TX);
      assert.equal(row.http_status_paid, 200);
      assert.equal(row.auth_nonce, encodeMppAttributionMemo({ challengeId: "p-1", realm: "fal.mpp.tempo.example", clientId: MPP_CLIENT_ID }));
      const meta = row.raw_response_meta as Record<string, unknown>;
      assert.equal(meta.protocol, "mpp");
      assert.equal(meta.requestBody, "empty");
      const settlement = row.raw_settlement as Record<string, unknown>;
      assert.equal(settlement.transaction, TX);
      assert.equal((settlement.receipt as Record<string, unknown>).method, "tempo");
      // Base も従来どおり
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.x402));
    });

    await t.test("daily cap ($2): once spent, no Tempo request and no row; Base still bought", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      const ep2 = await endpointRow("https://fal.mpp.tempo.example/model/2");
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep2.id,
        status: "settle_claimed",
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        network: TEMPO,
        asset: USDC_E,
        payTo: RECIPIENT.toLowerCase(),
        amountUnits: "2000000",
        spentUnits: "2000000",
      });
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl, mppxCharge });
      assert.ok(w.seen.every((s) => !s.url.includes("fal.mpp.tempo.example")), "no request to Tempo");
      assert.deepEqual(await ledgerFor("https://fal.mpp.tempo.example/model/1"), []);
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base bought");
    });

    await t.test("daily cap: remainder smaller than one purchase → refused at the reservation, no row, no paid request", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      const ep2 = await endpointRow("https://fal.mpp.tempo.example/model/2");
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep2.id,
        status: "settle_claimed",
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        network: TEMPO,
        asset: USDC_E,
        payTo: RECIPIENT.toLowerCase(),
        amountUnits: String(2_000_000 - 1000),
        spentUnits: String(2_000_000 - 1000),
      });
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl, mppxCharge });
      assert.ok(!w.seen.some((s) => s.url.includes("fal.mpp.tempo.example") && s.paid), "no paid request to Tempo");
      assert.deepEqual(await ledgerFor("https://fal.mpp.tempo.example/model/1"), [], "no row → selectable again tomorrow");
    });

    await t.test("balance gate: USDC.e short on Tempo → no signature, no row; the chain asked is tempo", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      const asked: string[] = [];
      const reader = async ({ chain }: { chain: string; owner: string }) => {
        asked.push(chain);
        return chain === "tempo" ? 0n : 1_000_000_000n;
      };
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: reader, limit: 10, fetchImpl: w.fetchImpl, mppxCharge });
      assert.ok(asked.includes("tempo"), `asked ${asked.join(",")}`);
      assert.ok(!w.seen.some((s) => s.url.includes("fal.mpp.tempo.example") && s.paid), "no paid request to Tempo");
      assert.ok(summary.payerUnfunded >= 1);
      assert.deepEqual(await ledgerFor("https://fal.mpp.tempo.example/model/1"), []);
      assert.deepEqual(await ledgerFor("https://fal.mpp.tempo.example/model/2"), []);
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base bought");
    });

    await t.test("an mpp_directory endpoint whose recipient was never learned (pay_to IS NULL) is not an L1 candidate (review #4)", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      // model/2 の学習済み受取先を消す（L0 は pass のまま）
      await db.execute(sql`UPDATE x402_endpoints SET pay_to = NULL, payee_id = NULL WHERE resource_url = 'https://fal.mpp.tempo.example/model/2'`);
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl, mppxCharge });
      assert.ok(!w.seen.some((s) => s.url.includes("/model/2")), "no request at all to the endpoint without a learned recipient");
      assert.deepEqual(await ledgerFor("https://fal.mpp.tempo.example/model/2"), []);
      assert.ok(w.seen.some((s) => s.url.includes("/model/1") && s.paid), "the endpoint with a learned recipient is still bought");
    });

    await t.test("selection: a wall charging other than declared is recorded as price_mismatch, never paid", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      const w = wall({ tempoAmount: "30000" });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl, mppxCharge });
      assert.ok(!w.seen.some((s) => s.url.includes("fal.mpp.tempo.example") && s.paid), "no paid request");
      const ledger = await ledgerFor("https://fal.mpp.tempo.example/model/1");
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].status, "price_mismatch");
      const meta = ledger[0].raw_response_meta as Record<string, unknown>;
      assert.equal(meta.protocol, "mpp");
      assert.equal(meta.detail, "amount_mismatch");
      assert.equal(ledger[0].spent_units, "0");
    });
  });
}
