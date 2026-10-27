// ============================================================
// L1 の購入ごとの証拠（2026-10-27）: challenge_402 と payment_payload。
//
// 1 回の購入（予約行）ごとに、内部の記録として 2 つを残す（purchase-evidence.ts）:
//   ① challenge_402    その購入で受け取った 402（HTTP status・x402Version・accepts の全体・選んだ accept・
//                       PAYMENT-REQUIRED で来たときはデコード後の JSON）。予約行の INSERT で書く。
//   ② payment_payload  有料の要求に載せた支払いペイロードのデコード結果。auth_nonce と同じ UPDATE で書く。
//
// ここで固定すること:
//  1. Celo（eip155:42220）の購入で①②が残る。②は売り手が受け取ったヘッダーのデコード結果とバイト単位で同じ。
//     PAYMENT-REQUIRED ヘッダーで来た 402 は source=header・デコード後の JSON。
//  2. 有料の要求が落ちても②は残る（有料の要求の前に書くから）。
//  3. 公開の書き出し（export.csv・sellers/export.csv・purchases API・エンドポイント頁の読み手）に 2 列が出ない。
//     src の中でこの 2 列を名指すのは書き手の 3 ファイルだけ、購入の表を列の指定なしに丸ごと読む問い合わせも無い。
//  4. 上限（32KB）で切り詰め、印を付ける。購入は止めない。
//  5. 秘密が入らない（鍵・RPC の URL・支払いヘッダー以外の要求ヘッダー）。ログにも署名を出さない。
//  6. scripts/sql/2026-10-27-l1-purchase-evidence.sql は何度流しても同じ（追加だけ・jsonb・NULL 可）。
//  7. （2026-10-27 独立点検 H1）auth_nonce / payment_payload の UPDATE が落ちても、drizzle の誤りの params
//     （署名済みペイロード・Gateway の signature）がログにも raw_response_meta にも出ない。伏せる層（redact.ts /
//     log-safe.ts）も `params:` 以降を落とす（Solana / XRPL / Stellar の署名済み tx の目印で確かめる）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-purchase-evidence.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 purchase evidence (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const CELO_CAIP2 = "eip155:42220";
  const BASE_CAIP2 = "eip155:8453";
  const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
  const CELO_PAYTO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
  const BASE_PAYTO = "0x2222222222222222222222222222222222222222";
  const CELO_URL = "https://celo-evidence.example/api/v2/addresses";
  const BASE_URL = "https://base-evidence.example/api";
  const RPC_SENTINEL = "https://rpc-sentinel.example/secret-token-0f1e2d";
  const GW_URL = "https://gw-evidence.example/api";
  const GW_PAYTO = "0x1111111111111111111111111111111111111111";
  /** Gateway の署名器の差し替えが返す目印（実物と同じ形・漏れたら必ず見つかる値）。 */
  const GW_SIGNATURE = `0x${"7e".repeat(65)}`;
  const GW_NONCE = `0x${"cd".repeat(32)}`;
  const GW_HEADER_MARK = "GWHEADERMARK0000";

  test("L1 purchase evidence", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { PURCHASE_EVIDENCE_MAX_BYTES, capPurchaseEvidence, paymentPayloadEvidence } = await import("@/lib/observatory/purchase-evidence");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rowsOf = (raw: unknown) =>
      [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[])];
    const asJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as Record<string, unknown> | null;

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
      "VET402_OPERATOR_PAYTO",
      "CELO_RPC_URL",
      "BASE_RPC_URL",
      "ARC_RPC_URL",
      "OBSERVATORY_ARC_GATEWAY_L1_ENABLED",
      "L1_ARC_GATEWAY_DAILY_CAP_USD",
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
    // RPC の URL が記録に紛れ込まないことを見るための目印（残高はテストの差し替えで読むので、実際には叩かない）。
    process.env.CELO_RPC_URL = RPC_SENTINEL;
    process.env.BASE_RPC_URL = RPC_SENTINEL;

    const celoUsdc = (amount: string) => ({
      scheme: "exact", network: CELO_CAIP2, amount, asset: CELO_USDC, payTo: CELO_PAYTO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" },
    });
    const baseUsdc = (amount: string) => ({
      scheme: "exact", network: BASE_CAIP2, amount, asset: BASE_USDC, payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
    });
    const { ARC_USDC } = await import("@/lib/observatory/x402-payer");
    const { ARC_GATEWAY_WALLET } = await import("@/lib/observatory/arc-gateway");
    const gatewayAccept = (amount: string) => ({
      scheme: "exact", network: "eip155:5042", amount, asset: ARC_USDC, payTo: GW_PAYTO, maxTimeoutSeconds: 60,
      extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: ARC_GATEWAY_WALLET },
    });
    const CATALOG: Record<string, unknown[]> = {
      [CELO_URL]: [celoUsdc("2000")],
      [BASE_URL]: [baseUsdc("3000")],
      [GW_URL]: [gatewayAccept("1000")],
    };

    type Seen = { url: string; paid: boolean; headers: Record<string, string>; paymentHeaderName: string | null; paymentHeaderValue: string | null };
    /**
     * 壁。mode で 402 の出し方と有料の要求への応え方を変える。
     *   body       本文に x402 の文書（既定）
     *   header     PAYMENT-REQUIRED ヘッダーに base64 の文書・本文は空。`extensions` に大きな値を足せる
     *   paidThrows 有料の要求で接続が落ちる
     */
    const wall = (opts: { mode?: "body" | "header"; paidThrows?: boolean; bigExtensionBytes?: number } = {}) => {
      const seen: Seen[] = [];
      let txSeq = 0;
      const documentFor = (url: string) => ({
        x402Version: 2,
        error: "payment required",
        resource: { url, description: "evidence test" },
        accepts: CATALOG[url] ?? [],
        ...(opts.bigExtensionBytes ? { extensions: { filler: "x".repeat(opts.bigExtensionBytes) } } : {}),
      });
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const name = headers.has("PAYMENT-SIGNATURE") ? "PAYMENT-SIGNATURE" : headers.has("X-PAYMENT") ? "X-PAYMENT" : null;
        const value = name ? headers.get(name) : null;
        const all: Record<string, string> = {};
        headers.forEach((v, k) => {
          all[k] = v;
        });
        seen.push({ url, paid: name !== null, headers: all, paymentHeaderName: name, paymentHeaderValue: value });
        if (!name) {
          const doc = documentFor(url);
          if (opts.mode === "header") {
            return new Response("", {
              status: 402,
              headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(doc)).toString("base64") },
            });
          }
          return new Response(JSON.stringify(doc), { status: 402, headers: { "content-type": "application/json" } });
        }
        if (opts.paidThrows) throw new Error("socket hang up");
        const decoded = JSON.parse(Buffer.from(value!, "base64").toString("utf8")) as { accepted?: { network?: string } };
        txSeq += 1;
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                transaction: `0x${(txSeq + (url === CELO_URL ? 0 : 8)).toString(16).padStart(4, "0").repeat(16)}`,
                network: String(decoded.accepted?.network ?? BASE_CAIP2),
                payer: "0x0000000000000000000000000000000000000001",
              }),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl, paid: (url: string) => seen.filter((s) => s.paid && s.url === url) };
    };

    async function seed(urls: string[]) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const items = urls.map((resource) =>
        parseCatalogItem({
          resource,
          accepts: CATALOG[resource],
          extensions: { bazaar: { info: { input: { method: "GET" } } } },
          quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
        }),
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-10-27" });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) =>
          new Response(JSON.stringify({ x402Version: 2, accepts: CATALOG[url] ?? [] }), { status: 402, headers: { "content-type": "application/json" } }),
      });
    }

    const rowFor = async (resourceUrl: string) => {
      const list = rowsOf(
        await db.execute(sql`
          SELECT pu.id::text AS id, pu.status, pu.network, pu.auth_nonce, pu.tx_hash, pu.challenge_402, pu.payment_payload,
                 octet_length(pu.challenge_402::text) AS c_bytes, octet_length(pu.payment_payload::text) AS p_bytes
          FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
          WHERE e.resource_url = ${resourceUrl} ORDER BY pu.attempted_at ASC`),
      );
      assert.equal(list.length, 1, `${resourceUrl} の行は 1 つ`);
      const r: Record<string, unknown> = list[0]!;
      return { ...r, challenge_402: asJson(r.challenge_402), payment_payload: asJson(r.payment_payload) } as Record<string, unknown> & {
        challenge_402: Record<string, unknown> | null;
        payment_payload: Record<string, unknown> | null;
      };
    };
    const FUNDED = async () => 1_000_000_000n;
    const decodeHeader = (v: string) => JSON.parse(Buffer.from(v, "base64").toString("utf8")) as Record<string, unknown>;

    /** console.* に出たものを拾う（ログに署名が出ないことを見る）。 */
    const captureConsole = async <T,>(fn: () => Promise<T>): Promise<{ result: T; text: string }> => {
      const lines: string[] = [];
      const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
      for (const k of Object.keys(orig) as (keyof typeof orig)[]) {
        console[k] = (...args: unknown[]) => {
          lines.push(args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" "));
        };
      }
      try {
        const result = await fn();
        return { result, text: lines.join("\n") };
      } finally {
        Object.assign(console, orig);
      }
    };

    await t.test("スキーマ: SQL は追加だけで何度流しても同じ。2 列は jsonb・NULL 可", async () => {
      const sqlFile = join(process.cwd(), "scripts/sql/2026-10-27-l1-purchase-evidence.sql");
      const text = readFileSync(sqlFile, "utf8");
      const statements = text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
      assert.ok(statements.every((l) => /^ALTER TABLE x402_l1_purchases ADD COLUMN IF NOT EXISTS (challenge_402|payment_payload) jsonb;$/.test(l.trim())), "追加だけ");
      execFileSync("psql", [TEST_DB, "-v", "ON_ERROR_STOP=1", "-f", sqlFile], { stdio: "pipe" });
      execFileSync("psql", [TEST_DB, "-v", "ON_ERROR_STOP=1", "-f", sqlFile], { stdio: "pipe" });
      const cols = rowsOf(
        await db.execute(sql`
          SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'x402_l1_purchases' AND column_name IN ('challenge_402', 'payment_payload') ORDER BY column_name`),
      );
      assert.deepEqual(
        cols.map((c) => ({ ...c })),
        [
          { column_name: "challenge_402", data_type: "jsonb", is_nullable: "YES", column_default: null },
          { column_name: "payment_payload", data_type: "jsonb", is_nullable: "YES", column_default: null },
        ],
      );
    });

    await t.test("Celo の購入で①②が残る（402 は本文）。②は売り手が受け取ったヘッダーのデコード結果と同じ", async () => {
      await seed([CELO_URL]);
      const w = wall();
      const { text: logs } = await captureConsole(() => runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl }));
      const paid = w.paid(CELO_URL);
      assert.equal(paid.length, 1, "Celo で 1 回払う");
      const row = await rowFor(CELO_URL);
      assert.equal(row.status, "settle_claimed");
      assert.equal(row.network, CELO_CAIP2);

      // ① 受け取った 402
      const c = row.challenge_402!;
      assert.equal(c.v, 1);
      assert.equal(c.protocol, "x402");
      assert.equal(c.httpStatus, 402);
      assert.equal(c.source, "body");
      assert.equal(c.x402Version, 2);
      assert.equal(c.acceptsCount, 1);
      const doc = c.document as Record<string, unknown>;
      assert.deepEqual(doc.accepts, CATALOG[CELO_URL], "accepts の全体（売り手の原文）");
      assert.deepEqual(doc.resource, { url: CELO_URL, description: "evidence test" });
      const selected = c.selectedAccept as Record<string, unknown>;
      assert.equal(selected.network, CELO_CAIP2);
      assert.equal(String(selected.payTo).toLowerCase(), CELO_PAYTO);
      assert.equal(selected.amount, "2000");
      assert.equal(c.truncated, undefined, "小さいので切らない");

      // ② 有料の要求に載せたペイロード
      const p = row.payment_payload!;
      assert.equal(p.v, 1);
      assert.equal(p.headerName, "PAYMENT-SIGNATURE");
      assert.equal(p.encoding, "base64-json");
      const sent = decodeHeader(paid[0].paymentHeaderValue!);
      assert.deepEqual(p.decoded, sent, "売り手が受け取ったヘッダーのデコード結果とバイト単位で同じ");
      const auth = ((p.decoded as Record<string, unknown>).payload as { authorization: Record<string, string>; signature: string });
      assert.equal(auth.authorization.nonce, row.auth_nonce, "auth_nonce と同じ認可");
      assert.equal(auth.authorization.to.toLowerCase(), CELO_PAYTO);
      assert.equal(auth.authorization.value, "2000");
      assert.match(auth.signature, /^0x[0-9a-f]+$/i);

      // 秘密が入らない。
      const both = JSON.stringify([row.challenge_402, row.payment_payload]).toLowerCase();
      assert.ok(!both.includes(TEST_PK.slice(2).toLowerCase()), "秘密鍵が入らない");
      assert.ok(!both.includes("rpc-sentinel"), "RPC の URL が入らない");
      for (const [k, v] of Object.entries(paid[0].headers)) {
        if (k === "payment-signature") continue;
        assert.ok(!both.includes(v.toLowerCase()), `支払い以外の要求ヘッダー（${k}）の値が入らない`);
      }
      assert.ok(!both.includes("user-agent"), "要求ヘッダーの名前も入らない");
      // ログにも出さない。
      assert.ok(!logs.includes(auth.signature), "署名がログに出ない");
      assert.ok(!logs.includes(paid[0].paymentHeaderValue!), "支払いヘッダーの値がログに出ない");
    });

    await t.test("402 が PAYMENT-REQUIRED ヘッダーで来たら source=header・デコード後の JSON を残す", async () => {
      await seed([CELO_URL]);
      const w = wall({ mode: "header" });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(w.paid(CELO_URL).length, 1);
      const c = (await rowFor(CELO_URL)).challenge_402!;
      assert.equal(c.source, "header");
      assert.equal(c.httpStatus, 402);
      const doc = c.document as Record<string, unknown>;
      assert.equal(doc.x402Version, 2);
      assert.deepEqual(doc.accepts, CATALOG[CELO_URL]);
      assert.equal(doc.error, "payment required");
    });

    await t.test("有料の要求が落ちても②は残る（auth_nonce と同じ UPDATE・有料の要求の前）", async () => {
      await seed([CELO_URL]);
      const w = wall({ paidThrows: true });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      const paid = w.paid(CELO_URL);
      assert.equal(paid.length, 1, "有料の要求は 1 回出て、落ちた");
      const row = await rowFor(CELO_URL);
      assert.equal(row.status, "settle_failed");
      assert.equal(row.tx_hash, null);
      assert.ok(row.auth_nonce);
      assert.deepEqual(row.payment_payload!.decoded, decodeHeader(paid[0].paymentHeaderValue!));
      assert.equal(row.challenge_402!.httpStatus, 402);
    });

    await t.test("上限: 大きい 402 は 32KB に切り詰めて印を付け、購入は止めない", async () => {
      await seed([CELO_URL]);
      const w = wall({ mode: "header", bigExtensionBytes: 200_000 });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(w.paid(CELO_URL).length, 1, "購入は進む");
      const row = await rowFor(CELO_URL);
      assert.equal(row.status, "settle_claimed");
      const c = row.challenge_402!;
      assert.ok(Number(row.c_bytes) <= PURCHASE_EVIDENCE_MAX_BYTES + 1024, `jsonb の text 表現でも上限の近く（${row.c_bytes}）`);
      assert.ok(Buffer.byteLength(JSON.stringify(c), "utf8") <= PURCHASE_EVIDENCE_MAX_BYTES, "JSON で 32KB 以下");
      const mark = c.truncated as Record<string, unknown>;
      assert.equal(mark.field, "document");
      assert.ok(Number(mark.originalBytes) > 200_000);
      assert.equal(typeof c.document, "string", "document は元の JSON の先頭（文字列）");
      assert.ok(String(c.document).startsWith('{"x402Version":2'));
      // 切っても選んだ accept と HTTP status は残る。
      assert.equal(c.httpStatus, 402);
      assert.equal((c.selectedAccept as Record<string, unknown>).network, CELO_CAIP2);
      // ②は小さいので切らない。
      assert.equal(row.payment_payload!.truncated, undefined);
    });

    await t.test("上限の関数: どの形でも 32KB 以下・印つき・多バイト文字を壊さない", () => {
      const big = { v: 1, keep: "k", document: { s: "あ".repeat(40_000), q: '"\\'.repeat(5_000) } };
      const out = capPurchaseEvidence(big, "document");
      assert.ok(Buffer.byteLength(JSON.stringify(out), "utf8") <= PURCHASE_EVIDENCE_MAX_BYTES);
      assert.equal(out.keep, "k");
      assert.equal((out.truncated as Record<string, unknown>).field, "document");
      assert.ok(!String(out.document).includes("�"), "文字の途中で切らない");
      // bulkyKey 以外が大きいときは全体を先頭だけにする。
      const other = capPurchaseEvidence({ v: 1, other: "z".repeat(100_000), document: {} }, "document");
      assert.ok(Buffer.byteLength(JSON.stringify(other), "utf8") <= PURCHASE_EVIDENCE_MAX_BYTES);
      assert.equal((other.truncated as Record<string, unknown>).field, "*");
      // 小さいものはそのまま（U+0000 は落とす——jsonb が受け付けない）。
      assert.deepEqual(capPurchaseEvidence({ v: 1, document: { a: "x\u0000y" } }, "document"), { v: 1, document: { a: "xy" } });
      // MPP の credential（`Payment <base64url>`）もデコードする。読めない値は生の値を残さない。
      const cred = Buffer.from(JSON.stringify({ challenge: { id: "c1" }, payload: { signature: "0xab" } })).toString("base64url");
      const mpp = paymentPayloadEvidence({ headerName: "authorization", headerValue: `Payment ${cred}` });
      assert.equal(mpp.encoding, "payment-base64url-json");
      assert.deepEqual(mpp.decoded, { challenge: { id: "c1" }, payload: { signature: "0xab" } });
      const bad = paymentPayloadEvidence({ headerName: "X-PAYMENT", headerValue: "not-base64-json!!" });
      assert.equal(bad.undecodable, true);
      assert.equal(bad.decoded, null);
      assert.ok(!JSON.stringify(bad).includes("not-base64-json"), "読めない値は残さない");
    });

    await t.test("公開の書き出しに 2 列が出ない（export.csv・sellers/export.csv・purchases API・エンドポイント頁の読み手）", async () => {
      await seed([CELO_URL, BASE_URL]);
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(w.paid(CELO_URL).length, 1);
      assert.equal(w.paid(BASE_URL).length, 1);
      const celo = await rowFor(CELO_URL);
      const base = await rowFor(BASE_URL);
      assert.ok(celo.payment_payload && base.payment_payload && celo.challenge_402 && base.challenge_402, "両方の行に①②がある");
      const secrets: string[] = [];
      for (const r of [celo, base]) {
        const d = r.payment_payload!.decoded as { payload: { signature: string } };
        secrets.push(d.payload.signature, String(r.auth_nonce));
      }
      for (const s of w.seen.filter((x) => x.paid)) secrets.push(s.paymentHeaderValue!);
      const forbidden = ["challenge_402", "payment_payload", "challenge402", "paymentPayload", "selectedAccept", "acceptsCount"];
      const check = (label: string, body: string) => {
        for (const s of secrets) assert.ok(!body.includes(s), `${label}: 署名・nonce・支払いヘッダーが出ない`);
        for (const f of forbidden) assert.ok(!body.includes(f), `${label}: ${f} が出ない`);
      };

      const { NextRequest } = await import("next/server");
      const ledger = await import("@/app/api/v1/observatory/export.csv/route");
      const csv = await ledger.GET(new NextRequest("http://localhost/api/v1/observatory/export.csv?days=7", { headers: { "x-real-ip": "203.0.113.71" } }));
      assert.equal(csv.status, 200);
      const csvText = await csv.text();
      const header = csvText.split("\n")[0].split(",");
      const { EXPORT_CSV_COLUMNS } = await import("@/lib/observatory/export-columns");
      assert.deepEqual(header, [...EXPORT_CSV_COLUMNS], "列は正典どおり（新しい 2 列は無い）");
      assert.ok(csvText.split("\n").filter((l) => l.trim() !== "").length >= 3, "2 つの購入の行が出ている（空の CSV で通さない）");
      check("export.csv", csvText);
      check("export.csv headers", JSON.stringify([...csv.headers.entries()]));

      const sellers = await import("@/app/api/v1/sellers/export.csv/route");
      const sres = await sellers.GET(new NextRequest("http://localhost/api/v1/sellers/export.csv", { headers: { "x-real-ip": "203.0.113.72" } }));
      assert.equal(sres.status, 200);
      const sellersText = await sres.text();
      assert.ok(sellersText.includes(BASE_URL.replace("https://", "")), "Base の出品の行が出ている（空で通さない）");
      check("sellers/export.csv", sellersText);

      const ids = rowsOf(await db.execute(sql`SELECT id::text AS id FROM x402_endpoints`)).map((r) => String(r.id));
      const purchasesRoute = await import("@/app/api/v1/observatory/endpoints/[id]/purchases/route");
      const { getEndpointDetail, getEndpointPurchases } = await import("@/lib/observatory/reader");
      for (const id of ids) {
        const res = await purchasesRoute.GET(new NextRequest(`http://localhost/api/v1/observatory/endpoints/${id}/purchases`, { headers: { "x-real-ip": "203.0.113.73" } }), {
          params: Promise.resolve({ id }),
        });
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.ok(body.includes("settle_claimed"), "購入の行が出ている（空で通さない）");
        check("purchases API", body);
        check("getEndpointPurchases", JSON.stringify(await getEndpointPurchases(id)));
        check("getEndpointDetail", JSON.stringify(await getEndpointDetail(id)));
      }
    });

    /** auth_nonce / payment_payload の UPDATE をわざと落とすトリガー（このテストの間だけ置く）。 */
    const withFailingAuthWrite = async (fn: () => Promise<void>) => {
      await db.execute(sql.raw(`
        CREATE OR REPLACE FUNCTION evidence_test_fail_auth_write() RETURNS trigger AS $$
        BEGIN
          IF NEW.payment_payload IS NOT NULL AND OLD.payment_payload IS NULL THEN
            RAISE EXCEPTION 'evidence test: auth write refused';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`));
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS evidence_test_fail_auth_write ON x402_l1_purchases`));
      await db.execute(sql.raw(`
        CREATE TRIGGER evidence_test_fail_auth_write BEFORE UPDATE ON x402_l1_purchases
        FOR EACH ROW EXECUTE FUNCTION evidence_test_fail_auth_write()`));
      try {
        await fn();
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER IF EXISTS evidence_test_fail_auth_write ON x402_l1_purchases`));
        await db.execute(sql.raw(`DROP FUNCTION IF EXISTS evidence_test_fail_auth_write()`));
      }
    };
    /** 支払いペイロードの目印。どれか 1 つでもログ・台帳に出たら漏れ。 */
    const PAYLOAD_MARKERS: RegExp[] = [
      /0x[0-9a-f]{130}/i, // EIP-3009 / Gateway の signature（65 バイト）
      /0x[0-9a-f]{64}/i, // authorization.nonce（この回は tx が無いので 32 バイトの hex は出てはいけない）
      /"authorization"/,
      /"signature"/,
      /PAYMENT-SIGNATURE/,
      /headerName/,
      /params: (?!<redacted>)/,
    ];
    const assertNoPayload = (label: string, text: string) => {
      for (const re of PAYLOAD_MARKERS) assert.ok(!re.test(text), `${label}: ${re} が出ない\n${text.slice(0, 600)}`);
    };
    const failedRow = async (resourceUrl: string) => {
      const list = rowsOf(
        await db.execute(sql`
          SELECT pu.status, pu.spent_units, pu.auth_nonce, pu.payment_payload, pu.raw_response_meta::text AS meta
          FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = ${resourceUrl}`),
      );
      assert.equal(list.length, 1);
      return list[0]!;
    };

    await t.test("H1: Celo の auth_nonce / payment_payload の UPDATE が落ちても、署名済みペイロードはログにも台帳にも出ない", async () => {
      await seed([CELO_URL]);
      const w = wall();
      let logs = "";
      await withFailingAuthWrite(async () => {
        ({ text: logs } = await captureConsole(() => runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl })));
      });
      assert.equal(w.paid(CELO_URL).length, 0, "有料の要求は出さない（auth_nonce と同じ扱い）");
      const row = await failedRow(CELO_URL);
      assert.equal(row.status, "request_error", "資格情報は外へ出ていない＝予約を戻す");
      assert.equal(row.spent_units, "0");
      assert.equal(row.auth_nonce, null);
      assert.equal(row.payment_payload, null);
      const meta = JSON.parse(String(row.meta)) as Record<string, unknown>;
      assert.equal(meta.reason, "threw_after_reservation");
      assert.match(String(meta.error), /auth_nonce_write failed: P0001 .*evidence test: auth write refused/, "SQLSTATE と原因の本文は残す");
      assert.equal((meta.cause as Record<string, unknown>).code, "P0001");
      assertNoPayload("raw_response_meta", String(row.meta));
      assert.ok(logs.includes("auth_nonce_write failed"), "ログに失敗は残る（黙って消さない）");
      assertNoPayload("logs", logs);
    });

    await t.test("H1: Arc Gateway の UPDATE が落ちても、gatewayAuthMeta の signature はログにも台帳にも出ない", async () => {
      await seed([GW_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      process.env.ARC_RPC_URL = "http://127.0.0.1:9/arc-evidence-test-rpc";
      const w = wall();
      let signed = 0;
      let logs = "";
      try {
        await withFailingAuthWrite(async () => {
          ({ text: logs } = await captureConsole(() =>
            runL1Batch({
              limit: 10,
              fetchImpl: w.fetchImpl,
              getPayerUsdcBalance: FUNDED,
              readArcGatewayAvailable: async () => 5_000_000n,
              signArcGateway: async () => {
                signed++;
                return {
                  header: { headerName: "PAYMENT-SIGNATURE", headerValue: Buffer.from(JSON.stringify({ x402Version: 2, mark: GW_HEADER_MARK, payload: { signature: GW_SIGNATURE } })).toString("base64") },
                  authorization: {
                    from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
                    to: GW_PAYTO,
                    value: "1000",
                    validAfter: "1",
                    validBefore: String(Math.floor(Date.now() / 1000) + 600),
                    nonce: GW_NONCE,
                  },
                  signature: GW_SIGNATURE,
                  verifyingContract: ARC_GATEWAY_WALLET,
                };
              },
            }),
          ));
        });
      } finally {
        delete process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
      }
      assert.equal(signed, 1, "Gateway で署名まで進んだ（UPDATE の失敗を通った）");
      assert.equal(w.paid(GW_URL).length, 0, "有料の要求は出さない");
      const row = await failedRow(GW_URL);
      assert.equal(row.status, "request_error");
      assert.equal(row.auth_nonce, null);
      const meta = String(row.meta);
      assert.match(meta, /auth_nonce_write failed: P0001/);
      for (const text of [meta, logs]) {
        assert.ok(!text.includes(GW_SIGNATURE.slice(2)), "Gateway の signature が出ない");
        assert.ok(!text.includes(GW_NONCE.slice(2)), "Gateway の nonce が出ない");
        assert.ok(!text.includes(GW_HEADER_MARK), "支払いヘッダーの値が出ない");
        assert.ok(!text.includes(Buffer.from(JSON.stringify({ x402Version: 2, mark: GW_HEADER_MARK })).toString("base64").slice(0, 16)), "base64 のままでも出ない");
        assertNoPayload("gateway", text);
      }
    });

    await t.test("H1: 伏せる層は drizzle の params を落とす（Solana / XRPL / Stellar の署名済み tx・EVM の署名）", async () => {
      const { DrizzleQueryError } = await import("drizzle-orm/errors");
      const { redactForLog, redactedError, stripQueryParams } = await import("@/lib/observatory/redact");
      const { redactSecretsForLog, logServerErrorSafe } = await import("@/lib/util/log-safe");
      const { dbErrorCause, dbWriteErrorWithoutParams } = await import("@/lib/observatory/l1-runner");
      const SOLANA_TX = "AQAAAAAAAAAASOLANASIGNEDTXMARKER" + "A".repeat(200);
      const XRPL_BLOB = "1200002280000000XRPLSIGNEDBLOBMARKER" + "F".repeat(200);
      const STELLAR_XDR = "AAAAAgAAAABSTELLARSIGNEDXDRMARKER" + "B".repeat(200);
      const EVM_SIG = `0x${"5a".repeat(65)}`;
      const markers = ["SOLANASIGNEDTXMARKER", "XRPLSIGNEDBLOBMARKER", "STELLARSIGNEDXDRMARKER", EVM_SIG.slice(2)];
      const pgCause = Object.assign(new Error("evidence test: auth write refused"), { code: "P0001" });
      for (const payload of [
        { payload: { transaction: SOLANA_TX } },
        { payload: { signedTxBlob: XRPL_BLOB, invoiceId: "inv" } },
        { payload: { transaction: STELLAR_XDR } },
        { payload: { signature: EVM_SIG, authorization: { nonce: `0x${"01".repeat(32)}` } } },
      ]) {
        const err = new DrizzleQueryError(
          'update "x402_l1_purchases" set "auth_nonce" = $1, "payment_payload" = $2 where "x402_l1_purchases"."id" = $3',
          ["n", JSON.stringify({ v: 1, decoded: payload }), "00000000-0000-0000-0000-000000000000"],
          pgCause,
        );
        assert.ok(markers.some((m) => err.message.includes(m)), "前提: drizzle の message は params を持つ");
        const outs: [string, string][] = [
          ["redactForLog", redactForLog(err)],
          ["redactedError", redactedError(err).message],
          ["redactSecretsForLog", redactSecretsForLog(err.message)],
          ["dbErrorCause", JSON.stringify(dbErrorCause(err))],
          ["dbWriteErrorWithoutParams", `${dbWriteErrorWithoutParams("auth_nonce_write", err).message} ${JSON.stringify(dbErrorCause(dbWriteErrorWithoutParams("auth_nonce_write", err)))}`],
          ["logServerErrorSafe", (await captureConsole(async () => logServerErrorSafe("observatory.l1.test", err))).text],
          ["logServerErrorSafe(redactedError)", (await captureConsole(async () => logServerErrorSafe("observatory.l1.test", redactedError(err)))).text],
        ];
        for (const [label, text] of outs) {
          for (const m of markers) assert.ok(!text.includes(m), `${label}: 署名済みの値が出ない (${text.slice(0, 200)})`);
        }
        assert.match(redactForLog(err), /Failed query: update "x402_l1_purchases" set "auth_nonce" = \$1.*\nparams: <redacted>$/s, "文は診断に残す");
        assert.match(dbWriteErrorWithoutParams("auth_nonce_write", err).message, /^auth_nonce_write failed: P0001 .*auth write refused$/);
        assert.equal(dbErrorCause(dbWriteErrorWithoutParams("auth_nonce_write", err))?.code, "P0001", "SQLSTATE は台帳の cause に残る");
      }
      // params の無い文字列は変えない。
      assert.equal(stripQueryParams("plain error: timeout"), "plain error: timeout");
      assert.equal(stripQueryParams("multi\nline"), "multi\nline");
    });

    await t.test("src の中で 2 列を名指すのは書き手の 3 ファイルだけ。購入の表を丸ごと読む問い合わせも無い", () => {
      const allowed = new Set(["src/lib/db/schema.ts", "src/lib/observatory/l1-runner.ts", "src/lib/observatory/purchase-evidence.ts"]);
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(ts|tsx|js|mjs)$/.test(name)) files.push(p);
        }
      };
      walk("src");
      assert.ok(files.length > 100, "src を読めている");
      const offenders: string[] = [];
      const wildcard: string[] = [];
      for (const f of files) {
        const text = readFileSync(f, "utf8");
        if (/challenge_402|payment_payload|\.challenge402\b|x402L1Purchases\.paymentPayload\b/.test(text) && !allowed.has(f)) offenders.push(f);
        if (/\.select\(\s*\)\s*\.from\(\s*(schema\.)?x402L1Purchases\b/.test(text)) wildcard.push(`${f}: select().from(x402L1Purchases)`);
        if (/SELECT\s+\*\s+FROM\s+x402_l1_purchases\b/i.test(text)) wildcard.push(`${f}: SELECT * FROM x402_l1_purchases`);
        // drizzle の relational query（db.query.x402L1Purchases.findMany 等）は既定で全列を返す。
        if (/\.query\.x402L1Purchases\b/.test(text)) wildcard.push(`${f}: db.query.x402L1Purchases`);
        // 引数なしの returning() は行の全列を返す（insert / update / delete のどれでも）。
        if (/\.(insert|update|delete)\(\s*(schema\.)?x402L1Purchases\s*\)(?:(?!;\s*\n)[\s\S]){0,800}?\.returning\(\s*\)/.test(text)) {
          wildcard.push(`${f}: returning() on x402L1Purchases`);
        }
        // 生 SQL の RETURNING * は、同じ文に x402_l1_purchases があるときだけ数える（文は ; か ` で区切る）。
        for (const stmt of text.split(/[;`]/)) {
          if (/x402_l1_purchases/.test(stmt) && /RETURNING\s+\*/i.test(stmt)) wildcard.push(`${f}: RETURNING * on x402_l1_purchases`);
        }
        // x402_l1_purchases に付けた別名（FROM / JOIN x402_l1_purchases pu・AS lp …）の `.*` と行丸ごとの JSON 化。
        const aliases = new Set(["x402_l1_purchases"]);
        for (const m of text.matchAll(/x402_l1_purchases\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi)) {
          const a = m[1]!.toLowerCase();
          if (!["where", "set", "on", "join", "left", "inner", "group", "order", "limit", "values", "using", "returning", "as", "for", "union", "from", "and", "or", "select", "insert", "update", "delete", "with", "having", "window", "except", "intersect", "cross", "full", "right", "natural", "lateral", "tablesample", "only"].includes(a)) aliases.add(a);
        }
        for (const a of aliases) {
          const re = new RegExp(`\\b${a}\\.\\*|to_jsonb?\\(\\s*${a}\\s*\\)|row_to_json\\(\\s*${a}\\s*\\)|jsonb?_agg\\(\\s*${a}\\s*\\)`, "i");
          if (re.test(text)) wildcard.push(`${f}: whole-row ${a}`);
        }
      }
      assert.deepEqual(offenders, [], "2 列を読む・書くのは書き手だけ（公開の読み手が名指したらここで落ちる）");
      assert.deepEqual(wildcard, [], "購入の表を列の指定なしに読まない");
      // 書き手の側でも、2 列の値をログへ渡さない。
      const runner = readFileSync("src/lib/observatory/l1-runner.ts", "utf8");
      for (const line of runner.split("\n")) {
        if (/log[A-Za-z]*\(/.test(line)) assert.ok(!/challenge402\b|paymentPayload\b/.test(line.replace(/evidence_\$\{column\}/, "")), `ログの呼び出しに証拠の値を渡さない: ${line.trim()}`);
      }
    });
  });
}
