// ============================================================
// Scope: S1-1 applies on Base (eip155:8453) only; termsRecorded on other networks is not changed here.
// S1-1 の合格の表（2026-11-08・Claude が先に固定。実装はこの表を緑にする）。
// seller_fixable_input に入るのは、決済済み（held_reason settled_4xx）で、
// 売り手の側に置く前の確認（条件の記録・残高・入力を全部送った・待ち切った）を全部通り、
// 400/422 の答えの先頭が検証の枠組みの構造化エラー（FastAPI/pydantic の detail[].loc、zod の issues[].path、
// errors[].field|path|param）として JSON で読める行だけ。自由文のエラーは読まない（2026-11-08 3 回目のレビューで方式を絞った）。
// どれか 1 つでも欠ければ seller の側に置かない。実装の述語をここで呼ばない（同語反復にしない）。
//
// 4 回目の独立レビュー指摘 1〜10（S1NEXT 本文は無いため rv1/rv2/rv3/rr1 の要約。原文の写しではない）:
// 1. merge-base は origin/main と一致させ、旧 squash ブランチは merge しない。
// 2. 許可リスト: 英数と _ のみ・pydantic loc 2 段以上・json_invalid/model_attributes_type 除外。
// 3. generic は location/in が body か query のときだけ。認証語は auth|secret|password|credential|bearer|jwt|session|key$。
// 4. S1-1 は Base（eip155:8453）のみ。termsRecorded は触らない。
// 5. bodyHead は SQL left(..., 500)。件数測定は tests/s1-1-bodyhead-500-measurement.md。
// 6. 英文公開面に em dash・セミコロン・our を置かない（rules-text 同期）。
// 7. export.csv / delivery の held_reason は sellers 分類を読まない。
// 8. decision と /sellers が同じ固定行で逆にならない。BLOCK なし。
// 9. 配達なし 2 UTC 日で n_counted と l1_basis が一致。
// 10. ERC-8004 の NOT_INDEXED 2 鎖と Base scanned を差分で消さない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRow, BASE_USDC_ADDRESS, type SellerRowFacts } from "@/lib/sellers/fix-modes";
import { heldReasonOf } from "@/lib/observatory/delivery";
import { DECISION_RULES_VERSION } from "@/lib/decision/rules";
import { readFileSync } from "node:fs";

const TX = `0x${"ab".repeat(32)}`;
const PYDANTIC = `{"detail":[{"type":"missing","loc":["body","query"],"msg":"Field required","input":{}}]}`;

function settled(p: Partial<SellerRowFacts> & { bodyHead?: string } = {}): SellerRowFacts {
  const { bodyHead, ...rest } = p;
  return {
    endpointId: "ep-s1-1-acc",
    status: "settled",
    httpStatusPaid: 400,
    txHash: TX,
    attemptedAt: "2026-10-20T12:00:00Z",
    network: "eip155:8453",
    method: "POST",
    meta: {
      requestBody: "declared",
      requestBodySha256: "a".repeat(64),
      requestQuery: "empty",
      bodyHead: bodyHead ?? PYDANTIC,
    },
    schema: { properties: { input: { properties: { body: { type: "object" } } } } },
    declaredInput: { query: "empty", body: "declared" },
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    amountUnits: "10000",
    payTo: `0x${"11".repeat(20)}`,
    asset: BASE_USDC_ADDRESS,
    payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    declaresHeaders: false,
    pathTemplate: false,
    listingMaxTimeoutSeconds: 20,
    ...rest,
  };
}

const PASS: Array<[string, SellerRowFacts]> = [
  ["400 + FastAPI/pydantic detail[].loc", settled()],
  ["422 + pydantic", settled({ httpStatusPaid: 422 })],
  ["400 + zod issues[].path", settled({ bodyHead: `{"success":false,"error":"Validation failed","issues":[{"expected":"string","code":"invalid_type","path":["body","url"],"message":"Required"}]}` })],
  ["400 + zod nested under error", settled({ bodyHead: `{"error":{"issues":[{"code":"too_small","path":["body","source"],"message":"String must contain at least 50 character(s)"}]}}` })],
  ["400 + errors[].field with in body", settled({ bodyHead: `{"errors":[{"in":"body","field":"offer_id","message":"is required"}]}` })],
  ["400 + errors[].location query", settled({ bodyHead: `{"errors":[{"location":"query","param":"symbol","message":"is required"}]}` })],
];

