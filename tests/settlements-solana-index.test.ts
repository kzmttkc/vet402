// ============================================================
// §7.2 Solana 決済索引 — 走査の完全性（2026-09-02 敵対的監査 C1）。
//
// 監査で見つかった構造欠陥: `SELECT DISTINCT pay_to … ORDER BY pay_to LIMIT 40`
// が固定で 41 番目以降の受取先は永久に索引されない／署名は最新 25 件だけで
// `until` も `before` も無く 26 件目以降が落ちる／予算切れで break しても
// チェックポイントが進んで空白が残る／RPC 未設定は公開 RPC へ無言フォールバック。
//
// RPC・DB を差し替え可能にした runSolanaIndex を、メモリ上の偽物で回す。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOLANA_MAX_PAYEES_PER_RUN,
  SOLANA_MAX_SIGNATURES_PER_PAYEE,
  runSolanaIndex,
  selectPayeesForRun,
  type SolanaCheckpoint,
  type SolanaIndexDeps,
  type SolanaRpc,
  type SolanaSignatureInfo,
} from "@/lib/settlements/index-solana";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function sig(n: number): SolanaSignatureInfo {
  return { signature: `sig${String(n).padStart(4, "0")}`, slot: 1000 + n, err: null };
}

/** 受取先ごとの署名一覧（新しい順）を持つ偽 RPC。until / before を本物と同じ意味で解釈する。 */
function fakeRpc(bySigs: Record<string, SolanaSignatureInfo[]>) {
  const calls: Array<{ address: string; before?: string; until?: string }> = [];
  const rpc: SolanaRpc = {
    async getSignaturesForAddress(address, opts) {
      calls.push({ address, before: opts.before, until: opts.until });
      let list = bySigs[address] ?? [];
      if (opts.before) {
        const i = list.findIndex((s) => s.signature === opts.before);
        list = i >= 0 ? list.slice(i + 1) : [];
      }
      if (opts.until) {
        const i = list.findIndex((s) => s.signature === opts.until);
        if (i >= 0) list = list.slice(0, i);
      }
      return list.slice(0, opts.limit);
    },
    async getParsedTransaction(signature) {
      const payee = Object.keys(bySigs).find((p) => bySigs[p].some((s) => s.signature === signature));
      if (!payee) return null;
      return {
        blockTime: 1_700_000_000,
        meta: {
          preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: payee, uiTokenAmount: { amount: "0" } }],
          postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: payee, uiTokenAmount: { amount: "5" } }],
        },
      };
    },
  };
  return { rpc, calls };
}

/** メモリ上のチェックポイント台帳と受取先一覧。 */
function fakeStore(payees: string[]) {
  const checkpoints = new Map<string, SolanaCheckpoint & { updatedAt: Date }>();
  const persisted: Array<{ payee: string; signature: string }> = [];
  let clock = 0;
  const deps = (rpc: SolanaRpc): SolanaIndexDeps => ({
    rpc,
    async listPayees() {
      return payees.map((payTo) => ({
        payTo,
        checkpointUpdatedAt: checkpoints.get(`settlements:solana:${payTo}`)?.updatedAt ?? null,
      }));
    },
    async getCheckpoint(scope) {
      const c = checkpoints.get(scope);
      return c ? { lastSlot: c.lastSlot, lastSignature: c.lastSignature } : null;
    },
    async setCheckpoint(scope, cp) {
      checkpoints.set(scope, { ...cp, updatedAt: new Date(++clock) });
    },
    async persist(input) {
      persisted.push({ payee: input.payee, signature: input.signature });
      return "inserted";
    },
  });
  return { deps, checkpoints, persisted };
}

test("selectPayeesForRun: 未索引を先頭、次にチェックポイントが古い順、上限で切る", () => {
  const rows = [
    { payTo: "b", checkpointUpdatedAt: new Date(200) },
    { payTo: "a", checkpointUpdatedAt: new Date(100) },
    { payTo: "d", checkpointUpdatedAt: null },
    { payTo: "c", checkpointUpdatedAt: null },
  ];
  assert.deepEqual(selectPayeesForRun(rows, 3), ["c", "d", "a"]);
});

test("41 番目の受取先は 2 回目の走査で索引される（固定 LIMIT の撤廃）", async () => {
  const payees = Array.from({ length: SOLANA_MAX_PAYEES_PER_RUN + 1 }, (_, i) => `payee${String(i).padStart(2, "0")}`);
  const sigs = Object.fromEntries(payees.map((p) => [p, [{ signature: `${p}-sig`, slot: 5, err: null }]]));
  const { rpc } = fakeRpc(sigs);
  const store = fakeStore(payees);

  const first = await runSolanaIndex(store.deps(rpc));
  assert.equal(first.payees, SOLANA_MAX_PAYEES_PER_RUN);
  const seenFirst = new Set(store.persisted.map((p) => p.payee));
  assert.equal(seenFirst.size, SOLANA_MAX_PAYEES_PER_RUN);
  assert.equal(seenFirst.has("payee40"), false, "41 番目は 1 回目には入らない");

  const second = await runSolanaIndex(store.deps(rpc));
  assert.equal(second.payees, SOLANA_MAX_PAYEES_PER_RUN);
  assert.equal(
    store.persisted.some((p) => p.payee === "payee40"),
    true,
    "未索引の受取先が 2 回目の先頭に来る",
  );
});

