// ============================================================
// 2026-09-29 監査 5 周目（データ記者の立場）の是正を固定する（DB 無し）。
//
//   1. 訂正ログのカーソル: 形の合わないカーソルは弾き、行から作ったカーソルは元に戻る
//   3/4. settlement_path: 売り手が名指した tx の昇格（before.txHash = after.txHash）を、vet402 の索引の
//      紐付けと取り違えない（本番の c4d4b20f 型）
//   5. mainnet の判定: 名前の無い id（eip155:11142220 = Celo Sepolia を含む）を mainnet の表に入れない
//   6. delivered の率: 保留・照合待ちを除いた分母を並べる
//   2. 新しい export: /sellers の件数と行の数が一致する・L0 の行が state と同じ規則で判定される
//   面: openapi・llms.txt・docs/api に新しい語と経路が出ている
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeCorrectionCursor,
  encodeCorrectionCursor,
  settlementPathOf,
  SETTLEMENT_PATHS,
} from "@/lib/observatory/corrections";
import { chainLabel, isMainnet, isTestnet } from "@/lib/observatory/chains";
import { deliveredRates, pct1 } from "@/lib/observatory/delivered-rates";
import { buildSellerBoard, type LatestRow } from "@/lib/sellers/board";
import { buildSellerExportRows, countSellerExportOutcomes, SELLER_EXPORT_COLUMNS } from "@/lib/sellers/export";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";
import { networkClassOf, toL0ExportRow } from "@/lib/observatory/l0-export";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import { csvCell, csvLines } from "@/lib/util/csv-write";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const TX = `0x${"d2".repeat(32)}`;
const TX2 = `0x${"91".repeat(32)}`;

// ------------------------------------------------------------------
// 1. カーソル
// ------------------------------------------------------------------
test("訂正ログのカーソル: 行 → カーソル → 元の (created_at, id) に戻る（マイクロ秒を落とさない）", () => {
  const row = { created_at: "2026-09-29 02:15:32.820289+00", id: "c4d4b20f-6637-4c51-ac6a-361944a7aed4" };
  const c = encodeCorrectionCursor(row);
  assert.match(c, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCorrectionCursor(c), { createdAt: row.created_at, id: row.id });
});

test("訂正ログのカーソル: 形の合わない値は null（route が 400 invalid_cursor にする）", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  for (const bad of [
    "",
    "not base64!",
    b64("2026-09-29 02:15:32+00"),
    b64("2026-09-29 02:15:32+00|not-a-uuid"),
    b64("yesterday|c4d4b20f-6637-4c51-ac6a-361944a7aed4"),
    b64("2026-13-45 02:15:32+00|c4d4b20f-6637-4c51-ac6a-361944a7aed4"),
    b64("2026-09-29 02:15:32+00'; DROP TABLE x;--|c4d4b20f-6637-4c51-ac6a-361944a7aed4"),
    "a".repeat(201),
  ]) {
    assert.equal(decodeCorrectionCursor(bad), null, bad);
  }
});

// ------------------------------------------------------------------
// 3/4. settlement_path
// ------------------------------------------------------------------
test("settlement_path: 本番の 4 件（売り手が名指した tx を照合へ回した行）は seller_named_tx_promoted で、索引の紐付けではない", () => {
  // correction_log の実際の形（2026-09-29 02:15:32 の 4 行: c4d4b20f・43bd55ed・ac4903fc・d6e480f5）。
  for (const priorStatus of ["delivered_no_receipt", "settle_failed"]) {
    assert.equal(
      settlementPathOf({
        reason: "settlement_backfill",
        before: { status: priorStatus, txHash: TX },
        after: { status: "settle_claimed", txHash: TX.toUpperCase().replace("0X", "0x") },
      }),
      "seller_named_tx_promoted",
    );
  }
  // 索引の紐付け: 前は tx が無い（または別の、照合できなかった売り手の hash）
  assert.equal(
    settlementPathOf({ reason: "settlement_backfill", before: { status: "delivered_no_receipt", txHash: null }, after: { status: "settle_claimed", txHash: TX } }),
    "vet402_index_link",
  );
  assert.equal(
    settlementPathOf({
      reason: "settlement_backfill",
      before: { status: "settle_claimed_unverifiable", txHash: TX2 },
      after: { status: "settle_claimed", txHash: TX },
    }),
    "vet402_index_link",
  );
});

