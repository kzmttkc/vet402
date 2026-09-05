// ============================================================
// The Graph の x402 Base subgraph を読むリーダの契約。
//
// ここに並ぶのは**すべて 2026-09-05 に本番 Gateway で実測した挙動**であって、
// 想像した失敗ではない。とくに2つ:
//
//   1. **鍵が無いとき Gateway は 403 ではなく HTTP 200 と GraphQL の `errors` を返す。**
//      `response.ok` だけを見る実装はこれを成功と読み、受領 0 件として
//      「証拠が薄い」という**誤った理由**で拒否する。
//      認証されていないことと、一度も受け取っていないことは、まったく別のことである。
//   2. **1つのアドレスが PAYER 行と RECIPIENT 行の両方を持つ**
//      （実測 `0xf7b1356c…`: RECIPIENT 12,376,084 / PAYER 11,540,523）。
//
// 実行日時 2026-09-05 09:1x JST・`_meta.block.number` 50,889,853 / deployment
// `QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN`（賞の「静的データ不可」への証跡）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { readSubgraphReceipts, X402_BASE_SUBGRAPH_ID } from "../dist/index.js";

const ADDR = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";

/** 応答を1つ返すだけの fetch。送った URL と init を残す。 */
function stub(response) {
  const sent = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ url: String(url), init });
      if (response instanceof Error) throw response;
      return {
        ok: response.status < 400,
        status: response.status,
        json: async () => response.body,
        headers: new Map(),
      };
    },
  };
}

const live = (rows) => ({
  status: 200,
  body: { data: { x402AddressSummaries: rows, _meta: { block: { number: 50889853, timestamp: 1788569053 }, deployment: "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN" } } },
});

test("S1 鍵無しの実応答（HTTP 200 + GraphQL errors）は「読めなかった」——0 件ではない", async () => {
  const f = stub({ status: 200, body: { errors: [{ message: "auth error: missing authorization header" }] } });
  const r = await readSubgraphReceipts({ address: ADDR, fetch: f.fetch });
  assert.equal(r.ok, false);
  assert.match(r.error, /^graph_query_error: auth error/, "認証の失敗が、認証の失敗として残る");
});

test("S2 行が0件なら「読めた 0 件」——読めなかったことにしない", async () => {
  const f = stub(live([]));
  const r = await readSubgraphReceipts({ address: ADDR, fetch: f.fetch });
  assert.equal(r.ok, true);
  assert.equal(r.receipts, 0, "そのアドレスは一度も受け取っていない、と読めている");
  assert.equal(r.block.number, 50889853);
});

test("S3 `_meta.block` が無い応答は証拠にしない（live を読んだと言えないから）", async () => {
  const f = stub({ status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: "253" }] } } });
  const r = await readSubgraphReceipts({ address: ADDR, fetch: f.fetch });
  assert.equal(r.ok, false);
  assert.equal(r.error, "graph_no_block_meta");
});

test("S4 鍵は URL のパスに載るが、決定行に残す publicUrl には載らない", async () => {
  const f = stub(live([{ totalPayments: "253" }]));
  const r = await readSubgraphReceipts({ address: ADDR, fetch: f.fetch, apiKey: "SECRET_KEY_DO_NOT_LOG" });
  assert.equal(r.ok, true);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].url, /gateway\.thegraph\.com\/api\/SECRET_KEY_DO_NOT_LOG\/subgraphs\/id\//, "実際の問い合わせは鍵つき");
  assert.equal(r.publicUrl.includes("SECRET_KEY_DO_NOT_LOG"), false, "呼び手の鍵を決定行へ書き出さない");
  assert.equal(r.subgraphId, X402_BASE_SUBGRAPH_ID);
  assert.equal(r.receipts, 253);
});

test("S5 Gateway が落ちている（HTTP 5xx / 例外）は「読めなかった」", async () => {
  const a = await readSubgraphReceipts({ address: ADDR, fetch: stub({ status: 503, body: {} }).fetch });
  assert.equal(a.ok, false);
  assert.equal(a.error, "graph_http_503");
  const b = await readSubgraphReceipts({ address: ADDR, fetch: stub(new Error("ETIMEDOUT")).fetch });
  assert.equal(b.ok, false);
  assert.match(b.error, /^graph_unreachable: ETIMEDOUT/);
});

test("S6 `x402AddressSummaries` が返らない応答を「0 件」に化かさない", async () => {
  // 我々が思った形で通っていないだけであって、そのアドレスが受け取っていない証拠ではない。
  // ここを 0 件に丸めると、**認証・スキーマ・ネットワークのどの失敗も「証拠が薄い」に化ける**。
  const f = stub({ status: 200, body: { data: { _meta: { block: { number: 50889853 } } } } });
  const r = await readSubgraphReceipts({ address: ADDR, fetch: f.fetch });
  assert.equal(r.ok, false);
  assert.equal(r.error, "graph_malformed_response");
});
