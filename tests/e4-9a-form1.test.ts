// 9a（E4 形1・x402 公式 scheme `auth-capture`）の 9a-6 公開名と 9a-7 比較表、公開文の決まり、export.csv 非接触。
// 支払いの振る舞い（9a-1〜9a-5・9a-8）は packages/sdk/test/e4-auth-capture.test.mjs（CI）と
// packages/sdk/test/integration/e4-auth-capture-anvil.test.mjs（anvil のある手元）が持つ。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  E4_FORM1_PUBLIC_TESTNET_RUN,
  E4_PUBLIC_SCHEME_NAME,
  E4_PUBLIC_SCOPE_EN,
  E4_PUBLIC_SCOPE_JA,
  E4_PUBLIC_TAGLINE,
  E4_SCHEME_CITATION,
  E4_SPEC_COMMIT,
  E4_SUPPORTING_CITATIONS,
  assertE4SchemeCitationReady,
  e4FormComparisonTable,
  isAllowedE4SchemePublicName,
  isForbiddenE4SchemePublicName,
} from "@/lib/e4/form1";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import { isE4Form1PublicTestnetGreen } from "@/lib/observatory/p2-live";

test("9a-6 公開名の一次引用は、コミット固定の scheme_auth_capture.md の L1 で scheme 名を名指しする", () => {
  assertE4SchemeCitationReady();
  assert.equal(
    E4_SCHEME_CITATION.url,
    "https://github.com/x402-foundation/x402/blob/d3eb19d018801c190be58acf4017e76f8bcf6d45/specs/schemes/auth-capture/scheme_auth_capture.md#L1",
  );
  assert.equal(E4_SCHEME_CITATION.line, 1);
  // 2026-11-11 に gh api で取った同じコミットの L1 そのまま。
  assert.equal(E4_SCHEME_CITATION.text, "# Scheme: `auth-capture`");
  assert.equal(E4_PUBLIC_SCHEME_NAME, "auth-capture");
  for (const c of E4_SUPPORTING_CITATIONS) assert.doesNotThrow(() => assertE4SchemeCitationReady({ ...c, text: `${c.text} \`auth-capture\`` }));
});

test("9a-6 引用が空・コミット固定でない・行が違う・名指ししない、はどれも fail（skip にも暫定の合格にもしない）", () => {
  assert.throws(() => assertE4SchemeCitationReady({ url: "", line: 1, text: "" }), /e4_scheme_citation_missing/);
  assert.throws(() => assertE4SchemeCitationReady({ url: E4_SCHEME_CITATION.url, line: 0, text: E4_SCHEME_CITATION.text }), /missing/);
  assert.throws(
    () => assertE4SchemeCitationReady({ ...E4_SCHEME_CITATION, url: "https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth_capture.md#L1" }),
    /not_pinned/,
  );
  assert.throws(
    () => assertE4SchemeCitationReady({ ...E4_SCHEME_CITATION, url: "https://github.com/coinbase/x402/blob/d3eb19d018801c190be58acf4017e76f8bcf6d45/specs/schemes/auth-capture/scheme_auth_capture.md#L1" }),
    /not_pinned/,
    "正典は x402-foundation/x402（coinbase/x402 はそのフォーク）",
  );
  assert.throws(
    () => assertE4SchemeCitationReady({ ...E4_SCHEME_CITATION, url: "https://github.com/x402-foundation/x402/blob/d3eb19d018801c190be58acf4017e76f8bcf6d45/specs/schemes/exact/scheme_exact_evm.md#L1" }),
    /not_pinned/,
    "exact の文書では auth-capture の名を引用したことにならない",
  );
  assert.throws(() => assertE4SchemeCitationReady({ ...E4_SCHEME_CITATION, line: 2 }), /line_mismatch/);
  assert.throws(() => assertE4SchemeCitationReady({ ...E4_SCHEME_CITATION, text: "# Scheme" }), /does_not_name_scheme/);
});

test("9a-6 SDK の引用と同じコミットを指す（2 か所で別のコミットを名乗らない）", () => {
  const sdk = readFileSync(join(process.cwd(), "packages/sdk/src/auth-capture.ts"), "utf8");
  assert.match(sdk, new RegExp(`AUTH_CAPTURE_SPEC_COMMIT = "${E4_SPEC_COMMIT}"`));
  assert.match(sdk, /export const AUTH_CAPTURE_SCHEME = "auth-capture";/);
});

