// ============================================================
// 「どちらの側か」の規則（2026-09-29 敵対的監査）— /sellers の分類と、払う前の判定（decision）の公平性。
//
// 監査は名指しされた売り手の立場で無作為 15 社を一次証拠で検証し、「seller's side」とされた失敗のうち
// 次が誤りか疑わしいと指摘した。ここではその 5 つの規則と、判定 API への波及を固定する。
//   1. 判定保留（held_reason がある）・照合待ちの行は seller の側に数えない
//   2. 宣言クエリの有無は、送る規則と同じ情報源（402 / 掲載の `bazaar.info.input` の見本値）で見る
//   3. 本文を送る前の 415 も vet402 の側
//   4. （recover-late の nonce での結びつけ: tests/late-settlement-nonce.pg.test.ts）
//   5. 課金されていない（レシートも tx も無い）4xx・2xx は seller の側にしない
//   8. 判定 API: vet402 の側・保留・課金なしだけでは BLOCK にしない。売り手の本物の失敗は従来どおり BLOCK
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRow, FIX_MODES, LATE_LINK_AFTER_MIN, LATE_LINK_BEFORE_MIN, type SellerRowFacts } from "@/lib/sellers/fix-modes";
import { heldReasonOf } from "@/lib/observatory/delivery";
import { LATE_SETTLEMENT_BACKDATE_MINUTES, LATE_SETTLEMENT_WINDOW_MINUTES } from "@/lib/settlements/recover-late";
import { declaredInputSummary } from "@/lib/observatory/declared-input-rules";
import { declaredRequestBody, declaredRequestUrl } from "@/lib/observatory/declared-input";
import { parseCatalogItem } from "@/lib/observatory/catalog-source";
import { assembleSellerFacts, l1NotCountedOf, notCountedReasonOf, type PurchaseInput } from "@/lib/decision/seller-facts";
import { conclusiveAttempts, decidePayer } from "@/lib/decision/rules";
import type { SellerFacts } from "@/lib/decision/types";
import { AUTHORIZATION_USED_TOPIC, readAuthorizationNonces, type EvmVerifyClient } from "@/lib/observatory/settlement-verify";

const TX = `0x${"ab".repeat(32)}`;
let seq = 0;
function row(p: Partial<SellerRowFacts>): SellerRowFacts {
  seq++;
  return {
    endpointId: `ep-${seq}`,
    status: "settle_failed",
    httpStatusPaid: null,
    txHash: null,
    attemptedAt: "2026-09-20T12:00:00Z",
    network: "eip155:8453",
    method: "GET",
    meta: null,
    schema: null,
    declaredInput: null,
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    ...p,
  };
}

// ---------- 1. 判定保留は seller の側に数えない ----------

test("1: held_reason のある行は、どの status・HTTP でも seller の側にならない（受け入れ: seller の件数 = held_reason 空欄の売り手側の型）", () => {
  const statuses = ["settled", "settle_failed", "delivered_no_receipt", "settle_claimed", "settle_claim_refuted", "settle_claimed_unverifiable", "no_402"];
  const codes = [null, 200, 201, 301, 400, 401, 402, 403, 404, 405, 408, 409, 415, 422, 429, 500, 502, 503];
  const times = ["2026-09-10T00:00:00Z", "2026-09-14T00:00:00Z", "2026-09-22T00:00:00Z", "2026-09-28T00:00:00Z"];
  let held = 0;
  let seller = 0;
  for (const status of statuses)
    for (const http of codes)
      for (const at of times)
        for (const tx of [null, TX])
          for (const method of ["GET", "POST"]) {
            const r = row({ status, httpStatusPaid: http, txHash: tx, attemptedAt: at, method, unpaidStatus: http });
            const h = heldReasonOf({ status, httpStatusPaid: http, txHash: tx, attemptedAt: at, network: r.network });
            const c = classifyRow(r);
            if (h !== null) {
              held++;
              assert.notEqual(c.bucket, "seller", `${status} ${http} ${at} ${tx ? "tx" : "no tx"} held as ${h}`);
            }
            if (c.bucket === "seller") {
              seller++;
              assert.equal(h, null, "every seller-side row has an empty held_reason");
            }
          }
  assert.ok(held > 50 && seller > 50, `${held} held, ${seller} seller`);
});

