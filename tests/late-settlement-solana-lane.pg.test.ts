// ============================================================
// Solana の遅延回収のレーン（2026-11-03・recover-late.ts の SOLANA_CHAIN_READ_LANE）。
//
// 数字の監査（2026-11-03・結論 #1）: travel.brij.fi/air/search（09-22 00:00:07Z・応答なし・100,000）は、チェーン上で
// spl-memo に行の auth_nonce を載せた着金を持っていた。Solana の一回性の値は我々の memo（randomBytes(16).hex・0x 無し 32 桁）。
//
// 守ること:
//  1. 候補の取引の memo（NonceReader）に行の auth_nonce があれば貼る。無ければ貼らない。
//  2. tx hash は base58 の署名（大文字小文字で別）。貼る tx は読み手が返した表記のまま。
//  3. 0 件の読みは 2 回で決める（Tempo と同じ）。読めない・読み手が無い・lanes に solana が無い回は変えない。
//  4. EIP-3009 の形の auth_nonce（EVM の行）は選ばない。
// Run: TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-solana-lane.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement solana lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const PAYER = "7Vz5aYk4F3bC9dE2fG6hJ8kL1mN3pQ5rS7tU9vW2xY4z";
  const PAY_TO = "4Nq8bYc2DdE3fF5gG7hH9jJ1kK3lL5mM7nN9oO2pP4qQ";
  const AMOUNT = "100000";
  const AT = new Date("2026-09-22T00:00:07Z");
  const MEMO = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const OTHER_MEMO = "ffffffffffffffffffffffffffffffff";
  const SIG = "5KtPn1LGuxhFqnXG3cJaqbSMVsHzNjqBW7wZ2x8kE3u9eQ1x4vYdL7mRcT2sA6bH9pF3gJ5kN8qW1rV4tY7uZ3mD";

  type Late = typeof import("@/lib/settlements/recover-late");
  type Readers = Pick<Parameters<Late["recoverLateSettlements"]>[0] & object, "readTransfers" | "readNonces">;
  type Mark = { decided?: boolean; tries?: number; zeroReads?: number };

  test("recover-late: Solana のレーンは memo で貼る", async (t) => {
    const late: Late = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);
    const seedRow = async (over: { nonce?: string | null; at?: Date } = {}) => {
      const endpointId = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `travel.brij.example/${endpointId}`,
        resourceUrl: `https://travel.brij.example/${endpointId}`,
        method: "GET",
        payTo: PAY_TO,
        network: SOLANA,
        status: "active",
        lastSeenAt: new Date(),
      });
      const id = randomUUID();
      await db.insert(schema.x402L1Purchases).values({
        id,
        endpointId,
        resourceKey: `travel.brij.example/${endpointId}`,
        network: SOLANA,
        status: "settle_failed",
        attemptedAt: over.at ?? AT,
        payer: PAYER,
        payTo: PAY_TO,
        amountUnits: AMOUNT,
        spentUnits: AMOUNT,
        authNonce: over.nonce === undefined ? MEMO : over.nonce,
        httpStatusPaid: null,
        rawResponseMeta: { phase: "paid", status: null, transportFailure: { side: "seller_or_path", code: null } },
      } as never);
      return id;
    };
    const read = async (id: string) => {
      const [r] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id));
      return r as unknown as { status: string; txHash: string | null; rawResponseMeta: { lateChainRead?: Mark; lateSettlement?: Record<string, unknown> } | null };
    };
    const corrections = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after, reason FROM correction_log WHERE subject_type = 'purchase' AND subject_id = ${id} ORDER BY created_at, id`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { before: unknown; after: unknown; reason: string }[];
    };
    const run = (readers: Readers & { lanes?: import("@/lib/settlements/recover-late").ChainReadLaneKey[] }) =>
      late.recoverLateSettlements({ ...readers, chainReadBudgetMs: 0, celoChainReadBudgetMs: 0, bnbChainReadBudgetMs: 0, arbitrumChainReadBudgetMs: 0, avalancheChainReadBudgetMs: 0, tempoChainReadBudgetMs: 0, arcChainReadBudgetMs: 0 });
    const transfer = () => ({ txHash: SIG, from: PAYER, to: PAY_TO, value: AMOUNT, blockTime: new Date(AT.getTime() + 2_000).toISOString() });

    await t.test("1: memo が一致すれば貼る。読み手には base58 を表記のまま渡し、tx も表記のまま貼る", async () => {
      await reset();
      const id = await seedRow();
      const calls: { payer: string; payTo: string; network: string }[] = [];
      const nonceCalls: { txHash: string }[] = [];
      const s = await run({
        readTransfers: async (q) => (calls.push({ payer: q.payer, payTo: q.payTo, network: q.network }), q.network === SOLANA ? [transfer()] : null),
        readNonces: async (q) => (nonceCalls.push({ txHash: q.txHash }), q.txHash === SIG ? ["vet402", MEMO] : []),
      });
      assert.equal(s.recoveredFromChainSolana, 1);
      assert.deepEqual(calls, [{ payer: PAYER, payTo: PAY_TO, network: SOLANA }]);
      assert.deepEqual(nonceCalls, [{ txHash: SIG }]);
      const r = await read(id);
      assert.equal(r.status, "settle_claimed");
      assert.equal(r.txHash, SIG, "署名は表記のまま（小文字化しない）");
      assert.equal(r.rawResponseMeta?.lateSettlement?.matchedBy, "authorization_nonce");
      const log = await corrections(id);
      assert.equal(log.length, 1);
      assert.deepEqual(log[0].after, { status: "settle_claimed", txHash: SIG });
    });

    await t.test("2: 額・宛先・時刻が合っても memo が違えば貼らない", async () => {
      await reset();
      const id = await seedRow();
      const s = await run({ readTransfers: async () => [transfer()], readNonces: async () => [OTHER_MEMO] });
      assert.equal(s.recovered, 0);
      const r = await read(id);
      assert.equal(r.txHash, null);
      assert.equal(r.rawResponseMeta?.lateChainRead?.decided, false);
      assert.equal((await corrections(id)).length, 0);
    });

    await t.test("3: 0 件は 2 回で決める。読めない・読み手が無い・lanes に solana が無い回は変えない", async () => {
      await reset();
      const id = await seedRow();
      let reads = 0;
      const none: Readers["readTransfers"] = async (q) => (q.network === SOLANA ? (reads++, []) : null);
      await run({ readTransfers: none, readNonces: async () => [] });
      const m = (await read(id)).rawResponseMeta?.lateChainRead;
      assert.deepEqual({ decided: m?.decided, zeroReads: m?.zeroReads, tries: m?.tries }, { decided: false, zeroReads: 1, tries: 1 });
      await run({ readTransfers: none, readNonces: async () => [] });
      assert.equal((await read(id)).rawResponseMeta?.lateChainRead?.decided, true);
      await run({ readTransfers: none, readNonces: async () => [] });
      assert.equal(reads, 2);
      const cases: [string, Parameters<typeof run>[0]][] = [
        ["Transfer が null（SOLANA_RPC_URL なし）", { readTransfers: async () => null, readNonces: async () => [MEMO] }],
        ["署名一覧が読み切れない（例外）", { readTransfers: async () => { throw new Error("page limit"); }, readNonces: async () => [MEMO] }],
        ["取引の memo が読めない（null）", { readTransfers: async () => [transfer()], readNonces: async () => null }],
        ["memo の読み手が無い", { readTransfers: async () => [transfer()] }],
        ["lanes に solana が無い", { readTransfers: async () => [transfer()], readNonces: async () => [MEMO], lanes: ["base", "celo", "bnb", "arbitrum", "avalanche", "tempo", "arc"] }],
      ];
      for (const [name, readers] of cases) {
        await reset();
        const row = await seedRow();
        const before = await read(row);
        const s = await run(readers);
        assert.equal(s.recovered, 0, name);
        assert.equal(s.chainRowsReadSolana, 0, name);
        assert.deepEqual(await read(row), before, name);
      }
    });

    await t.test("4: EIP-3009 の形の auth_nonce・auth_nonce なしの行は選ばない", async () => {
      for (const [name, nonce] of [
        ["EVM の nonce の形", `0x${"ab".repeat(32)}`],
        ["auth_nonce なし", null],
      ] as const) {
        await reset();
        const id = await seedRow({ nonce });
        const before = await read(id);
        let reads = 0;
        await run({ readTransfers: async () => (reads++, [transfer()]), readNonces: async () => [MEMO] });
        assert.equal(reads, 0, name);
        assert.deepEqual(await read(id), before, name);
      }
      const lane = late.CHAIN_READ_LANES.find((l) => l.key === "solana");
      assert.deepEqual([lane?.networks, lane?.nonceBound, lane?.nonceShape, lane?.zeroReadsToDecide], [[SOLANA], true, "^[0-9a-f]{32}$", 2]);
      assert.equal(late.SOLANA_CHAIN_READ_BUDGET_MS, 30_000);
    });

    await reset();
  });
}
