// ============================================================
// L2: 購入行の宣言（402 見本）で conform / l2_conform_no_required_keys（2026-11-13）。
// ============================================================
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleSellerFacts,
  type ProbeInput,
  type PurchaseInput,
  type SellerFactsInput,
} from "@/lib/decision/seller-facts";
import { decidePayer, type L1Timeline } from "@/lib/decision/rules";
import {
  checkL2Detailed,
  l2ReadingLabelOf,
  l2ReadingOf,
  l2RequiredKeysOf,
  L2_MATCH_NO_REQUIRED_KEYS_GLOSS,
} from "@/lib/observatory/l2-check";
import { DECISION_RULES_VERSION } from "@/lib/decision/rules";
import { DECISION_RULES_TEXT } from "@/lib/decision/rules-text";
import { withSettledTier } from "@/lib/observatory/reader";

const EXAMPLE = { currency_pair: "CELO/ARS", casa: "blue", quotes: {}, source: "x", note: "n" };
const H = createHash("sha256").update(JSON.stringify(EXAMPLE), "utf8").digest("hex");
const R = "bb".repeat(32);

const passProbe: ProbeInput = {
  probedAt: "2026-11-13T03:00:00Z",
  verdict: "pass",
  dialect: "v2",
  failReason: null,
  priceAmount: "declared",
  priceAsset: null,
  payTo: "declared",
};

const landingRow = (): PurchaseInput => ({
  attemptedAt: "2026-11-13T03:30:32Z",
  status: "settled",
  latencyMs: 100,
  httpStatusPaid: 200,
  payloadNonEmpty: true,
  l2Schema: "match",
  txHash: "0xabc",
  network: "eip155:42220",
  l2Detail: {
    missing: [],
    declarationHash: H,
    responseHash: R,
    reason: null,
    liveOutputExample: { exampleHash: H },
  },
  contentType: "application/json",
});

const baseInput = (purchases: PurchaseInput[], declaredSchema: unknown | null = null): SellerFactsInput => ({
  probes: [passProbe],
  purchases,
  settlements30d: { raw: 1, real: 1, test: 0, uniquePayersReal: 1 },
  payees: [],
  declaredSchema,
  method: "GET",
  lastAttemptAt: "2026-11-13T03:30:32Z",
  lastSignedAttemptAt: "2026-11-13T03:30:32Z",
  lastDeliveredAt: "2026-11-13T03:30:32Z",
});

const timeline: L1Timeline = {
  n_counted: 1,
  n_paid_undelivered: 0,
  n_paid_undelivered_since_delivery: 0,
  latest_counted: { at: "2026-11-13T03:30:32Z", delivered: true },
  last_delivered_at: "2026-11-13T03:30:32Z",
  last_signed_attempt_at: "2026-11-13T03:30:32Z",
};

test("A+B: landingen24h 形 → conform・記録頁ラベル・判定", () => {
  const row = landingRow();
  const reading = l2ReadingOf({ l2Schema: row.l2Schema, l2Detail: row.l2Detail, contentType: "application/json" }, null);
  assert.equal(reading, "match");
  assert.equal(l2ReadingLabelOf(reading, { l2Detail: row.l2Detail }, null), "match (no required keys)");
  const out: { l2ConformNoRequiredKeys?: boolean } = {};
  const facts = assembleSellerFacts(baseInput([row]), { out });
  assert.equal(facts.l2.status, "conform");
  assert.equal(facts.l2.observed_at, "2026-11-13T03:30:32.000Z");
  assert.equal(facts.l2.declaration_hash, H);
  assert.equal(facts.l2.response_hash, R);
  assert.equal(out.l2ConformNoRequiredKeys, true);
  const d = decidePayer(facts, { l1Timeline: timeline, l2ConformNoRequiredKeys: true });
  assert.ok(d.reason_codes.includes("l2_conform"));
  assert.ok(d.reason_codes.includes("l2_conform_no_required_keys"));
  assert.ok(!d.reason_codes.includes("l2_undeclared"));
  const undeclared = assembleSellerFacts({
    ...baseInput([{ ...landingRow(), l2Detail: null, l2Schema: "no_declaration" }]),
  });
  const d0 = decidePayer(undeclared, { l1Timeline: timeline });
  assert.equal(d.recommendation, d0.recommendation);
  const [withLabel] = withSettledTier(
    [
      {
        status: "settled",
        txHash: row.txHash,
        network: row.network,
        authNonce: null,
        settlementVerified: null,
        lateSettlement: null,
        circleGateway: null,
        l2Schema: row.l2Schema,
        l2Detail: row.l2Detail,
        l2BodyHead: null,
        l2ContentType: "application/json",
      },
    ],
    null,
  );
  assert.equal(withLabel.l2ReadingLabel, "match (no required keys)");
  assert.ok(L2_MATCH_NO_REQUIRED_KEYS_GLOSS.includes("JSON object or array"));
  assert.ok(!L2_MATCH_NO_REQUIRED_KEYS_GLOSS.includes("output example"));
});

