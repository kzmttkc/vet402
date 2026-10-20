// ============================================================
// L2: x402 v2 の無払い 402 に置かれた出力の見本（2026-10-20）。
//
// カタログの schema.properties.output.properties.example.{properties,required}
// （v1）が空でも、extensions.bazaar.info.output.example が空でないプレーンな
// オブジェクトなら宣言として使う。見本に必須の印は無いので、キーが欠けても mismatch にしない。
// v1 から requiredKeys か exampleProps が取れるときはそちらを優先する。
// Run: npx tsx --test tests/l2-v2-output-example.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  checkL2Detailed,
  declaredOutputOf,
  l2DeclarationSource,
  l2ReadingOf,
  legacyL2SchemaOf,
  liveOutputExampleOf,
} from "@/lib/observatory/l2-check";

const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const shaJson = (v: unknown) => sha(JSON.stringify(v));

/** カタログの v1 形（extensions.bazaar.schema）。 */
const v1 = (required: string[] | null, properties: Record<string, unknown> | null = { a: { type: "string" } }) => ({
  properties: {
    input: { type: "object" },
    output: {
      properties: {
        example: { ...(required ? { required } : {}), ...(properties ? { properties } : {}) },
      },
    },
  },
});

/** x402 v2 でよくある枠。example は型の印だけで、properties も required も無い。 */
const v2Frame = {
  type: "object",
  properties: {
    output: {
      type: "object",
      properties: {
        type: { type: "string" },
        example: { type: "object" },
      },
      required: ["type"],
    },
  },
};

const example = { symbol: "BTC", price: 1 };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
const envelope = (ex: unknown) => ({
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", payTo: "0xabc", asset: "0xdef" }],
  extensions: { bazaar: { info: { output: { type: "json", example: ex } } } },
});

test("v2 の枠スキーマだけでは宣言にならない（見本を渡さない呼び出しは no_declaration のまま）", () => {
  assert.deepEqual(declaredOutputOf(v2Frame), { requiredKeys: [], exampleProps: null });
  const d = checkL2Detailed(v2Frame, '{"symbol":"BTC","price":1}', "application/json");
  assert.equal(d.status, "no_declaration");
  assert.equal(d.declarationHash, shaJson(v2Frame));
  assert.equal(l2DeclarationSource(v2Frame), null);
});

test("(a) v2 の見本だけ・JSON 本文は match。配列の本文も match。ハッシュは見本", () => {
  const body = '{"ok":true}';
  for (const schema of [null, v2Frame]) {
    const d = checkL2Detailed(schema, body, "application/json", null, example);
    assert.equal(d.status, "match");
    assert.equal(d.reason, null);
    assert.deepEqual(d.missing, []);
    assert.equal(d.declarationHash, shaJson(example));
    assert.notEqual(d.declarationHash, schema ? shaJson(schema) : null);
    assert.equal(d.responseHash, sha(body));
    assert.equal(l2DeclarationSource(schema, example), "live_402_output_example");
    assert.deepEqual(declaredOutputOf(schema, example), { requiredKeys: [], exampleProps: example });
  }
  assert.equal(checkL2Detailed(null, "[1,2]", "application/json; charset=utf-8", null, example).status, "match");
  const nested = { alerts: [{ id: 1 }], meta: {} };
  assert.equal(checkL2Detailed(v2Frame, '{"alerts":[]}', "application/json", null, nested).status, "match");
});

test("(b) 見本のキーが本文に無くても mismatch にしない", () => {
  const d = checkL2Detailed(null, '{"ok":true}', "application/json", null, example);
  assert.equal(d.status, "match");
  assert.equal(d.reason, null);
  assert.deepEqual(d.missing, []);
  assert.equal(checkL2Detailed(v2Frame, "{}", "application/json", null, example).status, "match");
});

