// ============================================================
// 宣言クエリを送らずに払った行（Base 以外・2026-10-19）。
// 条件を全部満たす行は vet402 の側。判定（rowViewOf）・/sellers（classifySellerRow）・export は同じ分類を読む。
// 条件を 1 つ外すと今までの種類に戻る。その否定を反転させたら、このファイルの対応する assert が落ちる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { notCountedReasonOf, rowViewOf, type PurchaseInput } from "@/lib/decision/seller-facts";
import { TEMPO_MAINNET_CAIP2, TEMPO_MODERATO_CAIP2 } from "@/lib/observatory/mpp-payer";
import {
  DECLARED_QUERY_RECORD_SINCE,
  OTHER_CHAIN_QUERY_UNSENT_UNTIL,
  QUERY_NOT_SENT_SIGNED_STATUSES,
  TEMPO_QUERY_NETWORKS,
  otherChainQueryUnsentUntil,
  queryNotSentOnOurSide,
  queryNotSentOnOurSideSql,
} from "@/lib/observatory/request-query";
import { buildSellerExportRows } from "@/lib/sellers/export";
import {
  classifyRow,
  classifySellerRow,
  notSentInput,
  sideLabelOf,
  SIGNED_ROW_STATUSES,
  type SellerRowFacts,
} from "@/lib/sellers/fix-modes";

const CELO = "eip155:42220";
const BNB = "eip155:56";
const STELLAR = "stellar:pubnet";
const ARC = "eip155:5042";
const XRPL = "xrpl:0";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TX = `0x${"ab".repeat(32)}`;

function row(p: Partial<SellerRowFacts> & { declaresQuery?: boolean }): SellerRowFacts {
  const { declaresQuery, ...rest } = p;
  return {
    endpointId: "ep-q",
    status: "settle_failed",
    httpStatusPaid: 400,
    txHash: null,
    attemptedAt: "2026-10-01T00:00:00Z",
    network: CELO,
    method: "GET",
    meta: null,
    schema: declaresQuery === false ? null : { properties: { input: { properties: { queryParams: { required: ["q"] } } } } },
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    ...rest,
  };
}

function purchaseOf(r: SellerRowFacts): PurchaseInput {
  return {
    attemptedAt: r.attemptedAt,
    status: r.status,
    latencyMs: null,
    httpStatusPaid: r.httpStatusPaid,
    payloadNonEmpty: null,
    l2Schema: null,
    txHash: r.txHash,
    network: r.network,
    requestMeta: r.meta,
  };
}

/** 判定 API・/sellers・export が classifySellerRow と同じ答えを読む。 */
function assertSameReaders(r: SellerRowFacts, modeKey: string, bucket: string) {
  const sellers = classifySellerRow(r);
  assert.equal(sellers.mode?.key, modeKey);
  assert.equal(sellers.bucket, bucket);
  assert.equal(classifyRow(r).mode?.key, modeKey);
  const exported = buildSellerExportRows(
    [{ endpointId: r.endpointId, resourceKey: "h.example/api", host: "h.example" }],
    [{ ...r, host: "h.example" }],
  )[0];
  assert.equal(exported.outcome, sellers.bucket);
  assert.equal(exported.fix_mode, sellers.mode?.key ?? "");
  assert.equal(exported.side_label, sellers.mode ? sideLabelOf(sellers.mode) : "");
  const view = rowViewOf(purchaseOf(r), { method: r.method, declaredSchema: r.schema, declaredInput: r.declaredInput });
  assert.equal(view.bucket, sellers.bucket);
  assert.equal(view.modeKey, sellers.mode?.key ?? null);
  if (bucket === "vet402") assert.equal(notCountedReasonOf(view, purchaseOf(r)), "vet402_side");
}

test("署名した status と Tempo の network は、それぞれの正典と 1 つ", () => {
  assert.deepEqual([...QUERY_NOT_SENT_SIGNED_STATUSES].sort(), [...SIGNED_ROW_STATUSES].sort());
  assert.deepEqual([...TEMPO_QUERY_NETWORKS], [TEMPO_MAINNET_CAIP2, TEMPO_MODERATO_CAIP2]);
  assert.equal(DECLARED_QUERY_RECORD_SINCE, "2026-09-20T00:00:00Z");
});

test("DECLARED_QUERY_RECORD_SINCE の値は request-query.ts の 1 か所だけ", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  walk(join(process.cwd(), "src"));
  const holders = files.filter((f) => readFileSync(f, "utf8").includes(`"${DECLARED_QUERY_RECORD_SINCE}"`)).map((f) => f.slice(process.cwd().length + 1));
  assert.deepEqual(holders, ["src/lib/observatory/request-query.ts"]);
});

