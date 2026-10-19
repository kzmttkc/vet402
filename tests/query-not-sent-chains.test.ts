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
  QUERY_NOT_SENT_SIGNED_STATUSES,
  TEMPO_QUERY_NETWORKS,
  queryNotSentOnOurSide,
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
});

test("境目の瞬間（2026-09-20T00:00:00Z）は対象。日付の比較を反転すると落ちる", () => {
  const r = row({ attemptedAt: DECLARED_QUERY_RECORD_SINCE });
  assert.equal(queryNotSentOnOurSide(notSentInput(r)), true);
  assertSameReaders(r, "query_not_sent", "vet402");
  const before = row({ attemptedAt: "2026-09-19T23:59:59.999Z" });
  assert.equal(queryNotSentOnOurSide(notSentInput(before)), false);
  assert.equal(classifyRow(before).mode?.key, "refused_no_charge");
});

test("決済済み: Base は今までどおり charged_unsent_input。他チェーンは vet402 の側のまま", () => {
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
  assertSameReaders(celo, "query_not_sent", "vet402");
  // tx がある settle_failed（記録が無く input_unrecorded になっていた形）もこちらの側。
  const withTx = row({ txHash: TX });
  assertSameReaders(withTx, "query_not_sent", "vet402");
});
