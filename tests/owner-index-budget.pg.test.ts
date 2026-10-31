// ============================================================
// vet402 — identity registry の 2 つの索引（所有者 / 運用ウォレット）は、時間の予算の中で
// 区切りごとに「読む → 書く → checkpoint」する（2026-10-31）。
//
// 以前は 1 回に 250,000 ブロックを全部読み、書き込みと checkpoint は最後にまとめて 1 回だった。
// 10/8 から getLogs は 1 回 1,000 ブロックまでの予備の読み先へ回り、しかも 10 月の Base には
// 1 区切り（20,000 ブロック）に Transfer が 28 万件ある所がある。転送を 1 件ずつ DB に書く形では
// 300 秒の中で終わらず、関数ごと殺されて、途中まで読んだ分も残らなかった
// （本番の checkpoint は 10/8 から動かず、tip から約 98 万ブロック遅れ）。
//
// ここが固定すること（発注書 1031-index-owners-timeout.md の完了条件）:
//   1. 予算が 1 区切り分しかない → 1 区切りだけ進み、checkpoint はその区切りの終わり。応答に予算で止まった旨
//   2. 区切りの書き込みの途中で落ちる → checkpoint はその区切りの前のまま。次の回が同じ区切りを
//      読み直し、行は重複も欠落もしない
//   3. tip まで届く → caughtUp・両方の checkpoint が tip・行は今のチェーンの状態と一致
//   4. owner と wallet で進み方が違う → それぞれの checkpoint が自分の進んだ所。遅い方が resolver の実力
//   5. 区切りの途中で壁時計の上限を越えたら、その区切りは書かずに捨てる（checkpoint は前の区切りの終わり）
//   6. 1 区切りの件数が多すぎるときは、読む窓の終わり（= ブロックの境目）で区切りを閉じる
//   7. cron の応答（2 つを同じ持ち時間で回す）に、進んだブロック数・予算で止まったか・caughtUp が出る
//   8. 書き込みの期限を越えた区切りは checkpoint を進めずに応答を返す（レビュー L-1）
//   9. getLogs が返らなくても、壁時計の上限（withDeadline）で待つのをやめる（レビュー L-4）
//  10. 同時に走るのは 1 本だけ（job_leases の lease。レビュー M-2）
//
// RPC は tests/helpers/fake-identity-rpc.ts の偽物（INDEXER_RPC_URL をそこへ向ける。viem・chunked-logs・
// multicall は実物）。DB は TEST_DATABASE_URL の実 Postgres。時計は偽物で、getLogs を 1 回受けるごとに進む。
// ============================================================
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { startFakeIdentityRpc, ZERO, type FakeChain, type FakeLog, type FakeRpc } from "./helpers/fake-identity-rpc";

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "TEST_DATABASE_URL not set";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
const START = 52_323_145n; // 本番の identity_registry が 10/8 から止まっているブロック
const SEG = 20_000n;
const TIP = START + 10n * SEG - 1n; // 10 区切り
const MS_PER_GETLOGS = 1_000; // 1,000 ブロックの getLogs 1 回 = 偽の 1 秒

const addr = (c: string) => `0x${c.repeat(40)}` as Address;
const [A, B, C, D, E, F, G, H] = ["a", "b", "c", "d", "e", "f", "1", "2"].map(addr) as Address[];
const [W1, W2, W3, W7] = ["3", "4", "5", "7"].map(addr) as Address[];

function mint(block: bigint, agentId: bigint, owner: Address): FakeLog[] {
  return [
    { kind: "registered", block, agentId, owner },
    { kind: "transfer", block, from: ZERO, to: owner, agentId },
  ];
}