test("9a-6 公開してよい名は auth-capture だけ。自社の造語・nvm:・subetha- と綴りの揺れは拒む", () => {
  assert.equal(isAllowedE4SchemePublicName("auth-capture"), true);
  assert.equal(isForbiddenE4SchemePublicName("auth-capture"), false);
  for (const name of [
    "nvm:erc4337",
    "nvm:card-delegation",
    "subetha-zerc20",
    "x-subetha-escrow",
    "vet402-escrow",
    "vet402:deliver",
    "deliver-then-settle",
    "settle-on-delivery",
    "delivery-gated",
    "Auth-Capture",
    "auth_capture",
    "authcapture",
    " auth-capture",
    "",
  ]) {
    assert.equal(isForbiddenE4SchemePublicName(name), true, `${JSON.stringify(name)} は拒む`);
    assert.equal(isAllowedE4SchemePublicName(name), false);
  }
});

const PUBLIC_EN = () => [
  E4_PUBLIC_TAGLINE,
  E4_PUBLIC_SCOPE_EN,
  ...e4FormComparisonTable().flatMap((r) => [r.label, r.testnetResult]).filter((s) => s !== "未実施"),
];

test("公開の英文: 短い英文は変えない・we/our/us・ダッシュ・セミコロンを置かない", () => {
  assert.equal(E4_PUBLIC_TAGLINE, "Settle only once the answer has arrived");
  for (const s of PUBLIC_EN()) {
    assert.doesNotMatch(s, /\b(we|our|us)\b/i, s);
    assert.doesNotMatch(s, /[—–]/, s);
    assert.doesNotMatch(s, /;/, s);
  }
});