const FAIL: Array<[string, SellerRowFacts]> = [
  ["no charge (unsettled_4xx)", settled({ status: "settle_failed", txHash: null })],
  ["body declared, sent empty", settled({ meta: { requestBody: "empty", requestQuery: "empty", bodyHead: `{"error":"field 'query' is required"}` } })],
  ["body declared, sent none", settled({ meta: { requestBody: "none", requestQuery: "empty", bodyHead: `{"error":"field 'query' is required"}` } })],
  ["body declared, only the query sent", settled({ meta: { requestBody: "empty", requestQuery: "declared", requestQuerySha256: "c".repeat(64), bodyHead: `{"error":"field 'query' is required"}` }, declaredInput: { query: "declared", body: "declared" } })],
  ["declared headers not sent", settled({ declaresHeaders: true })],
  ["path variable not filled", settled({ pathTemplate: true })],
  ["payTo not recorded", settled({ payTo: null })],
  ["invalid_payment", settled({ bodyHead: `{"error":"invalid_payment"}` })],
  ["payment identifier required", settled({ bodyHead: `{"success":false,"error":"payment_identifier_required","message":"Payment identifier is required for this endpoint"}` })],
  ["invalid x402 payment", settled({ bodyHead: `{ "error": "Invalid x402 payment: use one header and the quoted requirements" }` })],
  ["invalid api key", settled({ bodyHead: `{"error":"invalid api key"}` })],
  ["missing token", settled({ bodyHead: `{"error":"Unauthorized: missing token"}` })],
  ["missing bearer authorization", settled({ bodyHead: `{"error":"missing bearer"}` })],
  ["no validation words", settled({ bodyHead: `{"error":"bad request"}` })],
  ["empty body head", settled({ bodyHead: "" })],
  // 2026-11-08 独立レビュー 2 回目で見つかった形
  ["no declaration, no body sent", settled({ schema: null, declaredInput: null, method: "GET", meta: { requestBody: "none", requestQuery: "empty", bodyHead: `{"error":"prompt is required"}` } })],
  ["no declaration, empty body sent", settled({ schema: null, declaredInput: null, meta: { requestBody: "empty", requestQuery: "empty", bodyHead: `{"error":"prompt is required"}` } })],
  ["x402 invalid_network", settled({ bodyHead: `{"error":"invalid_network"}` })],
  ["x402 invalid_scheme", settled({ bodyHead: `{"error":"invalid_scheme"}` })],
  ["x402 invalid_payload", settled({ bodyHead: `{"error":"invalid_payload"}` })],
  ["x402 invalid_transaction_state", settled({ bodyHead: `{"error":"invalid_transaction_state"}` })],
  ["x402 svm amount mismatch", settled({ bodyHead: `{"error":"invalid_exact_svm_payload_transaction_amount_mismatch"}` })],
  ["x402 evm recipient mismatch", settled({ bodyHead: `{"error":"invalid_exact_evm_payload_recipient_mismatch"}` })],
  ["cut header name", settled({ bodyHead: `{"error":"missing required header X-PAYM` })],
  ["HTML page", settled({ bodyHead: `<html><body>JavaScript is required` })],
  ["plain text cookies", settled({ bodyHead: `Cookies must be enabled` })],
  ["upstream invalid response", settled({ bodyHead: `{"error":"Upstream returned invalid response"}` })],
  ["invalid JSON in body", settled({ bodyHead: `{"error":"Invalid JSON in request body"}` })],
  ["invalid wallet address", settled({ bodyHead: `{"error":"invalid wallet address"}` })],
  ["quota with expected", settled({ bodyHead: `{"error":"Quota exceeded, expected wait 60s"}` })],
  // 2026-11-08 3 回目: 自由文は読まない
  ["free text required", settled({ bodyHead: `{"error":"field 'query' is required"}` })],
  ["free text must be a number", settled({ bodyHead: `{"error":"amount must be a number"}` })],
  ["Content-Type must be", settled({ bodyHead: `{"error":"Content-Type must be application/json"}` })],
  ["User-Agent not allowed", settled({ bodyHead: `{"error":"User-Agent is not allowed"}` })],
  ["request body is missing", settled({ bodyHead: `{"error":"request body is missing"}` })],
  ["validBefore", settled({ bodyHead: `{"error":"validBefore must be in the future"}` })],
  ["missing accepts", settled({ bodyHead: `{"error":"missing accepts"}` })],
  ["escaped payment", settled({ bodyHead: `{"error":"\\u0070ayment required"}` })],
  ["session required", settled({ bodyHead: `{"error":"session required"}` })],
  ["captcha required", settled({ bodyHead: `{"error":"captcha required"}` })],
  ["too many requests", settled({ bodyHead: `{"error":"too many requests, retry later"}` })],
  ["structured but about a header", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["header","x-api-key"],"msg":"Field required"}]}` })],
  ["structured but about the payment", settled({ bodyHead: `{"issues":[{"code":"invalid_type","path":["payment","signature"],"message":"Required"}]}` })],
  ["structured but cut off", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","qu` })],
  ["structured with an empty list", settled({ bodyHead: `{"detail":[]}` })],
  ["409", settled({ httpStatusPaid: 409 })],
  ["404", settled({ httpStatusPaid: 404 })],
  ["401", settled({ httpStatusPaid: 401 })],
  ["403", settled({ httpStatusPaid: 403 })],
  ["429", settled({ httpStatusPaid: 429 })],
  ["errors[].field without in or location", settled({ bodyHead: `{"errors":[{"field":"offer_id","message":"is required"}]}` })],
  ["pydantic loc only one segment", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body"],"msg":"Field required"}]}` })],
  ["pydantic json_invalid only", settled({ bodyHead: `{"detail":[{"type":"json_invalid","loc":["body",0],"msg":"Invalid JSON"}]}` })],
  ["pydantic model_attributes_type only", settled({ bodyHead: `{"detail":[{"type":"model_attributes_type","loc":["body"],"msg":"Input should be a valid object"}]}` })],
  ["pydantic loc cites password", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","password"],"msg":"Field required"}]}` })],
  ["pydantic loc cites api_key segment", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","api_key"],"msg":"Field required"}]}` })],
  ["zod path only one segment", settled({ bodyHead: `{"issues":[{"code":"invalid_type","path":["url"],"message":"Required"}]}` })],
  ["non-Base network same pydantic row", settled({ network: "eip155:42161" })],
  ["non-Base alias network", settled({ network: "solana:mainnet" })],
  ["Base alias network (base)", settled({ network: "base" })],
  ["pydantic loc cites authentication", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","authentication"],"msg":"Field required"}]}` })],
  ["pydantic loc cites author", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","author"],"msg":"Field required"}]}` })],
  ["pydantic loc cites oauth", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","oauth"],"msg":"Field required"}]}` })],
  ["pydantic loc cites secret", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","secret"],"msg":"Field required"}]}` })],
  ["pydantic loc cites credential", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","credential"],"msg":"Field required"}]}` })],
  ["pydantic loc cites bearer", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","bearer"],"msg":"Field required"}]}` })],
  ["pydantic loc cites jwt", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","jwt"],"msg":"Field required"}]}` })],
  ["query loc cites session", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["query","session"],"msg":"Field required"}]}` })],
  ["pydantic loc hyphen segment", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","foo-bar"],"msg":"Field required"}]}` })],
  ["pydantic loc cites passkey (key$)", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","passkey"],"msg":"Field required"}]}` })],
  ["pydantic loc cites token_auth", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","token_auth"],"msg":"Field required"}]}` })],
  ["pydantic loc cites xauth", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","xauth"],"msg":"Field required"}]}` })],
  ["pydantic loc cites reauth", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","reauth"],"msg":"Field required"}]}` })],
  ["pydantic loc cites my_auth", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","my_auth"],"msg":"Field required"}]}` })],
  ["pydantic loc cites unauthorized", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","unauthorized"],"msg":"Field required"}]}` })],
  ["pydantic loc cites reauthenticate", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","reauthenticate"],"msg":"Field required"}]}` })],
  ["pydantic loc cites xxauthxx", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","xxauthxx"],"msg":"Field required"}]}` })],
  ["pydantic loc cites preauthentication", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","preauthentication"],"msg":"Field required"}]}` })],
  ["pydantic loc cites myauthn", settled({ bodyHead: `{"detail":[{"type":"missing","loc":["body","myauthn"],"msg":"Field required"}]}` })],
  ["errors[].property with in body", settled({ bodyHead: `{"errors":[{"in":"body","property":"title","message":"is required"}]}` })],
];

for (const [name, r] of PASS) {
  test(`S1-1 pass: ${name} → seller_fixable_input on the seller side`, () => {
    assert.equal(heldReasonOf(r), "settled_4xx", "the ledger hold does not change");
    const c = classifyRow(r);
    assert.equal(c.mode?.key, "seller_fixable_input");
    assert.equal(c.bucket, "seller");
  });
}

for (const [name, r] of FAIL) {
  test(`S1-1 fail: ${name} → not seller_fixable_input, not the seller side`, () => {
    const c = classifyRow(r);
    assert.notEqual(c.mode?.key, "seller_fixable_input");
    assert.notEqual(c.bucket, "seller");
  });
}

test("S1-1: the decision rules version moves past 2026-11-02.3 (a held row can now count)", () => {
  assert.notEqual(DECISION_RULES_VERSION, "2026-11-02.3");
});

test("S1-1: the /sellers and decision readers carry the answer head for settled 400/422 rows", () => {
  for (const f of ["src/lib/sellers/reader.ts", "src/lib/decision/l1-window-purchases.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /bodyHead/, `${f} must carry bodyHead into the row meta`);
    assert.match(
      src,
      /'settled'\s+AND\s+\w*\.?http_status_paid\s+IN\s*\(\s*400\s*,\s*422\s*\)[\s\S]{0,120}left\([^)]*bodyHead[^)]*,\s*500\)/,
      `${f} must truncate bodyHead at 500 characters for settled 400/422 rows`,
    );
  }
});

test("S1-1: bodyHead truncated at 500 characters still classifies via the cut string", () => {
  const prefix = `{"detail":[{"type":"missing","loc":["body","query"],"msg":"`;
  const suffix = `","input":{}}]}`;
  const longPad = "x".repeat(500 - prefix.length - suffix.length + 80);
  const full = prefix + longPad + suffix;
  assert.ok(full.length > 500, "fixture must exceed 500 characters before truncation");
  const head = (prefix + longPad.slice(0, 500 - prefix.length - suffix.length) + suffix).slice(0, 500);
  assert.equal(head.length, 500);
  JSON.parse(head);
  const c = classifyRow(
    settled({
      meta: {
        requestBody: "declared",
        requestBodySha256: "a".repeat(64),
        requestQuery: "empty",
        bodyHead: head,
      },
    }),
  );
  assert.equal(c.mode?.key, "seller_fixable_input");
  assert.equal(c.bucket, "seller");
});

test("S1-1: export.csv and the state API do not read the /sellers classification", () => {
  for (const f of [
    "src/app/api/v1/observatory/export.csv/route.ts",
    "src/app/api/v1/observatory/state/route.ts",
    "src/lib/observatory/reader.ts",
    "src/lib/observatory/delivered-rates.ts",
    "src/lib/observatory/delivery.ts",
  ]) {
    const src = readFileSync(f, "utf8");
    assert.equal(/from\s+["']@\/lib\/sellers\//.test(src), false, `${f} must not import from lib/sellers`);
    assert.equal(src.includes("seller_fixable_input"), false, `${f} must not name seller_fixable_input`);
  }
});
