// ============================================================
// 判定・/sellers・export.csv は 1 回の購入を同じ 1 つの関数（fix-modes.ts classifySellerRow）で分け、食い違わない
// （2026-09-29 監査 7 周目・高 1〜3）。本番の 5 例（2026-09-29 の読み取り専用の SELECT で取った行・
// tests/fixtures/r7-decision-sellers.json）を固定具にする。nonce は "present" に置き換えてある。
//
//   cnvrt.ing/api/analyze-image       決済済み・HTTP 500 ×4、/sellers は not sorted → 判定は WARN（以前は BLOCK）
//   firecrawl.mpp.tempo.xyz/v1/search 決済済み・HTTP 500 ×2（Tempo）、記録頁は not sorted → WARN（以前は BLOCK）
//   api.x402-engine.com/v1/intelligence 決済済み・HTTP 202（settlement_pending_reconciliation）→ 配達に数えない・WARN
//   api.onesource.io/api/chain/ens/:input 未購入・L0 未プローブ（path_template）→ WARN（以前は BLOCK）・頁に判定を出す
//   api.m2msentinel.com/v1/dex/metrics  配達済み・L2 match → ALLOW（頁も export も delivered）
// 本番には今「売り手の側（確定）の払ったのに届かない」が 1 件も無いので、BLOCK の例は x402-engine の実際の行
// （署名した条件・残高・入力・応答がそろった行）を HTTP 500 で別の 2 日に置き換えた反実仮想で固定する。
// 加えて、会計の所見（遅延回収の待ち）: nonce のある失敗の行は試行から 90 分のうち「未確定」（pending）で、
// 判定・/sellers・export のどれでも売り手の失敗に数えない。export の latest_status は台帳の値のまま。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  assembleSellerFacts,
  l0UnverifiedCauseOf,
  l1NotCountedOf,
  l1TimelineOf,
  rowViewOf,
  type ProbeInput,
  type PurchaseInput,
  type SellerFactsInput,
} from "@/lib/decision/seller-facts";
import { decidePayer, l1BasisOf, type PayerOptions } from "@/lib/decision/rules";
import { buildRecordSides, buildSellerDetail, failureDaysOf, recordRowKey, type SellerEndpointFacts } from "@/lib/sellers/board";
import { buildSellerExportRows } from "@/lib/sellers/export";
import { classifySellerRow, LATE_LINK_PENDING_MINUTES, SIGNED_ROW_STATUSES, type SellerRowFacts } from "@/lib/sellers/fix-modes";
import { SellerDetailView } from "@/components/site/sellers/SellersViews";
import { l2ReadingOf } from "@/lib/observatory/l2-check";

type FixtureRow = { facts: SellerRowFacts; l2Schema: string | null; latencyMs: number | null; l2Detail?: unknown; bodyHead?: string | null; contentType?: string | null };
type Fixture = {
  endpoint: { id: string; resource_key: string; url: string; method: string | null; status: string; network: string; declared: boolean; declared_schema: unknown; declared_input: unknown };
  probes: { probedAt: string; verdict: string; dialect: string | null; failReason: string | null }[];
  rows: FixtureRow[];
};
const FIX = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/r7-decision-sellers.json"), "utf8")) as { fetchedAt: string; fixtures: Fixture[] };
const NOW = Date.parse(FIX.fetchedAt);
const byUrl = (u: string) => {
  const f = FIX.fixtures.find((x) => x.endpoint.url === u);
  assert.ok(f, u);
  return f;
};
const hostOf = (f: Fixture) => f.endpoint.resource_key.split("/")[0];

