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

test("S7 呼び手の API キーは、返り値のどこにも現れない", async () => {
  // 2026-09-06: ここは `url` に鍵入りの URL を入れ、別に publicUrl を用意して
  // 「決定行にはこちらを使う」と**注意書き**していた。注意書きでは防げない——
  // 呼び手が結果をそのまま console.log すれば、呼び手自身の鍵が流出する。
  // 実際に依頼元が自分の鍵を出力へ出した。**返さないことで防ぐ。**
  const KEY = "k0000000000000000000000000000000e";
  const f = async () => ({
    ok: true, status: 200,
    json: async () => ({
      data: {
        _meta: { block: { number: 1, timestamp: 2 }, deployment: "Qm" },
        x402AddressSummaries: [{ role: "RECIPIENT", totalPayments: "7" }],
      },
    }),
    headers: new Map(),
  });
  const r = await readSubgraphReceipts({
    address: "0x79dc34e41b2b591078d3de222c43ecaabd52fccb",
    apiKey: KEY,
    fetch: f,
  });
  assert.equal(r.ok, true);
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes(KEY), false, `返り値に鍵が含まれている: ${dumped.slice(0, 200)}`);
  // 空振りで緑にならないこと——鍵が実際に使われた経路であることを確かめる。
  assert.match(r.publicUrl, /gateway\.thegraph\.com\/api\/subgraphs\/id\//);
});

test("S8 address が 0x40桁でなければ、通信の前に呼び出し側エラー", async () => {
  // 2026-09-06 まで String(undefined) が Gateway へ出て
  // `Failed to decode Bytes value: Odd number of digits` という原因の分からない
  // エラーになっていた。**何が悪いかを言って落ちる。**
  for (const bad of [undefined, null, "", "0x123", "vitalik.eth", 42]) {
    let fetched = 0;
    await assert.rejects(
      () => readSubgraphReceipts({ address: bad, apiKey: "k", fetch: async () => { fetched++; throw new Error("must not be called"); } }),
      (e) => /address must be a 0x-prefixed 40-hex address/.test(String(e && e.message)),
      `${JSON.stringify(bad)} で呼び出し側エラーになっていない`,
    );
    assert.equal(fetched, 0, "通信の前に落ちていない");
  }
});