test("(c) JSON と名乗って壊れた本文は mismatch。オブジェクトでない JSON も mismatch", () => {
  const broken = checkL2Detailed(null, '{"symbol":', "application/json", null, example);
  assert.deepEqual([broken.status, broken.reason, broken.missing], ["mismatch", "unparseable", []]);
  assert.equal(broken.declarationHash, shaJson(example));
  const html = checkL2Detailed(v2Frame, "<html>oops</html>", "application/json", null, example);
  assert.deepEqual([html.status, html.reason, html.missing], ["mismatch", "not_json_body", []]);
  const nil = checkL2Detailed(null, "null", "application/json", null, example);
  assert.deepEqual([nil.status, nil.reason], ["mismatch", "not_object"]);
  const num = checkL2Detailed(null, "42", "application/json", null, example);
  assert.equal(num.reason, "not_object");
});

test("見本を使っても Content-Type が JSON でなければ no_declaration。読み切れない本文は not_checked", () => {
  const plain = checkL2Detailed(null, '{"symbol":"BTC"}', "text/plain", null, example);
  assert.equal(plain.status, "no_declaration");
  assert.equal(plain.reason, null);
  // JSON でない応答には見本を当てない（2026-10-20 点検 中3）。見本が無いのと同じ。
  assert.equal(plain.declarationHash, null);
  assert.equal(plain.declarationSource, null);
  const over = checkL2Detailed(v2Frame, '{"symbol":"BTC"}', "application/json", "body_over_cap", example);
  assert.deepEqual([over.status, over.reason, over.missing], ["not_checked", "body_over_cap", []]);
});

test("(d) v1 のスキーマがあれば見本より v1 が優先する", () => {
  const schema = v1(["price", "symbol"]);
  const body = '{"symbol":"BTC"}';
  const d = checkL2Detailed(schema, body, "application/json", null, example);
  assert.deepEqual([d.status, d.reason, d.missing], ["mismatch", "missing_keys", ["price"]]);
  assert.equal(d.declarationHash, shaJson(schema));
  assert.notEqual(d.declarationHash, shaJson(example));
  assert.equal(l2DeclarationSource(schema, example), "catalog_schema");
  assert.deepEqual(declaredOutputOf(schema, example), declaredOutputOf(schema));
  // 見本の形に本文が合っていても、v1 の必須キーが欠けていれば mismatch のまま。
  const matched = checkL2Detailed(schema, '{"price":1,"symbol":"BTC"}', "application/json", null, { other: true });
  assert.equal(matched.status, "match");
  assert.equal(matched.declarationHash, shaJson(schema));
});

test("(e) 見本が配列・null・空オブジェクト・文字列なら使わない", () => {
  const bad = [[1, 2], null, {}, "", 1, false, new Date("2026-10-20T00:00:00Z")];
  for (const ex of bad) {
    assert.deepEqual(
      checkL2Detailed(null, '{"a":1}', "application/json", null, ex as never),
      checkL2Detailed(null, '{"a":1}', "application/json"),
    );
    assert.deepEqual(
      checkL2Detailed(v2Frame, '{"a":1}', "application/json", null, ex as never),
      checkL2Detailed(v2Frame, '{"a":1}', "application/json"),
    );
    assert.equal(l2DeclarationSource(v2Frame, ex as never), null);
    assert.equal(liveOutputExampleOf({ bodyText: JSON.stringify(envelope(ex)), headers: new Headers() }), null);
  }
});