/** 本番（loadSellerFacts → decide.ts）と同じ材料で判定する。分類は記録頁と同じ buildRecordSides（readRecordSides）から。 */
function decisionOf(f: Fixture, rowsOverride?: FixtureRow[], now = NOW) {
  const rows = rowsOverride ?? f.rows;
  const facts = rows.map((r) => r.facts);
  const sides = buildRecordSides(facts, now);
  const windowStart = now - 30 * 86_400_000;
  const purchases: PurchaseInput[] = rows
    .filter((r) => Date.parse(r.facts.attemptedAt) > windowStart)
    .sort((a, b) => b.facts.attemptedAt.localeCompare(a.facts.attemptedAt))
    .map((r) => {
      const shown = sides.rows.get(recordRowKey(r.facts.attemptedAt, r.facts.status, r.facts.txHash));
      return {
        attemptedAt: r.facts.attemptedAt,
        status: r.facts.status,
        latencyMs: r.latencyMs,
        httpStatusPaid: r.facts.httpStatusPaid,
        payloadNonEmpty: r.facts.payloadNonEmpty ?? null,
        l2Schema: r.l2Schema,
        l2Detail: (r.l2Detail as PurchaseInput["l2Detail"]) ?? null,
        bodyHead: r.bodyHead ?? null,
        contentType: r.contentType ?? null,
        txHash: r.facts.txHash,
        network: r.facts.network,
        requestMeta: r.facts.meta,
        amountUnits: r.facts.amountUnits ?? null,
        payer: r.facts.payer ?? null,
        settlementConfirmed: r.facts.settlementConfirmed ?? null,
        authNonce: r.facts.authNonce ?? null,
        sellerView: shown ? { bucket: shown.bucket, modeKey: shown.mode?.key ?? null, held: shown.held, money: shown.money, delivered: shown.bucket === "delivered" } : null,
      };
    });
  const probes: ProbeInput[] = f.probes.map((p) => ({ ...p, priceAmount: "declared", priceAsset: null, payTo: "declared" }));
  const signed = rows.filter((r) => SIGNED_ROW_STATUSES.has(r.facts.status)).map((r) => r.facts.attemptedAt).sort();
  const input: SellerFactsInput = {
    probes,
    purchases,
    settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
    payees: [],
    declaredSchema: f.endpoint.declared_schema ?? null,
    method: f.endpoint.method,
    declaredInput: f.endpoint.declared_input ?? null,
    lastAttemptAt: purchases[0]?.attemptedAt ?? null,
    lastSignedAttemptAt: signed.at(-1) ?? null,
    lastDeliveredAt: null,
  };
  const factsOut = assembleSellerFacts(input);
  const options: PayerOptions = {
    l1NotCounted: l1NotCountedOf(input, now),
    l0UnverifiedCause: l0UnverifiedCauseOf(probes),
    l1Timeline: l1TimelineOf(input, now),
    now: new Date(now),
  };
  return { d: decidePayer(factsOut, options), basis: l1BasisOf(factsOut, options), facts: factsOut, sides, purchases, input };
}

/** /sellers の売り手頁の出品と export.csv の行（Base の出品だけ）。 */
function sellersOf(f: Fixture, rows = f.rows, now = NOW) {
  const latestProbe = f.probes[0] ?? null;
  const ep: SellerEndpointFacts = {
    endpointId: f.endpoint.id,
    resourceKey: f.endpoint.resource_key,
    resourceUrl: f.endpoint.url,
    method: f.endpoint.method,
    priceAmount: null,
    resourceId: "a".repeat(64),
    nextBuyFacts: { lastAttemptAnyAt: rows[0]?.facts.attemptedAt ?? null, settledCount: 0, cooldown: false, latestL0Verdict: latestProbe?.verdict ?? null, latestL0At: latestProbe?.probedAt ?? null, latestL0Reason: latestProbe?.failReason ?? null },
  };
  const facts = rows.map((r) => r.facts);
  const detail = buildSellerDetail(hostOf(f), [ep], facts, new Date(now).toISOString());
  const latest = detail.listings[0].latest;
  const exportRows = buildSellerExportRows(
    [{ endpointId: f.endpoint.id, resourceKey: f.endpoint.resource_key, host: hostOf(f) }],
    latest ? [{ ...latest.facts, host: hostOf(f) }] : [],
    // 本番の reader は出品の署名した行を全部読んで候補の日付を渡す（readSellerFailureDays）。同じ材料をここで作る。
    failureDaysOf(facts, new Map(), now),
    now,
  );
  return { detail, latest, exportRow: exportRows[0] };
}

/** 全部の例で、判定が読む分類と、頁・記録頁・export の分類が同じ（1 つの関数）。「数える」も同じ意味。 */
function assertSameClassification(f: Fixture) {
  const { sides, purchases, basis, d } = decisionOf(f);
  for (const p of purchases) {
    const shown = sides.rows.get(recordRowKey(p.attemptedAt, p.status, p.txHash))!;
    const again = rowViewOf({ ...p, sellerView: null }, { method: f.endpoint.method, declaredSchema: f.endpoint.declared_schema ?? null, declaredInput: f.endpoint.declared_input }, NOW);
    assert.equal(p.sellerView?.bucket, shown.bucket, `${f.endpoint.url}: 判定の分類 = 頁の分類`);
    assert.equal(p.sellerView?.money, again.money, `${f.endpoint.url}: お金の判定は行の事実だけで決まる`);
  }
  // 「数える」＝届いた、または売り手の側（確定）。判定の n_counted と頁の分類の数が一致する。
  const signed = purchases.filter((p) => SIGNED_ROW_STATUSES.has(p.status));
  const counted = signed.filter((p) => p.sellerView?.bucket === "seller" || p.sellerView?.bucket === "delivered").length;
  assert.equal(basis.n_counted, counted, `${f.endpoint.url}: n_counted`);
  // L1 で BLOCK なら、その根拠の行は頁でも売り手の側（確定）
  const l1Block = d.recommendation === "BLOCK" && basis.n_paid_undelivered_seller_side_since_last_delivery >= 2;
  if (d.recommendation === "BLOCK" && !d.reason_codes.some((c) => c === "l0_fail" || c === "wash_dominated" || c === "operator_blacklist" || c === "l2_mismatch")) {
    assert.ok(l1Block, `${f.endpoint.url}: L1 の BLOCK は売り手の側（確定）2 回以上だけ`);
  }
}

