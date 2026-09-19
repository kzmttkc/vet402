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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl, mppxCharge });
      assert.ok(!w.seen.some((s) => s.url.includes("/model/2")), "no request at all to the endpoint without a learned recipient");
      assert.deepEqual(await ledgerFor("https://fal.mpp.tempo.example/model/2"), []);
      assert.ok(w.seen.some((s) => s.url.includes("/model/1") && s.paid), "the endpoint with a learned recipient is still bought");
      // レーン枠（laneFloorCandidates・同じ targetsSql）にも同じ規則が効く: Tempo の枠は model/1 の 1 件だけ
      assert.equal(summary.laneFloor.tempo, 1, `lane floor counted ${JSON.stringify(summary.laneFloor)}`);
      // Tempo のレーンは主候補の先頭に来る（最初の要求が Tempo）
      assert.ok(w.seen[0]?.url.includes("fal.mpp.tempo.example"), `first request was ${w.seen[0]?.url}`);
    });

    await t.test("lane floor: with the flag on, both learned Tempo endpoints sit at the head of the batch; with the flag off the Tempo floor is 0", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      const on = wall();
      const s1 = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: on.fetchImpl, mppxCharge });
      assert.equal(s1.laneFloor.tempo, 2);
      assert.ok(on.seen[0]?.url.includes("fal.mpp.tempo.example"));
      await seed();
      delete process.env.OBSERVATORY_TEMPO_L1_ENABLED;
      const off = wall();
      const s2 = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: off.fetchImpl, mppxCharge });
      assert.equal(s2.laneFloor.tempo, 0);
      assert.ok(off.seen.every((s) => !s.url.includes("fal.mpp.tempo.example")));
    });

    await t.test("lane floor host cap: one host with four learned Tempo endpoints takes two head slots per batch, the other host still gets in (2026-09-18)", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      // fal（seed の 2 件）に同じホストの 2 件を足し、別ホストを 1 件足す。どれも L0 pass・受取先学習済みの形で置く。
      for (const [key, url] of [
        ["fal.mpp.tempo.example/model/3", "https://fal.mpp.tempo.example/model/3"],
        ["fal.mpp.tempo.example/model/4", "https://fal.mpp.tempo.example/model/4"],
        ["other.mpp.tempo.example/v1/x", "https://other.mpp.tempo.example/v1/x"],
      ]) {
        const inserted = rows<{ id: string }>(
          await db.execute(sql`
            INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status)
            VALUES (${key}, ${url}, 'mpp_directory', 'POST', ${TEMPO}, ${RECIPIENT.toLowerCase()}, '25000', ${USDC_E}, 'active') RETURNING id::text AS id`),
        );
        await db.insert(schema.x402L0Probes).values({ endpointId: inserted[0].id, method: "POST", verdict: "pass", dialect: "mpp" });
      }
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl, mppxCharge });
      assert.equal(summary.laneFloor.tempo, 3, `2 from fal + 1 from the other host, got ${JSON.stringify(summary.laneFloor)}`);
      assert.equal(summary.laneFloorHostCapped.tempo, 2, "the two extra fal endpoints were skipped by the host cap and the summary says so");
      const firstThreeHosts = w.seen.filter((s) => !s.paid).slice(0, 3).map((s) => new URL(s.url).hostname);
      assert.equal(firstThreeHosts.filter((h) => h === "fal.mpp.tempo.example").length, 2);
      assert.ok(firstThreeHosts.includes("other.mpp.tempo.example"), `head hosts were ${firstThreeHosts.join(",")}`);
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

    // ------------------------------------------------------------
    // 2026-09-19（横断監査 W1）: credential のヘッダ名は売り手が決める。別オリジンへ運ばない。
    //
    // MPP の challenge は `header` パラメータで credential を載せるヘッダ名を指定できる。
    // safe-fetch の固定名の表（authorization / x-payment / …）は我々が選んだ名前しか知らないので、
    // 売り手が `header="x-pay"` を返して有料リトライを 302 で別オリジンへ飛ばすと、署名済みの
    // credential がそのまま第三者へ渡っていた。ここは本物の safe-fetch を通して見る
    // （createSafeFetchImpl でスタブを包む）——固定名の表ではなく、呼び手が宣言した名前で落ちること。
    // ------------------------------------------------------------
    await t.test("credential header named by the seller does not ride a cross-origin redirect", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      const { createSafeFetchImpl } = await import("@/lib/net/safe-fetch");
      const hops: { url: string; headers: Record<string, string> }[] = [];
      const inner = async (url: string, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          headers[k] = v;
        });
        hops.push({ url, headers });
        const isTempo = url.includes("fal.mpp.tempo.example");
        const paid = headers["x-pay"] !== undefined || headers["authorization"] !== undefined || headers["x-payment"] !== undefined || headers["payment-signature"] !== undefined;
        if (isTempo && !paid) {
          // 壁は `header="x-pay"` を指定する（mppx の Challenge はこのパラメータを運ぶ）。
          return new Response(JSON.stringify({ error: "payment required" }), {
            status: 402,
            headers: { "content-type": "application/json", "www-authenticate": `${paymentChallenge()}, header="x-pay"` },
          });
        }
        if (isTempo && paid) {
          // 有料リトライを別オリジンへ転送する。
          return new Response("", { status: 302, headers: { location: "https://collector.example/take" } });
        }
        // 資格情報が境界で落ちているので、転送先は当然「払っていない」と見て 402 を返す。
        if (url.includes("collector.example")) return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "content-type": "application/json" } });
        // Base の売り手は従来どおり
        if (!paid) return new Response(baseChallenge, { status: 402, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" })).toString("base64"),
          },
        });
      };
      const guarded = createSafeFetchImpl({ fetchImpl: inner, resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: guarded, mppxCharge });

      const paidToSeller = hops.filter((h) => h.url.includes("fal.mpp.tempo.example") && h.headers["x-pay"] !== undefined);
      assert.ok(paidToSeller.length >= 1, `売り手の指定した x-pay で払っている（hops: ${hops.map((h) => h.url).join(" ")}）`);
      const collector = hops.filter((h) => h.url.includes("collector.example"));
      assert.ok(collector.length >= 1, "転送先まで歩いている");
      for (const h of collector) {
        assert.equal(h.headers["x-pay"], undefined, "売り手が名付けた資格情報が第三者へ渡ってはいけない");
        assert.equal(h.headers["authorization"], undefined);
      }

      // レビュー 2 巡目 W-4: 転送先が返した 402 でも **status は従来どおり `settle_failed`**。
      // 売り手は 1 ホップ目で署名済みの資格情報を受け取り終えている（だから spent_units も
      // 残る）ので、ここを我々側の `request_error` に倒すと、売り手は有料の口に 302 を
      // 1 行足すだけで「払ったのに何も返らなかった」という観測を公開台帳から消せてしまう。
      // 代わりに、どの境界で落としたかを行に残して**数えられる**ようにしておく
      // （`raw_response_meta ? 'credentialStripped'`）。
      const ledger = await ledgerFor("https://fal.mpp.tempo.example/model/1");
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].status, "settle_failed", `status が ${ledger[0].status}`);
      assert.equal(ledger[0].spent_units, "25000", "署名して売り手へ渡した額は計上したまま");
      const meta = ledger[0].raw_response_meta as Record<string, unknown>;
      const strip = meta.credentialStripped as Record<string, unknown> | undefined;
      assert.equal(strip?.from, "https://fal.mpp.tempo.example");
      assert.equal(strip?.to, "https://collector.example", `どこで落としたかを行に残す: ${JSON.stringify(meta)}`);
      assert.equal(meta.status, 402);
      // 数える側の形（後から件数を出す経路）を固定する。
      const counted = rows<{ n: string }>(
        await db.execute(sql`SELECT count(*)::text AS n FROM x402_l1_purchases WHERE raw_response_meta ? 'credentialStripped'`),
      )[0];
      assert.equal(counted.n, "2", "Tempo の 2 件とも同じ境界で落ちている");
    });

    // ------------------------------------------------------------
    // 2026-09-19（横断監査 W2 → 独立レビュー W-2）: Tempo の署名が落ちた行の扱い。
    //
    // mppx の createCredential は Tempo RPC（nonce・gas）へ出る。予約の**後**にあるので、
    // 落ちると resolveReservationAsFailed が settle_failed に倒し、spent_units が残った
    // ——一円も動いていないのに別枠と共有 $25 が減り、その行が売り手の不履行として
    // 公開台帳（export.csv）に載る。
    //
    // 直しは「行を消す」ではなく「`request_error` で残す」。`request_error` は export.csv・
    // decisions・backtest・PAID_ATTEMPT_STATUSES のどれにも入らない（冤罪にならない）一方、
    // 行が在ることで同じ売り手がスイープ窓のあいだ再選択されない＝ backoff になる。
    // 消すと、決定的に落ちる売り手（gas 見積りが revert する等）が毎バッチ先頭に戻り、
    // 1 回 5 件・1 ホスト 2 件のレーン枠を埋め続けて Tempo が永久に 1 件も買わない。
    // ------------------------------------------------------------
    await t.test("tempo signer failure: request_error の行が残り（spent 0・URL は伏字）、次のバッチでは再選択されない", async () => {
      await seed();
      process.env.OBSERVATORY_TEMPO_L1_ENABLED = "true";
      const w = wall();
      const failing = async () => {
        throw new Error("HTTP request failed. URL: https://tempo-rpc.example/v2/SECRETKEY");
      };
      // W-1: サーバログにも鍵を出さない（logServerError は error.message をそのまま console へ出す）。
      const logged: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      let summary;
      try {
        summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl, mppxCharge: failing });
      } finally {
        console.error = realError;
      }
      assert.ok(!w.seen.some((s) => s.url.includes("fal.mpp.tempo.example") && s.paid), "署名できていないので有料要求も出ない");
      assert.equal(logged.some((line) => line.includes("SECRETKEY")), false, `ログに鍵が出ている: ${logged.join(" | ")}`);

      const ledger = await ledgerFor("https://fal.mpp.tempo.example/model/1");
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].status, "request_error", "公開分母の外（export.csv からも除外される status）");
      assert.equal(ledger[0].spent_units, "0", "署名していないので計上しない");
      const meta = ledger[0].raw_response_meta as Record<string, unknown>;
      assert.equal(meta.phase, "mpp_credential");
      assert.equal(String(meta.error).includes("SECRETKEY"), false, `台帳に鍵が残っている: ${String(meta.error)}`);
      assert.ok(String(meta.error).includes("<url>"));
      // Tempo の別枠は減らない（spent_units 0）
      const day = rows<{ spent: string }>(
        await db.execute(sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS spent FROM x402_l1_purchases WHERE network LIKE 'eip155:4217'`),
      )[0];
      assert.equal(day.spent, "0");
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
      assert.equal(summary!.settled, 1);

      // backoff: 行が在るので、同じ売り手は次のバッチでスイープ窓のあいだ選ばれない。
      const again = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: again.fetchImpl, mppxCharge: failing });
      assert.ok(!again.seen.some((s) => s.url.includes("fal.mpp.tempo.example")), `再選択された: ${again.seen.map((s) => s.url).join(" ")}`);
      assert.equal((await ledgerFor("https://fal.mpp.tempo.example/model/1")).length, 1, "行は増えない");
    });

  });
}