test("settlement_path: 他の経路と、settlement_backfill 以外の行", () => {
  const p = (before: unknown, after: unknown) => settlementPathOf({ reason: "settlement_backfill", before, after });
  assert.equal(p({ status: "settle_claimed" }, { status: "settled", blockNumber: "1" }), "verified_settled");
  assert.equal(p({ status: "settle_claimed" }, { status: "settle_claim_refuted", reason: "tx_not_found" }), "claim_refuted");
  assert.equal(
    p({ status: "settle_claimed", txHash: TX }, { status: "delivered_no_receipt", txHash: null, lateLinkWithdrawn: "no_nonce_binding" }),
    "late_link_withdrawn",
  );
  assert.equal(
    p({ status: "settle_claimed", txHash: TX }, { status: "settle_failed", txHash: TX, sellerDeclaredUnsettled: "amount_mismatch" }),
    "seller_named_tx_declined",
  );
  assert.equal(p({ status: "x" }, { status: "y" }), "other");
  assert.equal(p('{"status":"settle_claimed"}', '{"status":"settled"}'), "verified_settled", "jsonb が文字列で来ても読む");
  assert.equal(settlementPathOf({ reason: "dispute_remeasure", before: {}, after: {} }), null);
  for (const v of ["verified_settled", "claim_refuted", "seller_named_tx_promoted", "vet402_index_link", "late_link_withdrawn", "seller_named_tx_declined", "other"]) {
    assert.ok((SETTLEMENT_PATHS as readonly string[]).includes(v), v);
  }
});

test("export: purchase_id を末尾に足した（既存の列は動かない）", () => {
  assert.equal(EXPORT_CSV_COLUMNS[EXPORT_CSV_COLUMNS.length - 1], "purchase_id");
  assert.equal(EXPORT_CSV_COLUMNS[0], "attempted_at");
  const route = read("src/app/api/v1/observatory/export.csv/route.ts");
  assert.match(route, /pu\.id::text AS purchase_id/);
});