test("本番の 5 例とも、判定・頁・記録頁・export が同じ分類関数の結果を読む（食い違わない）", () => {
  assert.equal(FIX.fixtures.length, 5);
  for (const f of FIX.fixtures) assertSameClassification(f);
});

test("cnvrt.ing 型: 決済済み・500 が続いても /sellers が not sorted なら WARN（売り手を公開で非難しない）。export も unsorted", () => {
  const f = byUrl("https://cnvrt.ing/api/analyze-image");
  const { d, basis } = decisionOf(f);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"), d.reason_codes.join(","));
  assert.ok(d.reason_codes.includes("l1_not_counted_unproven"));
  assert.equal(basis.n_paid_undelivered_seller_side_since_last_delivery, 0);
  const { latest, exportRow } = sellersOf(f);
  assert.equal(latest?.bucket, "unsorted");
  assert.equal(exportRow.outcome, "unsorted");
  assert.equal(exportRow.fix_mode, latest?.mode?.key);
  assert.equal(exportRow.side_label.startsWith("not sorted"), true);
});

test("firecrawl（Tempo）型: 記録頁が not sorted の決済済み 500 ×2 は WARN", () => {
  const f = byUrl("https://firecrawl.mpp.tempo.xyz/v1/search");
  const { d, sides } = decisionOf(f);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
  assert.equal(sides.confirmedSeller, 0);
  for (const s of sides.rows.values()) assert.notEqual(s.bucket, "seller");
});

test("x402-engine 型: 決済済みの 202（settlement_pending_reconciliation）は配達に数えない。判定は WARN、頁と export は not sorted", () => {
  const f = byUrl("https://api.x402-engine.com/v1/intelligence");
  const { d, facts } = decisionOf(f);
  assert.equal(facts.l1.n_delivered, 0);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
  assert.ok(!d.reason_codes.includes("l1_delivered"));
  const { latest, exportRow } = sellersOf(f);
  assert.equal(latest?.mode?.key, "accepted_not_delivered");
  assert.equal(exportRow.outcome, "unsorted");
  assert.equal(exportRow.fix_mode, "accepted_not_delivered");
  assert.equal(exportRow.latest_status, "settled", "台帳の status はそのまま");
});

test("未購入・L0 未プローブ（path_template）は WARN（BLOCK にしない）。売り手頁は購入していない出品にも判定・L0・異議の導線を出す", () => {
  const f = byUrl("https://api.onesource.io/api/chain/ens/:input");
  const { d } = decisionOf(f);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l0_unverified"));
  assert.ok(d.reason_codes.includes("l0_unverified_not_probed"));
  const { detail, exportRow } = sellersOf(f);
  assert.equal(exportRow.outcome, "not_tried");
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail, page: 1, now: NOW, revalidateSec: 300 }));
  assert.match(html, /Decision API now:/);
  assert.match(html, /Latest L0 check \(the 402 to an unpaid request\): none yet/);
  assert.match(html, /Not probed is not a failure/);
  assert.match(html, /Dispute this record/);
});

test("配達済みの出品（m2msentinel 型）: 判定 ALLOW・頁と export は delivered・L2 conform", () => {
  const f = byUrl("https://api.m2msentinel.com/v1/dex/metrics");
  const { d, facts } = decisionOf(f);
  assert.equal(d.recommendation, "ALLOW", d.reason_codes.join(","));
  assert.equal(facts.l2.status, "conform");
  const { latest, exportRow } = sellersOf(f);
  assert.equal(latest?.bucket, "delivered");
  assert.equal(exportRow.outcome, "delivered");
});

