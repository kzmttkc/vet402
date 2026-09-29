// ============================================================
// L2 の計器: 支払い付き応答の本文の読み取り上限（2026-09-29・監査 6 周目）。
//
// 守ること:
//  1. 上限（L1_PAID_BODY_CAP_BYTES = 256 KiB）以内の長い JSON は読み切って判定する
//     （16,000 バイトで切っていた頃は、閉じない JSON が「宣言と不一致」に見えていた）。
//  2. 上限を超えた本文は L2 を判定しない: not_checked・reason body_over_cap。欠落キーを並べない。
//  3. 本文の読み取りが途中で失敗した応答も not_checked（body_read_error）。
//  4. 出力の宣言が無い（必須キーも例のプロパティも無い）schema は、本文が読めなくても no_declaration。
//  5. JSON として読めない本文からは欠けたキーを作らない。最後まで読めて閉じていない本文は mismatch（unparseable）。
//     本文の読み取りが時間切れ・切断のときは、1 バイト以上受け取っていれば not_checked。数えるのは生のバイト。
//  6. Content-Type が JSON でない mismatch は本文の長さに依らない。
//  7. 印の無い古い行の読み直し（legacyL2SchemaOf・判定の読み手が使う）。
// Run: npx tsx --test tests/l1-paid-body-cap.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  L1_PAID_BODY_CAP_BYTES,
  L1_LEGACY_PAID_BODY_CAP_BYTES,
  checkL2Detailed,
  legacyL2SchemaOf,
  paidBodyReadOf,
  topLevelKeysOfJsonHead,
} from "@/lib/observatory/l2-check";
import { checkL2Detailed as runnerCheckL2Detailed } from "@/lib/observatory/l1-runner";
import { readBodyCapped, readBodyCappedDetailed } from "@/lib/net/read-capped";

/** カタログの宣言の形（extensions.bazaar.schema）。 */
const schemaWith = (required: string[] | null, properties: Record<string, unknown> | null = { a: { type: "string" } }) => ({
  properties: {
    input: { type: "object" },
    output: {
      properties: {
        example: { ...(required ? { required } : {}), ...(properties ? { properties } : {}) },
      },
    },
  },
});

/** 指定バイト数前後の JSON（{"count":n,"items":[...],"assets":...}）。 */
function longJson(minBytes: number): string {
  // 1 件 約 70 バイト。足りなければ倍にして作り直す（毎回 stringify し直さない）。
  for (let n = Math.ceil(minBytes / 70); ; n *= 2) {
    const items = Array.from({ length: n }, (_, i) => ({ id: i, name: `asset-${i}-${"x".repeat(40)}` }));
    const s = JSON.stringify({ count: n, items, assets: "tail" });
    if (Buffer.byteLength(s, "utf8") >= minBytes) return s;
  }
}

test("上限は 16,000 バイトより十分大きい（L0 と同じく、上限そのものは残す）", () => {
  assert.equal(L1_PAID_BODY_CAP_BYTES, 256 * 1024);
  assert.ok(L1_PAID_BODY_CAP_BYTES > L1_LEGACY_PAID_BODY_CAP_BYTES * 10);
});

test("l1-runner の checkL2Detailed は l2-check と同じ関数", () => {
  assert.equal(runnerCheckL2Detailed, checkL2Detailed);
});

test("16,000 バイトを超える長い JSON: 旧上限で切った本文は読めない（旧計器の誤り）、新上限では match", async () => {
  const body = longJson(40_000);
  const schema = schemaWith(["count", "items"]);
  // 旧計器の再現: 16,000 バイトで切った本文は閉じない（本番の 70 出品の形）。切ったことを知らずに渡すと読めない。
  const legacyText = await readBodyCapped(new Response(body), L1_LEGACY_PAID_BODY_CAP_BYTES);
  assert.equal(checkL2Detailed(schema, legacyText, "application/json").reason, "unparseable");
  // 新計器: 読み切って判定する。
  const r = await readBodyCappedDetailed(new Response(body), L1_PAID_BODY_CAP_BYTES + 1);
  const read = paidBodyReadOf(r.text, r.bytes, r.error);
  assert.equal(read.incomplete, null);
  assert.equal(read.bytes, Buffer.byteLength(body, "utf8"));
  const now = checkL2Detailed(schema, read.body, "application/json", read.incomplete);
  assert.equal(now.status, "match");
  assert.equal(now.reason, null);
});

