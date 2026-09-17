// ============================================================
// §7.2 XRPL 決済索引（2026-09-17）——偽の account_tx で固定する。
//   - ページ（marker）を辿り、validated な RLUSD Payment だけを受取として記録する
//   - チェックポイント（最後に見た ledger）が前進し、次回はその続きから読む
//   - x402 の印（SourceTag 804681468 / InvoiceID）で帰属を分ける。XRP 建ては記録しない
//   - 締切で途中終了した受取先はチェックポイントを進めない
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  XRPL_CHECKPOINT_SCOPE_PREFIX,
  XRPL_X402_SOURCE_TAG,
  extractRlusdDelivery,
  isX402Marked,
  runXrplIndex,
  xrplAttribution,
  type XrplAccountTxEntry,
  type XrplCheckpoint,
  type XrplDelivery,
  type XrplIndexDeps,
  type XrplIndexRpc,
} from "@/lib/settlements/index-xrpl";
import { RLUSD_CURRENCY_HEX, RLUSD_ISSUER } from "@/lib/observatory/xrpl402-payer";

const PAYEE = "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32";
const PAYER = "rn1E1zyZY5LuZfzds7DfJVL3ZVcNq1XrKt";
/** 取引の無い受取先。 */
const OTHER = "rG31cLyErnqeVj2eomEjBZtq7PYaupGYzL";

function entry(n: number, over: { tx?: Record<string, unknown>; meta?: Record<string, unknown>; validated?: boolean } = {}): XrplAccountTxEntry {
  return {
    tx: {
      TransactionType: "Payment",
      Account: PAYER,
      Destination: PAYEE,
      hash: `${n}`.padStart(64, "C"),
      ledger_index: 99_000_000 + n,
      date: 800_000_000 + n,
      ...over.tx,
    },
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: "0.01" }, ...over.meta },
    validated: over.validated ?? true,
  };
}

/** ledger_index_min から先を昇順で返し、limit ごとに marker を切る偽 RPC。 */
function fakeRpc(all: XrplAccountTxEntry[]) {
  const calls: { account: string; ledgerIndexMin: number; marker?: unknown }[] = [];
  const rpc: XrplIndexRpc = {
    async accountTx(account, opts) {
      calls.push({ account, ledgerIndexMin: opts.ledgerIndexMin, marker: opts.marker });
      const sorted = all
        .filter((e) => e.tx!.Destination === account || e.tx!.Account === account)
        .filter((e) => (e.tx!.ledger_index as number) >= opts.ledgerIndexMin)
        .sort((a, b) => (a.tx!.ledger_index as number) - (b.tx!.ledger_index as number));
      const start = typeof opts.marker === "number" ? opts.marker : 0;
      const slice = sorted.slice(start, start + opts.limit);
      const next = start + opts.limit;
      return { transactions: slice, marker: next < sorted.length ? next : undefined };
    },
  };
  return { rpc, calls };
}

function store(payees: string[]) {
  const checkpoints = new Map<string, XrplCheckpoint & { updatedAt: Date }>();
  const persisted: XrplDelivery[] = [];
  let clock = 0;
  const deps = (rpc: XrplIndexRpc, limitOverride?: number): XrplIndexDeps => ({
    rpc: limitOverride ? { accountTx: (a, o) => rpc.accountTx(a, { ...o, limit: limitOverride }) } : rpc,
    async listPayees() {
      return payees.map((payTo) => ({ payTo, checkpointUpdatedAt: checkpoints.get(`${XRPL_CHECKPOINT_SCOPE_PREFIX}${payTo}`)?.updatedAt ?? null }));
    },
    async getCheckpoint(scope) {
      const c = checkpoints.get(scope);
      return c ? { lastLedger: c.lastLedger } : null;
    },
    async setCheckpoint(scope, cp) {
      checkpoints.set(scope, { ...cp, updatedAt: new Date(++clock) });
    },
    async persist(d) {
      persisted.push(d);
      return "inserted";
    },
  });
  return { deps, checkpoints, persisted };
}