test("売り手の側（確定）の「払ったのに届かない」2 回以上だけが BLOCK。頁も export も seller・confirmed（実際の行からの反実仮想）", () => {
  const f = byUrl("https://api.x402-engine.com/v1/intelligence");
  const base = f.rows[0];
  const rows: FixtureRow[] = ["2026-09-27T06:00:54Z", "2026-09-22T06:00:54Z"].map((at, i) => ({
    ...base,
    facts: { ...base.facts, httpStatusPaid: 500, attemptedAt: at, txHash: `0x${String(i + 1).repeat(64)}`, meta: { requestBody: "declared", requestQuery: "empty" } },
  }));
  const { d, basis } = decisionOf(f, rows);
  assert.equal(d.recommendation, "BLOCK", d.reason_codes.join(","));
  assert.equal(basis.n_paid_undelivered_seller_side_since_last_delivery, 2);
  const { latest, exportRow } = sellersOf(f, rows);
  assert.equal(latest?.bucket, "seller");
  assert.equal(exportRow.outcome, "seller");
  assert.equal(exportRow.confirmed_seller, "true");
  // 同じ行が 1 日だけなら once（not sorted）・WARN
  const one = decisionOf(f, [rows[0]]);
  assert.equal(one.d.recommendation, "WARN");
  assert.equal(sellersOf(f, [rows[0]]).exportRow.outcome, "unsorted");
});

test("会計の所見: nonce のある失敗の行は試行から 90 分のうち「お金が動いたか未確定」。どの面でも売り手の失敗に数えない（status は台帳のまま）", () => {
  assert.equal(LATE_LINK_PENDING_MINUTES, 90);
  const f = byUrl("https://cnvrt.ing/api/analyze-image");
  const base = f.rows[0].facts;
  const lateRow = (minutesAgo: number): FixtureRow => ({
    facts: { ...base, status: "settle_failed", httpStatusPaid: 402, txHash: null, attemptedAt: new Date(NOW - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"), authNonce: "present" },
    l2Schema: null,
    latencyMs: null,
  });
  // 30 分前（遅延回収の前）: pending・money unknown
  const fresh = lateRow(30);
  const c = classifySellerRow(fresh.facts, { now: NOW });
  assert.equal(c.bucket, "pending");
  assert.equal(c.money, "unknown");
  const { exportRow, latest } = sellersOf(f, [fresh], NOW);
  assert.equal(latest?.bucket, "pending");
  assert.equal(exportRow.outcome, "pending");
  assert.equal(exportRow.latest_status, "settle_failed", "export の status の値は変えない");
  const { d } = decisionOf(f, [fresh]);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_empty_2xx_settlement_unknown"), d.reason_codes.join(","));
  assert.ok(!d.reason_codes.includes("l1_never_delivered"));
  // nonce が無い行・91 分たった行は待ちにしない（通常の分類へ）
  assert.notEqual(classifySellerRow({ ...fresh.facts, authNonce: null }, { now: NOW }).bucket, "pending");
  assert.notEqual(classifySellerRow(lateRow(LATE_LINK_PENDING_MINUTES + 1).facts, { now: NOW }).bucket, "pending");
  // 配達された行は待ちにしない（届いた事実が先）
  assert.equal(classifySellerRow({ ...fresh.facts, status: "settled", httpStatusPaid: 200, txHash: "0x1", payloadNonEmpty: true }, { now: NOW }).bucket, "delivered");
});

test("L2 の読み直し（古い行の切れた本文）は判定・記録頁・export.csv の l2_reading が同じ関数（l2ReadingOf）を通す", () => {
  // places.use.x402atlas.com 型: 16,000 バイトで切れた JSON を「全部欠けた」と記録した古い行
  const schema = { properties: { output: { properties: { example: { required: ["count", "assets"], properties: { count: {}, assets: {} } } } } } };
  const head = `{"count":232,"assets":[${Array.from({ length: 40 }, (_, i) => `{"name":"A${i}","sz":5}`).join(",")}`.slice(0, 500);
  const row = { l2Schema: "mismatch", l2Detail: { missing: ["count", "assets"], responseHash: "r" }, bodyHead: head, contentType: "application/json" };
  assert.equal(l2ReadingOf(row, schema), "not_checked");
  const facts = assembleSellerFacts({
    probes: [],
    purchases: [{ attemptedAt: new Date(NOW - 86_400_000).toISOString(), status: "settled", latencyMs: 1, httpStatusPaid: 200, payloadNonEmpty: true, l2Schema: "mismatch", txHash: "0x1", network: "eip155:8453", l2Detail: { missing: ["count", "assets"], declarationHash: "d", responseHash: "r" }, bodyHead: head, contentType: "application/json" }],
    settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
    payees: [],
    declaredSchema: schema,
    lastAttemptAt: null,
  });
  assert.equal(facts.l2.status, "not_checked", "判定の facts.l2 も同じ読み直し");
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  assert.match(read("src/lib/observatory/reader.ts"), /l2Reading: rest\.l2Schema === null \? null : l2ReadingOf\(/);
  assert.match(read("src/app/api/v1/observatory/export.csv/route.ts"), /l2_reading: l2Schema === null \? null : l2ReadingOf\(/);
  assert.match(read("src/app/observatory/e/[id]/page.tsx"), /L2 \{p\.l2Reading \?\? p\.l2Schema/);
});