test("(f) 抽出: ヘッダ・本文・壊れた base64・extensions 無し。読めたヘッダに見本が無ければ本文は混ぜない", () => {
  const headerEx = { alerts: ["btc"] };
  const bodyEx = { balance: "1" };
  const fromHeader = liveOutputExampleOf({
    bodyText: JSON.stringify(envelope(bodyEx)),
    headers: new Headers({ "PAYMENT-REQUIRED": b64(envelope(headerEx)) }),
  });
  assert.deepEqual(fromHeader, headerEx);
  // ヘッダ名の大小は Fetch の Headers が吸収する。
  assert.deepEqual(
    liveOutputExampleOf({ bodyText: "", headers: new Headers({ "payment-required": b64(envelope(headerEx)) }) }),
    headerEx,
  );
  assert.deepEqual(
    liveOutputExampleOf({ bodyText: ` \n${JSON.stringify(envelope(bodyEx))}`, headers: new Headers() }),
    bodyEx,
  );
  assert.deepEqual(
    liveOutputExampleOf({
      bodyText: JSON.stringify(envelope(bodyEx)),
      headers: new Headers({ "PAYMENT-REQUIRED": "%%%not-base64%%%" }),
    }),
    bodyEx,
  );
  assert.equal(
    liveOutputExampleOf({
      bodyText: "",
      headers: new Headers({ "PAYMENT-REQUIRED": b64("not json") }),
    }),
    null,
  );
  assert.equal(liveOutputExampleOf({ bodyText: JSON.stringify({ accepts: [] }), headers: new Headers() }), null);
  assert.equal(
    liveOutputExampleOf({
      bodyText: JSON.stringify({ extensions: { bazaar: { info: { input: { method: "GET" } } } } }),
      headers: new Headers(),
    }),
    null,
  );
  // ヘッダは JSON として読めるが見本が無い。同じ 402 の本文の見本を使う（parseChallenge も本文へ落ちる）。
  assert.deepEqual(
    liveOutputExampleOf({
      bodyText: JSON.stringify(envelope(bodyEx)),
      headers: new Headers({ "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [], extensions: { bazaar: { info: {} } } }) }),
    }),
    bodyEx,
  );
  // ヘッダにも本文にも見本があればヘッダ。
  assert.deepEqual(
    liveOutputExampleOf({
      bodyText: JSON.stringify(envelope(bodyEx)),
      headers: new Headers({ "PAYMENT-REQUIRED": b64(envelope({ from: "header" })) }),
    }),
    { from: "header" },
  );
  assert.deepEqual(
    liveOutputExampleOf({
      bodyText: JSON.stringify(envelope(bodyEx)),
      headers: { get() { throw new Error("header boom"); } },
    }),
    bodyEx,
  );
  assert.equal(liveOutputExampleOf({ bodyText: "{", headers: new Headers() }), null);
  assert.equal(liveOutputExampleOf({ bodyText: 1 as never, headers: null }), null);
  const before = Object.prototype.hasOwnProperty.call(Object.prototype, "polluted");
  liveOutputExampleOf({
    bodyText: '{"extensions":{"bazaar":{"info":{"output":{"example":{"__proto__":{"polluted":true},"symbol":"BTC"}}}}}}',
    headers: new Headers(),
  });
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), before);
});

test("(g) 第5引数を渡さない既存の呼び出しは結果が同一。古い行の読み直しも見本を見ない", () => {
  const schema = v1(["a", "b"]);
  const cases: Array<[unknown, string, string | null, "body_over_cap" | null]> = [
    [schema, '{"a":1,"b":2}', "application/json", null],
    [schema, '{"a":1}', "application/json", null],
    [schema, "<html>", "text/html", null],
    [schema, '{"a":1}', "text/html", "body_over_cap"],
    [null, "{}", "application/json", null],
    [v1(null, null), '{"truncated": [1, 2', "application/json", null],
    [{ properties: { input: {} } }, "{", "application/json", null],
    [v1([]), "[1,2]", "application/json", null],
  ];
  for (const [s, body, ct, inc] of cases) {
    const omitted = checkL2Detailed(s, body, ct, inc ?? undefined);
    assert.deepEqual(omitted, checkL2Detailed(s, body, ct, inc ?? undefined, undefined));
    assert.deepEqual(omitted, checkL2Detailed(s, body, ct, inc ?? undefined, null));
    assert.deepEqual(declaredOutputOf(s), declaredOutputOf(s, undefined));
    assert.deepEqual(declaredOutputOf(s), declaredOutputOf(s, null));
  }
  const legacy = legacyL2SchemaOf({
    l2Schema: "mismatch",
    l2Reason: null,
    missing: ["a"],
    bodyHead: '{"a":1}',
    contentType: "application/json",
    declaredSchema: v1(["a"]),
  });
  assert.deepEqual(legacy, { l2Schema: "match", missing: null, reason: null });
  assert.equal(
    l2ReadingOf(
      { l2Schema: "mismatch", l2Detail: { missing: ["a"], reason: null }, bodyHead: '{"a":1}', contentType: "application/json" },
      v1(["a"]),
    ),
    "match",
  );
  assert.equal(
    l2ReadingOf(
      { l2Schema: "no_declaration", l2Detail: null, bodyHead: null, contentType: "application/json" },
      null,
    ),
    "no_declaration",
  );
});