/** 10 区切りの小さな履歴。境目のブロック・checkpoint のブロック・燃やした token・貼り替えを含む。 */
function makeChain(): FakeChain {
  const o = (offset: bigint) => START + offset;
  const logs: FakeLog[] = [
    ...mint(o(0n), 1n, A), // checkpoint のブロックそのもの
    { kind: "walletSet", block: o(50n), agentId: 1n, wallet: W1 },
    ...mint(o(100n), 2n, C),
    ...mint(o(SEG - 1n), 6n, G), // 区切り 1 の最後のブロック
    ...mint(o(SEG), 3n, D), // 区切り 2 の最初のブロック
    { kind: "transfer", block: o(25_000n), from: C, to: ZERO, agentId: 2n }, // 燃やす
    { kind: "walletSet", block: o(30_000n), agentId: 3n, wallet: W3 },
    { kind: "transfer", block: o(45_000n), from: A, to: B, agentId: 1n },
    { kind: "walletSet", block: o(46_000n), agentId: 1n, wallet: W2 }, // 貼り替え
    // 8 は ownerOf が答えない（revert）。イベントだけで書く経路: 区切り 4 で (A,8) を書き、
    // 区切り 5 の A→C で (A,8) を消して (C,8) を書く（組ごとの delete を実際の行に当てる）。
    ...mint(o(60_000n), 8n, A),
    { kind: "transfer", block: o(85_000n), from: A, to: C, agentId: 8n },
    ...mint(o(70_000n), 5n, E),
    { kind: "transfer", block: o(70_500n), from: E, to: F, agentId: 5n },
    { kind: "transfer", block: o(90_000n), from: F, to: E, agentId: 5n },
    ...mint(TIP, 7n, H), // tip のブロック
    { kind: "walletSet", block: TIP, agentId: 7n, wallet: W7 },
  ];
  logs.sort((x, y) => (x.block < y.block ? -1 : x.block > y.block ? 1 : 0));
  const owners = new Map<bigint, Address>([
    [1n, B],
    [3n, D],
    [5n, E],
    [6n, G],
    [7n, H],
  ]); // 2 は燃やしたので ownerOf は revert。8 も revert（答えない読み先の代わり）
  return { tip: TIP, logs, owners };
}

const EXPECTED_OWNER_ROWS = [`${B}:1`, `${D}:3`, `${E}:5`, `${G}:6`, `${H}:7`, `${C}:8`].sort();
const EXPECTED_WALLET_ROWS = [`1:${W2}`, `3:${W3}`, `7:${W7}`].sort();

let rpc: FakeRpc;
let clock = 0;

before(async () => {
  if (!TEST_DB) return;
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  rpc = await startFakeIdentityRpc(makeChain(), REGISTRY);
  process.env.INDEXER_RPC_URL = rpc.url;
  delete process.env.BASE_RPC_URL;
  delete process.env.LOG_SCAN_FALLBACK_RPC_URLS;
  delete process.env.SKIP_CHAIN_READS;
  delete process.env.GET_LOGS_CHUNK_DELAY_MS;
  process.env.GET_LOGS_CHUNK_BLOCKS = "1000";
  process.env.GET_LOGS_CHUNK_CONCURRENCY = "1";
});