test("新しい署名が 26 件を超えても before でページングして取り切り、次回は until で差分だけ読む", async () => {
  const total = SOLANA_MAX_SIGNATURES_PER_PAYEE * 2 + 10; // 60
  const list = Array.from({ length: total }, (_, i) => sig(total - i)); // 新しい順
  const { rpc, calls } = fakeRpc({ P: list });
  const store = fakeStore(["P"]);

  const s = await runSolanaIndex(store.deps(rpc));
  assert.equal(s.signatures, total);
  assert.equal(store.persisted.length, total);
  assert.equal(calls.length, 3, "25 + 25 + 10 の 3 ページ");
  assert.equal(calls[1].before, list[24].signature);
  const cp = store.checkpoints.get("settlements:solana:P")!;
  assert.equal(cp.lastSignature, list[0].signature, "最新の署名がカーソル");
  assert.equal(cp.lastSlot, BigInt(list[0].slot));

  // 2 回目: 新規 2 件が積まれた
  const fresh = [sig(total + 2), sig(total + 1)];
  const { rpc: rpc2, calls: calls2 } = fakeRpc({ P: [...fresh, ...list] });
  const s2 = await runSolanaIndex(store.deps(rpc2));
  assert.equal(calls2[0].until, list[0].signature, "保存済みの署名を until に渡す");
  assert.equal(s2.signatures, 2);
  assert.equal(store.persisted.length, total + 2);
});

test("予算切れで途中終了したときはチェックポイントを進めない", async () => {
  const list = Array.from({ length: 30 }, (_, i) => sig(30 - i));
  const { rpc } = fakeRpc({ P: list });
  const store = fakeStore(["P"]);
  let t = 0;
  // 各 now() 呼び出しで 10ms 進む → 予算 45ms は署名処理の途中で切れる
  const s = await runSolanaIndex(store.deps(rpc), { budgetMs: 45, now: () => (t += 10) });
  assert.ok(store.persisted.length > 0 && store.persisted.length < 30, `途中で止まる (${store.persisted.length})`);
  assert.equal(store.checkpoints.has("settlements:solana:P"), false, "チェックポイントは書かれない");
  assert.equal(s.budgetExhausted, true);
});

test("署名が無い受取先もチェックポイントに触れて順番を後ろへ回す（飢餓防止）", async () => {
  const { rpc } = fakeRpc({ A: [], B: [sig(1)] });
  const store = fakeStore(["A", "B"]);
  await runSolanaIndex(store.deps(rpc));
  const a = store.checkpoints.get("settlements:solana:A");
  assert.ok(a, "空の受取先も updated_at が進む");
  assert.equal(a.lastSignature, null);
});

test("旧形式（slot だけ）のチェックポイントでも動く: slot 以下の署名を捨て、until は渡さない", async () => {
  const list = [sig(5), sig(4), sig(3), sig(2), sig(1)];
  const { rpc, calls } = fakeRpc({ P: list });
  const store = fakeStore(["P"]);
  await store.deps(rpc).setCheckpoint("settlements:solana:P", { lastSlot: BigInt(1000 + 3), lastSignature: null });
  const s = await runSolanaIndex(store.deps(rpc));
  assert.equal(calls[0].until, undefined);
  assert.equal(s.signatures, 2);
  assert.deepEqual(
    store.persisted.map((p) => p.signature),
    [sig(4).signature, sig(5).signature],
    "古い順に処理する",
  );
  assert.equal(store.checkpoints.get("settlements:solana:P")!.lastSignature, sig(5).signature);
});

test("RPC の失敗は errors に数え、理由をログに出す（握りつぶさない）", async () => {
  const rpc: SolanaRpc = {
    async getSignaturesForAddress() {
      throw new Error("429 Too Many Requests");
    },
    async getParsedTransaction() {
      return null;
    },
  };
  const store = fakeStore(["P"]);
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const s = await runSolanaIndex(store.deps(rpc));
    assert.equal(s.errors, 1);
  } finally {
    console.error = orig;
  }
  assert.ok(logged.some((l) => l.includes("429 Too Many Requests")), `理由が出る: ${logged.join(" | ")}`);
});

test("SOLANA_RPC_URL 未設定なら公開 RPC へ倒れず skipped: solana_rpc_unset", async () => {
  const saved = { rpc: process.env.SOLANA_RPC_URL, enabled: process.env.OBSERVATORY_SOLANA_INDEX_ENABLED };
  delete process.env.SOLANA_RPC_URL;
  delete process.env.OBSERVATORY_SOLANA_INDEX_ENABLED;
  try {
    const { indexSolana } = await import("@/lib/settlements/index-solana");
    const s = await indexSolana();
    assert.equal(s.skipped, "solana_rpc_unset");
  } finally {
    if (saved.rpc !== undefined) process.env.SOLANA_RPC_URL = saved.rpc;
    if (saved.enabled !== undefined) process.env.OBSERVATORY_SOLANA_INDEX_ENABLED = saved.enabled;
  }
});