// ------------------------------------------------------------------
// 5. mainnet
// ------------------------------------------------------------------
test("mainnet の判定: 名前の無い id は mainnet に入れない・Celo Sepolia はテストネット", () => {
  assert.equal(chainLabel("eip155:11142220"), "Celo Sepolia");
  assert.equal(isTestnet("eip155:11142220"), true);
  assert.equal(isMainnet("eip155:11142220"), false);
  assert.equal(isMainnet("eip155:999999999"), false, "未知の id は mainnet ではない（unclassified）");
  assert.equal(isTestnet("eip155:999999999"), false);
  assert.equal(networkClassOf("eip155:999999999"), "unclassified");
  for (const m of ["eip155:8453", "base", "eip155:4217", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "xrpl:0", "eip155:5042", "eip155:196", "eip155:137", "eip155:42161", "eip155:4663", "eip155:56"]) {
    assert.equal(isMainnet(m === "base" ? "eip155:8453" : m), true, m);
  }
  assert.equal(isMainnet("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="), true);
  assert.equal(isMainnet("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="), false);
  assert.equal(chainLabel("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="), "Algorand (algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=)", "既存の表記は変えない");
  for (const t of ["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "eip155:5042002", "eip155:42431", "xrpl:1", "eip155:11155111", "eip155:80002"]) {
    assert.equal(isMainnet(t), false, t);
    assert.equal(networkClassOf(t), "testnet", t);
  }
});

// ------------------------------------------------------------------
// 6. delivered の率
// ------------------------------------------------------------------
test("delivered の率: 分母を 3 つ並べる（本番 2026-09-29 の値で 45.2% / 88.7%）", () => {
  const r = deliveredRates({ attempts: 10099, delivered: 4566, inconclusive: 4949, awaitingReread: 2 });
  assert.equal(r.deliveredOfAttemptsPct, 45.2);
  assert.equal(r.deliveredOfNotHeldPct, 88.7);
  assert.equal(r.denominators.notHeld, 5150);
  assert.equal(r.denominators.finalOutcome, 5148);
  assert.equal(r.deliveredOfFinalOutcomePct, 88.7);
  assert.equal(pct1(1, 0), null);
  assert.equal(deliveredRates({ attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 }).deliveredOfAttemptsPct, null);
});

// ------------------------------------------------------------------
// 2a. /sellers の export
// ------------------------------------------------------------------
let seq = 0;
function row(p: Partial<SellerRowFacts>): SellerRowFacts {
  seq++;
  return {
    endpointId: p.endpointId ?? `ep-${seq}`,
    status: "settle_failed",
    httpStatusPaid: null,
    txHash: null,
    attemptedAt: "2026-09-20T12:00:00Z",
    network: "eip155:8453",
    method: "GET",
    meta: null,
    schema: null,
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    ...p,
  };
}

test("/sellers の export: outcome で数えると board の件数と一致し、1 出品 1 行", () => {
  const rows: (LatestRow & { rowId: string })[] = [
    { ...row({ endpointId: "a1", status: "settled", httpStatusPaid: 200, txHash: TX }), host: "a.example", rowId: "11111111-1111-4111-8111-111111111111" },
    { ...row({ endpointId: "a2", status: "settle_claimed", httpStatusPaid: 200, txHash: TX2 }), host: "a.example", rowId: "22222222-2222-4222-8222-222222222222" },
    { ...row({ endpointId: "b1", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z" }), host: "b.example", rowId: "33333333-3333-4333-8333-333333333333" },
    { ...row({ endpointId: "b2", status: "over_cap" }), host: "b.example", rowId: "44444444-4444-4444-8444-444444444444" },
    { ...row({ endpointId: "c1", status: "settle_failed", httpStatusPaid: 500 }), host: "c.example", rowId: "55555555-5555-4555-8555-555555555555" },
    { ...row({ endpointId: "c2", status: "request_error" }), host: "c.example", rowId: "66666666-6666-4666-8666-666666666666" },
  ];
  const listings = [
    { endpointId: "a1", resourceKey: "a.example/x", host: "a.example" },
    { endpointId: "a2", resourceKey: "a.example/y", host: "a.example" },
    { endpointId: "a3", resourceKey: "a.example/z", host: "a.example" },
    { endpointId: "b1", resourceKey: "b.example/x", host: "b.example" },
    { endpointId: "b2", resourceKey: "b.example/y", host: "b.example" },
    { endpointId: "c1", resourceKey: "c.example/x", host: "c.example" },
    { endpointId: "c2", resourceKey: "c.example/y", host: "c.example" },
    { endpointId: "d1", resourceKey: "d.example/x", host: "d.example" },
  ];
  const hostListings = [...new Set(listings.map((l) => l.host))].map((host) => ({
    host,
    listings: listings.filter((l) => l.host === host).length,
  }));
  const board = buildSellerBoard(hostListings, rows, "2026-09-29T00:00:00Z");
  const exported = buildSellerExportRows(listings, rows);
  assert.equal(exported.length, listings.length);
  const n = countSellerExportOutcomes(exported);
  assert.deepEqual(
    {
      delivered: n.delivered,
      pending: n.pending,
      seller: n.seller,
      vet402: n.vet402,
      unsorted: n.unsorted,
      notPaid: n.not_bought,
      notTried: n.not_tried,
    },
    {
      delivered: board.totals.delivered,
      pending: board.totals.pending,
      seller: board.totals.seller,
      vet402: board.totals.vet402,
      unsorted: board.totals.unsorted,
      notPaid: board.totals.notPaid,
      notTried: board.totals.notTried,
    },
  );
  const a1 = exported.find((r) => r.endpoint_id === "a1")!;
  assert.equal(a1.outcome, "delivered");
  assert.equal(a1.purchase_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(a1.in_ledger_export, "true");
  assert.equal(exported.find((r) => r.endpoint_id === "a2")!.outcome, "pending");
  assert.equal(exported.find((r) => r.endpoint_id === "c2")!.in_ledger_export, "false", "request_error は台帳の export に載らない");
  const d1 = exported.find((r) => r.endpoint_id === "d1")!;
  assert.equal(d1.outcome, "not_tried");
  assert.equal(d1.purchase_id, "");
  // 失敗の行は fix_mode と side_label を持つ
  for (const r of exported.filter((x) => ["seller", "vet402", "unsorted", "not_bought"].includes(x.outcome))) {
    assert.ok(r.fix_mode !== "" && r.side_label !== "", r.endpoint_id);
  }
  assert.deepEqual(Object.keys(exported[0]).sort(), [...SELLER_EXPORT_COLUMNS].sort());
});

// ------------------------------------------------------------------
// 2b. L0 の export
// ------------------------------------------------------------------
test("L0 の export: 公開判定は publishedVerdict と同じ規則・掲載と 7 日の印", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const base = { endpoint_id: "e", resource_key: "x.example/a", network: "eip155:8453", status: "active" };
  assert.equal(toL0ExportRow({ ...base, verdicts: ["pass", "fail"], last_probed_at: "2026-09-29T10:00:00Z" }, now).published_verdict, "pass");
  assert.equal(toL0ExportRow({ ...base, verdicts: ["fail", "fail"], last_probed_at: "2026-09-29T10:00:00Z" }, now).published_verdict, "fail");
  assert.equal(toL0ExportRow({ ...base, verdicts: ["fail", "pass"], last_probed_at: "2026-09-29T10:00:00Z" }, now).published_verdict, "unverified");
  const none = toL0ExportRow({ ...base, verdicts: null, last_probed_at: null }, now);
  assert.equal(none.published_verdict, "unverified");
  assert.equal(none.last_probed_at, "");
  assert.equal(none.latest_probe_older_than_7d, "");
  const old = toL0ExportRow({ ...base, status: "delisted", verdicts: ["pass"], last_probed_at: "2026-09-20T12:00:00Z" }, now);
  assert.equal(old.listed, "false");
  assert.equal(old.latest_probe_older_than_7d, "true");
  assert.equal(toL0ExportRow({ ...base, network: "eip155:11142220", verdicts: ["pass"], last_probed_at: null }, now).network_class, "testnet");
  assert.equal(toL0ExportRow({ ...base, network: "base", verdicts: ["pass"], last_probed_at: null }, now).chain, "Base");
});

test("CSV のセル: カンマ・引用符・改行を引用する", () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("x\ny"), '"x\ny"');
  assert.equal(csvCell(null), "");
  assert.equal(csvLines(["a", "b"], [{ a: 1, b: "q,r" }]), 'a,b\n1,"q,r"\n');
});

// ------------------------------------------------------------------
// 面
// ------------------------------------------------------------------
test("面: 新しい export と訂正ログの頁送りが openapi・llms.txt・docs/api・llms-full に出ている", () => {
  const surfaces = ["docs/openapi.yaml", "public/llms.txt", "src/app/docs/api/page.tsx", "src/app/llms-full.txt/route.ts"];
  for (const f of surfaces) {
    const body = read(f);
    for (const needle of ["/api/v1/observatory/l0/export.csv", "/api/v1/sellers/export.csv", "cursor"]) {
      assert.ok(body.includes(needle), `${f} に ${needle} が無い`);
    }
  }
  for (const f of ["docs/openapi.yaml", "public/llms.txt", "src/app/docs/api/page.tsx"]) {
    assert.ok(read(f).includes("seller_named_tx_promoted"), `${f} に seller_named_tx_promoted が無い`);
  }
  // llms.txt は「通常 1 日以内に settled」と言い切らない（照合待ちが 17 日の行があった）
  const llms = read("public/llms.txt");
  assert.doesNotMatch(llms, /normally promoted from `settle_claimed` to `settled` within a day/);
  assert.ok(llms.includes("l1.awaitingRereadOlderThan7d"));
  // /corrections は見出しの数の定義と、全件へ遡る道を書く
  const page = read("src/app/corrections/page.tsx");
  assert.ok(page.includes("How the two counts in the header are counted"));
  assert.ok(page.includes("?reason=settlement_backfill"));
  // state の頁は保留を除いた率を並べる
  const state = read("src/app/observatory/state/page.tsx");
  assert.ok(state.includes("of attempts not held"));
  assert.ok(state.includes("Awaiting on-chain re-read"));
});