after(async () => {
  await rpc?.close();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  const { getDb } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");
  const db = getDb()!;
  // このファイルの行は agent_id < 1000 だけ（owner-index-write-order.pg.test.ts は 9042・9043 を使う。並列でも混ざらない）。
  await db.execute(sql`DELETE FROM owner_agents WHERE agent_id < 1000`);
  await db.execute(sql`DELETE FROM agents WHERE agent_id < 1000`);
  await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope IN ('identity_registry', 'identity_registry_wallets')`);
  await db.execute(sql`
    INSERT INTO indexer_checkpoints (scope, last_block, chain_tip_at_run)
    VALUES ('identity_registry', ${START.toString()}::bigint, ${START.toString()}::bigint),
           ('identity_registry_wallets', ${START.toString()}::bigint, ${START.toString()}::bigint)`);
  await db.execute(sql`DELETE FROM job_leases WHERE name = 'index-owners'`);
  rpc.calls.length = 0;
  rpc.onGetLogs = () => {
    clock += MS_PER_GETLOGS;
  };
  rpc.hangGetLogs = () => false;
  clock = 0;
});

async function ownerRows(): Promise<string[]> {
  const { getDb } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");
  const res = await getDb()!.execute(sql`SELECT owner, agent_id::text AS id FROM owner_agents WHERE agent_id < 1000`);
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as { owner: string; id: string }[];
  return rows.map((r) => `${r.owner}:${r.id}`).sort();
}

async function walletRows(): Promise<string[]> {
  const { getDb } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");
  const res = await getDb()!.execute(sql`SELECT agent_id::text AS id, wallet FROM agents WHERE agent_id < 1000`);
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as { id: string; wallet: string }[];
  return rows.map((r) => `${r.id}:${r.wallet}`).sort();
}

async function checkpoint(scope: "identity_registry" | "identity_registry_wallets"): Promise<bigint | null> {
  const { getIndexerCheckpoint } = await import("@/lib/db/owner-index");
  return getIndexerCheckpoint(scope);
}

const now = () => clock;

test("owner: a budget worth one segment advances exactly one segment and says the budget stopped it", { skip }, async () => {
  const { indexOwnerAgents } = await import("@/lib/indexer/owner-indexer");
  // 区切り 1 つ = Registered 20 回 + Transfer 20 回の getLogs = 偽の 40 秒。予算 30 秒なら 2 つ目を始めない。
  const result = (await indexOwnerAgents({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 30_000,
    hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000,
    deps: { now },
  } as never)) as unknown as Record<string, unknown>;

  assert.equal(await checkpoint("identity_registry"), START + SEG - 1n, "checkpoint は読み終えて書き終えた区切りの終わり");
  assert.equal(result.toBlock, (START + SEG - 1n).toString());
  assert.equal(result.blocksAdvanced, Number(SEG) - 1, "checkpoint が動いたブロック数");
  assert.equal(result.partial, true);
  assert.equal(result.stoppedBy, "time_budget");
  assert.equal(result.caughtUp, false);
  // 区切り 1 の分だけが書かれている（1 は今の持ち主 B、2 は燃やされる前なので C が残る）。
  assert.deepEqual(await ownerRows(), [`${B}:1`, `${C}:2`, `${G}:6`].sort());
  // 読んだのは区切り 1 だけ。
  assert.ok(rpc.calls.every((c) => c.to <= START + SEG - 1n), "区切り 2 を読み始めていない");
});

test("wallet: a budget worth one segment advances exactly one segment and says the budget stopped it", { skip }, async () => {
  const { indexAgentWallets } = await import("@/lib/indexer/agent-wallet-indexer");
  // 区切り 1 つ = WalletSet 20 回 = 偽の 20 秒。
  const result = (await indexAgentWallets({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 15_000,
    hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000,
    deps: { now },
  } as never)) as unknown as Record<string, unknown>;

  assert.equal(await checkpoint("identity_registry_wallets"), START + SEG - 1n);
  assert.equal(result.toBlock, (START + SEG - 1n).toString());
  assert.equal(result.partial, true);
  assert.equal(result.stoppedBy, "time_budget");
  assert.equal(result.caughtUp, false);
  assert.deepEqual(await walletRows(), [`1:${W1}`]);
});

test("owner: a write that dies midway leaves the checkpoint before that segment; the next run rereads it with no duplicate or missing row", { skip }, async () => {
  const { indexOwnerAgents } = await import("@/lib/indexer/owner-indexer");
  const writer = await import("@/lib/db/owner-index-writer");
  let segment = 0;
  const failing = {
    now,
    // 区切り 2 の書き込みで、最初の 1 文（upsert）だけ通して落ちる。
    applyChanges: async (changes: Parameters<typeof writer.applyOwnerAgentChanges>[0]) => {
      const index = segment++;
      if (index === 1) {
        await writer.upsertOwnerAgents(changes.upserts);
        throw new Error("db write failed");
      }
      return writer.applyOwnerAgentChanges(changes);
    },
  };

  await assert.rejects(
    indexOwnerAgents({ maxBlocks: 250_000n, segmentBlocks: SEG, timeBudgetMs: 1_000_000, hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000, deps: failing } as never),
    /db write failed/,
  );
  assert.equal(await checkpoint("identity_registry"), START + SEG - 1n, "落ちた区切りの前のまま");

  rpc.calls.length = 0;
  const result = (await indexOwnerAgents({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 1_000_000,
    hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000,
    deps: { now },
  } as never)) as unknown as Record<string, unknown>;

  assert.equal(rpc.calls[0]!.from, START + SEG - 1n, "次の回は checkpoint のブロックから読み直す");
  assert.equal(result.caughtUp, true);
  assert.equal(await checkpoint("identity_registry"), TIP);
  const rows = await ownerRows();
  assert.equal(new Set(rows).size, rows.length, "重複なし");
  assert.deepEqual(rows, EXPECTED_OWNER_ROWS, "欠落なし・燃やした 2 は残らない");
});

test("both reach the tip: caughtUp, both checkpoints at the tip, and the rows match the chain", { skip }, async () => {
  const { indexOwnerAgents } = await import("@/lib/indexer/owner-indexer");
  const { indexAgentWallets } = await import("@/lib/indexer/agent-wallet-indexer");
  const opts = { maxBlocks: 250_000n, segmentBlocks: SEG, timeBudgetMs: 1_000_000, hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000, deps: { now } };

  const owner = (await indexOwnerAgents(opts as never)) as unknown as Record<string, unknown>;
  const wallet = (await indexAgentWallets(opts as never)) as unknown as Record<string, unknown>;

  for (const r of [owner, wallet]) {
    assert.equal(r.caughtUp, true);
    assert.equal(r.partial, false);
    assert.equal(r.stoppedBy, undefined);
    assert.equal(r.toBlock, TIP.toString());
    assert.equal(r.blocksAdvanced, Number(TIP - START));
  }
  assert.equal(await checkpoint("identity_registry"), TIP);
  assert.equal(await checkpoint("identity_registry_wallets"), TIP);
  assert.deepEqual(await ownerRows(), EXPECTED_OWNER_ROWS);
  assert.deepEqual(await walletRows(), EXPECTED_WALLET_ROWS);
  // 穴も重なりもなく区切りを読んだ（1,000 ブロックの chunk が START から TIP まで隙間なく並ぶ）。
  const transferCalls = rpc.calls.filter((c) => c.kind === "transfer");
  assert.equal(transferCalls[0]!.from, START);
  assert.equal(transferCalls.at(-1)!.to, TIP);
  for (let i = 1; i < transferCalls.length; i++) {
    assert.equal(transferCalls[i]!.from, transferCalls[i - 1]!.to + 1n, `chunk ${i} に穴か重なり`);
  }
});

test("owner and wallet advance differently: each checkpoint is its own, and the slower one decides what the resolver can trust", { skip }, async () => {
  const { indexOwnerAgents } = await import("@/lib/indexer/owner-indexer");
  const { indexAgentWallets } = await import("@/lib/indexer/agent-wallet-indexer");
  const { warmAgentResolveTail } = await import("@/lib/chain/agent-resolver");

  const owner = (await indexOwnerAgents({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 70_000, // 40 秒の区切りを 2 つ
    hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000,
    deps: { now },
  } as never)) as unknown as Record<string, unknown>;
  clock = 0;
  const wallet = (await indexAgentWallets({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 1_000_000,
    hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000,
    deps: { now },
  } as never)) as unknown as Record<string, unknown>;

  assert.equal(owner.stoppedBy, "time_budget");
  assert.equal(await checkpoint("identity_registry"), START + 2n * SEG - 1n, "owner は 2 区切り");
  assert.equal(wallet.caughtUp, true);
  assert.equal(await checkpoint("identity_registry_wallets"), TIP, "wallet は tip");

  // 遅い方（owner）が tip から 16 万ブロック遅れている = 2 日（86,400 ブロック）の tail に収まらない。
  assert.equal(await warmAgentResolveTail(5_000), "unavailable");

  clock = 0;
  await indexOwnerAgents({ maxBlocks: 250_000n, segmentBlocks: SEG, timeBudgetMs: 1_000_000, hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000, deps: { now } } as never);
  assert.equal(await checkpoint("identity_registry"), TIP);
  assert.equal(await warmAgentResolveTail(5_000), "indexed_only");
});

test("owner: crossing the hard stop inside a segment drops that segment unwritten and keeps the previous checkpoint", { skip }, async () => {
  const { indexOwnerAgents } = await import("@/lib/indexer/owner-indexer");
  // 区切り 2 の Transfer を読んでいる間に、時計が上限を越える。
  rpc.onGetLogs = (call) => {
    clock += MS_PER_GETLOGS;
    if (call.kind === "transfer" && call.from === START + SEG + 5_000n) clock += 1_000_000;
  };
  const result = (await indexOwnerAgents({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 200_000,
    hardStopMs: 250_000,
    deps: { now },
  } as never)) as unknown as Record<string, unknown>;

  assert.equal(result.partial, true);
  assert.equal(result.stoppedBy, "hard_stop");
  assert.equal(await checkpoint("identity_registry"), START + SEG - 1n);
  // 区切り 2 の行（3 の D）は書かれていない。
  assert.deepEqual(await ownerRows(), [`${B}:1`, `${C}:2`, `${G}:6`].sort());
});

test("owner: a segment with too many events is closed at the end of a read window, never inside a block", { skip }, async () => {
  const { indexOwnerAgents } = await import("@/lib/indexer/owner-indexer");
  // 区切り 1 の最初の窓（4,000 ブロック）に Registered 2 件 + Transfer 2 件（ブロック 0・100）。
  // 上限 4 件なら、その窓の終わり（START + 3,999）で区切りを閉じる。窓の境目はブロックの境目。
  // 予算 5 秒: 最初の区切り（窓 1 つ = getLogs 8 回 = 偽の 8 秒）だけで止める。
  const result = (await indexOwnerAgents({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 5_000,
    hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000,
    readWindowBlocks: 4_000n,
    maxSegmentEvents: 4,
    deps: { now },
  } as never)) as unknown as Record<string, unknown>;

  assert.equal(result.stoppedBy, "time_budget");
  assert.equal(result.registeredEvents, 2);
  assert.equal(result.transferEvents, 2);
  assert.equal(await checkpoint("identity_registry"), START + 3_999n, "閉じたのは最初の窓の終わり");
  assert.ok(rpc.calls.every((c) => c.to <= START + 3_999n), "次の窓を読み始めていない");
  assert.deepEqual(await ownerRows(), [`${B}:1`, `${C}:2`].sort());

  // 次の回は START + 3,999 から読み直し、19,999 の 6 も 20,000 の 3 も取りこぼさない。
  clock = 0;
  await indexOwnerAgents({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 1_000_000,
    hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000,
    readWindowBlocks: 4_000n,
    maxSegmentEvents: 4,
    deps: { now },
  } as never);
  assert.deepEqual(await ownerRows(), EXPECTED_OWNER_ROWS);
  assert.equal(await checkpoint("identity_registry"), TIP);
});

test("cron runner: both indexes share one time budget and the body says how far each moved, whether the budget stopped it, and caughtUp", { skip }, async () => {
  const { runIdentityIndexes } = await import("@/lib/indexer/identity-index-run");
  const stopped = await runIdentityIndexes({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 50_000,
    hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000,
    now,
  });
  assert.equal(stopped.status, 200);
  const body = stopped.body as Record<string, unknown> & {
    walletIndex: Record<string, unknown>;
    blocksAdvanced: { owner: number; wallet: number };
  };
  assert.equal(body.ok, true);
  assert.equal(body.caughtUp, false);
  assert.equal(body.stoppedByBudget, true);
  const ownerCp = await checkpoint("identity_registry");
  const walletCp = await checkpoint("identity_registry_wallets");
  assert.equal(body.blocksAdvanced.owner, Number(ownerCp! - START));
  assert.equal(body.blocksAdvanced.wallet, Number(walletCp! - START));
  assert.ok(body.blocksAdvanced.owner > 0 && body.blocksAdvanced.wallet > 0, "2 つとも進む（片方が予算を食い切らない）");
  assert.equal(body.toBlock, ownerCp!.toString());
  assert.equal(body.walletIndex.toBlock, walletCp!.toString());

  clock = 0;
  const done = await runIdentityIndexes({ maxBlocks: 250_000n, segmentBlocks: SEG, timeBudgetMs: 1_000_000, hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000, now });
  const doneBody = done.body as Record<string, unknown>;
  assert.equal(doneBody.ok, true);
  assert.equal(doneBody.caughtUp, true);
  assert.equal(doneBody.stoppedByBudget, false);
  assert.equal(await checkpoint("identity_registry"), TIP);
  assert.equal(await checkpoint("identity_registry_wallets"), TIP);
});

test("owner: a segment whose writes cross the write deadline is not checkpointed, and the run still answers", { skip }, async () => {
  const { indexOwnerAgents } = await import("@/lib/indexer/owner-indexer");
  const writer = await import("@/lib/db/owner-index-writer");
  let segment = 0;
  const result = (await indexOwnerAgents({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 1_000_000,
    hardStopMs: 1_000_000,
    writeDeadlineMs: 500_000,
    deps: {
      now,
      // 区切り 2 の書き込みを始める時点で、時計が書き込みの期限を越えている。本物の書き手に期限を渡す。
      applyChanges: async (changes: Parameters<typeof writer.applyOwnerAgentChanges>[0], options?: Parameters<typeof writer.applyOwnerAgentChanges>[1]) => {
        if (segment++ === 1) clock += 1_000_000;
        return writer.applyOwnerAgentChanges(changes, options);
      },
    },
  } as never)) as unknown as Record<string, unknown>;

  assert.equal(result.partial, true);
  assert.equal(result.stoppedBy, "write_deadline");
  assert.equal(result.toBlock, (START + SEG - 1n).toString());
  assert.equal(await checkpoint("identity_registry"), START + SEG - 1n, "書き終わらなかった区切りの前のまま");
  assert.deepEqual(await ownerRows(), [`${B}:1`, `${C}:2`, `${G}:6`].sort(), "区切り 2 の文は 1 つも始めていない");
});

async function leaseRow(): Promise<{ holder: string; expired: boolean } | null> {
  const { getDb } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");
  const res = await getDb()!.execute(
    sql`SELECT holder::text AS holder, expires_at <= now() AS expired FROM job_leases WHERE name = 'index-owners'`,
  );
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as { holder: string; expired: boolean }[];
  return rows[0] ?? null;
}

test("lease: two runs at once — one runs, the other answers lease_held and reads and writes nothing", { skip }, async () => {
  const { runIdentityIndexes } = await import("@/lib/indexer/identity-index-run");
  const opts = { maxBlocks: 250_000n, segmentBlocks: SEG, timeBudgetMs: 1_000_000, hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000, now };
  const [a, b] = await Promise.all([runIdentityIndexes(opts), runIdentityIndexes(opts)]);
  const bodies = [a.body, b.body] as Record<string, unknown>[];

  const skipped = bodies.filter((x) => x.skipped === "lease_held");
  const ran = bodies.filter((x) => x.skipped === undefined);
  assert.equal(skipped.length, 1, JSON.stringify(bodies.map((x) => x.skipped ?? x.caughtUp)));
  assert.equal(ran.length, 1);
  assert.equal(skipped[0]!.ok, true);
  assert.equal(ran[0]!.caughtUp, true);
  // 走らなかった方は 1 つも読んでいない（同じ範囲を 2 度読んだ要求が無い）。
  const keys = rpc.calls.map((c) => `${c.kind}:${c.from}`);
  assert.equal(new Set(keys).size, keys.length, "同じ範囲を 2 本が読んだ");
  assert.deepEqual(await ownerRows(), EXPECTED_OWNER_ROWS);
  assert.deepEqual(await walletRows(), EXPECTED_WALLET_ROWS);
  assert.equal(await leaseRow(), null, "走った方は終わりに自分の lease を解放した");
});

test("lease: a lease held by someone else is not taken or released; once it expires the next run takes it", { skip }, async () => {
  const { runIdentityIndexes } = await import("@/lib/indexer/identity-index-run");
  const { getDb } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");
  const db = getDb()!;
  const other = "11111111-1111-4111-8111-111111111111";
  await db.execute(sql`
    INSERT INTO job_leases (name, holder, acquired_at, expires_at)
    VALUES ('index-owners', ${other}::uuid, now(), now() + interval '300 seconds')`);
  const opts = { maxBlocks: 250_000n, segmentBlocks: SEG, timeBudgetMs: 1_000_000, hardStopMs: 1_000_000, writeDeadlineMs: 1_000_000, now };

  const held = await runIdentityIndexes(opts);
  assert.deepEqual(held.body, { ok: true, skipped: "lease_held" });
  assert.equal(rpc.calls.length, 0, "何も読んでいない");
  assert.equal(await checkpoint("identity_registry"), START, "何も書いていない");
  assert.deepEqual(await leaseRow(), { holder: other, expired: false }, "持ち主でない側は解放しない");

  // 期限が切れた lease（殺された回の残り）は次の回が取る。
  await db.execute(sql`UPDATE job_leases SET expires_at = now() - interval '1 second' WHERE name = 'index-owners'`);
  const taken = await runIdentityIndexes(opts);
  assert.equal((taken.body as Record<string, unknown>).caughtUp, true);
  assert.equal(await checkpoint("identity_registry"), TIP);
  assert.equal(await leaseRow(), null);
});

test("lease: a run whose lease expired and was taken over does not release the new holder's lease", { skip }, async () => {
  const { acquireLeaseFailClosed } = await import("@/lib/cron/lease-fail-closed");
  const { IDENTITY_INDEX_LEASE, IDENTITY_INDEX_LEASE_TTL_SECONDS } = await import("@/lib/indexer/identity-index-run");
  const { getDb } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");
  const first = await acquireLeaseFailClosed(IDENTITY_INDEX_LEASE, IDENTITY_INDEX_LEASE_TTL_SECONDS);
  assert.equal(first.acquired, true);
  await getDb()!.execute(sql`UPDATE job_leases SET expires_at = now() - interval '1 second' WHERE name = 'index-owners'`);
  const second = await acquireLeaseFailClosed(IDENTITY_INDEX_LEASE, IDENTITY_INDEX_LEASE_TTL_SECONDS);
  assert.equal(second.acquired, true);
  const secondHolder = (await leaseRow())!.holder;

  if (first.acquired) await first.release();
  assert.deepEqual(await leaseRow(), { holder: secondHolder, expired: false }, "古い持ち主の解放は新しい lease を消さない");
  if (second.acquired) await second.release();
  assert.equal(await leaseRow(), null);
});

test("owner: crossing the write deadline on the first segment throws instead of answering ok with nothing advanced", { skip }, async () => {
  const { indexOwnerAgents } = await import("@/lib/indexer/owner-indexer");
  const writer = await import("@/lib/db/owner-index-writer");
  const deps = {
    now,
    // 最初の区切りの書き込みを始める時点で、時計が書き込みの期限を越えている。
    applyChanges: async (changes: Parameters<typeof writer.applyOwnerAgentChanges>[0], options?: Parameters<typeof writer.applyOwnerAgentChanges>[1]) => {
      clock += 1_000_000;
      return writer.applyOwnerAgentChanges(changes, options);
    },
  };
  await assert.rejects(
    indexOwnerAgents({ maxBlocks: 250_000n, segmentBlocks: SEG, timeBudgetMs: 1_000_000, hardStopMs: 1_000_000, writeDeadlineMs: 500_000, deps } as never),
    (error: Error) => error.name === "DeadlineExceededError",
  );
  assert.equal(await checkpoint("identity_registry"), START, "checkpoint は動かない");
  assert.deepEqual(await ownerRows(), [], "最初の区切りの文は 1 つも始めていない");
});

test("cron runner: a first-segment write deadline makes the body ok:false (500), so a stuck index does not look green", { skip }, async () => {
  const { runIdentityIndexes } = await import("@/lib/indexer/identity-index-run");
  // 2 つの索引が同じ時計を回す。書き込みの期限 = 1 区切りを読み終える前の時刻（getLogs 20 回 = 偽の 20 秒）。
  // owner の最初の区切りは読み終えるのに getLogs 40 回かかるので、書き始める時には期限を過ぎている。
  const run = await runIdentityIndexes({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 1_000_000,
    hardStopMs: 1_000_000,
    writeDeadlineMs: 20_000,
    now,
  });
  const body = run.body as Record<string, unknown>;
  assert.equal(run.status, 500);
  assert.equal(body.ok, false);
  assert.match(String(body.error), /owner: deadline_exceeded/);
  assert.equal(await checkpoint("identity_registry"), START);
});

test("owner: a getLogs that never answers is abandoned by the wall clock and the earlier segment stays", { skip }, async () => {
  const { indexOwnerAgents } = await import("@/lib/indexer/owner-indexer");
  // 区切り 1 = getLogs 40 回 = 偽の 40 秒。上限 40.5 秒なら、区切り 2 の最初の読み取りに残るのは実時間 0.5 秒。
  // その要求に偽の RPC は答えない。withDeadline が 0.5 秒で発火しなければ、viem の timeout（20 秒 × 4 回）まで待つ。
  // このファイルの最後に置く: 答えなかった要求は viem が 20 秒後に打ち直し、時計と rpc.calls を動かすので、
  // 後ろに別のテストがあると混ざる（node --test はファイルごとに別のプロセスなので、ファイルの外には漏れない）。
  rpc.hangGetLogs = (call) => call.from >= START + SEG;
  const started = Date.now();
  const result = (await indexOwnerAgents({
    maxBlocks: 250_000n,
    segmentBlocks: SEG,
    timeBudgetMs: 1_000_000,
    hardStopMs: 40_500,
    deps: { now },
  } as never)) as unknown as Record<string, unknown>;
  const elapsed = Date.now() - started;

  assert.equal(result.partial, true);
  assert.equal(result.stoppedBy, "hard_stop");
  assert.ok(elapsed < 10_000, `壁時計で切れていない: ${elapsed}ms`);
  assert.equal(await checkpoint("identity_registry"), START + SEG - 1n);
  assert.deepEqual(await ownerRows(), [`${B}:1`, `${C}:2`, `${G}:6`].sort());
});