test("extractRlusdDelivery: validated な RLUSD Payment だけ。XRP・失敗・宛先違い・未 validated は null", () => {
  const d = extractRlusdDelivery(entry(1, { tx: { SourceTag: XRPL_X402_SOURCE_TAG, InvoiceID: "A".repeat(64) } }), PAYEE)!;
  assert.equal(d.amountUnits, "10000");
  assert.equal(d.payer, PAYER);
  assert.equal(d.sourceTag, XRPL_X402_SOURCE_TAG);
  assert.equal(d.invoiceId, "A".repeat(64));
  assert.equal(d.ledgerIndex, 99_000_001);
  assert.equal(d.blockTime?.toISOString(), new Date((800_000_001 + 946_684_800) * 1000).toISOString());
  assert.equal(extractRlusdDelivery(entry(2, { meta: { delivered_amount: "10000" } }), PAYEE), null, "XRP 建ては記録しない");
  assert.equal(extractRlusdDelivery(entry(3, { meta: { TransactionResult: "tecPATH_DRY" } }), PAYEE), null);
  assert.equal(extractRlusdDelivery(entry(4, { tx: { Destination: PAYER } }), PAYEE), null);
  assert.equal(extractRlusdDelivery(entry(5, { validated: false }), PAYEE), null);
  assert.equal(extractRlusdDelivery(entry(6, { tx: { TransactionType: "TrustSet" } }), PAYEE), null);
  assert.equal(extractRlusdDelivery(entry(7, { meta: { delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: PAYER, value: "1" } } }), PAYEE), null, "発行者違い");
  // API v2 の形（tx_json）も読む
  const v2 = { tx_json: entry(8).tx, meta: entry(8).meta, validated: true, hash: "8".padStart(64, "D"), ledger_index: 99_000_008, close_time_iso: "2026-09-17T00:00:00Z" };
  assert.equal(extractRlusdDelivery(v2, PAYEE)?.hash, "8".padStart(64, "D"));
});

test("帰属: SourceTag 804681468 か InvoiceID で x402 由来。印が無ければ unmatched", () => {
  assert.equal(isX402Marked({ sourceTag: XRPL_X402_SOURCE_TAG, invoiceId: null }), true);
  assert.equal(isX402Marked({ sourceTag: null, invoiceId: "A".repeat(64) }), true);
  assert.equal(isX402Marked({ sourceTag: 1, invoiceId: null }), false);
  assert.equal(xrplAttribution(false, "confirmed"), "unmatched");
  assert.equal(xrplAttribution(true, "unmatched"), "probable");
  assert.equal(xrplAttribution(true, "probable"), "probable");
});

test("ページを辿って全件を記録し、チェックポイントが最後の ledger まで進む。次回はその続きだけ読む", async () => {
  const all = [1, 2, 3, 4, 5].map((n) => entry(n, { tx: { SourceTag: XRPL_X402_SOURCE_TAG } }));
  const { rpc, calls } = fakeRpc(all);
  const s = store([PAYEE]);
  const first = await runXrplIndex(s.deps(rpc, 2));
  assert.equal(first.inserted, 5);
  assert.equal(first.transactions, 5);
  assert.equal(calls.length, 3, "2 件ずつ 3 ページ");
  assert.equal(calls[0].ledgerIndexMin, 1, "初回は ledger 1 から");
  assert.equal(s.checkpoints.get(`${XRPL_CHECKPOINT_SCOPE_PREFIX}${PAYEE}`)?.lastLedger, 99_000_005n);

  all.push(entry(6, { tx: { SourceTag: XRPL_X402_SOURCE_TAG } }));
  const second = await runXrplIndex(s.deps(rpc, 2));
  assert.equal(second.inserted, 1, "続きの 1 件だけ");
  assert.equal(calls[3].ledgerIndexMin, 99_000_006, "チェックポイント + 1 から");
  assert.equal(s.checkpoints.get(`${XRPL_CHECKPOINT_SCOPE_PREFIX}${PAYEE}`)?.lastLedger, 99_000_006n);
});

test("XRP 建て・失敗 tx は数えるが記録しない。取引 0 件でもチェックポイントに触れる", async () => {
  const { rpc } = fakeRpc([entry(1, { meta: { delivered_amount: "5000" } }), entry(2, { meta: { TransactionResult: "tecUNFUNDED" } })]);
  const s = store([PAYEE, OTHER]);
  const summary = await runXrplIndex(s.deps(rpc));
  assert.equal(summary.inserted, 0);
  assert.equal(summary.transactions, 2);
  assert.equal(summary.payees, 2);
  assert.ok(s.checkpoints.has(`${XRPL_CHECKPOINT_SCOPE_PREFIX}${OTHER}`), "取引の無い受取先も触れる（飢餓防止）");
});

test("締切で途中終了した受取先はチェックポイントを進めない", async () => {
  const { rpc } = fakeRpc([1, 2, 3].map((n) => entry(n)));
  const s = store([PAYEE]);
  let t = 0;
  const summary = await runXrplIndex(s.deps(rpc, 1), { budgetMs: 10, now: () => (t += 6) });
  assert.equal(summary.budgetExhausted, true);
  assert.equal(s.checkpoints.has(`${XRPL_CHECKPOINT_SCOPE_PREFIX}${PAYEE}`), false);
});