test("上限を超えた本文: not_checked（body_over_cap）。欠落キーを並べない・バイト数は上限で頭打ち", async () => {
  const body = longJson(L1_PAID_BODY_CAP_BYTES + 5_000);
  const r = await readBodyCappedDetailed(new Response(body), L1_PAID_BODY_CAP_BYTES + 1);
  assert.ok(r.bytes > L1_PAID_BODY_CAP_BYTES);
  const read = paidBodyReadOf(r.text, r.bytes, r.error);
  assert.equal(read.incomplete, "body_over_cap");
  assert.equal(read.bytes, L1_PAID_BODY_CAP_BYTES);
  const d = checkL2Detailed(schemaWith(["count", "items"]), read.body, "application/json", read.incomplete);
  assert.equal(d.status, "not_checked");
  assert.equal(d.reason, "body_over_cap");
  assert.deepEqual(d.missing, []);
});

test("上限は受け取った生のバイトで判定する（UTF-8 に直した後の文字列の長さではない）", async () => {
  // 不正なバイト 0xFF は U+FFFD（3 バイト）に直るので、直した後で数えると上限を超えて見える。
  const raw = new Uint8Array(L1_PAID_BODY_CAP_BYTES).fill(0xff);
  const r = await readBodyCappedDetailed(new Response(raw), L1_PAID_BODY_CAP_BYTES + 1);
  assert.equal(r.bytes, L1_PAID_BODY_CAP_BYTES);
  assert.ok(Buffer.byteLength(r.text, "utf8") > L1_PAID_BODY_CAP_BYTES, "直した後の長さは上限を超える");
  assert.equal(paidBodyReadOf(r.text, r.bytes, r.error).incomplete, null, "生のバイトは上限ちょうど＝読み切った");
  assert.equal(paidBodyReadOf("", L1_PAID_BODY_CAP_BYTES + 1, null).incomplete, "body_over_cap");
});

/** 先に chunk を送り、その後に失敗する本文（時間切れ・切断の再現）。 */
function failingBody(chunk: string, error: Error): Response {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent && chunk !== "") {
        sent = true;
        controller.enqueue(new TextEncoder().encode(chunk));
        return;
      }
      controller.error(error);
    },
  });
  return new Response(stream);
}
const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

test("本文の読み取りが時間切れ: 1 バイト以上受け取っていれば not_checked（body_timeout）、0 バイトなら従来どおり空", async () => {
  const schema = schemaWith(["count"]);
  const partial = await readBodyCappedDetailed(failingBody('{"count": 1, "items": [', abortError()), L1_PAID_BODY_CAP_BYTES + 1);
  assert.ok(partial.error !== null);
  assert.equal(partial.text, '{"count": 1, "items": [');
  const read = paidBodyReadOf(partial.text, partial.bytes, partial.error);
  assert.equal(read.incomplete, "body_timeout");
  const d = checkL2Detailed(schema, read.body, "application/json", read.incomplete);
  assert.deepEqual([d.status, d.reason, d.missing], ["not_checked", "body_timeout", []]);
  // 切断（時間切れ以外）は body_read_error
  const reset = await readBodyCappedDetailed(failingBody("{", new Error("socket hang up")), L1_PAID_BODY_CAP_BYTES + 1);
  assert.equal(paidBodyReadOf(reset.text, reset.bytes, reset.error).incomplete, "body_read_error");
  // 0 バイト: 従来どおり空の本文として扱う（incomplete なし）
  const none = await readBodyCappedDetailed(failingBody("", abortError()), L1_PAID_BODY_CAP_BYTES + 1);
  assert.equal(none.bytes, 0);
  assert.equal(paidBodyReadOf(none.text, none.bytes, none.error).incomplete, null);
});

test("ちょうど上限のバイト数は読み切った扱い、1 バイト超えたら body_over_cap", () => {
  assert.equal(paidBodyReadOf("", L1_PAID_BODY_CAP_BYTES, null).incomplete, null);
  assert.equal(paidBodyReadOf("", L1_PAID_BODY_CAP_BYTES + 1, null).incomplete, "body_over_cap");
});

test("出力の宣言が無い schema: 本文が JSON として読めなくても no_declaration（失敗にしない）", () => {
  // 本番: L2 = mismatch 711 行のうち 437 行は必須キーも例のプロパティも無い宣言だった（読めない本文で mismatch）。
  const d = checkL2Detailed(schemaWith(null, null), '{"truncated": [1, 2', "application/json");
  assert.equal(d.status, "no_declaration");
  assert.equal(d.reason, null);
  assert.equal(checkL2Detailed({ properties: { input: {} } }, "{", "application/json").status, "no_declaration");
});