test("公開の範囲は「対応する売り手に限り」。対応済みの売り手が居るとは書かない", () => {
  assert.equal(E4_PUBLIC_SCOPE_JA, "対応する売り手に限り、売り手がエラーを返した支払いは確定しない。");
  // 公式の売り手実装は 400 未満を capture する。202 や空の本文まで「確定しない」と広げない。
  for (const s of [E4_PUBLIC_SCOPE_JA, E4_PUBLIC_SCOPE_EN]) {
    assert.doesNotMatch(s, /届かなかった支払いは確定しない|202|empty body|never arrived/i, s);
  }
  assert.match(E4_PUBLIC_SCOPE_EN, /error status/);
  assert.match(E4_PUBLIC_SCOPE_EN, /only the seller's operator can refund it/);
  assert.match(E4_PUBLIC_SCOPE_EN, /^This applies only to sellers that offer auth-capture\./);
  for (const s of PUBLIC_EN()) {
    assert.doesNotMatch(s, /\b(already|now|today)\b/i, s);
    assert.doesNotMatch(s, /\b\d[\d,]*\s+sellers?\b/i, s);
    assert.doesNotMatch(s, /\b(sellers?|vendors?)\s+(support|offer|use)s?\s+(it|auth-capture)\s+(today|now)\b/i, s);
    assert.doesNotMatch(s, /\bguarantee/i, s);
  }
});

test("9a-7 比較表: 形1の testnet は未実施ではない（実際に通した結果）・形2と形3は未実施のまま・緑と書かない", () => {
  const rows = e4FormComparisonTable();
  assert.equal(rows.length, 3);
  const f1 = rows.find((r) => r.form === 1);
  assert.ok(f1);
  assert.notEqual(f1.testnetResult, "未実施");
  assert.doesNotMatch(f1.testnetResult, /pending/i, "pending を合格文にしない");
  for (const word of ["captured", "voided", "ExceedsMaxAmount", "reclaim", "buyer delta 0", "84532", "operator_captured_undelivered"]) {
    assert.ok(f1.testnetResult.includes(word), word);
  }
  assert.match(f1.testnetResult, /public Base Sepolia/);
  assert.match(f1.testnetResult, /2026-11-13/);
  assert.match(f1.testnetResult, /Each of the seven signed calls sent its payment once/);
  assert.match(f1.testnetResult, /The call above the SDK maxPerTxUsd limit was not signed/);
  assert.match(f1.testnetResult, /local fork/);
  // 空の 200 と 202 の void は試験用の売り手の決まり。公式の門の結果として書かない。
  assert.match(f1.testnetResult, /Empty 200 and 202: voided only because the test seller follows a delivery rule/);
  assert.match(f1.testnetResult, /Under the reference server rule a 202 is captured/);
  assert.doesNotMatch(f1.testnetResult, /HTTP 500, empty 200 and 202: voided/);
  assert.doesNotMatch(f1.testnetResult, /Not yet run on the public Base Sepolia network/);
  assert.equal(f1.holdsCustody, false);
  assert.equal(f1.movesFundsOnSettle, false);
  assert.match(f1.label, /auth-capture/);
  for (const r of rows.filter((x) => x.form !== 1)) {
    assert.equal(r.testnetResult, "未実施");
  }
});

const E4_FIXTURE_SCENARIO_BY_TX_KEY: Record<keyof typeof E4_FORM1_PUBLIC_TESTNET_RUN.txs, string> = {
  captureDelivered: "delivered",
  voidHttp500: "fail500",
  voidEmpty200: "empty200",
  voidAccepted202: "accepted202",
  captureOfficial202: "official202",
  revertedAboveMax: "ceiling_chain",
  reclaim: "vanish_reclaim",
};

function collectHex64Strings(value: unknown, path: string, out: { path: string; value: string }[]): void {
  if (typeof value === "string") {
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
      out.push({ path, value });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectHex64Strings(v, `${path}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      collectHex64Strings(v, path ? `${path}.${k}` : k, out);
    }
  }
}

type E4ScenarioSdk = {
  status: string;
  outcome: string | null;
  deliveryFailure: string | null;
  reasons: string[];
  signed: boolean;
};

type E4PublicTestnetScenario = {
  id: string;
  expect: string;
  txs: { role: string; hash: string; expectedStatus: number; status: number }[];
  sdk: E4ScenarioSdk;
  buyerDelta: string;
  sellerDelta: string;
  pass: boolean;
  paymentHeadersSeen?: string;
  revertError?: string | null;
  earlyReclaimRefused?: boolean;
};

type E4PublicTestnetFixture = {
  kind: string;
  chainId: string;
  allPass: boolean;
  stopped: string | null;
  usdcSpentUnits: string;
  resendsPerCall?: string;
  scenarios: E4PublicTestnetScenario[];
};

const SCENARIO_TX_ROLES: Record<string, string[]> = {
  delivered: ["authorize", "capture"],
  fail500: ["authorize", "void"],
  empty200: ["authorize", "void"],
  accepted202: ["authorize", "void"],
  official202: ["authorize", "capture"],
  ceiling_sdk: [],
  ceiling_chain: ["greedy_authorize"],
  vanish_reclaim: ["authorize", "reclaim"],
};

const SCENARIO_EXPECTATIONS: Record<
  string,
  {
    sdk: Partial<E4ScenarioSdk> & Pick<E4ScenarioSdk, "status" | "signed">;
    buyerDelta: string;
    sellerDelta: string;
    txCount?: number;
    paymentHeadersSeen?: string;
    revertError?: string;
    earlyReclaimRefused?: boolean;
  }
> = {
  delivered: {
    sdk: { status: "paid", outcome: "captured", signed: true, deliveryFailure: null },
    buyerDelta: "-10000",
    sellerDelta: "10000",
    txCount: 2,
  },
  fail500: {
    sdk: { status: "failed", outcome: "voided", signed: true, deliveryFailure: "http_status" },
    buyerDelta: "0",
    sellerDelta: "0",
    txCount: 2,
  },
  empty200: {
    sdk: { status: "failed", outcome: "voided", signed: true, deliveryFailure: "empty_body" },
    buyerDelta: "0",
    sellerDelta: "0",
    txCount: 2,
  },
  accepted202: {
    sdk: { status: "failed", outcome: "voided", signed: true, deliveryFailure: "accepted_202" },
    buyerDelta: "0",
    sellerDelta: "0",
    txCount: 2,
  },
  official202: {
    sdk: {
      status: "failed",
      outcome: "captured",
      signed: true,
      deliveryFailure: "accepted_202",
    },
    buyerDelta: "-10000",
    sellerDelta: "10000",
    txCount: 2,
  },
  ceiling_sdk: {
    sdk: { status: "refused", outcome: null, signed: false },
    buyerDelta: "0",
    sellerDelta: "0",
    txCount: 0,
    paymentHeadersSeen: "0",
  },
  ceiling_chain: {
    sdk: { status: "failed", outcome: "not_authorized", signed: true, deliveryFailure: "http_status" },
    buyerDelta: "0",
    sellerDelta: "0",
    txCount: 1,
    paymentHeadersSeen: "1",
    revertError: "ExceedsMaxAmount",
  },
  vanish_reclaim: {
    sdk: { status: "failed", outcome: "held", signed: true, deliveryFailure: "timeout" },
    buyerDelta: "0",
    sellerDelta: "0",
    txCount: 2,
    paymentHeadersSeen: "1",
    earlyReclaimRefused: true,
  },
};

test("9a-7 公開 Base Sepolia 実払い fixture と E4_FORM1_PUBLIC_TESTNET_RUN が一致する", () => {
  const raw = readFileSync(join(process.cwd(), E4_FORM1_PUBLIC_TESTNET_RUN.fixture), "utf8");
  const fixture: E4PublicTestnetFixture = JSON.parse(raw) as E4PublicTestnetFixture;
  assert.equal(fixture.kind, "e4-9a-testnet-run");
  assert.equal(fixture.chainId, "84532");
  assert.equal(fixture.allPass, true);
  assert.equal(fixture.stopped, null);
  assert.ok(Number(fixture.usdcSpentUnits) <= 100_000);
  const expectedIds = [
    "delivered",
    "fail500",
    "empty200",
    "accepted202",
    "official202",
    "ceiling_sdk",
    "ceiling_chain",
    "vanish_reclaim",
  ];
  assert.deepEqual(
    fixture.scenarios.map((s) => s.id),
    expectedIds,
  );
  for (const s of fixture.scenarios) {
    const exp = SCENARIO_EXPECTATIONS[s.id];
    assert.ok(exp, s.id);
    assert.equal(s.sdk.status, exp.sdk.status, `${s.id} status`);
    if (exp.sdk.outcome !== undefined) {
      assert.equal(s.sdk.outcome, exp.sdk.outcome, `${s.id} outcome`);
    }
    if (exp.sdk.deliveryFailure !== undefined) {
      assert.equal(s.sdk.deliveryFailure, exp.sdk.deliveryFailure, `${s.id} deliveryFailure`);
    }
    if (s.id === "official202") {
      assert.ok(s.sdk.reasons.includes("operator_captured_undelivered"), `${s.id} reasons`);
    }
    assert.equal(s.sdk.signed, exp.sdk.signed, `${s.id} signed`);
    assert.equal(s.buyerDelta, exp.buyerDelta, `${s.id} buyerDelta`);
    assert.equal(s.sellerDelta, exp.sellerDelta, `${s.id} sellerDelta`);
    if (exp.txCount !== undefined) {
      assert.equal(s.txs.length, exp.txCount, `${s.id} tx count`);
    }
    const wantRoles = SCENARIO_TX_ROLES[s.id];
    assert.ok(wantRoles, `${s.id} roles map`);
    assert.equal(s.txs.length, wantRoles.length, `${s.id} role slot count`);
    for (const role of wantRoles) {
      const roleTxs = s.txs.filter((t) => t.role === role);
      assert.equal(roleTxs.length, 1, `${s.id} ${role} count`);
      assert.equal(roleTxs[0]!.status, roleTxs[0]!.expectedStatus, `${s.id} ${role} status`);
    }
    // 払い直し 0 回の実測: 売り手が受けた署名付き要求は、署名した場面で 1、署名しない場面で 0。
    assert.equal(s.paymentHeadersSeen, exp.paymentHeadersSeen ?? "1", `${s.id} paymentHeadersSeen`);
    if (exp.revertError !== undefined) {
      assert.equal(s.revertError, exp.revertError, `${s.id} revertError`);
    }
    if (exp.earlyReclaimRefused !== undefined) {
      assert.equal(s.earlyReclaimRefused, exp.earlyReclaimRefused, `${s.id} earlyReclaimRefused`);
    }
    for (const tx of s.txs) {
      assert.equal(tx.status, tx.expectedStatus, `${s.id} ${tx.role}`);
    }
  }
  assert.equal(fixture.resendsPerCall, "0");
  for (const [txKey, scenarioId] of Object.entries(E4_FIXTURE_SCENARIO_BY_TX_KEY) as [
    keyof typeof E4_FORM1_PUBLIC_TESTNET_RUN.txs,
    string,
  ][]) {
    const scenario = fixture.scenarios.find((s) => s.id === scenarioId);
    if (!scenario) assert.fail(scenarioId);
    const expectedByRole = E4_FORM1_PUBLIC_TESTNET_RUN.txs[txKey];
    const roleToHash = expectedByRole as Record<string, string>;
    for (const role of Object.keys(roleToHash)) {
      const want = roleToHash[role]!;
      const got: string | undefined = scenario.txs.find((t) => t.role === role)?.hash;
      assert.equal(got, want, `${scenarioId} ${role}`);
    }
  }
  const hex64: { path: string; value: string }[] = [];
  collectHex64Strings(fixture, "", hex64);
  const txHashPaths = new Set(
    fixture.scenarios.flatMap((s, si) => s.txs.map((_, ti) => `scenarios[${si}].txs[${ti}].hash`)),
  );
  for (const { path, value } of hex64) {
    assert.ok(txHashPaths.has(path), `64 hex at ${path}: ${value.slice(0, 18)}…`);
  }
});

test("9a-2 p2-live: E4 public testnet green follows allPass and void or reclaim hashes", () => {
  assert.equal(E4_FORM1_PUBLIC_TESTNET_RUN.allPass, true);
  assert.equal(isE4Form1PublicTestnetGreen(), true);
});

test("export.csv の列は 19 列のまま（この変更で列・順番を変えない）", () => {
  assert.deepEqual(
    [...EXPORT_CSV_COLUMNS],
    [
      "attempted_at", "resource_key", "network", "status", "amount_units", "spent_units", "tx_hash", "http_status_paid",
      "latency_ms", "l2_schema", "held_reason", "request_body", "request_body_sha256", "settlement_source", "request_query",
      "request_query_sha256", "confirmed_units", "purchase_id", "l2_reading",
    ],
  );
});
