// ============================================================
// L2: 売り手の今の 402 をカタログより先に使う（課題 B1）。
//
// カタログ（CDP Bazaar の schema）と、challenge の outputSchema・見本が食い違うとき、
// 応答が 402 側に合っていれば mismatch にしない。402 に宣言が無ければカタログ。
// どちらも無ければ今までどおり no_declaration。mismatch には declarationSource
// （live_402 か catalog）が付く。
// Run: npx tsx --test tests/l2-declaration-priority.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkL2Detailed, l2DeclarationSource, liveOutputSchemaOf } from "@/lib/observatory/l2-check";

/** カタログの v1 形。required が見本スキーマの必須キー。 */
const catalog = (required: string[]) => ({
  properties: {
    input: { type: "object" },
    output: {
      properties: {
        example: { required, properties: Object.fromEntries(required.map((k) => [k, { type: "string" }])) },
      },
    },
  },
});

/** challenge の accepts[].outputSchema（v1）。 */
const outputSchema = (required: string[]) => ({
  input: { type: "http", method: "GET" },
  output: {
    type: "object",
    required,
    properties: Object.fromEntries(required.map((k) => [k, { type: "string" }])),
  },
});

const stale = catalog(["generatedAt", "data"]);
const sample = { price: 1, symbol: "BTC" };

test("402 の見本に合いカタログの必須キーが無い応答は mismatch にしない", () => {
  const body = '{"price":1,"symbol":"BTC"}';
  const d = checkL2Detailed(stale, body, "application/json", null, sample);
  assert.notEqual(d.status, "mismatch");
  assert.equal(d.status, "match");
  assert.equal(d.declarationSource, "live_402");
  assert.equal(l2DeclarationSource(stale, sample), "live_402");
  assert.deepEqual(d.missing, []);
});

test("402 の outputSchema に合いカタログに合わない応答は mismatch にしない", () => {
  const d = checkL2Detailed(stale, '{"symbol":"BTC"}', "application/json", null, null, outputSchema(["symbol"]));
  assert.notEqual(d.status, "mismatch");
  assert.equal(d.status, "match");
  assert.equal(d.declarationSource, "live_402");
});

test("402 にもカタログにも合わない応答は mismatch で declarationSource が live_402", () => {
  const bySample = checkL2Detailed(stale, '{"other":true}', "application/json", null, sample);
  assert.equal(bySample.status, "mismatch");
  assert.equal(bySample.declarationSource, "live_402");
  assert.deepEqual(bySample.missing, ["price", "symbol"]);

  const bySchema = checkL2Detailed(stale, '{"other":true}', "application/json", null, null, outputSchema(["symbol"]));
  assert.equal(bySchema.status, "mismatch");
  assert.equal(bySchema.declarationSource, "live_402");
  assert.deepEqual(bySchema.missing, ["symbol"]);
  assert.equal(bySchema.missing.includes("generatedAt"), false);
  assert.equal(bySchema.missing.includes("data"), false);
});

test("402 に宣言が無ければカタログを使い、mismatch の declarationSource は catalog", () => {
  const d = checkL2Detailed(catalog(["data"]), "{}", "application/json", null, null, null);
  assert.equal(d.status, "mismatch");
  assert.equal(d.reason, "missing_keys");
  assert.deepEqual(d.missing, ["data"]);
  assert.equal(d.declarationSource, "catalog");
  assert.equal(l2DeclarationSource(catalog(["data"]), null, null), "catalog");
});

test("どちらにも宣言が無い応答は今までどおり no_declaration で declarationSource は null", () => {
  const bare = { properties: { output: { properties: { example: { type: "object" } } } } };
  for (const schema of [null, bare]) {
    const d = checkL2Detailed(schema, "{}", "application/json", null, null, null);
    assert.equal(d.status, "no_declaration", JSON.stringify(schema));
    assert.equal(d.declarationSource, null);
    assert.equal(d.reason, null);
  }
});

test("カタログが宣言していないときの見本は、キーが欠けても mismatch にしない", () => {
  const d = checkL2Detailed(null, '{"ok":true}', "application/json", null, sample);
  assert.equal(d.status, "match");
  assert.equal(d.declarationSource, "live_402");
  assert.deepEqual(d.missing, []);
});

test("outputSchema の見本に合いカタログに合わない応答は mismatch にしない", () => {
  const schema = {
    input: { type: "http", method: "GET" },
    output: { type: "json", example: { price: 1, symbol: "BTC" } },
  };
  const hit = checkL2Detailed(stale, '{"price":1,"symbol":"BTC"}', "application/json", null, null, schema);
  assert.equal(hit.status, "match");
  assert.equal(hit.declarationSource, "live_402");
  const miss = checkL2Detailed(stale, '{"other":true}', "application/json", null, null, schema);
  assert.equal(miss.status, "mismatch");
  assert.equal(miss.declarationSource, "live_402");
  assert.deepEqual(miss.missing, ["price", "symbol"]);
});

test("liveOutputSchemaOf はヘッダの outputSchema を本文より先に取る", () => {
  const headerSchema = outputSchema(["symbol"]);
  const bodySchema = outputSchema(["other"]);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
  const doc = (schema: unknown) => ({ accepts: [{ outputSchema: schema }] });
  assert.deepEqual(
    liveOutputSchemaOf({
      bodyText: JSON.stringify(doc(bodySchema)),
      headers: new Headers({ "payment-required": b64(doc(headerSchema)) }),
    }),
    headerSchema,
  );
  assert.deepEqual(liveOutputSchemaOf({ bodyText: JSON.stringify(doc(bodySchema)), headers: new Headers() }), bodySchema);
  assert.equal(liveOutputSchemaOf({ bodyText: "{", headers: new Headers() }), null);
  assert.equal(liveOutputSchemaOf({ bodyText: JSON.stringify({ accepts: [{ scheme: "exact" }] }), headers: null }), null);
});

test("l1-runner は 402 を先に渡し、mismatch の記録へ declarationSource を付ける", () => {
  const src = readFileSync("src/lib/observatory/l1-runner.ts", "utf8");
  assert.match(src, /liveOutputSchemaOf\(\{ bodyText: firstBody, headers: first\.headers \}\)/);
  assert.match(
    src,
    /const d = checkL2Detailed\(\s*candidate\.declaredSchema,\s*paidBody,\s*contentType,\s*paidBodyRead\.incomplete,\s*liveOutputExample,\s*liveOutputSchema,\s*\)/,
  );
  assert.match(src, /l2Schema = d\.status/);
  assert.match(src, /declarationSource: d\.declarationSource/);
  assert.equal((src.match(/l2Schema = shadow/g) ?? []).length, 0);
});