test("reason: 最後まで読めて閉じていない JSON は売り手の不具合（mismatch・欠けたキーは空）。ほかも mismatch", () => {
  const schema = schemaWith(["a", "b"]);
  const unclosed = checkL2Detailed(schema, '{"a": 1, "b": [1, 2', "application/json");
  assert.deepEqual([unclosed.status, unclosed.reason, unclosed.missing], ["mismatch", "unparseable", []]);
  const brokenArray = checkL2Detailed(schema, "[1, 2", "application/json");
  assert.deepEqual([brokenArray.status, brokenArray.reason, brokenArray.missing], ["mismatch", "unparseable", []]);
  const notJson = checkL2Detailed(schema, "<html>oops</html>", "application/json");
  assert.deepEqual([notJson.status, notJson.reason, notJson.missing], ["mismatch", "not_json_body", []], "欠けたキーを作らない");
  const notObject = checkL2Detailed(schema, "42", "application/json");
  assert.deepEqual([notObject.status, notObject.reason, notObject.missing], ["mismatch", "not_object", []]);
  const missing = checkL2Detailed(schema, '{"a":1}', "application/json");
  assert.deepEqual([missing.status, missing.reason, missing.missing], ["mismatch", "missing_keys", ["b"]]);
  const html = checkL2Detailed(schema, "<html>", "text/html");
  assert.deepEqual([html.status, html.reason, html.missing], ["mismatch", "not_json_content_type", []]);
  // Content-Type を取り違えた JSON は、読めたキーで欠けを数える。
  const mislabeled = checkL2Detailed(schema, '{"a":1}', "text/plain");
  assert.deepEqual([mislabeled.status, mislabeled.reason, mislabeled.missing], ["mismatch", "not_json_content_type", ["b"]]);
  // Content-Type が JSON でない判定は本文を読み切れたかに依らない（欠けたキーは作らない）。
  const over = checkL2Detailed(schema, '{"a":1}', "text/html", "body_over_cap");
  assert.deepEqual([over.status, over.missing], ["mismatch", []]);
  const ok = checkL2Detailed(schema, '{"a":1,"b":2}', "application/json");
  assert.deepEqual([ok.status, ok.reason, ok.missing], ["match", null, []]);
});

test("配列の本文は従来どおり（必須キーが無ければ match、あれば missing_keys）", () => {
  assert.equal(checkL2Detailed(schemaWith([]), "[1,2]", "application/json").status, "match");
  const d = checkL2Detailed(schemaWith(["a"]), "[1,2]", "application/json");
  assert.deepEqual([d.status, d.reason], ["mismatch", "missing_keys"]);
});

test("宣言なし（schema 自体が無い）は従来どおり no_declaration・ハッシュは本文のもの", () => {
  const d = checkL2Detailed(null, "{}", "application/json");
  assert.equal(d.status, "no_declaration");
  assert.equal(d.declarationHash, null);
  assert.match(d.responseHash, /^[0-9a-f]{64}$/);
});

// ------------------------------------------------------------------
// 印（l2.reason）の無い古い行の読み直し
// ------------------------------------------------------------------
const REQ = schemaWith(["count", "items"]);
const legacy = (over: Partial<Parameters<typeof legacyL2SchemaOf>[0]>) =>
  legacyL2SchemaOf({ l2Schema: "mismatch", l2Reason: null, missing: ["count", "items"], bodyHead: null, contentType: "application/json", declaredSchema: REQ, ...over });

test("古い行: 記録した欠けたキーが保存した頭の最上位に見える → 切れた証拠があるので not_checked（本番の形）", () => {
  const head = longJson(40_000).slice(0, 500);
  assert.ok(head.startsWith('{"count":'));
  assert.deepEqual(legacy({ bodyHead: head }), { l2Schema: "not_checked", missing: null, reason: "legacy_body_cut" });
  // 一部だけでも、見えているキーを「欠けた」と記録していれば切れた証拠
  assert.equal(legacy({ bodyHead: head, missing: ["count"] }).l2Schema, "not_checked");
});

