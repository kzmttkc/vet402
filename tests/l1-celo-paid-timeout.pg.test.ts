// ============================================================
// Celo の支払い付き要求の待ちが 45 秒、Base が 20 秒であること（偽の fetch）。
// 無払いの要求はどちらも 20 秒。ネットには出ない。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-celo-paid-timeout.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { L1_CELO_PAID_TIMEOUT_MS, L1_REQUEST_TIMEOUT_MS } from "@/lib/observatory/l1-timing";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 celo paid timeout (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const CELO = "eip155:42220";
  const BASE = "eip155:8453";
  const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
  const CELO_URL = "https://celo-wait.example/api";
  const BASE_URL = "https://base-wait.example/api";
  const CELO_PAYTO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
  const BASE_PAYTO = "0x2222222222222222222222222222222222222222";

  test("L1 paid-request timeout: Celo 45s, Base 20s", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const ENV = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_CELO_L1_ENABLED",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
      "OBSERVATORY_XRPL_L1_ENABLED",
      "OBSERVATORY_STELLAR_L1_ENABLED",
      "OBSERVATORY_L1_CENSUS",
      "L1_CELO_DAILY_CAP_USD",
      "L1_SELLER_DAILY_CAP_USD",
      "L1_DOMAIN_DAILY_CAP_USD",
      "L1_LANE_FLOOR_PER_RUN",
    ] as const;
    const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
    for (const k of ENV) delete process.env[k];
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.OBSERVATORY_CELO_L1_ENABLED = "true";

    const celoAccept = {
      scheme: "exact",
      network: CELO,
      amount: "1000",
      asset: CELO_USDC,
      payTo: CELO_PAYTO,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    };
    const baseAccept = {
      scheme: "exact",
      network: BASE,
      amount: "1000",
      asset: BASE_USDC,
      payTo: BASE_PAYTO,
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    };
    const catalog: Record<string, unknown[]> = {
      [CELO_URL]: [celoAccept],
      [BASE_URL]: [baseAccept],
    };

    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const items = [CELO_URL, BASE_URL].map((resource) =>
        parseCatalogItem({
          resource,
          accepts: catalog[resource],
          extensions: { bazaar: { info: { input: { method: "GET" } } } },
          quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
        }),
      );
      await syncCatalog({
        fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true },
        today: "2026-10-18",
      });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) =>
          new Response(JSON.stringify({ x402Version: 2, accepts: catalog[url] ?? [] }), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
      });
    }

    /** setTimeout に渡ったミリ秒。支払いのタイマーは fetch に入る直前に張られる。 */
    function spyTimers(): { armed: number[]; restore: () => void } {
      const armed: number[] = [];
      const orig = globalThis.setTimeout;
      const wrapped = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof ms === "number") armed.push(ms);
        return orig(fn as never, ms as never, ...(args as []));
      }) as unknown as typeof globalThis.setTimeout;
      globalThis.setTimeout = wrapped;
      return {
        armed,
        restore: () => {
          globalThis.setTimeout = orig;
        },
      };
    }

    await t.test("偽の fetch: Celo の支払い付きは 45 秒、Base は 20 秒。無払いはどちらも 20 秒", async () => {
      await seed();
      const hits: { url: string; paid: boolean; armedMs: number | undefined }[] = [];
      const spy = spyTimers();
      try {
        const summary = await runL1Batch({
          limit: 10,
          getPayerUsdcBalance: async () => 1_000_000_000n,
          fetchImpl: async (url: string, init?: RequestInit) => {
            const armedMs = spy.armed.at(-1);
            const headers = new Headers(init?.headers);
            const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
            hits.push({ url, paid, armedMs });
            if (!paid) {
              return new Response(JSON.stringify({ x402Version: 2, accepts: catalog[url] ?? [] }), {
                status: 402,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(JSON.stringify({ data: "goods" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        });
        const one = (url: string, paid: boolean) => hits.filter((h) => h.url === url && h.paid === paid);
        assert.equal(one(BASE_URL, false).length, 1, `base unpaid hits ${JSON.stringify(hits)} summary ${JSON.stringify(summary)}`);
        assert.equal(one(BASE_URL, true).length, 1, `base paid hits ${JSON.stringify(hits)}`);
        assert.equal(one(CELO_URL, false).length, 1, `celo unpaid hits ${JSON.stringify(hits)} summary ${JSON.stringify(summary)}`);
        assert.equal(one(CELO_URL, true).length, 1, `celo paid hits ${JSON.stringify(hits)}`);
        assert.equal(one(BASE_URL, false)[0].armedMs, L1_REQUEST_TIMEOUT_MS);
        assert.equal(one(BASE_URL, true)[0].armedMs, L1_REQUEST_TIMEOUT_MS);
        assert.equal(one(CELO_URL, false)[0].armedMs, L1_REQUEST_TIMEOUT_MS);
        assert.equal(one(CELO_URL, true)[0].armedMs, L1_CELO_PAID_TIMEOUT_MS);
        assert.equal(summary.attempted, 2);
      } finally {
        spy.restore();
      }
    });

    await t.test("偽の fetch: 差し込み口の時刻で abort する（Celo の上書きと Base の timeoutMs は別）", async () => {
      await seed();
      const elapsed: { url: string; ms: number }[] = [];
      const summary = await runL1Batch({
        limit: 10,
        timeoutMs: 40,
        celoPaidTimeoutMs: 90,
        getPayerUsdcBalance: async () => 1_000_000_000n,
        fetchImpl: async (url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
          if (!paid) {
            return new Response(JSON.stringify({ x402Version: 2, accepts: catalog[url] ?? [] }), {
              status: 402,
              headers: { "content-type": "application/json" },
            });
          }
          const started = Date.now();
          await new Promise<void>((_resolve, reject) => {
            const signal = init?.signal;
            const giveUp = setTimeout(() => reject(new Error(`abort did not fire within 1s for ${url}`)), 1_000);
            const fail = (error: Error) => {
              clearTimeout(giveUp);
              reject(error);
            };
            if (signal == null) {
              fail(new Error("paid fetch has no signal"));
              return;
            }
            if (signal.aborted) {
              elapsed.push({ url, ms: Date.now() - started });
              fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
              return;
            }
            signal.addEventListener("abort", () => {
              elapsed.push({ url, ms: Date.now() - started });
              fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
          throw new Error("paid fetch resolved without abort");
        },
      });
      const at = (url: string) => elapsed.filter((e) => e.url === url);
      assert.equal(at(BASE_URL).length, 1, `base abort ${JSON.stringify(elapsed)} summary ${JSON.stringify(summary)}`);
      assert.equal(at(CELO_URL).length, 1, `celo abort ${JSON.stringify(elapsed)}`);
      assert.ok(at(BASE_URL)[0].ms >= 30 && at(BASE_URL)[0].ms < 80, `base aborted at ${at(BASE_URL)[0].ms}ms`);
      assert.ok(at(CELO_URL)[0].ms >= 75 && at(CELO_URL)[0].ms < 160, `celo aborted at ${at(CELO_URL)[0].ms}ms`);
    });
  });
}