test("retest の (c) は Base の境目より前の条だけを読む", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/observatory/retest-sellers-sql.ts"), "utf8");
  assert.match(src, /queryNotSentOnBaseBeforeCutoffSql/);
  assert.doesNotMatch(src, /queryNotSentOnOurSideSql/);
});

test("Celo・BNB・Stellar・Arc は、条件を全部満たすと vet402 の側。判定・/sellers・export は同じ", () => {
  for (const network of [CELO, BNB, STELLAR, ARC]) {
    const r = row({ network });
    assert.equal(queryNotSentOnOurSide(notSentInput(r)), true, network);
    assertSameReaders(r, "query_not_sent", "vet402");
    assert.match(classifyRow(r).mode?.what ?? "", /vet402 did not send the query the listing declares/);
  }
});

test("条件を 1 つ外すと今までどおり（query_not_sent にしない）", () => {
  const stay = (label: string, r: SellerRowFacts, key: string) => {
    assert.equal(queryNotSentOnOurSide(notSentInput(r)), false, label);
    assert.equal(classifyRow(r).mode?.key, key, label);
    assertSameReaders(r, key, key === "query_not_sent" ? "vet402" : classifySellerRow(r).bucket);
  };
  stay("requestQuery declared", row({ meta: { requestQuery: "declared" } }), "refused_no_charge");
  stay("requestQuery empty は記録", row({ meta: { requestQuery: "empty" } }), "refused_no_charge");
  stay("宣言にクエリが無い", row({ declaresQuery: false }), "refused_no_charge");
  stay("Tempo", row({ network: "eip155:4217" }), "refused_no_charge");
  stay("2026-09-20 より前", row({ attemptedAt: "2026-09-19T23:59:59Z" }), "refused_no_charge");
  stay("401", row({ httpStatusPaid: 401 }), "refused_no_charge");
  stay("network が空", row({ network: "" }), "refused_no_charge");
  stay("表に無い network", row({ network: "eip155:1" }), "refused_no_charge");
});

test("境目の瞬間（2026-09-20T00:00:00Z）は対象。日付の比較を反転すると落ちる", () => {
  const r = row({ attemptedAt: DECLARED_QUERY_RECORD_SINCE });
  assert.equal(queryNotSentOnOurSide(notSentInput(r)), true);
  assertSameReaders(r, "query_not_sent", "vet402");
  const before = row({ attemptedAt: "2026-09-19T23:59:59.999Z" });
  assert.equal(queryNotSentOnOurSide(notSentInput(before)), false);
  assert.equal(classifyRow(before).mode?.key, "refused_no_charge");
});