test("C: カタログに必須キーあり・declarationHash がカタログ → some・新語なし", () => {
  const DECL = { properties: { output: { properties: { example: { required: ["a"], properties: { a: {} } } } } } };
  const catHash = createHash("sha256").update(JSON.stringify(DECL), "utf8").digest("hex");
  const row = landingRow();
  row.l2Detail = { ...row.l2Detail!, declarationHash: catHash, liveOutputExample: undefined };
  const out: { l2ConformNoRequiredKeys?: boolean } = {};
  const facts = assembleSellerFacts({ ...baseInput([row], DECL), declaredSchema: DECL }, { out });
  assert.equal(facts.l2.status, "conform");
  assert.equal(out.l2ConformNoRequiredKeys, false);
  const d = decidePayer(facts, { l1Timeline: timeline, l2ConformNoRequiredKeys: false });
  assert.ok(!d.reason_codes.includes("l2_conform_no_required_keys"));
  assert.equal(l2ReadingLabelOf("match", { l2Detail: row.l2Detail }, DECL), "match");
});

test("D: 見本ハッシュ・カタログも出力宣言 → some・新語なし", () => {
  const DECL = { properties: { output: { properties: { example: { required: ["x"], properties: { x: {} } } } } } };
  const row = landingRow();
  assert.equal(l2RequiredKeysOf({ l2Detail: row.l2Detail, l2Reading: "match" }, DECL), "some");
  const out: { l2ConformNoRequiredKeys?: boolean } = {};
  const facts = assembleSellerFacts({ ...baseInput([row], DECL), declaredSchema: DECL }, { out });
  assert.equal(out.l2ConformNoRequiredKeys, false);
});

test("E: 宣言ハッシュがどちらとも違う → unknown・新語なし", () => {
  const row = landingRow();
  row.l2Detail = { ...row.l2Detail!, declarationHash: "cc".repeat(32) };
  assert.equal(l2RequiredKeysOf({ l2Detail: row.l2Detail, l2Reading: "match" }, null), "unknown");
  const out: { l2ConformNoRequiredKeys?: boolean } = {};
  assembleSellerFacts(baseInput([row]), { out });
  assert.equal(out.l2ConformNoRequiredKeys, false);
  assert.equal(l2ReadingLabelOf("match", { l2Detail: row.l2Detail }, null), "match");
});

test("F: カタログ null の mismatch と unexplained", () => {
  const rowKeys: PurchaseInput = {
    ...landingRow(),
    l2Schema: "mismatch",
    l2Detail: {
      missing: ["x"],
      declarationHash: H,
      responseHash: R,
      reason: "missing_keys",
      liveOutputExample: { exampleHash: H },
    },
  };
  const facts = assembleSellerFacts(baseInput([rowKeys]));
  assert.equal(facts.l2.status, "mismatch");
  assert.deepEqual(facts.l2.missing_keys, ["x"]);
  assert.equal(l2ReadingOf({ l2Schema: rowKeys.l2Schema, l2Detail: rowKeys.l2Detail, contentType: "application/json" }, null), "mismatch");
  const d1 = decidePayer(facts, { l1Timeline: timeline });
  assert.equal(d1.recommendation, "BLOCK");
  assert.ok(d1.reason_codes.includes("l2_mismatch"));
  assert.ok(!d1.reason_codes.includes("l2_mismatch_unexplained"));

  const rowShape: PurchaseInput = {
    ...landingRow(),
    l2Schema: "mismatch",
    l2Detail: {
      missing: [],
      declarationHash: H,
      responseHash: R,
      reason: "not_object",
      liveOutputExample: { exampleHash: H },
    },
  };
  const d2 = decidePayer(assembleSellerFacts(baseInput([rowShape])), { l1Timeline: timeline });
  assert.equal(d2.recommendation, "WARN");
  assert.ok(d2.reason_codes.includes("l2_mismatch_unexplained"));
});

test("I: カタログに出力の宣言が無く購入行の宣言で not_checked（本文 256 KiB 超）→ not_checked・WARN", () => {
  const row: PurchaseInput = {
    ...landingRow(),
    l2Schema: "not_checked",
    l2Detail: {
      missing: [],
      declarationHash: H,
      responseHash: R,
      reason: "body_over_cap",
      liveOutputExample: { exampleHash: H },
    },
  };
  const factsNull = assembleSellerFacts(baseInput([row]));
  assert.equal(factsNull.l2.status, "not_checked");
  assert.equal(factsNull.l2.observed_at, "2026-11-13T03:30:32.000Z");
  assert.equal(factsNull.l2.declaration_hash, H);
  assert.equal(factsNull.l2.response_hash, null);
  assert.equal(factsNull.l2.diff_hash, null);
  assert.equal(factsNull.l2.missing_keys, null);
  const d = decidePayer(factsNull, { l1Timeline: timeline });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l2_not_checked"));
  assert.ok(!d.reason_codes.includes("l2_undeclared"));
  assert.ok(!d.reason_codes.includes("l2_conform_no_required_keys"));
  const factsObj = assembleSellerFacts({ ...baseInput([row]), declaredSchema: { type: "object" } });
  assert.equal(factsObj.l2.status, "not_checked");
  const noDecl = assembleSellerFacts(baseInput([{ ...row, l2Schema: "no_declaration" }]));
  assert.equal(noDecl.l2.status, "undeclared");
});

