// ============================================================
// Arc の遅延回収のレーン（2026-11-03・recover-late.ts の ARC_CHAIN_READ_LANE）。
//
// 数字の監査（2026-11-03・結論 #1）: 有料の要求が transport で切れて settle_failed・tx なしになった Arc の行 2 行は、チェーン上で
// AuthorizationUsed(購入元, その行の nonce) つきで金が動いていた。Arc は EIP-3009 なので、BNB と同じ規則で決める。
//
// 守ること:
//  1. nonce が receipt で一致すれば貼る（settle_claimed・照合器が settled にする）。
//  2. ログが 0 件でも、認可が使われた行は確定しない（decided: false・tries は増やさない・次の回に読み直す）。
//     読めない行は 1 文字も変えない。
//  3. 認可が使われていない行だけ decided: true の印を付ける。ログの読み手が例外を投げても決まる。
//  4. 認可の読み手が無ければ何も決めない。
//  5. 額が合う別の着金があっても、nonce が違えば貼らない。
//  6. lanes に arc が無い回は Arc の行を選ばない（index-settlements の回）。
// Run: TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-arc-lane.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement arc lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const PAY_TO = "0x3f0b2c7d9a1e4f6c8b5d7e9f1a2b3c4d5e6f7a8b";
  const ARC = "eip155:5042";
  const AMOUNT = "50000";
  /** 本番の 9ca07ba4（hazard.lonestaroracle.xyz・10-18 00:00:21Z・応答なし・50,000）と同じ形。 */
  const AT = new Date("2026-10-18T00:00:21Z");
  const nonce = (b: string) => `0x${b.repeat(32)}`;
  const tx = (b: string) => `0x${b.repeat(32)}`;

  type Late = typeof import("@/lib/settlements/recover-late");
  type Readers = Pick<Parameters<Late["recoverLateSettlements"]>[0] & object, "readTransfers" | "readNonces" | "readAuthorizationState">;

  test("recover-late: Arc のレーンは認可の状態で決める", async (t) => {
    const late: Late = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);
    const seedRow = async (n: string, at = AT) => {
      const endpointId = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `arc.example/${endpointId}`,
        resourceUrl: `https://arc.example/${endpointId}`,
        method: "GET",
        payTo: PAY_TO,
        network: ARC,
        status: "active",
        lastSeenAt: new Date(),
      });
      const id = randomUUID();
      await db.insert(schema.x402L1Purchases).values({
        id,
        endpointId,
        resourceKey: `arc.example/${endpointId}`,
        network: ARC,
        status: "settle_failed",
        attemptedAt: at,
        payer: PAYER,
        payTo: PAY_TO,
        amountUnits: AMOUNT,
        spentUnits: AMOUNT,
        authNonce: n,
        httpStatusPaid: null,
        rawResponseMeta: { phase: "paid", status: null, transportFailure: { side: "seller_or_path", code: null } },
      } as never);
      return id;
    };
    const read = async (id: string) => {
      const [r] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id));
      return r as unknown as { status: string; txHash: string | null; rawResponseMeta: { lateChainRead?: { decided?: boolean; by?: string; tries?: number }; lateSettlement?: Record<string, unknown> } | null };
    };
    const corrections = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after, reason FROM correction_log WHERE subject_type = 'purchase' AND subject_id = ${id} ORDER BY created_at, id`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { before: unknown; after: unknown; reason: string }[];
    };
    const run = (readers: Readers & { chainReadLimit?: number; lanes?: import("@/lib/settlements/recover-late").ChainReadLaneKey[] }) =>
      late.recoverLateSettlements({ ...readers, chainReadBudgetMs: 0, celoChainReadBudgetMs: 0, bnbChainReadBudgetMs: 0, arbitrumChainReadBudgetMs: 0, avalancheChainReadBudgetMs: 0 });
    const noLogs: Readers["readTransfers"] = async (q) => (q.network === ARC ? [] : null);
    const noNonces: Readers["readNonces"] = async () => [];

    await t.test("ログが 0 件でも、使われた認可の行は確定しない", async () => {
      await reset();
      const id = await seedRow(nonce("a1"));
      for (let i = 0; i < 2; i++) {
        const summary = await run({ readTransfers: noLogs, readNonces: noNonces, readAuthorizationState: async () => true });
        assert.equal(summary.chainRowsUnreadArc, 1);
        assert.equal(summary.chainRowsReadArc, 0);
        const r = await read(id);
        assert.equal(r.status, "settle_failed");
        assert.equal(r.txHash, null);
        assert.equal(r.rawResponseMeta?.lateChainRead?.decided, false);
        assert.equal(r.rawResponseMeta?.lateChainRead?.tries, 0);
      }
    });

    await t.test("ログの読み手が例外でも、使われていない認可の行は決まる", async () => {
      await reset();
      const unused = await seedRow(nonce("d1"));
      const used = await seedRow(nonce("d2"), new Date(AT.getTime() + 86_400_000));
      let transferReads = 0;
      await run({
        readTransfers: async (q) => {
          if (q.network !== ARC) return null;
          transferReads++;
          throw new Error("HTTP 403");
        },
        readNonces: noNonces,
        readAuthorizationState: async (q) => q.nonce !== nonce("d1"),
      });
      assert.equal((await read(unused)).rawResponseMeta?.lateChainRead?.decided, true);
      assert.equal((await read(unused)).rawResponseMeta?.lateChainRead?.by, "authorization_state");
      const u = await read(used);
      assert.equal(u.rawResponseMeta?.lateChainRead?.decided, false);
      assert.equal(u.txHash, null);
      assert.equal(transferReads, 1, "使われていない行のためにログを読まない");
    });

    await t.test("読めない認可の行は変えない・認可の読み手が無ければ何も決めない", async () => {
      await reset();
      const id = await seedRow(nonce("a2"));
      const before = await read(id);
      await run({ readTransfers: noLogs, readNonces: noNonces, readAuthorizationState: async () => null });
      assert.deepEqual(await read(id), before);
      await run({
        readTransfers: noLogs,
        readNonces: noNonces,
        readAuthorizationState: async () => {
          throw new Error("rpc down");
        },
      });
      assert.deepEqual(await read(id), before);
      await run({ readTransfers: noLogs, readNonces: noNonces });
      assert.deepEqual(await read(id), before);
      assert.equal((await corrections(id)).length, 0);
    });

    await t.test("nonce が一致すれば貼り、別の着金の行は貼らない。貼った行は照合前で、訂正ログに 1 行", async () => {
      await reset();
      const hit = await seedRow(nonce("b1"));
      const miss = await seedRow(nonce("b2"));
      const transfer = { txHash: tx("c1"), from: PAYER, to: PAY_TO, value: AMOUNT, blockTime: new Date(AT.getTime() + 12_000).toISOString() };
      const nonceCalls: { network: string; txHash: string; payer: string; payTo?: string }[] = [];
      const s = await run({
        readTransfers: async (q) => (q.network === ARC ? [transfer] : null),
        readNonces: async (q) => (nonceCalls.push(q), [nonce("b1")]),
        readAuthorizationState: async (q) => q.nonce === nonce("b1"),
      });
      assert.equal(s.recoveredFromChainArc, 1);
      assert.deepEqual(s.links, [{ purchaseId: hit, txHash: tx("c1") }]);
      assert.deepEqual(nonceCalls, [{ network: ARC, txHash: tx("c1"), payer: PAYER, payTo: PAY_TO }]);
      const linked = await read(hit);
      assert.equal(linked.status, "settle_claimed");
      assert.equal(linked.txHash?.toLowerCase(), tx("c1"));
      assert.equal(linked.rawResponseMeta?.lateSettlement?.source, "chain_read");
      assert.equal(linked.rawResponseMeta?.lateSettlement?.matchedBy, "authorization_nonce");
      assert.equal(linked.rawResponseMeta?.lateSettlement?.priorStatus, "settle_failed");
      const log = await corrections(hit);
      assert.equal(log.length, 1);
      assert.deepEqual(log[0].before, { status: "settle_failed", txHash: null });
      assert.deepEqual(log[0].after, { status: "settle_claimed", txHash: tx("c1") });
      assert.equal(log[0].reason, "settlement_backfill");
      const other = await read(miss);
      assert.equal(other.txHash, null);
      assert.equal(other.rawResponseMeta?.lateChainRead?.decided, true);
    });

    await t.test("lanes に arc が無い回は Arc の行を選ばない", async () => {
      await reset();
      const id = await seedRow(nonce("e1"));
      const before = await read(id);
      const calls: string[] = [];
      await run({
        readTransfers: async (q) => (calls.push(q.network), q.network === ARC ? [] : null),
        readNonces: noNonces,
        readAuthorizationState: async () => false,
        lanes: ["base", "celo", "bnb", "arbitrum", "avalanche"],
      });
      assert.deepEqual(calls, []);
      assert.deepEqual(await read(id), before);
      // arc を含む回は決める。
      await run({ readTransfers: noLogs, readNonces: noNonces, readAuthorizationState: async () => false, lanes: ["arc"] });
      assert.equal((await read(id)).rawResponseMeta?.lateChainRead?.decided, true);
    });

    await reset();
  });
}
