// ============================================================
// BNB の遅延回収のレーン（2026-11-02・recover-late.ts の BNB_CHAIN_READ_LANE）。
//
// 本番で起きたこと: 応答なしで settle_failed になった行のうち 14 行は、売り手が後で決済していた。公開 RPC の eth_getLogs は
// 同じ範囲に 406 件と 0 件を返し分けるので、ログの 0 件で「着金なし」と決めると、実在の着金を永久に見落とす。
//
// 守ること:
//  1. nonce が receipt で一致すれば貼る。
//  2. ログが 0 件でも、認可が使われた行は確定しない（decided: false・tries は増やさない・次の回に読み直す）。
//     読めない行は 1 文字も変えない。
//  3. 認可が使われていない行だけ decided: true の印を付ける。ログの読み手が例外を投げても決まる。
//  4. 認可の読み手が無ければ何も決めない。
//  5. 額が合う別の着金があっても、nonce が違えば貼らない。
// Run: TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-bnb-lane.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement bnb lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const PAY_TO = "0x50ab2018c06c6e4eaa9ba52057eb55ed284912fc";
  const BNB = "eip155:56";
  const AMOUNT = "80000";
  const AT = new Date("2026-10-23T00:01:50Z");
  const nonce = (b: string) => `0x${b.repeat(32)}`;
  const tx = (b: string) => `0x${b.repeat(32)}`;

  type Late = typeof import("@/lib/settlements/recover-late");
  type Readers = Pick<Parameters<Late["recoverLateSettlements"]>[0] & object, "readTransfers" | "readNonces" | "readAuthorizationState">;

  test("recover-late: BNB のレーンは認可の状態で決める", async (t) => {
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
        resourceKey: `bnb.example/${endpointId}`,
        resourceUrl: `https://bnb.example/${endpointId}`,
        method: "GET",
        payTo: PAY_TO,
        network: BNB,
        status: "active",
        lastSeenAt: new Date(),
      });
      const id = randomUUID();
      await db.insert(schema.x402L1Purchases).values({
        id,
        endpointId,
        resourceKey: `bnb.example/${endpointId}`,
        network: BNB,
        status: "settle_failed",
        attemptedAt: at,
        payer: PAYER,
        payTo: PAY_TO,
        amountUnits: AMOUNT,
        authNonce: n,
      } as never);
      return id;
    };
    const read = async (id: string) => {
      const [r] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id));
      return r as unknown as { status: string; txHash: string | null; rawResponseMeta: { lateChainRead?: { decided?: boolean; by?: string; tries?: number } } | null };
    };
    const run = (readers: Readers & { chainReadLimit?: number }) => late.recoverLateSettlements({ ...readers, chainReadBudgetMs: 0, celoChainReadBudgetMs: 0, arbitrumChainReadBudgetMs: 0, avalancheChainReadBudgetMs: 0 });
    const noLogs: Readers["readTransfers"] = async (q) => (q.network === BNB ? [] : null);
    const noNonces: Readers["readNonces"] = async () => [];

    await t.test("ログが 0 件でも、使われた認可の行は確定しない", async () => {
      await reset();
      const id = await seedRow(nonce("a1"));
      for (let i = 0; i < 2; i++) {
        const summary = await run({ readTransfers: noLogs, readNonces: noNonces, readAuthorizationState: async () => true });
        assert.equal(summary.chainRowsUnreadBnb, 1);
        assert.equal(summary.chainRowsReadBnb, 0);
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
          if (q.network !== BNB) return null;
          transferReads++;
          throw new Error("HTTP 403: archive");
        },
        readNonces: noNonces,
        readAuthorizationState: async (q) => q.nonce !== nonce("d1"),
      });
      assert.equal((await read(unused)).rawResponseMeta?.lateChainRead?.decided, true);
      const u = await read(used);
      assert.equal(u.rawResponseMeta?.lateChainRead?.decided, false);
      assert.equal(u.txHash, null);
      assert.equal(transferReads, 1, "使われていない行のためにログを読まない");
    });

    await t.test("使われた認可の行は未読の行の後ろに回る", async () => {
      await reset();
      const stuck = await seedRow(nonce("e1"));
      const fresh = await seedRow(nonce("e2"), new Date(AT.getTime() - 86_400_000));
      await run({ readTransfers: noLogs, readNonces: noNonces, readAuthorizationState: async () => true, chainReadLimit: 1 });
      assert.equal((await read(stuck)).rawResponseMeta?.lateChainRead?.decided, false);
      assert.equal((await read(fresh)).rawResponseMeta?.lateChainRead, undefined);
      await run({ readTransfers: noLogs, readNonces: noNonces, readAuthorizationState: async () => true, chainReadLimit: 1 });
      assert.equal((await read(fresh)).rawResponseMeta?.lateChainRead?.decided, false);
    });

    await t.test("読めない認可の行は変えない", async () => {
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
    });

    await t.test("認可の読み手が無ければ何も決めない", async () => {
      await reset();
      const id = await seedRow(nonce("a3"));
      const before = await read(id);
      await run({ readTransfers: noLogs, readNonces: noNonces });
      assert.deepEqual(await read(id), before);
    });

    await t.test("使われていない認可の行だけ decided: true", async () => {
      await reset();
      const unused = await seedRow(nonce("a4"));
      const used = await seedRow(nonce("a5"), new Date(AT.getTime() + 86_400_000));
      const seen: { nonce: string; network: string; payer: string }[] = [];
      await run({
        readTransfers: noLogs,
        readNonces: noNonces,
        readAuthorizationState: async (q) => {
          seen.push(q);
          return q.nonce === nonce("a4") ? false : true;
        },
      });
      const r = await read(unused);
      assert.equal(r.rawResponseMeta?.lateChainRead?.decided, true);
      assert.equal(r.rawResponseMeta?.lateChainRead?.by, "authorization_state");
      assert.equal(r.status, "settle_failed");
      assert.equal(r.txHash, null);
      assert.equal((await read(used)).rawResponseMeta?.lateChainRead?.decided, false);
      assert.ok(seen.every((q) => q.network === BNB && q.payer === PAYER));
      // 決まった行は次の回に読まない。
      const again: string[] = [];
      await run({
        readTransfers: noLogs,
        readNonces: noNonces,
        readAuthorizationState: async (q) => {
          again.push(q.nonce);
          return true;
        },
      });
      assert.deepEqual(again, [nonce("a5")]);
    });

    await t.test("nonce が一致すれば貼り、別の着金の行は貼らない", async () => {
      await reset();
      const hit = await seedRow(nonce("b1"));
      const miss = await seedRow(nonce("b2"));
      const transfer = { txHash: tx("c1"), from: PAYER, to: PAY_TO, value: AMOUNT, blockTime: new Date(AT.getTime() + 15_000).toISOString() };
      await run({
        readTransfers: async (q) => (q.network === BNB ? [transfer] : null),
        readNonces: async () => [nonce("b1")],
        readAuthorizationState: async (q) => q.nonce === nonce("b1"),
      });
      const linked = await read(hit);
      assert.equal(linked.txHash?.toLowerCase(), tx("c1"));
      const other = await read(miss);
      assert.equal(other.txHash, null);
      assert.equal(other.rawResponseMeta?.lateChainRead?.decided, true);
    });

    await reset();
  });
}