test("l1-runner は x402 だけ見本を渡し、Tempo の checkL2Detailed は引数を増やさない", () => {
  const src = readFileSync("src/lib/observatory/l1-runner.ts", "utf8");
  // l2_schema はカタログの宣言だけ（引数 4 つ）。見本は x402 だけの影（shadow）。
  assert.match(src, /const d = checkL2Detailed\(candidate\.declaredSchema, paidBody, contentType, paidBodyRead\.incomplete\);\s*l2Schema = d\.status;/);
  assert.match(src, /if \(!isTempo\) \{[\s\S]{0,200}?try \{\s*const liveOutputExample = liveOutputExampleOf\(\{ bodyText: firstBody, headers: first\.headers \}\);/);
  assert.match(src, /const shadow = checkL2Detailed\(candidate\.declaredSchema, paidBody, contentType, paidBodyRead\.incomplete, liveOutputExample\);/);
  assert.match(src, /shadowStatus: shadow\.status,/);
  assert.equal((src.match(/l2Schema = shadow/g) ?? []).length, 0);
});

test("公開の no_declaration は 402 の見本をまだ照合しないと書いてあり、禁止の語法が無い", () => {
  const sentence = "gave vet402 nothing to check this response against (no schema, a schema with no required keys and no example properties, or example properties with a content type that is not JSON). An output example the seller puts in the 402";
  const squash = (s: string) => s.replace(/\s+/g, " ");
  const endpoint = squash(readFileSync("src/app/observatory/e/[id]/page.tsx", "utf8"));
  const method = squash(readFileSync("src/app/observatory/methodology/page.tsx", "utf8"));
  assert.ok(endpoint.includes(sentence));
  assert.ok(endpoint.includes("extensions.bazaar.info.output.example"));
  assert.ok(method.includes(sentence));
  assert.ok(method.includes("extensions.bazaar.info.output.example"));
  assert.ok(method.includes("It is never counted as a failed delivery."));
  assert.equal(endpoint.includes("the listing declares no output schema to check the response against"), false);
  assert.equal(method.includes("output schema; never counted as a failure."), false);
  assert.ok(endpoint.includes("is not checked yet\"") && method.includes("is not checked yet."));
  for (const prose of [sentence, "is not checked yet.", "It is never counted as a failed delivery."]) {
    assert.equal(/\b(we|our|us)\b/i.test(prose), false, prose);
    assert.equal(prose.includes(";"), false, prose);
    assert.equal(prose.includes("—") || prose.includes("–") || prose.includes("--"), false, prose);
  }
});

test("見本を当てない応答: 0 バイト・空白だけ・ストリーム・JSON でない Content-Type は見本が無いのと同じ", () => {
  for (const [body, ct] of [
    ["", "application/json"],
    ["  \n", "application/json"],
    ['{"symbol":"BTC"}\n{"symbol":"ETH"}\n', "application/x-ndjson"],
    ['{"symbol":"BTC"}\n', "application/jsonl"],
    ['data: {"symbol":"BTC"}\n\n', "text/event-stream"],
    ['{"symbol":"BTC"}', "application/json-seq"],
    ['{"symbol":"BTC"}', "text/plain"],
    ['{"symbol":"BTC"}', null],
  ] as const) {
    const d = checkL2Detailed(v2Frame, body, ct, null, example);
    assert.equal(d.status, "no_declaration", `${ct} ${JSON.stringify(body)}`);
    assert.equal(d.declarationSource, null);
    assert.equal(d.declarationHash, shaJson(v2Frame));
    const n = checkL2Detailed(null, body, ct, null, example);
    assert.equal(n.status, "no_declaration");
    assert.equal(n.declarationHash, null);
  }
});

test("見本を当てた応答は declarationSource と見本のハッシュを返す", () => {
  const d = checkL2Detailed(v2Frame, '{"other":1}', "application/json; charset=utf-8", null, example);
  assert.equal(d.status, "match");
  assert.equal(d.declarationSource, "live_402_output_example");
  assert.equal(d.declarationHash, shaJson(example));
  const broken = checkL2Detailed(v2Frame, "<html>", "application/json", null, example);
  assert.equal(broken.status, "mismatch");
  assert.equal(broken.reason, "not_json_body");
  assert.deepEqual(broken.missing, []);
  const cut = checkL2Detailed(v2Frame, '{"symbol":', "application/json", "body_timeout", example);
  assert.equal(cut.status, "not_checked");
  const v1d = checkL2Detailed(v1(["a"]), '{"a":1}', "application/json", null, example);
  assert.equal(v1d.declarationSource, "catalog_schema");
  assert.equal(checkL2Detailed(v2Frame, '{"a":1}', "application/json").declarationSource, null);
});

test("引数を省いた checkL2Detailed は変更前の期待値どおり", () => {
  assert.equal(checkL2Detailed(v2Frame, '{"a":1}', "application/json").status, "no_declaration");
  assert.equal(checkL2Detailed(null, '{"a":1}', "application/json").status, "no_declaration");
  assert.equal(checkL2Detailed(v1(["a"]), '{"b":1}', "application/json").status, "mismatch");
  assert.equal(checkL2Detailed(v1(["a"]), '{"a":1}', "application/json").status, "match");
  assert.equal(checkL2Detailed(v1(["a"]), '{"a":1}', "text/plain").status, "mismatch");
  assert.equal(checkL2Detailed(v1(null), "<html>", "application/json").status, "mismatch");
});

test("記録頁の L2 の説明は末尾にピリオドを持たない（頁が足す）。mismatch の説明は判定の 4 つの理由に当たる", () => {
  const src = readFileSync("src/app/observatory/e/[id]/page.tsx", "utf8");
  const block = src.slice(src.indexOf("const L2_GLOSS"), src.indexOf("};", src.indexOf("const L2_GLOSS")));
  for (const m of block.matchAll(/:\s*"([^"]*)"/g)) assert.equal(m[1].endsWith("."), false, m[1]);
  const mismatch = /mismatch:\s*"([^"]*)"/.exec(block)![1];
  for (const part of ["the content type was not JSON although the listing marks required keys", "the body read in full did not parse as JSON", "was JSON but not an object or array", "lacked a key the listing marks as required"]) {
    assert.ok(mismatch.includes(part), part);
  }
  // 理由ごとに判定が mismatch になることを、その説明と一緒に固定する。
  const v1Req = { properties: { output: { properties: { example: { required: ["price"], properties: { price: {} } } } } } };
  assert.equal(checkL2Detailed(v1Req, '{"price":1}', "text/plain").reason, "not_json_content_type");
  assert.equal(checkL2Detailed(v1Req, "42", "application/json").reason, "not_object");
  assert.equal(checkL2Detailed(v1Req, "{", "application/json").reason, "unparseable");
  assert.equal(checkL2Detailed(v1Req, "{}", "application/json").reason, "missing_keys");
  const v1Ex = { properties: { output: { properties: { example: { properties: { price: {} } } } } } };
  assert.equal(checkL2Detailed(v1Ex, "<html></html>", "text/html").status, "no_declaration");
});