test("古い行: 欠けたキーが最上位に見えない → そのまま mismatch（agentsouk: 必須キーが output の下＝本物の不一致）", () => {
  // 本番 api.agentsouk.dev の行の頭と宣言（2026-09-29 SELECT）。summary 等は output の下にあり、最上位には無い。
  const head =
    '{"object":"x402_result","job_id":"job_01M2PANZTWXTAW16XHS6887SH9","listing_id":"lst_01M1YBDYPTBYH0G9DVQH0PWPFR","output":{"summary":"- \\"Example Domain\\" is available for use in documentation examples without requiring permission.\\n- Its use in actual operations should be avoided.","key_points":["The domain exists for documentation examples","No permission is needed to use it","Operational use is discouraged","A \\"Learn more\\" link is shown for further information about the domain name"';
  const padded = head + ",".repeat(Math.max(0, 500 - head.length));
  assert.ok(padded.length >= 500);
  const schema = schemaWith(["summary", "key_points", "language", "source"]);
  const r = legacy({ bodyHead: padded.slice(0, 500), missing: ["summary", "key_points", "language", "source"], declaredSchema: schema });
  assert.deepEqual(r, { l2Schema: "mismatch", missing: ["summary", "key_points", "language", "source"], reason: null });
});

test("古い行: 欠けたキーの記録が無い長い行・配列の頭はそのまま mismatch（判定は l2_mismatch_unexplained）", () => {
  const head = longJson(40_000).slice(0, 500);
  assert.equal(legacy({ bodyHead: head, missing: null }).l2Schema, "mismatch");
  assert.equal(legacy({ bodyHead: head, missing: [] }).l2Schema, "mismatch");
  assert.equal(legacy({ bodyHead: `[${head.slice(1)}` }).l2Schema, "mismatch");
});

test("古い行: bodyHead が本文の全部（500 文字未満）なら今の規則で判定し直す（閉じていなければ mismatch・欠けたキーは空）", () => {
  assert.deepEqual(legacy({ bodyHead: '{"count": 1}', missing: ["items"] }), { l2Schema: "mismatch", missing: ["items"], reason: "missing_keys" });
  assert.deepEqual(legacy({ bodyHead: '{"error":"x"}' }), { l2Schema: "mismatch", missing: ["count", "items"], reason: "missing_keys" });
  assert.deepEqual(legacy({ bodyHead: '{"count": 1, "items": [' }), { l2Schema: "mismatch", missing: [], reason: "unparseable" });
});

test("古い行: 出力の宣言が無く JSON として閉じていない（または閉じたか分からない）→ mismatch・欠けたキーなし（WARN）", () => {
  const none = schemaWith(null, null);
  const longHead = longJson(40_000).slice(0, 500);
  assert.deepEqual(legacy({ declaredSchema: none, missing: [], bodyHead: longHead }), { l2Schema: "mismatch", missing: [], reason: null });
  assert.deepEqual(legacy({ declaredSchema: none, missing: null, bodyHead: '{"a": [1, 2' }), { l2Schema: "mismatch", missing: [], reason: null });
  assert.deepEqual(legacy({ declaredSchema: none, missing: [], bodyHead: null }), { l2Schema: "mismatch", missing: [], reason: null });
  // 本文が 500 文字未満で全部そろっていて閉じていれば、今の規則と同じ no_declaration
  assert.equal(legacy({ declaredSchema: none, missing: [], bodyHead: '{"a": 1}' }).l2Schema, "no_declaration");
});

test("古い行: Content-Type が JSON でない・JSON の頭でない・印のある行はそのまま", () => {
  assert.equal(legacy({ contentType: "text/html", bodyHead: "<html>" }).l2Schema, "mismatch");
  assert.equal(legacy({ bodyHead: "<html>" + "x".repeat(600) }).l2Schema, "mismatch");
  assert.equal(legacy({ l2Reason: "missing_keys", bodyHead: longJson(40_000).slice(0, 500) }).l2Schema, "mismatch");
  assert.equal(legacy({ l2Schema: "match" }).l2Schema, "match");
});

test("topLevelKeysOfJsonHead: 最上位のキーだけ・文字列の中の括弧とエスケープを数えない・切れた頭でもよい", () => {
  const keys = topLevelKeysOfJsonHead('{"a":{"b":1,"c":"}{"},"d":"x\\"y","e":[{"f":1}],"g":"trun');
  assert.deepEqual([...keys].sort(), ["a", "d", "e", "g"]);
  assert.equal(topLevelKeysOfJsonHead('[{"a":1}]').size, 0);
});
