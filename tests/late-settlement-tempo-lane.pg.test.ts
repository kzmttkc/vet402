// ============================================================
// Tempo の遅延回収のレーン（2026-11-03・recover-late.ts の TEMPO_CHAIN_READ_LANE）。
//
// 数字の監査（2026-11-03・結論 #1）: Tempo の settle_failed 32 行を全数走査すると、10 行（$0.233）は TransferWithMemo の
// memo が行の auth_nonce と一致する着金を持っていた（fal.mpp.tempo.xyz・goflightlabs・orthogonal。応答なし・502）。
// Tempo の一回性の値は TIP-20 の memo（bytes32・auth_nonce）。「memo が使われたか」を問う関数は無い。
//
// 守ること:
//  1. 候補の tx のレシートの memo（NonceReader）が行の auth_nonce と一致すれば貼る。額・宛先・時刻が合っても memo が違えば貼らない。
//  2. 0 件の読みは 1 回では決めない: 1 回目は decided: false・zeroReads 1。別の回の 2 回目が 0 件で decided: true。
//  3. 着金はあったが貼れなかった行は decided: false・tries +1（上限まで読み直す・zeroReads は増えない）。
//  4. 読めない（null・例外）・読み手が無い・lanes に tempo が無い回は 1 文字も変えない。
//  5. 旧い行（memo の形でない auth_nonce）は選ばない。
// Run: TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-tempo-lane.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement tempo lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const PAY_TO = "0x7d1f3a9c5b2e8d4f6a0c1b3e5d7f9a2c4e6b8d0f";
  const TEMPO = "eip155:4217";
  const AMOUNT = "35000";
  /** 本番の 2084c653（fal.mpp.tempo.xyz/fal-ai/stable-diffusion-v35-large・09-30 00:00:25Z・AbortError・35,000）と同じ形。 */
  const AT = new Date("2026-09-30T00:00:25Z");
  /** MPP の帰属 memo（0x + 64 桁）。 */
  const memo = (b: string) => `0x${b.repeat(32)}`;
  const tx = (b: string) => `0x${b.repeat(32)}`;

  type Late = typeof import("@/lib/settlements/recover-late");
  type Readers = Pick<Parameters<Late["recoverLateSettlements"]>[0] & object, "readTransfers" | "readNonces" | "readAuthorizationState">;
  type Mark = { decided?: boolean; tries?: number; zeroReads?: number; zeroReadAt?: string; exactTransfers?: number; by?: string };

  test("recover-late: Tempo のレーンは memo で貼り、0 件は 2 回で決める", async (t) => {
    const late: Late = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);
    const seedRow = async (over: { nonce?: string | null; at?: Date; http?: number | null } = {}) => {
      const endpointId = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `fal.mpp.tempo.example/${endpointId}`,
        resourceUrl: `https://fal.mpp.tempo.example/${endpointId}`,
        method: "POST",
        payTo: PAY_TO,
        network: TEMPO,
        status: "active",
        lastSeenAt: new Date(),
      });
      const id = randomUUID();
      await db.insert(schema.x402L1Purchases).values({
        id,
        endpointId,
        resourceKey: `fal.mpp.tempo.example/${endpointId}`,
        network: TEMPO,
        status: "settle_failed",
        attemptedAt: over.at ?? AT,
        payer: PAYER,
        payTo: PAY_TO,
        amountUnits: AMOUNT,
        spentUnits: AMOUNT,
        authNonce: over.nonce === undefined ? memo("a1") : over.nonce,
        httpStatusPaid: over.http === undefined ? null : over.http,
        rawResponseMeta: { phase: "paid", status: over.http ?? null, protocol: "mpp" },
      } as never);
      return id;
    };
    const read = async (id: string) => {
      const [r] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id));
      return r as unknown as { status: string; txHash: string | null; settlementVerified: boolean | null; rawResponseMeta: { lateChainRead?: Mark; lateSettlement?: Record<string, unknown>; protocol?: string } | null };
    };
    const corrections = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after, reason FROM correction_log WHERE subject_type = 'purchase' AND subject_id = ${id} ORDER BY created_at, id`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { before: unknown; after: unknown; reason: string }[];
    };
    const run = (readers: Readers & { chainReadLimit?: number; lanes?: import("@/lib/settlements/recover-late").ChainReadLaneKey[] }) =>
      late.recoverLateSettlements({ ...readers, chainReadBudgetMs: 0, celoChainReadBudgetMs: 0, bnbChainReadBudgetMs: 0, arbitrumChainReadBudgetMs: 0, avalancheChainReadBudgetMs: 0 });
    const transfer = (over: Partial<import("@/lib/settlements/recover-late").ChainTransfer> = {}) => ({
      txHash: tx("c1"),
      from: PAYER,
      to: PAY_TO,
      value: AMOUNT,
      blockTime: new Date(AT.getTime() + 9_000).toISOString(),
      ...over,
    });
    const noLogs: Readers["readTransfers"] = async (q) => (q.network === TEMPO ? [] : null);
    const memosOf = (byTx: Record<string, string[] | null>): Readers["readNonces"] => async (q) => {
      const hit = byTx[q.txHash.toLowerCase()];
      return hit === undefined ? [] : hit;
    };

    await t.test("1: 応答なし・9 秒後に memo つきの着金 → memo の合う tx を貼る。訂正ログは settlement_backfill", async () => {
      await reset();
      const id = await seedRow();
      const calls: Parameters<NonNullable<Readers["readTransfers"]>>[0][] = [];
      const nonceCalls: { network: string; txHash: string; payer: string; payTo?: string }[] = [];
      const s = await run({
        readTransfers: async (q) => (calls.push(q), q.network === TEMPO ? [transfer()] : null),
        readNonces: async (q) => (nonceCalls.push(q), q.txHash === tx("c1") ? [memo("a1")] : []),
      });
      assert.equal(s.recoveredFromChainTempo, 1);
      assert.equal(s.chainRowsReadTempo, 1);
      assert.deepEqual(s.links, [{ purchaseId: id, txHash: tx("c1") }]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].network, TEMPO);
      assert.equal(calls[0].payer, PAYER);
      assert.equal(calls[0].payTo, PAY_TO);
      assert.ok(calls[0].from.getTime() <= AT.getTime() - 2 * 60_000 && calls[0].to.getTime() >= AT.getTime() + 30 * 60_000);
      assert.deepEqual(nonceCalls, [{ network: TEMPO, txHash: tx("c1"), payer: PAYER, payTo: PAY_TO }]);
      const linked = await read(id);
      assert.equal(linked.status, "settle_claimed");
      assert.equal(linked.txHash, tx("c1"));
      assert.equal(linked.settlementVerified, null);
      assert.equal(linked.rawResponseMeta?.protocol, "mpp", "元の raw_response_meta を壊さない");
      assert.equal(linked.rawResponseMeta?.lateSettlement?.source, "chain_read");
      assert.equal(linked.rawResponseMeta?.lateSettlement?.matchedBy, "authorization_nonce");
      const log = await corrections(id);
      assert.equal(log.length, 1);
      assert.deepEqual(log[0].before, { status: "settle_failed", txHash: null });
      assert.deepEqual(log[0].after, { status: "settle_claimed", txHash: tx("c1") });
      assert.equal(log[0].reason, "settlement_backfill");
      // 二度目は読まない。
      const again = await run({ readTransfers: async (q) => (calls.push(q), [transfer()]), readNonces: memosOf({ [tx("c1")]: [memo("a1")] }) });
      assert.equal(again.recovered, 0);
      assert.equal(calls.length, 1);
    });

    await t.test("2: 額・宛先・時刻が合っても memo が違えば貼らない（着金ありの印・tries で読み直す・zeroReads は増えない）", async () => {
      for (const [name, memos] of [
        ["レシートに TransferWithMemo が無い", []],
        ["別の memo（同じ売り手への別の購入の tx）", [memo("ff")]],
      ] as const) {
        await reset();
        const id = await seedRow();
        const s = await run({ readTransfers: async () => [transfer()], readNonces: memosOf({ [tx("c1")]: [...memos] }) });
        assert.equal(s.recovered, 0, name);
        const r = await read(id);
        assert.equal(r.status, "settle_failed", name);
        assert.equal(r.txHash, null, name);
        assert.equal((await corrections(id)).length, 0, name);
        const m = r.rawResponseMeta?.lateChainRead;
        assert.deepEqual({ decided: m?.decided, tries: m?.tries, zeroReads: m?.zeroReads, exact: m?.exactTransfers }, { decided: false, tries: 1, zeroReads: 0, exact: 1 }, name);
      }
      await reset();
      const id = await seedRow();
      let reads = 0;
      for (let i = 0; i < 5; i++) await run({ readTransfers: async () => (reads++, [transfer()]), readNonces: memosOf({ [tx("c1")]: [memo("ff")] }) });
      assert.equal(reads, late.CHAIN_READ_MAX_TRIES);
      assert.equal((await read(id)).txHash, null);
    });

    await t.test("3: 0 件の読みは 1 回では決めない。12 時間以上あいた別の回の 2 回目が 0 件で決まる", async () => {
      await reset();
      const id = await seedRow({ http: 502 });
      let reads = 0;
      const reader: Readers["readTransfers"] = async (q) => (q.network === TEMPO ? (reads++, []) : null);
      const first = await run({ readTransfers: reader, readNonces: memosOf({}) });
      assert.equal(first.chainRowsReadTempo, 1);
      let m = (await read(id)).rawResponseMeta?.lateChainRead;
      assert.deepEqual({ decided: m?.decided, tries: m?.tries, zeroReads: m?.zeroReads }, { decided: false, tries: 1, zeroReads: 1 });
      assert.ok(typeof m?.zeroReadAt === "string" && Number.isFinite(Date.parse(m.zeroReadAt)));
      // 同じ日のうちは読み直さない（同じ日の 2 回の 0 件を「別の回」と数えない）。
      await run({ readTransfers: reader, readNonces: memosOf({}) });
      assert.equal(reads, 1);
      /** 前回の 0 件を ZERO_READ_SPACING_HOURS + 1 時間前に動かす（別の日の回を作る）。 */
      const ageZeroRead = (rowId: string) =>
        db.execute(sql`UPDATE x402_l1_purchases SET raw_response_meta = jsonb_set(raw_response_meta, '{lateChainRead,zeroReadAt}',
          to_jsonb(to_char((now() - make_interval(hours => ${late.ZERO_READ_SPACING_HOURS + 1}::int)) AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE id = ${rowId}::uuid`);
      // 2 回目に着金が見つかれば（1 回目の 0 件が RPC の取りこぼしだった）貼る。
      await reset();
      const flaky = await seedRow();
      await run({ readTransfers: reader, readNonces: memosOf({}) });
      await ageZeroRead(flaky);
      const s2 = await run({ readTransfers: async () => [transfer()], readNonces: memosOf({ [tx("c1")]: [memo("a1")] }) });
      assert.deepEqual(s2.links, [{ purchaseId: flaky, txHash: tx("c1") }]);
      // 2 回とも 0 件なら決まり、3 回目は読まない。
      await reset();
      const none = await seedRow({ http: 502 });
      reads = 0;
      await run({ readTransfers: reader, readNonces: memosOf({}) });
      await ageZeroRead(none);
      await run({ readTransfers: reader, readNonces: memosOf({}) });
      m = (await read(none)).rawResponseMeta?.lateChainRead;
      assert.deepEqual({ decided: m?.decided, tries: m?.tries, zeroReads: m?.zeroReads }, { decided: true, tries: 2, zeroReads: 2 });
      await ageZeroRead(none);
      await run({ readTransfers: reader, readNonces: memosOf({}) });
      assert.equal(reads, 2);
      assert.equal((await read(none)).status, "settle_failed");
      assert.equal((await corrections(none)).length, 0);
    });

    await t.test("4: 読めない・読み手が無い・lanes に tempo が無い回は行を変えない", async () => {
      const cases: [string, Parameters<typeof run>[0]][] = [
        ["Transfer が null（TEMPO_RPC_URL なし）", { readTransfers: async () => null, readNonces: memosOf({ [tx("c1")]: [memo("a1")] }) }],
        ["Transfer の読みが例外", { readTransfers: async () => { throw new Error("rpc down"); }, readNonces: memosOf({}) }],
        ["レシートが読めない（null）", { readTransfers: async () => [transfer()], readNonces: async () => null }],
        ["レシートの読みが例外", { readTransfers: async () => [transfer()], readNonces: async () => { throw new Error("rpc down"); } }],
        ["memo の読み手が無い", { readTransfers: async () => [transfer()] }],
        ["lanes に tempo が無い", { readTransfers: async () => [transfer()], readNonces: memosOf({ [tx("c1")]: [memo("a1")] }), lanes: ["base", "celo", "bnb", "arbitrum", "avalanche"] }],
      ];
      for (const [name, readers] of cases) {
        await reset();
        const id = await seedRow();
        const before = await read(id);
        const s = await run(readers);
        assert.equal(s.recovered, 0, name);
        assert.equal(s.chainRowsReadTempo, 0, name);
        assert.deepEqual(await read(id), before, name);
        assert.equal((await corrections(id)).length, 0, name);
      }
    });

    await t.test("5: memo の形でない auth_nonce・署名していない行・窓が閉じていない行は選ばない", async () => {
      const cases: [string, Parameters<typeof seedRow>[0]][] = [
        ["auth_nonce なし", { nonce: null }],
        ["Solana の memo の形（0x 無し 32 桁）", { nonce: "ab".repeat(16) }],
        ["窓が閉じていない（直近 5 分）", { at: new Date(Date.now() - 5 * 60_000) }],
      ];
      for (const [name, over] of cases) {
        await reset();
        const id = await seedRow(over);
        const before = await read(id);
        let reads = 0;
        const s = await run({ readTransfers: async () => (reads++, [transfer()]), readNonces: memosOf({ [tx("c1")]: [memo("a1")] }) });
        assert.equal(s.recovered, 0, name);
        assert.equal(reads, 0, name);
        assert.deepEqual(await read(id), before, name);
      }
      const lane = late.CHAIN_READ_LANES.find((l) => l.key === "tempo");
      assert.deepEqual([lane?.networks, lane?.nonceBound, lane?.noAnswerFirst, lane?.rowWindows, lane?.decidesByAuthorizationState ?? false, lane?.zeroReadsToDecide], [[TEMPO], true, true, true, false, 2]);
      assert.equal(late.TEMPO_CHAIN_READ_BUDGET_MS, 30_000);
    });

    await reset();
  });
}
