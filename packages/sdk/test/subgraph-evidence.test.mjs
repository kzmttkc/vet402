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
import { readSubgraphReceipts, redactGraphKey, GRAPH_KEY_PLACEHOLDER, X402_BASE_SUBGRAPH_ID } from "../dist/index.js";

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

// ------------------------------------------------------------------
// S7: 呼び手の API キーは、返り値のどこにも現れない——**成功経路だけでなく全経路で**。
//
// 2026-09-06: 成功経路は `publicUrl` から鍵を外して塞いだ。ところが**エラー経路**が
// 空いていた。SDK は `fetch` を呼び手から受け取るので、呼び手の fetch が投げる例外の
// メッセージに URL（＝鍵）が載るかどうかは我々の管理外（undici は
// `request to https://…/api/<KEY>/… failed` と言う）。The Graph 側の GraphQL エラー本文も
// 同様に相手が決める文字列である。どちらもそのまま `error` に連結していた。
//
// 返り値の `error` を見て「なぜ拒否されたか」を知るのは正当な使い方で、そこに鍵が
// 混ざるのは我々の責任。**種別（接頭辞）は残し、鍵だけを伏せる。**
// ------------------------------------------------------------------
// 本物と同じ形（32桁 hex）の偽鍵。先頭を `k` にすると hex でなくなり、`/api/<hex32>/` の
// 形の検査が空振りで緑になる（2026-09-06 に実際にそうなった）。
const KEY = "a" + "0".repeat(30) + "e";
assert.match(KEY, /^[0-9a-f]{32}$/);
const KEYED_URL = `https://gateway.thegraph.com/api/${KEY}/subgraphs/id/Qm1`;
const ADDR_LC = "0x79dc34e41b2b591078d3de222c43ecaabd52fccb";
const KEY_PATH = /\/api\/[0-9a-f]{32}\//i;

/** 返り値を丸ごと文字列にして、鍵も `/api/<hex32>/` の形も無いことを確かめる。 */
function assertNoKey(result, label) {
  const dumped = JSON.stringify(result);
  assert.equal(dumped.includes(KEY), false, `${label}: 返り値に鍵が含まれている: ${dumped.slice(0, 240)}`);
  assert.doesNotMatch(dumped, KEY_PATH, `${label}: 返り値に /api/<hex32>/ の形が残っている: ${dumped.slice(0, 240)}`);
}