test("上限の時刻は表に 1 回で、SQL は表から作る", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/observatory/request-query.ts"), "utf8");
  const sql = queryNotSentOnOurSideSql({ row: "lr", schema: "lr.declared_schema", input: "lr.declared_input" });
  assert.equal(otherChainQueryUnsentUntil(XRPL), "2026-09-21T06:00:30Z");
  assert.equal(otherChainQueryUnsentUntil(SOLANA), "2026-10-01T12:00:20Z");
  assert.equal(otherChainQueryUnsentUntil(CELO), "2026-10-19T04:05:17Z");
  assert.equal(otherChainQueryUnsentUntil(ARC), otherChainQueryUnsentUntil(CELO));
  assert.equal(otherChainQueryUnsentUntil(STELLAR), otherChainQueryUnsentUntil(CELO));
  assert.equal(otherChainQueryUnsentUntil(BNB), otherChainQueryUnsentUntil(CELO));
  assert.equal(otherChainQueryUnsentUntil("eip155:8453"), null);
  assert.equal(otherChainQueryUnsentUntil("eip155:1"), null);
  for (const group of OTHER_CHAIN_QUERY_UNSENT_UNTIL) {
    assert.equal(src.split(`"${group.until}"`).length - 1, 1, group.until);
    assert.match(sql, new RegExp(group.until));
    for (const network of group.networks) assert.match(sql, new RegExp(network.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(sql, /outcomeWriteFailed/);
});

/** /sellers と export。判定の fallback（rowViewOf）は payTo を持たないので、ここは見ない。 */
function assertUnrecorded(r: SellerRowFacts, label: string) {
  assert.equal(classifyRow(r).mode?.key, "input_unrecorded", label);
  assert.equal(classifyRow(r).bucket, "unsorted", label);
  const sellers = classifySellerRow(r);
  assert.equal(sellers.mode?.key, "input_unrecorded", label);
  assert.equal(sellers.bucket, "unsorted", label);
  const exported = buildSellerExportRows(
    [{ endpointId: r.endpointId, resourceKey: "h.example/api", host: "h.example" }],
    [{ ...r, host: "h.example" }],
  )[0];
  assert.equal(exported.outcome, "unsorted", label);
  assert.equal(exported.fix_mode, "input_unrecorded", label);
}

/** 上限の時刻以降・tx あり。記録が無いので input_unrecorded（query_not_sent にしない）。 */
function afterCutoff(network: string, at: string): SellerRowFacts {
  return row({
    network,
    attemptedAt: at,
    txHash: TX,
    amountUnits: "20000",
    payTo: `0x${"11".repeat(20)}`,
    asset: `0x${"22".repeat(20)}`,
    declaresHeaders: false,
    pathTemplate: false,
  });
}

test("上限の前後（XRPL・Solana・Celo）。比較を反転すると落ちる", () => {
  const bounds = [
    [XRPL, "2026-09-21T06:00:30Z"],
    [SOLANA, "2026-10-01T12:00:20Z"],
    [CELO, "2026-10-19T04:05:17Z"],
  ] as const;
  for (const [network, until] of bounds) {
    const before = row({ network, attemptedAt: new Date(Date.parse(until) - 1).toISOString() });
    assert.equal(queryNotSentOnOurSide(notSentInput(before)), true, `${network} before`);
    assertSameReaders(before, "query_not_sent", "vet402");
    const at = afterCutoff(network, until);
    assert.equal(queryNotSentOnOurSide(notSentInput(at)), false, `${network} at cutoff`);
    assertUnrecorded(at, network);
    const later = afterCutoff(network, new Date(Date.parse(until) + 1).toISOString());
    assert.equal(queryNotSentOnOurSide(notSentInput(later)), false, `${network} after`);
    assertUnrecorded(later, `${network} later`);
  }
});

test("outcomeWriteFailed の行は、記録が無くても query_not_sent にしない", () => {
  const dropped = row({ meta: { outcomeWriteFailed: { cause: null, error: "db" } } });
  assert.equal(queryNotSentOnOurSide(notSentInput(dropped)), false);
  assert.notEqual(classifyRow(dropped).mode?.key, "query_not_sent");
  assert.equal(classifyRow(dropped).mode?.key, "refused_no_charge");
});

test("決済済み: 全チェーンで charged_unsent_input。classifyRow は query_not_sent のまま", () => {
  const base = row({
    network: "eip155:8453",
    status: "settled",
    txHash: TX,
    httpStatusPaid: 422,
    attemptedAt: "2026-09-20T00:00:00Z",
  });
  assert.equal(classifyRow(base).mode?.key, "query_not_sent");
  assert.equal(classifySellerRow(base).mode?.key, "charged_unsent_input");
  assert.equal(classifySellerRow(base).bucket, "unsorted");

  const celo = row({ status: "settled", txHash: TX, httpStatusPaid: 400 });
  assert.equal(classifyRow(celo).mode?.key, "query_not_sent");
  assert.equal(classifySellerRow(celo).mode?.key, "charged_unsent_input");
  assert.equal(classifySellerRow(celo).bucket, "unsorted");
  const exported = buildSellerExportRows(
    [{ endpointId: celo.endpointId, resourceKey: "h.example/api", host: "h.example" }],
    [{ ...celo, host: "h.example" }],
  )[0];
  assert.equal(exported.outcome, "unsorted");
  assert.equal(exported.fix_mode, "charged_unsent_input");
  const view = rowViewOf(purchaseOf(celo), { method: celo.method, declaredSchema: celo.schema, declaredInput: celo.declaredInput });
  assert.equal(view.bucket, "unsorted");
  assert.equal(view.modeKey, "charged_unsent_input");
  // 上限より前の tx あり未決済は今までどおり vet402。
  const withTx = row({ txHash: TX });
  assertSameReaders(withTx, "query_not_sent", "vet402");
  // settle_failed でも tx があり照合でお金が動いたと確かめた行は、決済済みと同じく charged_unsent_input。
  const confirmed = row({ status: "settle_failed", txHash: TX, settlementConfirmed: true });
  assert.equal(classifySellerRow(confirmed).bucket, "unsorted");
  assert.equal(classifySellerRow(confirmed).mode?.key, "charged_unsent_input");
  // 上限以降の決済済みは、記録が無いだけでは charged_unsent_input にしない。
  const after = row({ status: "settled", txHash: TX, httpStatusPaid: 400, attemptedAt: "2026-10-19T04:05:17Z" });
  assert.notEqual(classifySellerRow(after).mode?.key, "charged_unsent_input");
  assert.notEqual(classifyRow(after).mode?.key, "query_not_sent");
});
