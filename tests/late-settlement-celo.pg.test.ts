// ============================================================
// 遅れて決済された Celo の購入の回収（2026-10-11・recover-late.ts の Celo のレーン）。
//
// 本番で起きたこと（2026-10-11 02:30:53 UTC・agent402.tools/api/skill/ssl-audit・0.006 USDC）: 支払い付きの要求が
// 20 秒で切れて応答なし＝ settle_failed・tx なし。売り手は 17 秒後に Celo で決済していた（tx 0x23421d63…2cd07a・
// AuthorizationUsed(購入元, nonce) と Transfer(購入元 → 0xabf4…a9d0, 6000) の 2 本）。索引は Base が先頭の出品の
// Celo の受取先を持たず、チェーンの直読みは Base の行しか選ばなかったので、台帳は「決済に失敗」のままだった。
//
// 守ること:
//  1. 署名して送った・応答なし・後でチェーンに着金がある → その行の nonce が tx で消費されていれば貼る。照合器が
//     settled にする。応答を受け取っていない行は、決済済みになっても「届いた」とは記録しない（Base と同じ）。
//  2. 額・宛先・払い元・時刻が合っても、その行の nonce が tx で消費されていなければ貼らない。
//  3. 額・宛先・払い元・窓のどれかが違えば貼らない（nonce を読みにも行かない）。
//  4. RPC が読めない（Transfer・レシートのどちらでも）・読み手が無いなら、行を 1 文字も変えない。
//  5. 署名していない行（auth_nonce なし・形の不正）は選ばない。Arc の行も選ばない（このレーンは Celo だけ）。
//  6. Base のレーンは変えない: Base の行の上限に Celo の行は数えず、Base の貼り方（nonce を読まない）も従来どおり。
// Run: TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-celo.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement celo (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  /** 購入元（EVM の共通の EOA）と、agent402.tools が Celo の accept で宣言する受取先。 */
  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const PAY_TO = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
  const OTHER_PAY_TO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
  const OTHER_PAYER = "0x902dcf34e53695bdea2ffb354b1a2e58bd598256";
  const CELO = "eip155:42220";
  const BASE = "eip155:8453";
  const ARC = "eip155:5042";
  const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const AMOUNT = "6000";
  /** 本番の行と同じ時刻の形: 試行 02:30:53、着金はその 17 秒後。 */
  const AT = new Date("2026-10-11T02:30:53Z");
  const SETTLED_AT = "2026-10-11T02:31:10.000Z";
  const nonce = (b: string) => `0x${b.repeat(32)}`;
  const tx = (b: string) => `0x${b.repeat(32)}`;
  const NONCE = nonce("bc");
  const OTHER_NONCE = nonce("33");

  type Late = typeof import("@/lib/settlements/recover-late");
  type TransferReader = import("@/lib/settlements/recover-late").TransferReader;
  type NonceReader = import("@/lib/settlements/recover-late").NonceReader;
  type ChainTransfer = import("@/lib/settlements/recover-late").ChainTransfer;

  test("recover-late: Celo のチェーン直読み（nonce で決める）", async (t) => {
    const late: Late = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);
    /** 出品は Base が先頭（本番の agent402.tools と同じ形）。Celo の受取先は索引（index-evm）の対象にならない。 */
    const seedEndpoint = async () => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `agent402.example/api/${id}`,
        resourceUrl: `https://agent402.example/api/${id}`,
        method: "POST",
        payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
        network: BASE,
        status: "active",
        lastSeenAt: new Date(),
      });
      return id;
    };
    /** 既定は本番の ssl-audit の行の形: 署名して送った（auth_nonce あり）・応答なし（HTTP なし）・settle_failed・tx なし。 */
    const seedRow = async (
      over: {
        network?: string;
        status?: string;
        attemptedAt?: Date;
        http?: number | null;
        tx?: string | null;
        nonce?: string | null;
        amount?: string;
        payTo?: string;
        meta?: unknown;
      } = {},
    ) => {
      const network = over.network ?? CELO;
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: await seedEndpoint(),
          status: over.status ?? "settle_failed",
          network,
          asset: network === CELO ? CELO_USDC : BASE_USDC,
          payTo: over.payTo ?? PAY_TO,
          payer: PAYER,
          amountUnits: over.amount ?? AMOUNT,
          spentUnits: over.amount ?? AMOUNT,
          attemptedAt: over.attemptedAt ?? AT,
          txHash: over.tx ?? null,
          httpStatusPaid: over.http === undefined ? null : over.http,
          payloadNonEmpty: false,
          l2Schema: "not_checked",
          authNonce: over.nonce === undefined ? NONCE : over.nonce,
          rawResponseMeta:
            over.meta === undefined ? { phase: "paid", status: null, transportFailure: { side: "seller_or_path", code: null } } : over.meta,
        })
        .returning();
      return row.id;
    };
    const get = async (id: string) => (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];
    const corrections = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after, reason FROM correction_log WHERE subject_type = 'purchase' AND subject_id = ${id} ORDER BY created_at, id`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { before: unknown; after: unknown; reason: string }[];
    };
    const transfer = (over: Partial<ChainTransfer> = {}): ChainTransfer => ({
      txHash: tx("23"),
      from: PAYER,
      to: PAY_TO,
      value: AMOUNT,
      blockTime: SETTLED_AT,
      ...over,
    });
    /** 呼ばれた回数と引数を残す読み手。 */
    const transfersOf = (list: ChainTransfer[] | null) => {
      const calls: Parameters<TransferReader>[0][] = [];
      const reader: TransferReader = async (q) => {
        calls.push(q);
        return list;
      };
      return { reader, calls };
    };
    /** tx → その tx で購入元が消費した nonce。表に無い tx は空（その tx は我々の認可を消費していない）。 */
    const noncesOf = (byTx: Record<string, string[] | null>) => {
      const calls: Parameters<NonceReader>[0][] = [];
      const reader: NonceReader = async (q) => {
        calls.push(q);
        const hit = byTx[q.txHash.toLowerCase()];
        return hit === undefined ? [] : hit;
      };
      return { reader, calls };
    };
    /** 行が 1 文字も変わっていないこと（status・tx・印・照合の跡）と、訂正ログが無いこと。 */
    const assertUntouched = async (id: string, before: Awaited<ReturnType<typeof get>>, why: string) => {
      const now = await get(id);
      assert.equal(now.status, before.status, why);
      assert.equal(now.txHash, before.txHash, why);
      assert.deepEqual(now.rawResponseMeta, before.rawResponseMeta, why);
      assert.equal(now.settlementVerified, before.settlementVerified, why);
      assert.equal((await corrections(id)).length, 0, why);
    };

    await t.test("1: 署名して送った・応答なし・17 秒後に着金 → nonce の合う tx を貼り、照合器が settled にする。届いたとは記録しない", async () => {
      await reset();
      const id = await seedRow();
      const tr = transfersOf([transfer()]);
      const nr = noncesOf({ [tx("23")]: [NONCE] });
      const s = await late.recoverLateSettlements({ readTransfers: tr.reader, readNonces: nr.reader });
      assert.equal(s.recovered, 1);
      assert.equal(s.recoveredFromChain, 1);
      assert.equal(s.recoveredFromChainCelo, 1);
      assert.equal(s.chainRowsReadCelo, 1);
      assert.deepEqual(s.links, [{ purchaseId: id, txHash: tx("23") }]);

      // 読み手への問い: Celo の network・行の払い元と宛先・窓は試行の 2 分前から 30 分後を含む。
      assert.equal(tr.calls.length, 1);
      assert.equal(tr.calls[0].network, CELO);
      assert.equal(tr.calls[0].payer, PAYER);
      assert.equal(tr.calls[0].payTo, PAY_TO);
      assert.ok(tr.calls[0].from.getTime() <= AT.getTime() - 2 * 60_000 && tr.calls[0].to.getTime() >= AT.getTime() + 30 * 60_000);
      assert.equal(typeof tr.calls[0].timeoutMs, "number");
      assert.deepEqual(nr.calls, [{ network: CELO, txHash: tx("23"), payer: PAYER }]);

      // 貼った行は照合前（settled とは名乗らない）。印は Base の直読みと同じ形で、決め手は nonce。
      const linked = await get(id);
      assert.equal(linked.status, "settle_claimed");
      assert.equal(linked.txHash, tx("23"));
      assert.equal(linked.settlementVerified, null);
      assert.equal(linked.httpStatusPaid, null);
      const meta = linked.rawResponseMeta as { phase?: string; transportFailure?: unknown; lateSettlement: Record<string, unknown> };
      assert.equal(meta.phase, "paid", "元の raw_response_meta を壊さない");
      assert.ok(meta.transportFailure, "応答が無かった印は残す");
      assert.equal(meta.lateSettlement.source, "chain_read");
      assert.equal(meta.lateSettlement.matchedBy, "authorization_nonce");
      assert.equal(meta.lateSettlement.priorStatus, "settle_failed");
      assert.equal(meta.lateSettlement.txHash, tx("23"));
      const log = await corrections(id);
      assert.equal(log.length, 1, "貼り付けと訂正ログは同じ文");
      assert.deepEqual(log[0].before, { status: "settle_failed", txHash: null });
      assert.deepEqual(log[0].after, { status: "settle_claimed", txHash: tx("23") });
      assert.equal(log[0].reason, "settlement_backfill");
      const { settlementSourceOf } = await import("@/lib/observatory/settlement-source");
      assert.equal(settlementSourceOf({ txHash: linked.txHash, lateSettlement: meta.lateSettlement }), "vet402_index", "tx を名指したのは売り手ではない");

      // 二度目は何もしない（同じ行を二度貼らない・読みにも行かない）。
      const again = await late.recoverLateSettlements({ readTransfers: tr.reader, readNonces: nr.reader });
      assert.equal(again.recovered, 0);
      assert.equal(tr.calls.length, 1);

      // 照合器: 本物の EVM の照合（verifyL1Settlement）を、Celo を名乗る偽の RPC で通す。期待値は行のもの（署名した値）。
      const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
      const { verifyL1Settlement, AUTHORIZATION_USED_TOPIC } = await import("@/lib/observatory/settlement-verify");
      const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
      const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;
      const receiptLogs = [
        { address: CELO_USDC.toLowerCase(), topics: [AUTHORIZATION_USED_TOPIC, pad(PAYER), NONCE], data: "0x" },
        { address: CELO_USDC.toLowerCase(), topics: [TRANSFER_TOPIC, pad(PAYER), pad(PAY_TO)], data: `0x${BigInt(AMOUNT).toString(16).padStart(64, "0")}` },
      ];
      const client = {
        getChainId: async () => 42220,
        getBlockNumber: async () => 79_800_000n,
        getTransactionReceipt: async () => ({ status: "success", blockNumber: 79_785_112n, logs: receiptLogs }),
        getBlock: async () => ({ timestamp: BigInt(Date.parse(SETTLED_AT) / 1000) }),
      } as never;
      const verifyInputs: unknown[] = [];
      const l1Calls: { settled: boolean; txHash: string | null }[] = [];
      const l2Calls: unknown[] = [];
      const summary = await runSettlementVerification({
        deps: {
          verify: async (input) => {
            verifyInputs.push(input);
            return verifyL1Settlement(input, { client });
          },
          registryHooks: {
            l1: async (x) => void l1Calls.push({ settled: x.settled, txHash: x.txHash ?? null }),
            l2: async (x) => void l2Calls.push(x),
          },
        },
      });
      assert.equal(summary.verified, 1);
      assert.equal(summary.refuted, 0);
      assert.equal(summary.lateLinksWithdrawn, 0);
      assert.deepEqual(verifyInputs, [
        { txHash: tx("23"), network: CELO, expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: AMOUNT, expectedAuthNonce: NONCE },
      ]);
      const settled = await get(id);
      assert.equal(settled.status, "settled");
      assert.equal(settled.settlementVerified, true);
      assert.equal(settled.txHash, tx("23"));
      // 「届いたか」は Base の遅延回収と同じ: 応答を受け取っていないので、届いたとは記録しない。
      assert.equal(settled.httpStatusPaid, null);
      assert.equal(settled.payloadNonEmpty, false);
      assert.equal(settled.l2Schema, "not_checked");
      assert.deepEqual(l1Calls, [{ settled: true, txHash: tx("23") }]);
      assert.deepEqual(l2Calls, [], "L2（中身）の所見は書かない");
      const evidence = await db.select().from(schema.observedPurchases);
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].deliveryVerified, false, "決済は確認した。配達は確認していない");
      assert.equal((await corrections(id)).length, 2);
    });

    await t.test("2: 額・宛先・時刻が合う着金があっても、その行の nonce が tx で消費されていなければ貼らない", async () => {
      for (const [name, consumed] of [
        ["レシートに AuthorizationUsed が無い", []],
        ["別の nonce が消費されている（同じ売り手への別の購入の tx）", [OTHER_NONCE]],
      ] as const) {
        await reset();
        const id = await seedRow();
        const before = await get(id);
        const tr = transfersOf([transfer()]);
        const nr = noncesOf({ [tx("23")]: [...consumed] });
        const s = await late.recoverLateSettlements({ readTransfers: tr.reader, readNonces: nr.reader });
        assert.equal(s.recovered, 0, name);
        assert.equal(nr.calls.length, 1, name);
        const row = await get(id);
        assert.equal(row.status, "settle_failed", name);
        assert.equal(row.txHash, null, name);
        assert.equal(row.settlementVerified, before.settlementVerified, name);
        assert.equal((await corrections(id)).length, 0, name);
        // 窓に額ちょうどの着金はあったが貼れなかった行: 決まっていない（上限まで読み直す）。lateSettlement は付かない。
        const meta = row.rawResponseMeta as { lateSettlement?: unknown; lateChainRead: { decided: boolean; tries: number; exactTransfers: number } };
        assert.equal(meta.lateSettlement, undefined, name);
        assert.deepEqual({ decided: meta.lateChainRead.decided, tries: meta.lateChainRead.tries, exact: meta.lateChainRead.exactTransfers }, { decided: false, tries: 1, exact: 1 }, name);
      }
      // 読み直しは上限まで。その間も貼らない。
      await reset();
      const id = await seedRow();
      const tr = transfersOf([transfer()]);
      const nr = noncesOf({ [tx("23")]: [OTHER_NONCE] });
      for (let i = 0; i < 5; i++) await late.recoverLateSettlements({ readTransfers: tr.reader, readNonces: nr.reader });
      assert.equal(tr.calls.length, late.CHAIN_READ_MAX_TRIES);
      assert.equal((await get(id)).txHash, null);
    });

    await t.test("3: 額・宛先・払い元・窓のどれかが違う着金は貼らない（レシートを読みにも行かない）", async () => {
      const cases: [string, Partial<ChainTransfer>][] = [
        ["額が 1 単位少ない", { value: "5999" }],
        ["額が 1 単位多い", { value: "6001" }],
        ["額が 10 倍", { value: "60000" }],
        ["宛先が別", { to: OTHER_PAY_TO }],
        ["払い元が別", { from: OTHER_PAYER }],
        ["試行の 3 分前（窓の外）", { blockTime: new Date(AT.getTime() - 3 * 60_000).toISOString() }],
        ["試行の 31 分後（窓の外）", { blockTime: new Date(AT.getTime() + 31 * 60_000).toISOString() }],
        ["時刻が読めない", { blockTime: "not-a-time" }],
      ];
      for (const [name, over] of cases) {
        await reset();
        const id = await seedRow();
        const tr = transfersOf([transfer(over)]);
        // レシートが「この行の nonce が消費された」と言っても、Transfer が合わなければ候補にしない。
        const nr = noncesOf({ [tx("23")]: [NONCE] });
        const s = await late.recoverLateSettlements({ readTransfers: tr.reader, readNonces: nr.reader });
        assert.equal(s.recovered, 0, name);
        assert.equal(nr.calls.length, 0, name);
        const row = await get(id);
        assert.equal(row.status, "settle_failed", name);
        assert.equal(row.txHash, null, name);
        assert.equal((await corrections(id)).length, 0, name);
      }
      // 既に別の購入が持っている tx（売り手が受領証で名指した tx）は候補にしない。
      await reset();
      const id = await seedRow();
      await seedRow({ status: "settled", tx: tx("23"), http: 200, nonce: OTHER_NONCE, attemptedAt: new Date(AT.getTime() - 16_000) });
      const nr = noncesOf({ [tx("23")]: [NONCE] });
      const s = await late.recoverLateSettlements({ readTransfers: transfersOf([transfer()]).reader, readNonces: nr.reader });
      assert.equal(s.recovered, 0);
      assert.equal(nr.calls.length, 0);
      assert.equal((await get(id)).txHash, null);
      // 照合器が「この購入のものではない」と取り消した tx も、二度と候補にしない。
      await reset();
      const rejected = await seedRow({ meta: { phase: "paid", lateSettlement: { rejectedTxHashes: [tx("23")] } } });
      const s2 = await late.recoverLateSettlements({ readTransfers: transfersOf([transfer()]).reader, readNonces: noncesOf({ [tx("23")]: [NONCE] }).reader });
      assert.equal(s2.recovered, 0);
      assert.equal((await get(rejected)).txHash, null);
    });

    await t.test("4: RPC が読めない・読み手が無いなら、行を変えない（決済済みにも、着金なしの印にも倒さない）", async () => {
      const cases: [string, { readTransfers?: TransferReader; readNonces?: NonceReader }][] = [
        ["Transfer が読めない（null・CELO_RPC_URL が無いときの読み手の答え）", { readTransfers: async () => null, readNonces: async () => [NONCE] }],
        ["Transfer の読みが例外", { readTransfers: async () => { throw new Error("rpc down"); }, readNonces: async () => [NONCE] }],
        ["レシートが読めない（null）", { readTransfers: async () => [transfer()], readNonces: async () => null }],
        ["レシートの読みが例外", { readTransfers: async () => [transfer()], readNonces: async () => { throw new Error("rpc down"); } }],
        ["nonce の読み手が無い", { readTransfers: async () => [transfer()] }],
        ["Transfer の読み手が無い", { readNonces: async () => [NONCE] }],
        ["どちらも無い", {}],
      ];
      for (const [name, readers] of cases) {
        await reset();
        const id = await seedRow();
        const before = await get(id);
        const s = await late.recoverLateSettlements(readers);
        assert.equal(s.recovered, 0, name);
        assert.equal(s.chainRowsReadCelo, 0, name);
        await assertUntouched(id, before, name);
      }
      // nonce の読み手が無いときは、Celo の行について Transfer の読み手を呼びもしない。
      await reset();
      await seedRow();
      const tr = transfersOf([transfer()]);
      await late.recoverLateSettlements({ readTransfers: tr.reader });
      assert.equal(tr.calls.length, 0);
      // 2 本の候補のうち 1 本のレシートが読めない: 読めた 1 本が合っていても、この組は次回へ回す（半分だけ決めない）。
      await reset();
      const id = await seedRow();
      const before = await get(id);
      const s = await late.recoverLateSettlements({
        readTransfers: async () => [transfer(), transfer({ txHash: tx("24"), blockTime: "2026-10-11T02:31:20.000Z" })],
        readNonces: async (q) => (q.txHash === tx("23") ? [NONCE] : null),
      });
      assert.equal(s.recovered, 0);
      await assertUntouched(id, before, "読めない tx が残っている組");
      // 読めるようになれば、次の回で貼る（読めなかった回は印を付けていないので、また選ばれる）。
      const s2 = await late.recoverLateSettlements({
        readTransfers: async () => [transfer(), transfer({ txHash: tx("24"), blockTime: "2026-10-11T02:31:20.000Z" })],
        readNonces: async (q) => (q.txHash === tx("23") ? [NONCE] : []),
      });
      assert.deepEqual(s2.links, [{ purchaseId: id, txHash: tx("23") }]);
    });

    await t.test("5: 署名していない行・Arc の行・窓が閉じていない行は選ばない", async () => {
      const cases: [string, Parameters<typeof seedRow>[0]][] = [
        ["auth_nonce が無い（資格情報が外へ出ていない）", { nonce: null }],
        ["auth_nonce が EIP-3009 の nonce の形でない", { nonce: "0x1234" }],
        ["auth_nonce が空白", { nonce: "   " }],
        ["Arc の行（このレーンは Celo だけ）", { network: ARC }],
        ["窓が閉じていない（直近 5 分）", { attemptedAt: new Date(Date.now() - 5 * 60_000) }],
        ["既に tx を持つ settle_claimed", { status: "settle_claimed", tx: tx("77") }],
        ["署名していない status（price_mismatch）", { status: "price_mismatch" }],
      ];
      for (const [name, over] of cases) {
        await reset();
        const id = await seedRow(over);
        const before = await get(id);
        const tr = transfersOf([transfer({ blockTime: new Date((over?.attemptedAt ?? AT).getTime() + 17_000).toISOString() })]);
        const nr = noncesOf({ [tx("23")]: [NONCE, "0x1234"] });
        const s = await late.recoverLateSettlements({ readTransfers: tr.reader, readNonces: nr.reader });
        assert.equal(s.recovered, 0, name);
        assert.equal(tr.calls.length, 0, name);
        assert.equal(nr.calls.length, 0, name);
        await assertUntouched(id, before, name);
      }
      assert.deepEqual(late.CHAIN_READ_LANES.map((l) => [l.key, [...l.networks], l.nonceBound]), [
        ["base", ["eip155:8453", "base"], false],
        ["celo", ["eip155:42220"], true],
        ["bnb", ["eip155:56"], true],
        ["arbitrum", ["eip155:42161"], true],
      ]);
    });

    await t.test("6: 同じ売り手へ同額を数秒違いで 2 回・着金 2 本 → 時刻の順ではなく nonce で、それぞれの tx に貼る", async () => {
      await reset();
      const n1 = nonce("a1");
      const n2 = nonce("a2");
      const first = await seedRow({ nonce: n1, attemptedAt: AT });
      const second = await seedRow({ nonce: n2, attemptedAt: new Date(AT.getTime() + 3_000) });
      // 着金の順は試行の順と逆（先に試行した行の決済が後）。時刻順に対にすると入れ替わる。
      const tr = transfersOf([
        transfer({ txHash: tx("e1"), blockTime: "2026-10-11T02:31:05.000Z" }),
        transfer({ txHash: tx("e2"), blockTime: "2026-10-11T02:31:12.000Z" }),
      ]);
      const nr = noncesOf({ [tx("e1")]: [n2], [tx("e2")]: [n1] });
      const s = await late.recoverLateSettlements({ readTransfers: tr.reader, readNonces: nr.reader });
      assert.equal(s.recoveredFromChainCelo, 2);
      assert.equal(tr.calls.length, 1, "同じ払い元・宛先・額の行は 1 回の読みで扱う");
      assert.equal((await get(first)).txHash, tx("e2"));
      assert.equal((await get(second)).txHash, tx("e1"));
      // 2 行に着金 1 本: nonce の合う行だけに貼り、もう 1 行は settle_failed のまま。
      await reset();
      const paid = await seedRow({ nonce: n1, attemptedAt: AT });
      const unpaid = await seedRow({ nonce: n2, attemptedAt: new Date(AT.getTime() + 3_000) });
      const s2 = await late.recoverLateSettlements({
        readTransfers: transfersOf([transfer({ txHash: tx("e3") })]).reader,
        readNonces: noncesOf({ [tx("e3")]: [n1] }).reader,
      });
      assert.deepEqual(s2.links, [{ purchaseId: paid, txHash: tx("e3") }]);
      assert.equal((await get(unpaid)).status, "settle_failed");
      assert.equal((await get(unpaid)).txHash, null);
      // 1 行の nonce が 2 本の tx で消費されたと読める（チェーンでは起きない・RPC の誤り）: どちらにも貼らない。
      await reset();
      const odd = await seedRow({ nonce: n1 });
      const s3 = await late.recoverLateSettlements({
        readTransfers: transfersOf([transfer({ txHash: tx("f1") }), transfer({ txHash: tx("f2"), blockTime: "2026-10-11T02:31:20.000Z" })]).reader,
        readNonces: noncesOf({ [tx("f1")]: [n1], [tx("f2")]: [n1] }).reader,
      });
      assert.equal(s3.recovered, 0);
      assert.equal((await get(odd)).txHash, null);
    });

    await t.test("7: Base のレーンは変えない。行の上限はレーンごとで、Base の未読の行が Celo の行を押し出さない", async () => {
      await reset();
      // Base: Celo の行より新しい未読の行が 2 行（上限 1 行なら 1 行しか読まれない）。nonce のある行・候補は 1 本。
      const baseNew = await seedRow({ network: BASE, attemptedAt: new Date("2026-10-11T08:00:00Z"), nonce: nonce("b1"), payTo: OTHER_PAY_TO });
      const baseOld = await seedRow({ network: BASE, attemptedAt: new Date("2026-10-11T07:00:00Z"), nonce: nonce("b2"), payTo: OTHER_PAY_TO, amount: "7000" });
      const celoRow = await seedRow();
      const calls: string[] = [];
      const reader: TransferReader = async (q) => {
        calls.push(q.network);
        if (q.network === CELO) return [transfer()];
        return [{ txHash: tx("b9"), from: PAYER, to: OTHER_PAY_TO, value: AMOUNT, blockTime: "2026-10-11T08:00:05.000Z" }];
      };
      const nr = noncesOf({ [tx("23")]: [NONCE] });
      const s = await late.recoverLateSettlements({ readTransfers: reader, readNonces: nr.reader, chainReadLimit: 1 });
      assert.deepEqual(calls, [BASE, CELO], "Base を 1 行、Celo を 1 行（別枠）");
      assert.equal(s.recoveredFromChain, 2);
      assert.equal(s.recoveredFromChainCelo, 1);
      assert.equal(s.chainRowsRead, 2);
      // Base の貼り方は従来どおり: 候補が 1 本なら貼る（nonce はこの段では読まない・照合器が見る）。
      assert.deepEqual(nr.calls, [{ network: CELO, txHash: tx("23"), payer: PAYER }]);
      const b = await get(baseNew);
      assert.equal(b.status, "settle_claimed");
      assert.equal(b.txHash, tx("b9"));
      assert.equal((b.rawResponseMeta as { lateSettlement: { matchedBy?: string } }).lateSettlement.matchedBy, "unique");
      assert.equal((await get(baseOld)).rawResponseMeta && "lateChainRead" in ((await get(baseOld)).rawResponseMeta as object), false, "上限の外の Base の行は未読のまま");
      assert.equal((await get(celoRow)).txHash, tx("23"));
      // Base の行は nonce の読み手が無くても従来どおり読まれる（Celo の行だけが読まれない）。
      await reset();
      await seedRow({ network: BASE, attemptedAt: new Date("2026-10-11T08:00:00Z"), nonce: nonce("b1"), payTo: OTHER_PAY_TO });
      const celo2 = await seedRow();
      const before = await get(celo2);
      const calls2: string[] = [];
      await late.recoverLateSettlements({ readTransfers: async (q) => (calls2.push(q.network), []) });
      assert.deepEqual(calls2, [BASE]);
      await assertUntouched(celo2, before, "nonce の読み手が無い回の Celo の行");
    });

    await t.test("8: 着金が窓に無い行は「決まった」と印して二度と読まない（売り手が決済していない購入）", async () => {
      await reset();
      const id = await seedRow({ http: 402, meta: { phase: "paid", status: 402 } });
      const tr = transfersOf([]);
      const nr = noncesOf({});
      await late.recoverLateSettlements({ readTransfers: tr.reader, readNonces: nr.reader });
      await late.recoverLateSettlements({ readTransfers: tr.reader, readNonces: nr.reader });
      assert.equal(tr.calls.length, 1);
      assert.equal(nr.calls.length, 0);
      const row = await get(id);
      assert.equal(row.status, "settle_failed");
      assert.equal(row.txHash, null);
      assert.equal((row.rawResponseMeta as { lateChainRead: { decided: boolean } }).lateChainRead.decided, true);
      assert.equal((await corrections(id)).length, 0);
    });

    await t.test("9（点検・中 1）: 応答なしの行は、それより新しい 402 の行より先に読む。402 の行は最後", async () => {
      // 本番の 10/11 の形: いちばん古い行が応答なし（ssl-audit）、それより新しい行は別の売り手の 402。
      await reset();
      const payNoAnswer = PAY_TO;
      const pay402a = "0x00000000000000000000000000000000000004a1";
      const pay402b = "0x00000000000000000000000000000000000004b2";
      const pay2xx = "0x00000000000000000000000000000000000002c3";
      const pay500 = "0x00000000000000000000000000000000000005d4";
      await seedRow({ payTo: pay402a, http: 402, attemptedAt: new Date("2026-10-11T08:30:34Z"), nonce: nonce("41"), meta: { phase: "paid", status: 402 } });
      await seedRow({ payTo: pay402b, http: 402, attemptedAt: new Date("2026-10-11T05:00:58Z"), nonce: nonce("42"), meta: { phase: "paid", status: 402 } });
      await seedRow({ payTo: pay500, http: 500, attemptedAt: new Date("2026-10-11T04:00:00Z"), nonce: nonce("45"), meta: { phase: "paid", status: 500 } });
      await seedRow({ payTo: pay2xx, status: "delivered_no_receipt", http: 200, attemptedAt: new Date("2026-10-11T03:00:00Z"), nonce: nonce("43"), meta: { phase: "paid", status: 200 } });
      const noAnswer = await seedRow({ payTo: payNoAnswer, attemptedAt: AT });
      const order: string[] = [];
      const reader: TransferReader = async (q) => {
        order.push(q.payTo);
        return q.payTo === payNoAnswer ? [transfer()] : [];
      };
      const nr = noncesOf({ [tx("23")]: [NONCE] });
      const s = await late.recoverLateSettlements({ readTransfers: reader, readNonces: nr.reader, chainReadLimit: 1 });
      assert.deepEqual(order, [payNoAnswer], "1 行しか読めない回は、応答なしの行（いちばん古い）を読む");
      assert.deepEqual(s.links, [{ purchaseId: noAnswer, txHash: tx("23") }]);
      for (let i = 0; i < 4; i++) await late.recoverLateSettlements({ readTransfers: reader, readNonces: nr.reader, chainReadLimit: 1 });
      assert.deepEqual(order, [payNoAnswer, pay2xx, pay500, pay402a, pay402b], "次に 2xx、ほかの応答、最後に 402（新しい順）");
      // 上限に余裕がある回でも順は同じ（持ち時間が先に尽きたときに残るのが 402 の行になる）。
      await reset();
      await seedRow({ payTo: pay402a, http: 402, attemptedAt: new Date("2026-10-11T08:30:34Z"), nonce: nonce("41"), meta: { phase: "paid", status: 402 } });
      await seedRow({ payTo: payNoAnswer, attemptedAt: AT });
      const order2: string[] = [];
      await late.recoverLateSettlements({ readTransfers: async (q) => (order2.push(q.payTo), []), readNonces: nr.reader });
      assert.deepEqual(order2, [payNoAnswer, pay402a]);
    });

    await t.test("10（点検・中 2）: 同じ売り手・同額で 1 日以上離れた行は、行ごとの窓で読む。読めなかった組は変えず、ログに 1 行", async () => {
      await reset();
      const n1 = nonce("d1");
      const n2 = nonce("d2");
      const dayOne = new Date("2026-10-10T00:15:00Z");
      const dayTwo = new Date("2026-10-11T02:30:53Z");
      const older = await seedRow({ nonce: n1, attemptedAt: dayOne });
      const newer = await seedRow({ nonce: n2, attemptedAt: dayTwo });
      const calls: { from: Date; to: Date }[] = [];
      const reader: TransferReader = async (q) => {
        calls.push({ from: q.from, to: q.to });
        return q.from.getTime() < dayTwo.getTime() - 60 * 60_000
          ? [transfer({ txHash: tx("c1"), blockTime: new Date(dayOne.getTime() + 9_000).toISOString() })]
          : [transfer({ txHash: tx("c2"), blockTime: new Date(dayTwo.getTime() + 17_000).toISOString() })];
      };
      const nr = noncesOf({ [tx("c1")]: [n1], [tx("c2")]: [n2] });
      const s = await late.recoverLateSettlements({ readTransfers: reader, readNonces: nr.reader });
      assert.equal(calls.length, 2, "行ごとに 1 回（26 時間を 1 回で読まない）");
      for (const c of calls) {
        assert.ok(c.to.getTime() - c.from.getTime() <= 32 * 60_000, `1 回の読みは窓 1 つぶん（${(c.to.getTime() - c.from.getTime()) / 60_000} 分）`);
      }
      // 新しい行の窓が先（並びの順）。それぞれの窓は自分の試行の 2 分前〜30 分後。
      assert.deepEqual(
        calls.map((c) => [c.from.toISOString(), c.to.toISOString()]),
        [
          [new Date(dayTwo.getTime() - 2 * 60_000).toISOString(), new Date(dayTwo.getTime() + 30 * 60_000).toISOString()],
          [new Date(dayOne.getTime() - 2 * 60_000).toISOString(), new Date(dayOne.getTime() + 30 * 60_000).toISOString()],
        ],
      );
      assert.equal(s.recoveredFromChainCelo, 2);
      assert.equal((await get(older)).txHash, tx("c1"));
      assert.equal((await get(newer)).txHash, tx("c2"));

      // 2 つ目の組の読みが時間で切れる: 1 つ目の組の貼り付けは残り、2 つ目の行は変えず、ログに 1 行。次の回は 2 つ目だけ読む。
      await reset();
      const olderId = await seedRow({ nonce: n1, attemptedAt: dayOne });
      const newerId = await seedRow({ nonce: n2, attemptedAt: dayTwo });
      const olderBefore = await get(olderId);
      const windows: string[] = [];
      const slow: TransferReader = (q) => {
        windows.push(q.from.toISOString());
        if (q.from.getTime() < dayTwo.getTime() - 60 * 60_000) return new Promise(() => {}); // 古い行の窓は答えが返らない
        return Promise.resolve([transfer({ txHash: tx("c2"), blockTime: new Date(dayTwo.getTime() + 17_000).toISOString() })]);
      };
      const logged: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
      let summary;
      try {
        summary = await late.recoverLateSettlements({ readTransfers: slow, readNonces: nr.reader, celoChainReadBudgetMs: 3_300 });
      } finally {
        console.error = origError;
      }
      assert.deepEqual(summary.links, [{ purchaseId: newerId, txHash: tx("c2") }], "読めた組の貼り付けは残る");
      assert.equal(summary.chainRowsReadCelo, 1);
      assert.equal(summary.chainRowsUnreadCelo, 1);
      await assertUntouched(olderId, olderBefore, "時間で切れた組の行");
      const lines = logged.filter((l) => l.includes("chain_read_unread"));
      assert.equal(lines.length, 1, logged.join("\n"));
      assert.match(lines[0], /celo/);
      assert.match(lines[0], /1 group\(s\), 1 row\(s\) left unchanged for the next run/);
      assert.match(lines[0], /ran out of time/);
      // 次の回: 読めなかった行だけがまた選ばれる（読めた組はやり直さない）。
      const next: string[] = [];
      const s2 = await late.recoverLateSettlements({
        readTransfers: async (q) => (next.push(q.from.toISOString()), [transfer({ txHash: tx("c1"), blockTime: new Date(dayOne.getTime() + 9_000).toISOString() })]),
        readNonces: nr.reader,
      });
      assert.deepEqual(next, [new Date(dayOne.getTime() - 2 * 60_000).toISOString()]);
      assert.deepEqual(s2.links, [{ purchaseId: olderId, txHash: tx("c1") }]);

      // 読みが例外で落ちたときのログは RPC の URL（鍵入りの形）を伏せる。締切を過ぎた回は読まない。
      await reset();
      const id = await seedRow();
      const before = await get(id);
      const logged2: string[] = [];
      console.error = (...args: unknown[]) => void logged2.push(args.map(String).join(" "));
      try {
        const failed = await late.recoverLateSettlements({
          readTransfers: async () => {
            throw new Error("HTTP request failed. URL: https://celo-mainnet.example/v2/SECRET-KEY-123 Details: fetch failed");
          },
          readNonces: nr.reader,
        });
        assert.equal(failed.chainRowsUnreadCelo, 1);
      } finally {
        console.error = origError;
      }
      const line = logged2.filter((l) => l.includes("chain_read_unread"));
      assert.equal(line.length, 1);
      assert.match(line[0], /the transfer read failed: HTTP request failed/);
      assert.ok(!logged2.join("\n").includes("SECRET-KEY-123") && !logged2.join("\n").includes("celo-mainnet.example"), "URL は伏せる");
      await assertUntouched(id, before, "読みが落ちた回の行");
      let late2 = 0;
      const past = await late.recoverLateSettlements({ readTransfers: async () => (late2++, [transfer()]), readNonces: nr.reader, deadlineAt: Date.now() - 1 });
      assert.equal(late2, 0, "締切を過ぎていたら Celo の行は読まない");
      assert.equal(past.recovered, 0);
      await assertUntouched(id, before, "締切を過ぎた回の行");
      // Base のレーンは分けない・並びも従来どおり（tests/late-settlement-r4.pg.test.ts の 2b が固定）。レーンの表で確かめる。
      assert.deepEqual(late.CHAIN_READ_LANES.map((l) => [l.key, l.noAnswerFirst, l.rowWindows]), [
        ["base", false, false],
        ["celo", true, true],
        ["bnb", true, true],
        ["arbitrum", true, true],
      ]);
      assert.equal(late.CHAIN_READ_BUDGET_MS, 45_000, "Base の持ち時間は変えていない");
      assert.equal(late.CELO_CHAIN_READ_BUDGET_MS, 30_000);
    });
  });
}