test("S7a 成功経路: publicUrl にも他のどこにも鍵が無い", async () => {
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
  const r = await readSubgraphReceipts({ address: ADDR_LC, apiKey: KEY, fetch: f });
  assert.equal(r.ok, true);
  assertNoKey(r, "成功");
  // 空振りで緑にならないこと——鍵が実際に使われた経路であることを確かめる。
  assert.match(r.publicUrl, /gateway\.thegraph\.com\/api\/subgraphs\/id\//);
});

test("S7b ① 呼び手の fetch が URL 入りメッセージで throw しても、鍵は error に出ない（種別は残る）", async () => {
  const f = async (url) => { throw new Error(`request to ${url} failed, reason: getaddrinfo ENOTFOUND`); };
  const r = await readSubgraphReceipts({ address: ADDR_LC, apiKey: KEY, fetch: f });
  assert.equal(r.ok, false);
  assertNoKey(r, "①");
  assert.match(r.error, /^graph_unreachable: /, "種別まで消してしまってはいけない");
  assert.match(r.error, /ENOTFOUND/, "鍵以外の原因（何が起きたか）は残す");
  assert.ok(r.error.includes(`/api/${GRAPH_KEY_PLACEHOLDER}/`), `伏せ字が入っている: ${r.error}`);
});

test("S7c ② The Graph 側の GraphQL エラー本文に URL が載っても、鍵は error に出ない（種別は残る）", async () => {
  const f = async (url) => ({
    ok: true, status: 200,
    json: async () => ({ errors: [{ message: `bad query at ${url}: auth error` }] }),
    headers: new Map(),
  });
  const r = await readSubgraphReceipts({ address: ADDR_LC, apiKey: KEY, fetch: f });
  assert.equal(r.ok, false);
  assertNoKey(r, "②");
  assert.match(r.error, /^graph_query_error: /, "種別まで消してしまってはいけない");
  assert.match(r.error, /auth error/, "相手の言い分は残す");
});

test("S7d ③ Node 標準 fetch の到達不能（`fetch failed`）: 鍵は無く、種別は残る", async () => {
  const f = async () => { throw new TypeError("fetch failed"); };
  const r = await readSubgraphReceipts({ address: ADDR_LC, apiKey: KEY, fetch: f });
  assert.equal(r.ok, false);
  assertNoKey(r, "③");
  assert.equal(r.error, "graph_unreachable: fetch failed");
});

test("S7e graph_http_5xx: 鍵は無く、種別はそのまま", async () => {
  const f = async () => ({ ok: false, status: 503, json: async () => ({}), headers: new Map() });
  const r = await readSubgraphReceipts({ address: ADDR_LC, apiKey: KEY, fetch: f });
  assert.equal(r.ok, false);
  assertNoKey(r, "5xx");
  assert.equal(r.error, "graph_http_503");
});

test("S7f graph_malformed_response（非オブジェクト / rows 欠落）: 鍵は無く、種別はそのまま", async () => {
  for (const body of ["not json object", { data: { _meta: { block: { number: 1 } } } }]) {
    const f = async () => ({ ok: true, status: 200, json: async () => body, headers: new Map() });
    const r = await readSubgraphReceipts({ address: ADDR_LC, apiKey: KEY, fetch: f });
    assert.equal(r.ok, false);
    assertNoKey(r, "malformed");
    assert.equal(r.error, "graph_malformed_response");
  }
});

test("S7g 鍵が例外メッセージに URL 以外の形で（裸で）載っても伏せる", async () => {
  const f = async () => { throw new Error(`auth ${KEY} rejected`); };
  const r = await readSubgraphReceipts({ address: ADDR_LC, apiKey: KEY, fetch: f });
  assert.equal(r.ok, false);
  assertNoKey(r, "裸の鍵");
  assert.equal(r.error, `graph_unreachable: auth ${GRAPH_KEY_PLACEHOLDER} rejected`);
});

test("S7h 鍵を渡していない呼び出しでも、URL の /api/<hex32>/ の形は伏せる", async () => {
  // 呼び手の fetch が自前で鍵をパスに足しているかもしれない。渡されていない鍵は
  // 文字列で消せないので、経路の形で消す（demo の redact.ts と同じ考え）。
  const f = async () => { throw new Error(`request to ${KEYED_URL} failed`); };
  const r = await readSubgraphReceipts({ address: ADDR_LC, fetch: f });
  assert.equal(r.ok, false);
  assertNoKey(r, "鍵無し");
  assert.match(r.error, /^graph_unreachable: request to https:\/\/gateway\.thegraph\.com\/api\/<KEY>\/subgraphs\/id\/Qm1 failed$/);
});

// ------------------------------------------------------------------
// redactGraphKey 単体。demo の redact.ts もこれを使う（同じロジックを2箇所に置かない）。
// ------------------------------------------------------------------
test("R1 redactGraphKey: 鍵を渡せば全出現を伏せ、渡さなくても /api/<hex32>/ と Gateway の鍵付き経路は伏せる", () => {
  assert.equal(GRAPH_KEY_PLACEHOLDER, "<KEY>");
  assert.equal(redactGraphKey(`a ${KEY} b ${KEY}`, KEY), "a <KEY> b <KEY>");
  assert.equal(redactGraphKey(`x ${KEY.toUpperCase()} y`, KEY), "x <KEY> y", "大文字化されても消す");
  assert.equal(redactGraphKey(KEYED_URL), "https://gateway.thegraph.com/api/<KEY>/subgraphs/id/Qm1");
  assert.equal(
    redactGraphKey("POST https://gateway.thegraph.com/api/deadbeefdeadbeefdeadbeef/subgraphs/id/Cb56"),
    "POST https://gateway.thegraph.com/api/<KEY>/subgraphs/id/Cb56",
    "32桁でなくても Gateway の鍵付き経路は伏せる",
  );
  assert.equal(redactGraphKey(`https://example.invalid/api/${KEY}/x`), "https://example.invalid/api/<KEY>/x", "ホストが違っても /api/<hex32>/ は伏せる");
});

test("R2 redactGraphKey: 鍵ではない `x402` の公開経路と、空鍵・短い鍵は壊さない", () => {
  const url = `https://gateway.thegraph.com/api/x402/subgraphs/id/${X402_BASE_SUBGRAPH_ID}`;
  assert.equal(redactGraphKey(url), url);
  assert.equal(redactGraphKey(url, ""), url);
  assert.equal(redactGraphKey(url, undefined), url);
  assert.equal(redactGraphKey("version 2", "2"), "version 2", "短い値を消すと出力が壊れる");
  assert.equal(redactGraphKey("plain text"), "plain text");
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