test("1: 保留の行は「not sorted (held)」、課金なしは「not sorted: no charge」と書く", () => {
  const settled = classifyRow(row({ status: "settled", httpStatusPaid: 404, txHash: TX }));
  assert.equal(settled.mode?.key, "settled_then_rejected");
  assert.equal(settled.mode?.sideLabel, "not sorted (held)");
  const refused = classifyRow(row({ status: "settle_failed", httpStatusPaid: 404 }));
  assert.equal(refused.mode?.sideLabel, "not sorted: no charge");
  for (const m of FIX_MODES.filter((x) => x.side === "unsorted" && x.key !== "other")) {
    assert.match(m.fix, /^Nothing is counted against the seller\./, m.key);
  }
});

// ---------- 2. 宣言クエリの情報源（監査の実例: site.intel.rallylive.ca・insider.lonestaroracle.xyz） ----------

// 監査の証拠（adv/hits.json）の Bazaar の掲載そのまま（必要な部分だけ）。
const RALLYLIVE_ITEM = {
  accepts: [{ amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453", payTo: "0xFC24FD34da9e49A0110DCaEe3Ad30eC54175eBB3", scheme: "exact" }],
  extensions: {
    bazaar: {
      info: { input: { method: "GET", queryParams: { domain: "github.com" }, type: "http" } },
      schema: { properties: { input: { properties: { method: { enum: ["GET"] }, queryParams: { properties: {}, type: "object" }, type: { const: "http" } } } } },
    },
  },
  resource: "https://site.intel.rallylive.ca/site/uses/mapbox",
};
const INSIDER_ITEM = {
  accepts: [{ amount: "30000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453", payTo: "0x52Ab53912D37759B2ad364f22dD06B16714b6C06", scheme: "exact" }],
  extensions: {
    bazaar: {
      info: { input: { method: "GET", queryParams: { days: 90, symbol: "AAPL", ticker: "AAPL" }, type: "http" } },
      schema: { properties: { input: { properties: { queryParams: { type: "object", properties: { days: {}, symbol: {}, ticker: {} } } } } } },
    },
  },
  resource: "https://insider.lonestaroracle.xyz/trades",
};
const NEURO_ITEM = {
  accepts: [{ amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453", payTo: "0xa369aC3412360206DB63507b190E691c0C5B9F3e", scheme: "exact" }],
  extensions: {
    bazaar: {
      info: { input: { body: { file: "<binary WAV audio>", model: "whisper-1" }, bodyType: "form-data", method: "POST", type: "http" } },
      schema: { properties: { input: { properties: { body: { type: "object", required: ["file"] } } } } },
    },
  },
  resource: "https://api.neurodynamic.tech/v1/audio/transcriptions",
};

/** L1 が 402 の応答から実際に組む規則（PAYMENT-REQUIRED ヘッダに同じ文書を載せる）。 */
function declaredInputRequestFromLive(item: { resource: string } & Record<string, unknown>) {
  const doc = { x402Version: 2, ...item };
  const headers = new Headers({ "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(doc), "utf8").toString("base64") });
  return {
    query: declaredRequestUrl({ resourceUrl: item.resource, bodyText: "", headers }).source,
    body: declaredRequestBody({ bodyText: "", headers }).source,
  };
}

test("2: 掲載の要約は送る規則そのもの（declared-input の規則を同じ文書に当てた結果と一致）", () => {
  for (const item of [RALLYLIVE_ITEM, INSIDER_ITEM, NEURO_ITEM]) {
    const parsed = parseCatalogItem(item);
    assert.deepEqual(parsed.declaredInput, declaredInputSummary({ resourceUrl: item.resource, document: item }));
    // 402 の本文として同じ文書を渡したとき、L1 が実際に送る規則（declaredRequestUrl / declaredRequestBody）と同じ答え
    assert.deepEqual(parsed.declaredInput, declaredInputRequestFromLive(item));
  }
  assert.deepEqual(parseCatalogItem(RALLYLIVE_ITEM).declaredInput, { query: "declared", body: "empty" });
  assert.deepEqual(parseCatalogItem(INSIDER_ITEM).declaredInput, { query: "declared", body: "empty" });
  assert.deepEqual(parseCatalogItem(NEURO_ITEM).declaredInput, { query: "empty", body: "declared" });
  assert.deepEqual(parseCatalogItem({ resource: "https://x.example/a" }).declaredInput, { query: "empty", body: "empty" });
});

test("2: rallylive / insider の 09-22 の 400 は vet402 の側（スキーマに必須が無くても、見本値の宣言がある）", () => {
  for (const [item, at] of [
    [RALLYLIVE_ITEM, "2026-09-22T00:01:36Z"],
    [INSIDER_ITEM, "2026-09-22T00:01:02Z"],
  ] as const) {
    const p = parseCatalogItem(item);
    const r = row({ status: "settle_failed", httpStatusPaid: 400, attemptedAt: at, schema: p.declaredSchema, declaredInput: p.declaredInput, meta: { requestBody: true } });
    const c = classifyRow(r);
    assert.equal(c.mode?.key, "query_not_sent", item.resource);
    assert.equal(c.bucket, "vet402");
    // 要約がまだ無い（catalog-sync 前）なら、スキーマだけの判定に戻る（seller の側には置かない: 課金なし）
    const before = classifyRow({ ...r, declaredInput: null });
    assert.notEqual(before.bucket, "seller");
    // 境目の後は vet402 の側にしない
    assert.notEqual(classifyRow({ ...r, attemptedAt: "2026-09-27T23:27:16Z" }).mode?.key, "query_not_sent");
  }
});

// ---------- 3. 415 ----------

test("3: neurodynamic の 09-10 の 415（本文を送る前・form-data の file を宣言）は vet402 の側。境目の後は違う", () => {
  const p = parseCatalogItem(NEURO_ITEM);
  const r = row({ status: "settle_failed", httpStatusPaid: 415, method: "POST", attemptedAt: "2026-09-10T12:07:00Z", schema: p.declaredSchema, declaredInput: p.declaredInput });
  assert.equal(classifyRow(r).mode?.key, "body_not_sent");
  assert.equal(classifyRow({ ...r, schema: null }).mode?.key, "body_not_sent", "the declared_input alone is enough");
  assert.equal(classifyRow({ ...r, attemptedAt: "2026-09-16T23:25:55Z" }).mode?.key, "refused_no_charge");
  // 決済済みの 415 も同じ（本文を送らなかったのはこちら）
  assert.equal(classifyRow({ ...r, status: "settled", txHash: TX }).mode?.key, "body_not_sent");
});

// ---------- 5. 課金なし ----------

test("5: 402signal（レシート無しの 200・tx なし）と rubric（決済されない 404）は seller の側にしない", () => {
  const signal = classifyRow(row({ status: "delivered_no_receipt", httpStatusPaid: 200, method: "POST", attemptedAt: "2026-09-17T15:23:13Z" }));
  assert.equal(signal.mode?.key, "answered_no_charge");
  assert.equal(signal.bucket, "unsorted");
  const rubric = classifyRow(row({ status: "settle_failed", httpStatusPaid: 404, method: "POST", attemptedAt: "2026-09-24T18:01:40Z", meta: { requestBody: true } }));
  assert.equal(rubric.mode?.key, "refused_no_charge");
  assert.equal(rubric.bucket, "unsorted");
  // 着金が結びついた行（tx あり）は課金なしではない
  assert.equal(classifyRow(row({ status: "delivered_no_receipt", httpStatusPaid: 200, txHash: TX })).bucket, "seller");
  // 払った後の 5xx・払った要求への 402 は従来どおり売り手の側
  assert.equal(classifyRow(row({ status: "settle_failed", httpStatusPaid: 500 })).bucket, "seller");
  assert.equal(classifyRow(row({ status: "settle_failed", httpStatusPaid: 402 })).bucket, "seller");
  // 支払い前の応答（no_402 の 404 = 掲載の URL が無い）は課金の話ではない
  assert.equal(classifyRow(row({ status: "no_402", network: null, unpaidStatus: 404 })).mode?.key, "gone");
});

test("5: 課金なしの文面は遅延回収の窓（recover-late.ts）と同じ数字を言う", () => {
  assert.equal(LATE_LINK_BEFORE_MIN, LATE_SETTLEMENT_BACKDATE_MINUTES);
  assert.equal(LATE_LINK_AFTER_MIN, LATE_SETTLEMENT_WINDOW_MINUTES);
  const m = FIX_MODES.find((x) => x.key === "answered_no_charge")!;
  assert.ok(m.what.includes(`${LATE_SETTLEMENT_BACKDATE_MINUTES} minutes before to ${LATE_SETTLEMENT_WINDOW_MINUTES} minutes after`));
});

// ---------- 4. レシートの nonce を読む ----------

test("4: readAuthorizationNonces はレシートの AuthorizationUsed のうち、payer が authorizer のものだけを返す", async () => {
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const payer = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const topicOf = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
  const n1 = "0x0d4612ff13aefe46297d19bdbdff5b7b80d5861eef13dfc868a24402fcbad9cc";
  const n2 = `0x${"11".repeat(32)}`;
  const client = {
    getChainId: async () => 8453,
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ timestamp: 0n }),
    getTransactionReceipt: async () => ({
      status: "success",
      blockNumber: 1n,
      logs: [
        { address: USDC, topics: [AUTHORIZATION_USED_TOPIC, topicOf(payer), n1] },
        { address: USDC, topics: [AUTHORIZATION_USED_TOPIC, topicOf("0x" + "22".repeat(20)), n2] }, // 別の authorizer
        { address: "0x" + "33".repeat(20), topics: [AUTHORIZATION_USED_TOPIC, topicOf(payer), n2] }, // 別のトークン
      ],
    }),
  } as unknown as EvmVerifyClient;
  const tx = "0x65862479c7dd2d101a501edd95ec39daa3683aee40e315dee21668f4baecd5f3";
  assert.deepEqual(await readAuthorizationNonces({ network: "eip155:8453", txHash: tx, payer }, { client }), [n1]);
  assert.equal(await readAuthorizationNonces({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", txHash: tx, payer }, { client }), null);
  assert.equal(await readAuthorizationNonces({ network: "eip155:8453", txHash: "0xnope", payer }, { client }), null);
  const wrongChain = { ...client, getChainId: async () => 1 } as unknown as EvmVerifyClient;
  assert.equal(await readAuthorizationNonces({ network: "eip155:8453", txHash: tx, payer }, { client: wrongChain }), null);
  const reverted = { ...client, getTransactionReceipt: async () => ({ status: "reverted", blockNumber: 1n, logs: [] }) } as unknown as EvmVerifyClient;
  assert.equal(await readAuthorizationNonces({ network: "eip155:8453", txHash: tx, payer }, { client: reverted }), null);
  const broken = { ...client, getTransactionReceipt: async () => { throw new Error("rpc down"); } } as unknown as EvmVerifyClient;
  assert.equal(await readAuthorizationNonces({ network: "eip155:8453", txHash: tx, payer }, { client: broken }), null);
});

// ---------- 8. 判定 API の公平性 ----------

const okFacts: SellerFacts = {
  l0: { status: "pass", observed_at: "2026-09-28T00:00:00Z", dialect: "v2", fail_reason: null },
  l1: { n_delivered: 0, n_settled: 0, n_attempts: 3, n_inconclusive: 0, n_probe_error: 0, p50_ms: null, p95_ms: null, last_purchase_id: null, observed_at: null, last_attempt_at: null },
  l2: { status: "undeclared", declaration_hash: null, response_hash: null, diff_hash: null, missing_keys: null, observed_at: null },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: ["eip155:8453:0xb"],
  settlement_30d_real: 259,
  settlement_30d_raw: 300,
  settlement_30d_test: 0,
  unique_payers_30d_real: 19,
  wash_dominated: false,
};
const withL1 = (l1: Partial<SellerFacts["l1"]>): SellerFacts => ({ ...okFacts, l1: { ...okFacts.l1, ...l1 } });
const nc = (vet402_side: number, held: number, no_charge: number) => ({ l1NotCounted: { total: vet402_side + held + no_charge, by: { vet402_side, held, no_charge } } });

test("8: 境界 — 除く試行を引いた結論の数が 3 に届くかで BLOCK と WARN が分かれる", () => {
  // 従来どおり: 売り手の側の失敗 3 回・配達 0 → BLOCK
  assert.equal(decidePayer(withL1({ n_attempts: 3 }), nc(0, 0, 0)).recommendation, "BLOCK");
  assert.equal(decidePayer(withL1({ n_attempts: 3 })).recommendation, "BLOCK", "no l1NotCounted: the old rule");
  // 3 回とも課金なし → BLOCK にしない（WARN・l1_inconclusive・理由コードに明記）
  const noCharge = decidePayer(withL1({ n_attempts: 3 }), nc(0, 0, 3));
  assert.equal(noCharge.recommendation, "WARN");
  assert.ok(noCharge.reason_codes.includes("l1_inconclusive"));
  assert.ok(noCharge.reason_codes.includes("l1_not_counted_no_charge"));
  assert.ok(!noCharge.reason_codes.includes("l1_never_delivered"));
  // 4 回・1 回除く → 結論 3 → BLOCK（売り手の本物の失敗が 3 回ある）
  const b = decidePayer(withL1({ n_attempts: 4 }), nc(1, 0, 0));
  assert.equal(b.recommendation, "BLOCK");
  assert.ok(b.reason_codes.includes("l1_never_delivered"));
  assert.ok(b.reason_codes.includes("l1_not_counted_vet402_side"));
  // 4 回・2 回除く → 結論 2 → WARN（l1_never_delivered だが BLOCK には届かない）
  const w = decidePayer(withL1({ n_attempts: 4 }), nc(0, 2, 0));
  assert.equal(w.recommendation, "WARN");
  assert.ok(w.reason_codes.includes("l1_never_delivered"));
  assert.ok(w.reason_codes.includes("l1_not_counted_held"));
  // 渡さなければ n_inconclusive で読む
  assert.equal(conclusiveAttempts(withL1({ n_attempts: 5, n_inconclusive: 2 })), 3);
  assert.equal(decidePayer(withL1({ n_attempts: 5, n_inconclusive: 2 })).recommendation, "BLOCK");
  // 除く数が n_inconclusive より小さく来ても、保留は必ず除く
  assert.equal(conclusiveAttempts(withL1({ n_attempts: 5, n_inconclusive: 3 }), nc(1, 0, 0).l1NotCounted), 2);
  // 配達があれば除いた理由は載せない（判定に効いていない）
  const delivered = decidePayer(withL1({ n_delivered: 1, n_settled: 1, n_attempts: 4 }), nc(1, 1, 1));
  assert.ok(!delivered.reason_codes.some((c) => c.startsWith("l1_not_counted_")));
  // 公開の facts の形は変えない（SDK・openapi と対）
  assert.ok(!("n_not_counted" in okFacts.l1));
});

const P = (p: Partial<PurchaseInput>): PurchaseInput => ({
  attemptedAt: "2026-09-20T18:00:39Z",
  status: "settle_failed",
  latencyMs: 500,
  httpStatusPaid: null,
  payloadNonEmpty: null,
  l2Schema: null,
  txHash: null,
  network: "eip155:8453",
  ...p,
});
const inputOf = (purchases: PurchaseInput[], extra: { method?: string; declaredSchema?: unknown; declaredInput?: unknown } = {}) => ({
    probes: [
      { probedAt: "2026-09-28T00:00:00Z", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
      { probedAt: "2026-09-27T00:00:00Z", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
    ],
    purchases,
    settlements30d: { raw: 259, real: 259, test: 0, uniquePayersReal: 19 },
    payees: ["eip155:8453:0xb"],
    declaredSchema: extra.declaredSchema ?? null,
    method: extra.method ?? "POST",
    declaredInput: extra.declaredInput ?? null,
    lastAttemptAt: purchases[0]?.attemptedAt ?? null,
  });
/** 本番の経路（loadSellerFacts → decide）と同じく、facts と除く数を組にして判定する。 */
const judge = (purchases: PurchaseInput[], extra: { method?: string; declaredSchema?: unknown; declaredInput?: unknown } = {}) => {
  const input = inputOf(purchases, extra);
  const facts = assembleSellerFacts(input);
  const notCounted = l1NotCountedOf(input);
  return { facts, notCounted, decision: decidePayer(facts, { l1NotCounted: notCounted }) };
};

test("8: stableenrich の people-search 型（L1 3 回とも「レシート無しの 200・着金なし」）は BLOCK にしない", () => {
  const rows = ["2026-09-20T18:00:39Z", "2026-09-19T12:08:58Z", "2026-09-18T00:01:27Z"].map((at) =>
    P({ attemptedAt: at, status: "delivered_no_receipt", httpStatusPaid: 200, payloadNonEmpty: true, requestMeta: { requestBody: true } }),
  );
  const { facts, notCounted, decision } = judge(rows);
  assert.equal(facts.l1.n_attempts, 3);
  assert.equal(facts.l1.n_inconclusive, 0, "held_reason is unchanged (the public export column)");
  assert.deepEqual(notCounted, { total: 3, by: { vet402_side: 0, held: 0, no_charge: 3 } });
  // 修正前の判定（除く数を渡さない）は BLOCK だった
  assert.equal(decidePayer(facts).recommendation, "BLOCK");
  assert.equal(decision.recommendation, "WARN");
  assert.deepEqual(
    decision.reason_codes.filter((c) => c.startsWith("l1_")),
    ["l1_inconclusive", "l1_not_counted_no_charge"],
  );
});

test("8: 売り手の本物の失敗（払った要求への 5xx・署名した支払いへの 402）は従来どおり BLOCK", () => {
  const five = judge([1, 2, 3].map((i) => P({ attemptedAt: `2026-09-2${i}T00:00:00Z`, httpStatusPaid: 500 })));
  assert.equal(five.notCounted.total, 0);
  assert.equal(five.decision.recommendation, "BLOCK");
  assert.ok(five.decision.reason_codes.includes("l1_never_delivered"));
  const refused = judge([1, 2, 3].map((i) => P({ attemptedAt: `2026-09-2${i}T00:00:00Z`, httpStatusPaid: 402 })));
  assert.equal(refused.decision.recommendation, "BLOCK");
  const refuted = judge([1, 2, 3].map((i) => P({ attemptedAt: `2026-09-2${i}T00:00:00Z`, status: "settle_claim_refuted", httpStatusPaid: 200, txHash: TX })));
  assert.equal(refuted.decision.recommendation, "BLOCK");
  // 課金なし 2 回 + 本物の失敗 3 回 → BLOCK
  const mixed = judge([
    ...[1, 2].map((i) => P({ attemptedAt: `2026-09-1${i}T00:00:00Z`, status: "delivered_no_receipt", httpStatusPaid: 200, payloadNonEmpty: true })),
    ...[1, 2, 3].map((i) => P({ attemptedAt: `2026-09-2${i}T00:00:00Z`, httpStatusPaid: 503 })),
  ]);
  assert.equal(mixed.notCounted.total, 2);
  assert.equal(mixed.decision.recommendation, "BLOCK");
  // 課金なし 2 回 + 本物の失敗 2 回 → 結論 2 → WARN
  const mixed2 = judge([
    ...[1, 2].map((i) => P({ attemptedAt: `2026-09-1${i}T00:00:00Z`, status: "delivered_no_receipt", httpStatusPaid: 200, payloadNonEmpty: true })),
    ...[1, 2].map((i) => P({ attemptedAt: `2026-09-2${i}T00:00:00Z`, httpStatusPaid: 503 })),
  ]);
  assert.equal(mixed2.decision.recommendation, "WARN");
  // 配達が 1 回でもあれば従来どおり（ALLOW 側の規則は変えない）
  const ok = judge([P({ attemptedAt: "2026-09-25T00:00:00Z", status: "settled", httpStatusPaid: 200, payloadNonEmpty: true, txHash: TX })]);
  assert.equal(ok.decision.recommendation, "ALLOW");
});

test("8: vet402 の側（宣言の本文を送る前の 400・資金切れの 402）と照合待ちだけでも BLOCK にしない", () => {
  const body = judge(
    [1, 2, 3].map((i) => P({ attemptedAt: `2026-09-1${i}T00:00:00Z`, httpStatusPaid: 400 })),
    { method: "POST", declaredInput: { query: "empty", body: "declared" } },
  );
  assert.deepEqual(body.notCounted.by, { vet402_side: 3, held: 0, no_charge: 0 });
  assert.equal(body.decision.recommendation, "WARN");
  assert.ok(body.decision.reason_codes.includes("l1_not_counted_vet402_side"));
  const unfunded = judge(["2026-09-13T01:00:00Z", "2026-09-14T01:00:00Z", "2026-09-15T01:00:00Z"].map((at) => P({ attemptedAt: at, httpStatusPaid: 402 })));
  assert.equal(unfunded.decision.recommendation, "WARN");
  const pending = judge([1, 2, 3].map((i) => P({ attemptedAt: `2026-09-2${i}T00:00:00Z`, status: "settle_claimed", httpStatusPaid: 200, txHash: TX })));
  assert.deepEqual(pending.notCounted.by, { vet402_side: 0, held: 3, no_charge: 0 });
  assert.equal(pending.decision.recommendation, "WARN");
  // 署名していない行（over_cap 等）は数にも除外にも入らない
  const unsigned = judge([1, 2, 3].map((i) => P({ attemptedAt: `2026-09-2${i}T00:00:00Z`, status: "over_cap" })));
  assert.deepEqual(unsigned.notCounted, { total: 0, by: { vet402_side: 0, held: 0, no_charge: 0 } });
});

test("8: 判定の除外は /sellers の分類と同じ（署名した行の全組み合わせで、seller の側・未分類だけが数えられる）", () => {
  const statuses = ["settled", "settle_failed", "delivered_no_receipt", "settle_claimed", "settle_claim_refuted", "settle_claimed_unverifiable"];
  for (const status of statuses)
    for (const http of [null, 200, 400, 401, 402, 404, 415, 422, 429, 500])
      for (const at of ["2026-09-10T00:00:00Z", "2026-09-14T00:00:00Z", "2026-09-25T00:00:00Z"])
        for (const tx of [null, TX]) {
          const p = P({ status, httpStatusPaid: http, attemptedAt: at, txHash: tx });
          const endpoint = { method: "POST", declaredSchema: null, declaredInput: { query: "declared", body: "declared" } };
          const c = classifyRow(row({ status, httpStatusPaid: http, attemptedAt: at, txHash: tx, method: "POST", declaredInput: endpoint.declaredInput }));
          const counted = notCountedReasonOf(p, endpoint) === null;
          // 2026-09-29 独立レビュー: 判定は払う側に慎重。中身の届いていない「課金なし」の 2xx は /sellers では
          // 未分類（売り手に不利にしない）だが、判定では数える（tx 無しは課金なしの証明ではない）。
          const sellerOrOther =
            c.bucket === "seller" || c.mode?.key === "other" || c.bucket === "delivered" ||
            (c.mode?.key === "answered_no_charge" && p.payloadNonEmpty !== true);
          assert.equal(counted, sellerOrOther, `${status} ${http} ${at} ${tx ? "tx" : "-"}: ${c.bucket}/${c.mode?.key}`);
        }
});

test("8: 2026-09-29 独立レビュー（BLOCK）: 空の 200・レシート無し・tx 無しは「課金なし」として外さない（裏で決済する売り手が BLOCK を逃れない）", () => {
  const rows = ["2026-09-20T18:00:39Z", "2026-09-19T12:08:58Z", "2026-09-18T00:01:27Z"].map((at) =>
    P({ attemptedAt: at, status: "delivered_no_receipt", httpStatusPaid: 200, payloadNonEmpty: false, requestMeta: { requestBody: true } }),
  );
  const { notCounted, decision } = judge(rows);
  assert.equal(notCounted.by.no_charge, 0);
  assert.equal(decision.recommendation, "BLOCK");
});