test("G: 購入行に宣言が無い（l2Detail null）・カタログ null の no_declaration → undeclared・observed_at null", () => {
  const facts = assembleSellerFacts(
    baseInput([{ ...landingRow(), l2Detail: null, l2Schema: "no_declaration" }]),
  );
  assert.equal(facts.l2.status, "undeclared");
  assert.equal(facts.l2.observed_at, null);
});

test("H: l2ReadingOf は landingen24h 形で match のまま", () => {
  const row = landingRow();
  assert.equal(
    l2ReadingOf({ l2Schema: row.l2Schema, l2Detail: row.l2Detail, contentType: "application/json" }, null),
    "match",
  );
});

test("declarationHash null の match はカタログ null なら undeclared", () => {
  const row = landingRow();
  row.l2Detail = { ...row.l2Detail!, declarationHash: null };
  const facts = assembleSellerFacts(baseInput([row]));
  assert.equal(facts.l2.status, "undeclared");
  const out: { l2ConformNoRequiredKeys?: boolean } = {};
  assembleSellerFacts(baseInput([row]), { out });
  assert.equal(out.l2ConformNoRequiredKeys, false);
  assert.equal(l2ReadingLabelOf("match", { l2Detail: row.l2Detail }, null), "match");
});

test("宣言ハッシュ不明の match は unknown・ラベル match", () => {
  const row = landingRow();
  row.l2Detail = { ...row.l2Detail!, declarationHash: "dd".repeat(32), liveOutputExample: null };
  const out: { l2ConformNoRequiredKeys?: boolean } = {};
  const facts = assembleSellerFacts(baseInput([row]), { out });
  assert.equal(facts.l2.status, "conform");
  assert.equal(out.l2ConformNoRequiredKeys, false);
  assert.equal(l2ReadingLabelOf("match", { l2Detail: row.l2Detail }, null), "match");
});

test("JSON 配列本文・必須キー0の見本・カタログ null → conform と checkL2Detailed match", () => {
  const EX = { a: 1 };
  const exHash = createHash("sha256").update(JSON.stringify(EX), "utf8").digest("hex");
  const row: PurchaseInput = {
    attemptedAt: "2026-11-14T00:00:00Z",
    status: "settled",
    latencyMs: 50,
    httpStatusPaid: 200,
    payloadNonEmpty: true,
    l2Schema: "match",
    txHash: "0xdef",
    network: "eip155:8453",
    l2Detail: {
      missing: [],
      declarationHash: exHash,
      responseHash: createHash("sha256").update("[1,2]", "utf8").digest("hex"),
      reason: null,
      liveOutputExample: { exampleHash: exHash },
    },
    contentType: "application/json",
  };
  const reading = l2ReadingOf({ l2Schema: row.l2Schema, l2Detail: row.l2Detail, contentType: row.contentType }, null);
  assert.equal(reading, "match");
  assert.equal(l2ReadingLabelOf(reading, { l2Detail: row.l2Detail }, null), "match (no required keys)");
  assert.equal(l2RequiredKeysOf({ l2Detail: row.l2Detail, l2Reading: "match" }, null), "none");
  const out: { l2ConformNoRequiredKeys?: boolean } = {};
  const facts = assembleSellerFacts(baseInput([row]), { out });
  assert.equal(facts.l2.status, "conform");
  assert.equal(out.l2ConformNoRequiredKeys, true);
  const d = decidePayer(facts, { l1Timeline: timeline, l2ConformNoRequiredKeys: true });
  assert.ok(d.reason_codes.includes("l2_conform_no_required_keys"));
  assert.equal(checkL2Detailed(null, "[1,2]", "application/json", null, EX).status, "match");
});

test("rules_version 2026-11-13.1 と規則の文に L2 の新しい語", () => {
  assert.equal(DECISION_RULES_VERSION, "2026-11-13.1");
  assert.ok(DECISION_RULES_TEXT.includes("l2_conform_no_required_keys"));
  assert.ok(
    DECISION_RULES_TEXT.includes(
      "l2_undeclared means neither the catalog nor the purchase row of the latest delivery gives an output declaration to check against",
    ),
  );
});

test("カタログ { type: object }・l2Detail 無しの古い match 行は conform", () => {
  const CATALOG = { type: "object" };
  const row: PurchaseInput = {
    ...landingRow(),
    l2Detail: null,
    l2Schema: "match",
    attemptedAt: "2026-08-01T00:00:00Z",
  };
  const facts = assembleSellerFacts({ ...baseInput([row], CATALOG), declaredSchema: CATALOG });
  assert.equal(facts.l2.status, "conform");
  const out: { l2ConformNoRequiredKeys?: boolean } = {};
  assembleSellerFacts({ ...baseInput([row], CATALOG), declaredSchema: CATALOG }, { out });
  assert.equal(out.l2ConformNoRequiredKeys, false);
});
