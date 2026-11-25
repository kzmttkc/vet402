// ============================================================
// Stellar の遅延回収のレーン（2026-11-26・recover-late.ts の STELLAR_CHAIN_READ_LANE）。
//
// 守ること:
//  1. transfer と窓が合えば settle_claimed に貼る（lateSettlement・訂正ログ）。
//  2. 窓の外の transfer では直らない。
//  3. 同じ payer・pay_to・額の行が 2 つで transfer が 1 本のとき、1 行だけ貼る。
//  4. 2 回走らせても何も変わらない。
// Run: TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-stellar-lane.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement stellar lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const STELLAR = "stellar:pubnet";
  const PAYER = "GCEOU7BSH7RIVZXYQJUYBS76YCTNVB63XWZGT5ZNPWMJW6MUQKN2KX7C";
  const PAY_TO = "GBIX2M7HEXAMPLEPAYTOADDRESSAAAAAAAAAAAAAAAAAAAAAA";
  const AMOUNT = "5000";
  const AT = new Date("2026-11-25T00:01:14Z");

  type Late = typeof import("@/lib/settlements/recover-late");
  type Readers = Pick<Parameters<Late["recoverLateSettlements"]>[0] & object, "readTransfers">;

  test("recover-late: Stellar のレーンは transfer と窓で貼る", async (t) => {
    const late: Late = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);
    const seedRow = async (
      over: { at?: Date; endpointId?: string; status?: string; txHash?: string } = {},
    ) => {
      const endpointId = over.endpointId ?? randomUUID();
      if (!over.endpointId) {
        await db.insert(schema.x402Endpoints).values({
          id: endpointId,
          resourceKey: `stellar.example/${endpointId}`,
          resourceUrl: `https://stellar.example/${endpointId}`,
          method: "GET",
          payTo: PAY_TO,
          network: STELLAR,
          status: "active",
          lastSeenAt: new Date(),
        });
      }
      const id = randomUUID();
      await db.insert(schema.x402L1Purchases).values({
        id,
        endpointId,
        resourceKey: `stellar.example/${endpointId}`,
        network: STELLAR,
        status: over.status ?? "settle_failed",
        attemptedAt: over.at ?? AT,
        payer: PAYER,
        payTo: PAY_TO,
        amountUnits: AMOUNT,
        spentUnits: AMOUNT,
        txHash: over.txHash ?? null,
        httpStatusPaid: over.status === "settled" ? 200 : null,
        rawResponseMeta: { phase: "paid", status: over.status === "settled" ? 200 : null, transportFailure: { side: "seller_or_path", code: null } },
      } as never);
      return id;
    };
    const read = async (id: string) => {
      const [r] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id));
      return r as unknown as {
        id: string;
        status: string;
        txHash: string | null;
        rawResponseMeta: { lateSettlement?: Record<string, unknown> } | null;
      };
    };
    const corrections = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after, reason FROM correction_log WHERE subject_type = 'purchase' AND subject_id = ${id} ORDER BY created_at, id`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { before: unknown; after: unknown; reason: string }[];
    };
    const run = (
      readers: Readers & { lanes?: import("@/lib/settlements/recover-late").ChainReadLaneKey[]; chainReadLimit?: number },
    ) =>
      late.recoverLateSettlements({
        ...readers,
        chainReadBudgetMs: 0,
        celoChainReadBudgetMs: 0,
        bnbChainReadBudgetMs: 0,
        arbitrumChainReadBudgetMs: 0,
        avalancheChainReadBudgetMs: 0,
        tempoChainReadBudgetMs: 0,
        arcChainReadBudgetMs: 0,
        solanaChainReadBudgetMs: 0,
        lanes: readers.lanes ?? ["stellar"],
        chainReadLimit: readers.chainReadLimit,
      });
    const transfer = (hash: string, blockTime: string) => ({
      txHash: hash,
      from: PAYER,
      to: PAY_TO,
      value: AMOUNT,
      blockTime,
    });

    await t.test("1: 窓の中の transfer で settle_claimed に貼る", async () => {
      await reset();
      const id = await seedRow();
      const hash = randomBytes(32).toString("hex");
      const bt = new Date(AT.getTime() + 20_000).toISOString();
      const s = await run({
        readTransfers: async (q) => (q.network === STELLAR ? [transfer(hash, bt)] : null),
      });
      assert.equal(s.recoveredFromChainStellar, 1);
      const r = await read(id);
      assert.equal(r.status, "settle_claimed");
      assert.equal(r.txHash, hash);
      assert.equal(r.rawResponseMeta?.lateSettlement?.source, "chain_read");
      const log = await corrections(id);
      assert.equal(log.length, 1);
      assert.deepEqual(log[0].after, { status: "settle_claimed", txHash: hash });
    });

    await t.test("2: 窓の外の transfer では直らない", async () => {
      await reset();
      const id = await seedRow();
      const hash = randomBytes(32).toString("hex");
      const bt = new Date(AT.getTime() + 2 * 3600_000).toISOString();
      assert.equal((await run({ readTransfers: async () => [transfer(hash, bt)] })).recovered, 0);
      assert.equal((await read(id)).txHash, null);
    });

    await t.test("3: 同額の行が 2 つ・transfer 1 本なら 1 行だけ貼る", async () => {
      await reset();
      const ep = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: ep,
        resourceKey: `stellar.example/${ep}`,
        resourceUrl: `https://stellar.example/${ep}`,
        method: "GET",
        payTo: PAY_TO,
        network: STELLAR,
        status: "active",
        lastSeenAt: new Date(),
      });
      const a = await seedRow({ endpointId: ep, at: AT });
      const b = await seedRow({ endpointId: ep, at: new Date(AT.getTime() + 40 * 60_000) });
      const hash = randomBytes(32).toString("hex");
      const bt = new Date(AT.getTime() + 20_000).toISOString();
      const s = await run({ readTransfers: async () => [transfer(hash, bt)] });
      assert.equal(s.recovered, 1);
      const rows = await Promise.all([read(a), read(b)]);
      const withTx = rows.filter((r) => r.txHash === hash);
      assert.equal(withTx.length, 1);
      assert.equal(withTx[0].id, a, "先に確定した a だけが tx を持つ");
      assert.equal((await read(a)).txHash, hash);
      assert.equal((await read(b)).txHash, null);
    });

    await t.test("6: settled が持つ tx は失敗行に貼らない（settled も変えない）", async () => {
      await reset();
      const hash = randomBytes(32).toString("hex");
      const bt = new Date(AT.getTime() + 20_000).toISOString();
      const settledId = await seedRow({ status: "settled", txHash: hash, at: new Date(AT.getTime() - 16_000) });
      const failedId = await seedRow();
      const settledBefore = await read(settledId);
      await run({ readTransfers: async () => [transfer(hash, bt)] });
      assert.equal((await read(failedId)).txHash, null);
      const settledAfter = await read(settledId);
      assert.deepEqual({ status: settledAfter.status, txHash: settledAfter.txHash }, { status: settledBefore.status, txHash: hash });
    });

    await t.test("7: 同じ組の 2 行の窓が両方とも tx を含むとき、どちらにも貼らない", async () => {
      await reset();
      const ep = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: ep,
        resourceKey: `stellar.example/${ep}`,
        resourceUrl: `https://stellar.example/${ep}`,
        method: "GET",
        payTo: PAY_TO,
        network: STELLAR,
        status: "active",
        lastSeenAt: new Date(),
      });
      const a = await seedRow({ endpointId: ep, at: AT });
      const b = await seedRow({ endpointId: ep, at: new Date(AT.getTime() + 25 * 60_000) });
      const hash = randomBytes(32).toString("hex");
      const bt = new Date(AT.getTime() + 25 * 60_000).toISOString();
      const s = await run({ readTransfers: async () => [transfer(hash, bt)] });
      assert.equal(s.recovered, 0);
      assert.equal((await read(a)).txHash, null);
      assert.equal((await read(b)).txHash, null);
    });

    await t.test("8: 一意索引の競合 — linkErrors が 1、貼れた行だけ tx を持つ", async () => {
      await reset();
      const ep = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: ep,
        resourceKey: `stellar.example/${ep}`,
        resourceUrl: `https://stellar.example/${ep}`,
        method: "GET",
        payTo: PAY_TO,
        network: STELLAR,
        status: "active",
        lastSeenAt: new Date(),
      });
      const a = await seedRow({ endpointId: ep, at: AT });
      const b = await seedRow({ endpointId: ep, at: new Date(AT.getTime() + 10_000) });
      const hash = randomBytes(32).toString("hex");
      const how = "read from the chain (the transfer was not in our index)";
      const mk = (purchaseId: string) => ({ purchaseId, txHash: hash, source: "chain_read", matchedBy: "unique", how });
      const beforeA = await read(a);
      const beforeB = await read(b);
      const errors = { count: 0 };
      // 決定的にする（点検 3 回目）: a を貼った取引を確定せずに持ち、その間に別の接続で b を貼りに行く。
      // b は a の未確定の書き込みが見えないので重複の確かめを通り、一意索引の手前で待つ。a を確定すると b は一意索引の違反になる。
      let bDone: Promise<unknown> | null = null;
      await db.transaction(async (tx) => {
        await late.linkOneLatePurchase(tx as unknown as typeof db, mk(a), errors);
        bDone = late.linkOneLatePurchase(db, mk(b), errors);
        // b の文が送られ、一意索引の手前で待つまでの時間（a の取引を確定する前）。
        await new Promise((r) => setTimeout(r, 500));
      });
      await bDone;
      assert.equal(errors.count, 1);
      const rows = await Promise.all([read(a), read(b)]);
      const withTx = rows.filter((r) => r.txHash === hash);
      assert.equal(withTx.length, 1);
      assert.equal(withTx[0].id, a, "先に確定した a だけが tx を持つ");
      assert.equal(rows.filter((r) => r.txHash === null).length, 1);
      const loser = rows.find((r) => r.txHash === null)!;
      const untouched = loser.id === a ? beforeA : beforeB;
      assert.deepEqual({ status: loser.status, txHash: loser.txHash }, { status: untouched.status, txHash: untouched.txHash });
    });

    await t.test("4: 2 回目は何も変わらない", async () => {
      await reset();
      const id = await seedRow();
      const hash = randomBytes(32).toString("hex");
      const bt = new Date(AT.getTime() + 20_000).toISOString();
      const reader = async () => [transfer(hash, bt)];
      assert.equal((await run({ readTransfers: reader })).recovered, 1);
      assert.equal((await run({ readTransfers: reader })).recovered, 0);
      assert.equal((await read(id)).txHash, hash);
    });

    await t.test("5: lanes に stellar が無い回は変えない", async () => {
      await reset();
      const id = await seedRow();
      const before = await read(id);
      const hash = randomBytes(32).toString("hex");
      const s = await run({
        readTransfers: async () => [transfer(hash, new Date(AT.getTime() + 20_000).toISOString())],
        lanes: ["tempo", "arc", "solana"],
      });
      assert.equal(s.recovered, 0);
      assert.deepEqual(await read(id), before);
    });

    const lane = late.CHAIN_READ_LANES.find((l) => l.key === "stellar");
    assert.deepEqual(
      [lane?.networks, lane?.nonceBound, lane?.rowWindows, lane?.windowBackMinutes, lane?.zeroReadsToDecide],
      [[STELLAR], false, true, 0.25, 2],
    );
    assert.equal(late.STELLAR_CHAIN_READ_BUDGET_MS, 30_000);

    await reset();
  });
}