// 面の間のずれを見る計器（scripts/surface-consistency-canary.ts）の本体の検査。
// 本番は叩かない。公開面の出力の形（HTML・CSV・JSON・YAML）を固定具で作り、
//   - 全部そろった固定具 → PASS
//   - 食い違いを作った固定具 → FAIL（どの項目・どの面かまで）
//   - 0 件・面が取れない → FAIL（緑にしない）
// を確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCsv,
  parseDocsReasonTable,
  parseLlmsText,
  parseOpenApiReasonCodes,
  parseRecordPage,
  parseSellerHostPage,
  sideFromWords,
} from "@/lib/surface-canary/parse";
import { buildReport, compareAll, compareListing, listingsForRegistryRecheck, recheckSummaryMarkdown, settleAfterRecheck, type Check, type DecisionBody, type ListingInput, type Registry, type SurfaceTally } from "@/lib/surface-canary/compare";
import { isRetryableStatus, retryBackoffMs } from "@/lib/surface-canary/retry";
import { buildLedgerIndex } from "@/lib/surface-canary/ledger";
import { buildPools, PoolCursor, seedFor } from "@/lib/surface-canary/sample";

// ---- 登録簿の固定具（/docs/api の表・openapi・llms） -------------------------------------------

const RULES = "2026-09-29.3";
const DOC_ROWS: [string, string, string][] = [
  ["l0_pass", "—", "—"],
  ["l0_fail", "BLOCK", "Yes"],
  ["l0_unverified", "WARN or BLOCK", "Partly"],
  ["l0_unverified_&lt;cause&gt;", "BLOCK", "Partly"],
  ["l1_delivered", "—", "—"],
  ["l1_not_attempted", "WARN", "No"],
  ["l1_inconclusive", "WARN", "No"],
  ["l1_never_delivered", "WARN", "Yes"],
  ["l1_paid_not_delivered", "WARN or BLOCK", "Yes"],
  ["l1_not_counted_vet402_side", "—", "No"],
  ["l1_not_counted_unproven", "—", "No"],
  ["l2_undeclared", "—", "Partly"],
  ["l2_mismatch", "WARN or BLOCK", "Yes"],
  ["&lt;input&gt;_unavailable", "BLOCK", "—"],
];
const DOCS_HTML =
  `<h3 id="reason-codes">Reason codes (rules <!-- -->${RULES}<!-- -->)</h3><table class="fact-table"><tbody>` +
  DOC_ROWS.map(
    ([c, v, f]) =>
      `<tr id="reason-${c.replace(/&lt;|&gt;/g, "")}"><td class="x"><code>${c}</code></td><td>${v}</td><td>meaning</td><td>payer</td><td>${f}</td></tr>`,
  ).join("") +
  `</tbody></table>`;
const ENUM = DOC_ROWS.map(([c]) => c).filter((c) => !c.includes("&lt;"));
const OPENAPI = `openapi: 3.1.0
components:
  schemas:
    DecisionReasonCode:
      type: string
      description: >-
        Since ${RULES}. The reason codes.
      enum: [${ENUM.join(", ")}]
      x-vet402-patterns: ["^l0_unverified_[a-z0-9_]{1,40}$", "^(settlements|funder_index|erc8004)_unavailable$"]

    DecisionResult:
      properties:
        l1_basis:
          type: object
`;
const LLMS = `Rules ${RULES} (\`rules_version\`): l1_paid_not_delivered is a BLOCK when twice; l1_basis carries the counts.`;

function registry(): Registry {
  const docs = parseDocsReasonTable(DOCS_HTML);
  const openapi = parseOpenApiReasonCodes(OPENAPI);
  assert.ok(docs && openapi);
  return { docs, openapi, llms: [{ name: "llms.txt", ...parseLlmsText(LLMS) }] };
}

// ---- 1 出品の固定具（面がすべて同じことを言う） ------------------------------------------------

const SCORED = "2026-09-29T10:00:00.000Z";

type Kind = "allow" | "warn_vet402" | "block_l0";

function sellerLi(id: string, rid: string, o: { latest: string; result: string; side: string; status: string; held?: string; iso: string }) {
  return (
    `<li class="border-b" id="listing-${id}"><a href="/observatory/e/${id}">x</a><dl>` +
    `<dt class="t">Latest attempt</dt><dd class="m-0">${o.latest}</dd><dt class="t">Result</dt><dd class="m-0">${o.result}</dd>` +
    `<dt class="t">Whose side</dt><dd class="m-0">${o.side}</dd></dl>` +
    `<span class="block"><strong>Decision API now:</strong> <!-- -->asking… · <a href="/api/v1/resources/${rid}/decision?role=payer">the full answer</a></span>` +
    `<span class="block"><strong>Last result about the seller:</strong> <!-- -->none.</span>` +
    `<span>Recorded (L1 attempt)<!-- -->:<!-- --> <code>${o.status}</code>${o.held ? ` · <!-- -->held as <code>${o.held}</code>` : ""}</span>` +
    `<span>In export.csv: the row with <code>attempted_at</code> <!-- -->${o.iso}<!-- --> and</span>` +
    // 前の試行の段（別の held）が同じ塊に続いても、最新の段だけを読む
    `<details><span>Recorded (earlier)<!-- -->:<!-- --> <code>settle_failed</code> · held as <code>payer_unfunded</code></span></details></li>`
  );
}

function recordHtml(state: string, rows: { minute: string; result: string; http: string; tx?: string; l2: string; side: string }[]) {
  const head = `<span>Published state: <span class="i"><svg width="10"><rect></rect></svg>${state}</span></span>`;
  if (rows.length === 0) return head + `<p>No paid purchases recorded for this endpoint yet.</p>`;
  return (
    head +
    `<table class="fact-table"><caption class="sr-only">L1 purchase history, newest first</caption><thead><tr><th>Attempted at</th><th>Result</th><th>HTTP</th><th>On-chain tx</th><th>Latency</th></tr></thead><tbody>` +
    rows
      .map(
        (r) =>
          `<tr><td><span class="sm:hidden">x</span><span class="hidden sm:inline">${r.minute} UTC</span></td><td>${r.result}</td><td class="num">${r.http}</td>` +
          `<td>${r.tx ? `<a href="https://basescan.org/tx/${r.tx}" class="underline">short</a>` : "—"}</td><td>100 ms</td></tr>` +
          `<tr class="fact-subrow"><td colSpan="5">5000 units<!-- --> · <!-- -->L2 <!-- -->${r.l2}<span class="block">Whose side: <!-- -->${r.side}</span></td></tr>`,
      )
      .join("") +
    `</tbody></table>`
  );
}

function listing(i: number, kind: Kind, types: string[]): ListingInput {
  const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const rid = (i.toString(16) + "a".repeat(64)).slice(0, 64);
  const key = `seller${i}.example/api/${kind}`;
  const tx = "0x" + (i.toString(16) + "b".repeat(64)).slice(0, 64);
  const at = "2026-09-20T12:00:00Z";
  const probe = "2026-09-29 04:40:00+00";

  let decision: DecisionBody;
  let sellersRow: Record<string, string>;
  let ledger: Record<string, string>[];
  let record: string;
  let page: string;
  let l0: Record<string, string>;
  const base = { subject: { id: rid, observatory_id: id, canonical_url: `https://${key}`, method: "GET" }, rules_version: RULES, scoredAt: SCORED, degraded: false };
  if (kind === "allow") {
    decision = {
      ...base,
      recommendation: "ALLOW",
      reason_codes: ["l0_pass", "l1_delivered", "l2_undeclared"],
      facts: { l0: { status: "pass", observed_at: probe }, l1: { n_delivered: 1, n_settled: 1, n_attempts: 1, last_attempt_at: at }, l2: { status: "undeclared" } },
      l1_basis: { window_days: 30, n_paid_undelivered: 0, last_delivered_at: at },
      evidence: [{ level: "L1", purchase_id: `eip155:8453:${tx}` }],
    };
    sellersRow = { endpoint_id: id, resource_key: key, outcome: "delivered", fix_mode: "", side_label: "", held_reason: "", latest_attempted_at: at, latest_status: "settled", purchase_id: `p-${i}`, in_ledger_export: "true" };
    ledger = [{ attempted_at: at, resource_key: key, network: "eip155:8453", status: "settled", tx_hash: tx, http_status_paid: "200", l2_schema: "no_declaration", held_reason: "", confirmed_units: "5000", purchase_id: `p-${i}` }];
    record = recordHtml("pass", [{ minute: "2026-09-20 12:00", result: "settled (nonce-bound)", http: "200", tx, l2: "no_declaration", side: "no failure (delivered)" }]);
    page = sellerLi(id, rid, { latest: "2026-09-20 12:00 UTC", result: "delivered", side: "no failure (delivered)", status: "settled", iso: at });
    l0 = { endpoint_id: id, resource_key: key, network: "eip155:8453", listed: "true", published_verdict: "pass", latest_probe_verdict: "pass", last_probed_at: "2026-09-29T04:40:00Z" };
  } else if (kind === "warn_vet402") {
    decision = {
      ...base,
      recommendation: "WARN",
      reason_codes: ["l0_pass", "l1_inconclusive", "l1_not_counted_vet402_side", "l2_undeclared"],
      facts: { l0: { status: "pass", observed_at: probe }, l1: { n_delivered: 0, n_settled: 0, n_attempts: 1, last_attempt_at: at }, l2: { status: "undeclared" } },
      l1_basis: { window_days: 30, n_paid_undelivered: 0, last_delivered_at: null },
      evidence: [],
    };
    sellersRow = { endpoint_id: id, resource_key: key, outcome: "vet402", fix_mode: "query_not_sent", side_label: "vet402's side", held_reason: "unsettled_4xx", latest_attempted_at: at, latest_status: "settle_failed", purchase_id: `p-${i}`, in_ledger_export: "true" };
    ledger = [{ attempted_at: at, resource_key: key, network: "eip155:8453", status: "settle_failed", tx_hash: "", http_status_paid: "400", l2_schema: "not_checked", held_reason: "unsettled_4xx", confirmed_units: "0", purchase_id: `p-${i}` }];
    record = recordHtml("pass", [{ minute: "2026-09-20 12:00", result: "settle_failed", http: "400", l2: "not_checked", side: "vet402&#x27;s side" }]);
    page = sellerLi(id, rid, { latest: "2026-09-20 12:00 UTC", result: "vet402 did not send the declared query", side: "vet402&#x27;s side", status: "settle_failed", held: "unsettled_4xx", iso: at });
    l0 = { endpoint_id: id, resource_key: key, network: "eip155:8453", listed: "true", published_verdict: "pass", latest_probe_verdict: "pass", last_probed_at: "2026-09-29T04:40:00Z" };
  } else {
    decision = {
      ...base,
      recommendation: "BLOCK",
      reason_codes: ["l0_fail", "l1_not_attempted", "l2_undeclared"],
      facts: { l0: { status: "fail", observed_at: probe }, l1: { n_delivered: 0, n_settled: 0, n_attempts: 0, last_attempt_at: null }, l2: { status: "undeclared" } },
      l1_basis: { window_days: 30, n_paid_undelivered: 0, last_delivered_at: null },
      evidence: [],
    };
    sellersRow = { endpoint_id: id, resource_key: key, outcome: "not_tried", fix_mode: "", side_label: "", held_reason: "", latest_attempted_at: "", latest_status: "", purchase_id: "", in_ledger_export: "" };
    ledger = [];
    record = recordHtml("fail", []);
    page = sellerLi(id, rid, { latest: "not tried yet", result: "—", side: "—", status: "", iso: "" }).replace(/<span>Recorded[\s\S]*?<\/details>/, "");
    l0 = { endpoint_id: id, resource_key: key, network: "eip155:8453", listed: "true", published_verdict: "fail", latest_probe_verdict: "fail", last_probed_at: "2026-09-29T04:40:00Z" };
  }
  const allow = decision.recommendation === "ALLOW" && !decision.degraded;
  const refuse = allow ? [] : decision.reason_codes!.filter((c) => !["l0_pass", "l1_delivered", "l2_undeclared", "l1_not_counted_vet402_side"].includes(c));
  const parsedPage = parseSellerHostPage(`<h2>Your listings</h2><ul>${page}</ul>`);
  const parsedRecord = parseRecordPage(record);
  assert.ok(parsedPage && parsedRecord);
  return {
    observatoryId: id,
    resourceKey: key,
    network: "eip155:8453",
    types,
    decision: { ok: true, value: decision },
    mcp: { ok: true, value: { resourceId: rid, decision: allow ? "ALLOW_PAY" : "REFUSE", refuseReasons: refuse, measurement: structuredClone(decision) } },
    sellersRow: { ok: true, value: sellersRow },
    sellerPage: { ok: true, value: parsedPage.listings.get(id)! },
    record: { ok: true, value: parsedRecord },
    ledgerRows: { ok: true, value: ledger },
    ledgerRetrievedAt: "2026-09-29T09:00:00Z",
    l0Row: { ok: true, value: l0 },
  };
}

/** 40 件の、面がそろった標本（必須の型と区分を全部含む） */
function consistentSample(): ListingInput[] {
  const TYPES: [Kind, string[]][] = [
    ["allow", ["delivered"]],
    ["warn_vet402", ["l1_failure", "l2_not_checked"]],
    ["block_l0", ["l0_fail", "unprobed", "path_template"]],
    ["allow", ["delivered", "l2_mismatch"]],
  ];
  return Array.from({ length: 40 }, (_, i) => listing(i + 1, TYPES[i % 4]![0], TYPES[i % 4]![1]));
}

const tallyFor = (n: number): SurfaceTally => ({ attempted: n * 4 + 7, fetched: n * 4 + 7, failed: [] });

// ---- 読み手 ------------------------------------------------------------------------------------

test("parseCsv: 引用符の中のカンマ・改行・二重引用符", () => {
  const rows = parseCsv('a,b,c\n1,"x, y","say ""hi""\nthere"\n2,,\n');
  assert.deepEqual(rows, [
    { a: "1", b: "x, y", c: 'say "hi"\nthere' },
    { a: "2", b: "", c: "" },
  ]);
});

test("openapi: パターンの中の ] で切れずに x-vet402-patterns を読む", () => {
  const o = parseOpenApiReasonCodes(OPENAPI);
  assert.ok(o);
  assert.equal(o.patterns.length, 2);
  assert.ok(o.patterns[0]!.test("l0_unverified_not_probed"));
  assert.equal(o.since, RULES);
  assert.ok(o.yamlKeys.has("l1_basis"));
});

test("売り手頁: 最新の段の Recorded / held だけを読み、前の試行の段を混ぜない", () => {
  const html = `<h2>Your listings</h2><ul>${sellerLi("11111111-1111-4111-8111-111111111111", "c".repeat(64), {
    latest: "2026-09-27 12:02 UTC", result: "delivered", side: "no failure (delivered)", status: "settled", iso: "2026-09-27T12:02:37Z",
  })}</ul>`;
  const p = parseSellerHostPage(html);
  const l = p?.listings.get("11111111-1111-4111-8111-111111111111");
  assert.ok(l);
  assert.equal(l.recordedStatus, "settled");
  assert.equal(l.heldAs, null);
  assert.equal(l.decisionResourceId, "c".repeat(64));
  assert.equal(l.attemptedAtIso, "2026-09-27T12:02:37Z");
  assert.equal(l.latestAttempt, "2026-09-27 12:02 UTC");
  const baseLabeled = parseSellerHostPage(
    `<h2>Your listings</h2><ul><li id="listing-22222222-2222-4222-8222-222222222222"><dl><dt>Latest Base attempt</dt><dd>2026-10-06 09:32 UTC</dd></dl></li></ul>`,
  );
  assert.equal(
    baseLabeled?.listings.get("22222222-2222-4222-8222-222222222222")?.latestAttempt,
    "2026-10-06 09:32 UTC",
  );
});

test("誰の側かの語: 照合待ちは not sorted の語でも pending", () => {
  assert.equal(sideFromWords("not sorted: awaiting on-chain verification"), "pending");
  assert.equal(sideFromWords("not sorted: vet402 unproven"), "unsorted");
  assert.equal(sideFromWords("vet402's side"), "vet402");
  assert.equal(sideFromWords("—"), null);
});

// ---- PASS / FAIL -------------------------------------------------------------------------------

test("全部そろった固定具は PASS（比べた項目が全項目にある）", () => {
  const listings = consistentSample();
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length) });
  assert.deepEqual(r.discrepancies, [], JSON.stringify(r.discrepancies.slice(0, 3), null, 1));
  assert.deepEqual(r.failReasons, []);
  assert.equal(r.ok, true);
  for (const [item, n] of Object.entries(r.comparedByItem)) assert.ok(n > 0, `${item} was never compared`);
});

test("食い違い: 売り手頁が seller's side・export は vet402's side → FAIL（side/latest_row_side）", () => {
  const listings = consistentSample();
  const x = listings[1]!;
  assert.ok(x.sellerPage.ok === true);
  x.sellerPage = { ok: true, value: { ...x.sellerPage.value, whoseSide: "seller's side" } };
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length) });
  assert.equal(r.ok, false);
  const d = r.discrepancies.find((c) => c.rule === "latest_row_side");
  assert.ok(d, "latest_row_side not flagged");
  assert.equal(d.listing, x.resourceKey);
  assert.deepEqual(d.values.map((v) => v.surface), ["sellers", "seller_page", "record"]);
});

/** 売り手頁が「not tried」のまま（行を名指さない）で、頁頭の台帳を読んだ時刻だけを変えた頁 */
function notTriedPageReadAt(x: ListingInput, readAt: string) {
  assert.ok(x.decision.ok === true);
  const li = sellerLi(x.observatoryId, x.decision.value.subject!.id!, { latest: "not tried on Base yet", result: "not tried on Base yet", side: "not tried on Base yet", status: "", iso: "" })
    .replace(/<span>Recorded[\s\S]*?<\/details>/, "");
  const p = parseSellerHostPage(`<span class="doc-asof">Read from the database <!-- -->${readAt} UTC<!-- -->. Refreshed after a view, so the first view after a quiet period can be older.</span><h2>Your listings</h2><ul>${li}</ul>`);
  assert.ok(p);
  const v = p.listings.get(x.observatoryId)!;
  assert.equal(v.ledgerReadAt, readAt);
  return v;
}

test("読み置き: 売り手頁が最新の行より前に台帳を読んで not tried → 頁だけ外し、export・台帳・記録頁は比べる", () => {
  const listings = consistentSample();
  const x = listings[0]!; // allow: 最新の行は 2026-09-20 12:00
  x.sellerPage = { ok: true, value: notTriedPageReadAt(x, "2026-09-20 11:58") };
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length) });
  assert.deepEqual(r.discrepancies, [], JSON.stringify(r.discrepancies.slice(0, 3)));
  const c = compareListing(x, registry());
  assert.ok(c.skips.some((k) => k.rule === "seller_page_stale"), "stale page not recorded as a skip");
  for (const rule of ["latest_row_side", "latest_row_status"]) {
    const ch = c.checks.find((k) => k.rule === rule);
    assert.ok(ch?.ok, `${rule} was not compared`);
    assert.ok(!ch.values.some((v) => v.surface === "seller_page"), `${rule} still reads the stale page`);
  }
});

test("食い違い: 売り手頁は読み置きでも、記録頁が vet402's side・export は delivered → FAIL（side/latest_row_side）", () => {
  const listings = consistentSample();
  const x = listings[0]!;
  assert.ok(x.record.ok === true);
  x.sellerPage = { ok: true, value: notTriedPageReadAt(x, "2026-09-20 11:58") };
  const rows = x.record.value.rows.map((row, i) => (i === 0 ? { ...row, whoseSide: "vet402's side" } : row));
  x.record = { ok: true, value: { ...x.record.value, rows } };
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length) });
  assert.equal(r.ok, false);
  const d = r.discrepancies.find((c) => c.rule === "latest_row_side");
  assert.ok(d, "latest_row_side not flagged");
  assert.deepEqual(d.values.map((v) => v.surface), ["sellers", "record"]);
});

test("食い違い: 売り手頁が最新の行と同じ分に台帳を読んだのに not tried → FAIL（読み置きにしない）", () => {
  const listings = consistentSample();
  const x = listings[0]!;
  x.sellerPage = { ok: true, value: notTriedPageReadAt(x, "2026-09-20 12:00") };
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length) });
  assert.equal(r.ok, false);
  assert.ok(r.discrepancies.find((c) => c.rule === "latest_row_side"), "latest_row_side not flagged");
});

test("食い違い: 売り手頁が最新の行より後に台帳を読んだのに not tried → FAIL（side/latest_row_side）", () => {
  const listings = consistentSample();
  const x = listings[0]!;
  x.sellerPage = { ok: true, value: notTriedPageReadAt(x, "2026-09-20 12:05") };
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length) });
  assert.equal(r.ok, false);
  const d = r.discrepancies.find((c) => c.rule === "latest_row_side");
  assert.ok(d, "latest_row_side not flagged");
  assert.equal(d.listing, x.resourceKey);
  assert.ok(d.values.some((v) => v.surface === "seller_page" && String(v.value).includes("page read 2026-09-20 12:05")));
});

test("食い違い: 未プローブで BLOCK、記録頁は unverified・売り手は not tried → FAIL（verdict/block_vs_unmeasured）", () => {
  const listings = consistentSample();
  const x = listings[2]!;
  assert.ok(x.decision.ok === true && x.l0Row.ok === true && x.mcp.ok === true);
  const d: DecisionBody = { ...x.decision.value, reason_codes: ["l0_unverified", "l0_unverified_not_probed", "l1_not_attempted", "l2_undeclared"], degraded: true, facts: { ...x.decision.value.facts, l0: { status: "unverified", observed_at: null } } };
  x.decision = { ok: true, value: d };
  x.mcp = { ok: true, value: { ...x.mcp.value, measurement: structuredClone(d), refuseReasons: ["l0_unverified", "l0_unverified_not_probed", "l1_not_attempted", "degraded_measurement"] } };
  x.l0Row = { ok: true, value: { ...x.l0Row.value, published_verdict: "unverified", latest_probe_verdict: "", last_probed_at: "" } };
  x.record = { ok: true, value: parseRecordPage(recordHtml("unverified", []))! };
  const { checks } = compareListing(x, registry());
  const bad = checks.filter((c) => !c.ok);
  assert.deepEqual(bad.map((c) => c.rule), ["block_vs_unmeasured"]);
  assert.deepEqual(bad[0]!.values.map((v) => v.surface), ["decision", "l0", "record", "sellers", "seller_page"]);
});

test("食い違い: 判定の n_settled（お金が動いた回数）が台帳と違う → FAIL（money_moved）", () => {
  const listings = consistentSample();
  const x = listings[0]!;
  assert.ok(x.decision.ok === true);
  const d = structuredClone(x.decision.value);
  d.facts!.l1!.n_settled = 2;
  x.decision = { ok: true, value: d };
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length) });
  assert.equal(r.ok, false);
  assert.ok(r.discrepancies.some((c) => c.item === "money_moved" && c.rule === "n_settled_vs_ledger"));
});

test("食い違い: 判定の理由コードが openapi・docs の一覧に無い → FAIL（reason_codes）", () => {
  const listings = consistentSample();
  const x = listings[3]!;
  assert.ok(x.decision.ok === true && x.mcp.ok === true);
  const d = { ...x.decision.value, reason_codes: [...x.decision.value.reason_codes!, "l1_brand_new_code"] };
  x.decision = { ok: true, value: d };
  x.mcp = { ok: true, value: { ...x.mcp.value, measurement: structuredClone(d) } };
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length) });
  const rules = r.discrepancies.map((c) => c.rule);
  assert.ok(rules.includes("codes_in_openapi") && rules.includes("codes_in_docs_table"), rules.join(","));
});

test("食い違い: 記録頁は L2 mismatch、判定は undeclared（数えない）→ FAIL（l2_state）", () => {
  const listings = consistentSample();
  const x = listings[0]!;
  assert.ok(x.ledgerRows.ok === true && x.record.ok === true);
  x.ledgerRows = { ok: true, value: x.ledgerRows.value.map((r) => ({ ...r, l2_schema: "mismatch" })) };
  x.record = { ok: true, value: { ...x.record.value, rows: x.record.value.rows.map((r) => ({ ...r, l2: "mismatch" })) } };
  const { checks } = compareListing(x, registry());
  assert.deepEqual(checks.filter((c) => !c.ok).map((c) => `${c.item}/${c.rule}`), ["l2_state/l2_same_row"]);
});

/**
 * 判定の L2 の語と、比べる行の台帳（l2_schema / l2_reading）・記録頁の L2 を差し替えて、l2_same_row の結果だけを返す。
 * 判定は出力を宣言している出品で、直近の配達が match・mismatch でなければ not_checked と言う（seller-facts.ts の l2Status）。
 */
function l2SameRow(decL2: string, rowL2: string, recordL2: string, rowReading?: string) {
  const x = listing(1, "allow", ["delivered"]);
  assert.ok(x.ledgerRows.ok === true && x.record.ok === true && x.decision.ok === true && x.mcp.ok === true);
  const d = structuredClone(x.decision.value);
  d.facts = { ...d.facts, l2: { status: decL2 } };
  x.decision = { ok: true, value: d };
  x.mcp = { ok: true, value: { ...x.mcp.value, measurement: structuredClone(d) } };
  x.ledgerRows = { ok: true, value: x.ledgerRows.value.map((r) => ({ ...r, l2_schema: rowL2, ...(rowReading === undefined ? {} : { l2_reading: rowReading }) })) };
  x.record = { ok: true, value: { ...x.record.value, rows: x.record.value.rows.map((r) => ({ ...r, l2: recordL2 })) } };
  const c = compareListing(x, registry()).checks.find((k) => k.rule === "l2_same_row");
  assert.ok(c, "l2_same_row was not compared");
  return c;
}

test("L2 の行: 判定 not_checked × 行 no_declaration（買った後に売り手が出力を宣言した）は食い違いではない", () => {
  const c = l2SameRow("not_checked", "no_declaration", "no_declaration");
  assert.equal(c.ok, true, JSON.stringify(c.values));
});

test("L2 の行: 判定 not_checked × 行の L2 が空欄は食い違いではない", () => {
  const c = l2SameRow("not_checked", "", "");
  assert.equal(c.ok, true, JSON.stringify(c.values));
});

test("L2 の行: 判定 not_checked × 行 match は食い違い（判定はその行を conform と読むはず）", () => {
  const c = l2SameRow("not_checked", "match", "match");
  assert.equal(c.ok, false, JSON.stringify(c.values));
});

test("L2 の行: 判定 not_checked × 行 mismatch は食い違い", () => {
  const c = l2SameRow("not_checked", "mismatch", "mismatch");
  assert.equal(c.ok, false, JSON.stringify(c.values));
});

test("L2 の行: 行の l2_schema が mismatch でも読み直し（l2_reading）が not_checked なら、判定 not_checked と一致", () => {
  const c = l2SameRow("not_checked", "mismatch", "not_checked", "not_checked");
  assert.equal(c.ok, true, JSON.stringify(c.values));
});

test("L2 の行: 行の l2_schema が no_declaration でも読み直し（l2_reading）が match なら、判定 not_checked は食い違い", () => {
  const c = l2SameRow("not_checked", "no_declaration", "", "match");
  assert.equal(c.ok, false, JSON.stringify(c.values));
});

test("L2 の行: 台帳は no_declaration でも記録頁が match なら、判定 not_checked は食い違い（記録頁も同値表に当てる）", () => {
  const c = l2SameRow("not_checked", "no_declaration", "match");
  assert.equal(c.ok, false, JSON.stringify(c.values));
});

test("L2 の行: 判定 undeclared × 行 no_declaration は食い違いではない（従来どおり）", () => {
  const c = l2SameRow("undeclared", "no_declaration", "no_declaration");
  assert.equal(c.ok, true, JSON.stringify(c.values));
});

test("食い違い: 規則の版が文書と判定で違う → FAIL（rules_version）", () => {
  const listings = consistentSample();
  const reg = registry();
  reg.llms = [{ name: "llms.txt", ...parseLlmsText("Rules 2026-09-29.2 (`rules_version`)") }];
  const r = buildReport({ listings, registry: reg, tally: tallyFor(listings.length) });
  assert.ok(r.discrepancies.some((c) => c.rule === "rules_version_everywhere"));
});

// ---- 結果が出ないこと自体を失敗にする -------------------------------------------------------------

test("0 件は FAIL: 面が 0・比べた項目が 0・標本が足りない", () => {
  const r = buildReport({ listings: [], registry: { docs: null, openapi: null, llms: [] }, tally: { attempted: 0, fetched: 0, failed: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.compared, 0);
  for (const want of ["no surface was fetched", "no item was compared", "sample too small"])
    assert.ok(r.failReasons.some((f) => f.startsWith(want)), `missing fail reason: ${want} in ${r.failReasons.join(" | ")}`);
});

test("全部の面が取れない（決定が 1 件も読めない）は FAIL — 食い違い 0 でも緑にしない", () => {
  const listings = consistentSample().map((l) => ({ ...l, decision: { ok: false as const, error: "HTTP 503" }, mcp: { ok: false as const, error: "HTTP 503" } }));
  const r = buildReport({
    listings,
    registry: registry(),
    tally: { attempted: 80, fetched: 0, failed: listings.map((l) => ({ surface: "decision", listing: l.resourceKey, error: "HTTP 503" })) },
  });
  assert.equal(r.ok, false);
  assert.ok(r.failReasons.some((f) => f.startsWith("no surface was fetched")));
  assert.ok(r.failReasons.some((f) => f.startsWith("sample too small")));
});

test("標本に必須の型・区分が欠けると FAIL", () => {
  const listings = consistentSample().filter((l) => l.decision.ok === true && l.decision.value.recommendation !== "BLOCK");
  while (listings.length < 40) listings.push(listing(100 + listings.length, "allow", ["delivered"]));
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length) });
  assert.equal(r.ok, false);
  assert.ok(r.failReasons.includes("sample lacks verdict BLOCK"));
  assert.ok(r.failReasons.includes("sample lacks type unprobed"));
});

// ---- 標本 --------------------------------------------------------------------------------------

test("標本: 同じ日は同じ順・掲載中だけ・型ごとの列", () => {
  const l0 = [
    { endpoint_id: "a", resource_key: "h/x/:id", network: "n", listed: "true", published_verdict: "unverified", latest_probe_verdict: "" },
    { endpoint_id: "b", resource_key: "h/y", network: "n", listed: "true", published_verdict: "fail", latest_probe_verdict: "fail" },
    { endpoint_id: "c", resource_key: "h/z", network: "n", listed: "false", published_verdict: "fail", latest_probe_verdict: "fail" },
  ];
  const ledger = [{ attempted_at: "2026-09-28T00:00:00Z", resource_key: "h/y", network: "n", l2_schema: "mismatch" }];
  const pools = buildPools({ sellers: [{ endpoint_id: "b", outcome: "vet402" }], l0, ledger, now: Date.parse(SCORED), seed: seedFor("2026-09-29") });
  assert.deepEqual(pools.get("path_template")!.map((c) => c.observatoryId), ["a"]);
  assert.deepEqual(pools.get("unprobed")!.map((c) => c.observatoryId), ["a"]);
  assert.deepEqual(pools.get("l0_fail")!.map((c) => c.observatoryId), ["b"]);
  assert.deepEqual(pools.get("l2_mismatch")!.map((c) => c.observatoryId), ["b"]);
  assert.deepEqual(pools.get("l1_failure")!.map((c) => c.observatoryId), ["b"]);
  const cur = new PoolCursor(pools);
  assert.equal(cur.next("l0_fail")!.observatoryId, "b");
  assert.equal(cur.next("l2_mismatch"), null, "the same listing is not drawn twice");
});

// ---- 2026-10-28: 台帳の行は endpoint 単位で付ける（別のチェーンで買った行も含む） ------------------------------
// 10/25 から毎回赤: agent402.tools/api/skill/contact-verify（Base の出品）を Celo と Stellar で買った行が、
// resource_key|network で引いた台帳の側から落ち、判定 n_settled=2 と台帳 0 行が食い違って見えた。

const STELLAR_TX = "202626484c28c26d1b7a2c5821a924d8001450113b747ff2d16ed2a949002cb1";

/** allow の出品に、同じ endpoint を Stellar で買った配達の行を足す（判定は 2 回と数える） */
function crossChainListing(): { x: ListingInput; l0: Record<string, string>[]; ledger: Record<string, string>[] } {
  const x = listing(1, "allow", ["delivered"]);
  assert.ok(x.decision.ok === true && x.ledgerRows.ok === true && x.l0Row.ok === true);
  const stellar = {
    attempted_at: "2026-09-25T12:01:05Z", resource_key: x.resourceKey, network: "stellar:pubnet", status: "settled", tx_hash: STELLAR_TX,
    http_status_paid: "200", l2_schema: "no_declaration", held_reason: "", confirmed_units: "4000", purchase_id: "p-stellar",
  };
  const ledger = [...x.ledgerRows.value, stellar];
  const d = structuredClone(x.decision.value);
  d.facts!.l1 = { n_delivered: 2, n_settled: 2, n_attempts: 2, last_attempt_at: stellar.attempted_at };
  d.evidence = [{ level: "L1", purchase_id: `stellar:pubnet:${STELLAR_TX}` }, { level: "L2", purchase_id: `stellar:pubnet:${STELLAR_TX}` }];
  x.decision = { ok: true, value: d };
  assert.ok(x.mcp.ok === true);
  x.mcp = { ok: true, value: { ...x.mcp.value, measurement: structuredClone(d) } };
  return { x, l0: [x.l0Row.value], ledger };
}

test("台帳の付け方: endpoint が 1 つの resource_key は network を問わず全部その出品の行（空の network も）", () => {
  const l0 = [{ endpoint_id: "a", resource_key: "s.example/x", network: "eip155:8453" }];
  const ledger = [
    { resource_key: "s.example/x", network: "eip155:8453", status: "settled", purchase_id: "1" },
    { resource_key: "s.example/x", network: "stellar:pubnet", status: "settled", purchase_id: "2" },
    { resource_key: "s.example/x", network: "eip155:42220", status: "settled", purchase_id: "3" },
    { resource_key: "s.example/x", network: "", status: "no_eligible_accept", purchase_id: "" },
    { resource_key: "other.example/y", network: "eip155:8453", status: "settled", purchase_id: "4" },
  ];
  const got = buildLedgerIndex({ l0, ledger }).rowsOf({ observatoryId: "a", resourceKey: "s.example/x", network: "eip155:8453" });
  assert.deepEqual(got.rows.map((r) => r.network), ["eip155:8453", "stellar:pubnet", "eip155:42220", ""]);
  assert.deepEqual(got.unplaced, []);
});

test("台帳の付け方: endpoint が複数（Base と Tempo）なら network の一致で分け、どれにも合わない network は unplaced", () => {
  const l0 = [
    { endpoint_id: "base", resource_key: "s.example/x", network: "eip155:8453" },
    { endpoint_id: "tempo", resource_key: "s.example/x", network: "eip155:4217" },
  ];
  const ledger = [
    { resource_key: "s.example/x", network: "eip155:8453", status: "settle_failed", purchase_id: "1" },
    { resource_key: "s.example/x", network: "eip155:4217", status: "settled", purchase_id: "2" },
    { resource_key: "s.example/x", network: "eip155:56", status: "settled", purchase_id: "3" },
    { resource_key: "s.example/x", network: "", status: "no_eligible_accept", purchase_id: "" },
  ];
  const idx = buildLedgerIndex({ l0, ledger });
  const b = idx.rowsOf({ observatoryId: "base", resourceKey: "s.example/x", network: "eip155:8453" });
  assert.deepEqual(b.rows.map((r) => r.purchase_id), ["1"]);
  assert.deepEqual(b.unplaced.map((r) => r.purchase_id), ["3"]);
  const t = idx.rowsOf({ observatoryId: "tempo", resourceKey: "s.example/x", network: "eip155:4217" });
  assert.deepEqual(t.rows.map((r) => r.purchase_id), ["2"]);
  // 売り手一覧が指す最新の購入は、同じ resource_key なら含める（unplaced からは外す）
  const withLatest = idx.rowsOf({ observatoryId: "base", resourceKey: "s.example/x", network: "eip155:8453" }, "3");
  assert.deepEqual(withLatest.rows.map((r) => r.purchase_id), ["1", "3"]);
  assert.deepEqual(withLatest.unplaced, []);
});

test("別のチェーンで買った行: endpoint 単位で付ければ判定 n_settled=2 と台帳が一致する（resource_key|network だけなら赤）", () => {
  const { x, l0, ledger } = crossChainListing();
  // 以前の付け方（その出品の network の行だけ）は Stellar の行を落とし、money_moved・failure_count・evidence_in_ledger が赤になる
  const old = { ...x, ledgerRows: { ok: true as const, value: ledger.filter((r) => r.network === x.network) } };
  const oldBad = compareListing(old, registry()).checks.filter((c) => !c.ok).map((c) => c.rule);
  assert.ok(oldBad.includes("n_settled_vs_ledger") && oldBad.includes("n_attempts_vs_ledger") && oldBad.includes("evidence_in_ledger"), oldBad.join(","));

  const placed = buildLedgerIndex({ l0, ledger }).rowsOf(x, "p-1");
  x.ledgerRows = { ok: true, value: placed.rows };
  x.ledgerUnplaced = placed.unplaced;
  const { checks } = compareListing(x, registry());
  assert.deepEqual(checks.filter((c) => !c.ok), [], JSON.stringify(checks.filter((c) => !c.ok), null, 1));
  for (const rule of ["n_settled_vs_ledger", "n_attempts_vs_ledger", "n_delivered_vs_ledger", "evidence_in_ledger", "l2_same_row"])
    assert.ok(checks.some((c) => c.rule === rule && c.ok), `${rule} was not compared`);
});

test("付け先の決まらない行が窓の中にあれば、数は比べずに skip（食い違いにしない）", () => {
  const { x, ledger } = crossChainListing();
  x.ledgerRows = { ok: true, value: ledger.filter((r) => r.network === x.network) };
  x.ledgerUnplaced = ledger.filter((r) => r.network !== x.network);
  const { checks, skips } = compareListing(x, registry());
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  const s = skips.find((k) => k.rule === "n_settled_vs_ledger");
  assert.ok(s && /network none of its endpoints list/.test(s.reason), JSON.stringify(skips));
  assert.ok(!checks.some((c) => c.rule === "n_settled_vs_ledger"));
  // 証拠の行は unplaced の中でも見つかる
  assert.ok(checks.some((c) => c.rule === "evidence_in_ledger" && c.ok));
});

test("判定が同じ resource の別の endpoint について答えたら、この出品の台帳と L1・L2 を比べない", () => {
  const x = listing(2, "warn_vet402", ["l1_failure"]);
  assert.ok(x.decision.ok === true);
  const d = structuredClone(x.decision.value);
  d.subject = { ...d.subject, observatory_id: "b55129d8-4197-40fe-9107-e77685de4b94" };
  d.facts!.l1 = { n_delivered: 0, n_settled: 0, n_attempts: 0, last_attempt_at: null };
  x.decision = { ok: true, value: d };
  assert.ok(x.mcp.ok === true);
  x.mcp = { ok: true, value: { ...x.mcp.value, measurement: structuredClone(d) } };
  const { checks, skips } = compareListing(x, registry());
  assert.ok(!checks.some((c) => !c.ok && (c.rule === "n_attempts_vs_ledger" || c.item === "l2_state")), JSON.stringify(checks.filter((c) => !c.ok)));
  for (const rule of ["n_attempts_vs_ledger", "l2_same_row"])
    assert.ok(skips.some((k) => k.rule === rule && /decision answers for endpoint b55129d8/.test(k.reason)), rule);
});

test("L2 の行: 202（受け付けただけ）の行は判定の配達に数えないので、比べる行にしない", () => {
  const x = listing(3, "allow", ["delivered"]);
  assert.ok(x.ledgerRows.ok === true && x.decision.ok === true);
  const d = structuredClone(x.decision.value);
  d.evidence = [];
  x.decision = { ok: true, value: d };
  assert.ok(x.mcp.ok === true);
  x.mcp = { ok: true, value: { ...x.mcp.value, measurement: structuredClone(d) } };
  // 判定は n_delivered=1（200 の行）・n_settled=1。202 の行は窓の外に置いて数の比較から外し、L2 の行選びだけを見る
  const accepted = { ...x.ledgerRows.value[0]!, attempted_at: "2026-09-29T09:59:00Z", tx_hash: "", http_status_paid: "202", l2_schema: "not_checked", l2_reading: "not_checked", purchase_id: "p-202" };
  x.ledgerRows = { ok: true, value: [...x.ledgerRows.value, accepted] };
  const l2 = compareListing(x, registry()).checks.find((c) => c.rule === "l2_same_row");
  assert.ok(l2, "l2_same_row was not compared");
  assert.equal(l2.ok, true, JSON.stringify(l2.values));
  assert.match(String(l2.values.find((v) => v.surface === "ledger")?.value), /2026-09-20T12:00:00Z/);
});

test("not tried（Base の購入なし）の出品に別のチェーンの行だけがあるのは食い違いではない", () => {
  const x = listing(4, "block_l0", ["l0_fail"]);
  const tx = STELLAR_TX;
  x.ledgerRows = {
    ok: true,
    value: [{ attempted_at: "2026-08-15T12:00:00Z", resource_key: x.resourceKey, network: "stellar:pubnet", status: "settled", tx_hash: tx, http_status_paid: "200", l2_schema: "no_declaration", held_reason: "", confirmed_units: "4000", purchase_id: "p-s" }],
  };
  x.record = { ok: true, value: parseRecordPage(recordHtml("fail", [{ minute: "2026-08-15 12:00", result: "settled", http: "200", tx, l2: "no_declaration", side: "no failure (delivered)" }]))! };
  const { checks } = compareListing(x, registry());
  const nt = checks.find((c) => c.rule === "not_tried_vs_rows");
  assert.ok(nt && nt.ok, JSON.stringify(nt));
  assert.match(String(nt.values.find((v) => v.surface === "ledger")?.value), /0 rows on eip155:8453 in 90d \(\+1 on other chains\)/);
  // Base の行が 1 つでもあれば not tried は食い違い（今までどおり）
  x.ledgerRows = { ok: true, value: [...x.ledgerRows.value, { ...x.ledgerRows.value[0]!, network: "eip155:8453", tx_hash: "0x" + "c".repeat(64), purchase_id: "p-b" }] };
  assert.equal(compareListing(x, registry()).checks.find((c) => c.rule === "not_tried_vs_rows")?.ok, false);
});

// ---- 2026-11-02.2: L2 は窓に関係なく最後の配達を読む。根拠の行は 30 日窓にも 90 日の export にも無いことがある ----

/** 判定の L2 の根拠になる配達（evidence の L2 行）を差し替えた出品。 */
function l2FromOlderDelivery(lastDeliveredAt: string, tx: string) {
  const x = listing(1, "allow", ["delivered"]);
  assert.ok(x.ledgerRows.ok === true && x.decision.ok === true && x.mcp.ok === true);
  const d = structuredClone(x.decision.value);
  d.facts = { ...d.facts, l2: { status: "mismatch", missing_keys: ["id"] } };
  d.l1_basis = { ...d.l1_basis, last_delivered_at: lastDeliveredAt };
  d.evidence = [{ level: "L2", purchase_id: `eip155:8453:${tx}` }];
  x.decision = { ok: true, value: d };
  x.mcp = { ok: true, value: { ...x.mcp.value, measurement: structuredClone(d) } };
  return x;
}

test("L2 の根拠の配達が 90 日の export より古いときは比べない（赤にしない）", () => {
  const scoredAt = Date.parse("2026-10-01T00:00:00Z");
  const x = l2FromOlderDelivery(new Date(scoredAt - 100 * 86_400_000).toISOString(), `0x${"ab".repeat(32)}`);
  assert.ok(x.decision.ok === true);
  x.decision = { ok: true, value: { ...x.decision.value, scoredAt: new Date(scoredAt).toISOString() } };
  const { checks, skips } = compareListing(x, registry());
  for (const rule of ["l2_same_row", "evidence_in_ledger"]) {
    assert.ok(!checks.some((c) => c.rule === rule), `${rule} was compared: ${JSON.stringify(checks.filter((c) => c.rule === rule))}`);
    assert.ok(skips.some((s) => s.rule === rule && /90-day export/.test(s.reason)), `${rule} not skipped: ${JSON.stringify(skips)}`);
  }
});

test("窓の外でも export の中にある配達は、L2 の行として比べる", () => {
  const tx = `0x${"cd".repeat(32)}`;
  const x = listing(1, "allow", ["delivered"]);
  assert.ok(x.ledgerRows.ok === true && x.decision.ok === true && x.mcp.ok === true);
  const scoredAt = Date.parse(x.decision.value.scoredAt!);
  const at = new Date(scoredAt - 45 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
  const row = { ...x.ledgerRows.value[0]!, attempted_at: at, tx_hash: tx, status: "settled", http_status_paid: "200", l2_schema: "mismatch", l2_reading: "mismatch" };
  const d = structuredClone(x.decision.value);
  d.facts = { ...d.facts, l2: { status: "mismatch", missing_keys: ["id"] } };
  d.l1_basis = { ...d.l1_basis, last_delivered_at: at };
  d.evidence = [];
  const y = { ...x, ledgerRows: { ok: true as const, value: [row] }, decision: { ok: true as const, value: d }, mcp: { ok: true as const, value: { ...x.mcp.value, measurement: structuredClone(d) } } };
  const c = compareListing(y, registry()).checks.find((k) => k.rule === "l2_same_row");
  assert.ok(c, "l2_same_row was not compared");
  assert.equal(c.ok, true, JSON.stringify(c.values));
  assert.match(String(c.values.find((v) => v.surface === "ledger")?.value), new RegExp(at));
});

test("付け先の決まらない配達は、比べる行より新しいときだけ l2_same_row を控える", () => {
  const x = listing(1, "allow", ["delivered"]);
  assert.ok(x.ledgerRows.ok === true && x.decision.ok === true);
  const base = x.ledgerRows.value[0]!;
  const unplacedAt = (at: string) => [{ ...base, attempted_at: at, network: "eip155:42161", tx_hash: `0x${"ef".repeat(32)}`, status: "settled", http_status_paid: "200" }];
  const t = Date.parse(base.attempted_at);
  const older = compareListing({ ...x, ledgerUnplaced: unplacedAt(new Date(t - 86_400_000).toISOString().replace(/\.\d+Z$/, "Z")) }, registry());
  assert.ok(older.checks.some((c) => c.rule === "l2_same_row"), "古い行があっても比べる");
  const newer = compareListing({ ...x, ledgerUnplaced: unplacedAt(new Date(t + 60_000).toISOString().replace(/\.\d+Z$/, "Z")) }, registry());
  assert.ok(!newer.checks.some((c) => c.rule === "l2_same_row"), "新しい行があれば控える");
  assert.ok(newer.skips.some((s) => s.rule === "l2_same_row" && /cannot place/.test(s.reason)));
});

// ---- H-A のあとで残った赤（判定 2,658 件と 90 日の export のリプレイで見つけた形） ----

test("L2 の行: 判定 undeclared × 行 not_checked は食い違いではない（買った後に出力の宣言が消えた出品）", () => {
  const c = l2SameRow("undeclared", "not_checked", "not_checked");
  assert.equal(c.ok, true, JSON.stringify(c.values));
});

test("L2 の行: 掲載に宣言が無い出品は、古い行が L2 の読みを持っていても比べない", () => {
  const x = listing(1, "allow", ["delivered"]);
  assert.ok(x.ledgerRows.ok === true && x.decision.ok === true && x.mcp.ok === true);
  const d = structuredClone(x.decision.value);
  d.facts = { ...d.facts, l2: { status: "undeclared", declaration_hash: null } };
  const y = {
    ...x,
    decision: { ok: true as const, value: d },
    mcp: { ok: true as const, value: { ...x.mcp.value, measurement: structuredClone(d) } },
    ledgerRows: { ok: true as const, value: x.ledgerRows.value.map((r) => ({ ...r, l2_schema: "match", l2_reading: "match" })) },
  };
  const { checks, skips } = compareListing(y, registry());
  assert.ok(!checks.some((c) => c.rule === "l2_same_row"), JSON.stringify(checks.filter((c) => c.rule === "l2_same_row")));
  assert.ok(skips.some((s) => s.rule === "l2_same_row" && /no declaration now/.test(s.reason)));
});

test("L0: 判定 fail × export withdrawn は同じ 2 回の失敗で、食い違いではない", () => {
  const x = listing(4, "block_l0", ["l0_fail"]);
  assert.ok(x.l0Row.ok === true && x.decision.ok === true);
  const y = { ...x, record: { ok: "n/a" as const, why: "test" }, l0Row: { ok: true as const, value: { ...x.l0Row.value, published_verdict: "withdrawn" } } };
  const c = compareListing(y, registry()).checks.find((k) => k.rule === "l0_published_state");
  assert.ok(c, "l0_published_state was not compared");
  assert.equal(c.ok, true, JSON.stringify(c.values));
});

test("L0: 判定 pass × export withdrawn は食い違いのまま", () => {
  const x = listing(1, "allow", ["delivered"]);
  assert.ok(x.l0Row.ok === true);
  const y = { ...x, record: { ok: "n/a" as const, why: "test" }, l0Row: { ok: true as const, value: { ...x.l0Row.value, published_verdict: "withdrawn" } } };
  const c = compareListing(y, registry()).checks.find((k) => k.rule === "l0_published_state");
  assert.ok(c, "l0_published_state was not compared");
  assert.equal(c.ok, false, JSON.stringify(c.values));
});

test("L2 の行: 宣言のある出品で判定 undeclared × 行 match は食い違いのまま（赤）", () => {
  const x = listing(1, "allow", ["delivered"]);
  assert.ok(x.ledgerRows.ok === true && x.decision.ok === true && x.mcp.ok === true);
  const d = structuredClone(x.decision.value);
  d.facts = { ...d.facts, l2: { status: "undeclared", declaration_hash: "abc" } };
  const y = {
    ...x,
    record: { ok: "n/a" as const, why: "test" },
    decision: { ok: true as const, value: d },
    mcp: { ok: true as const, value: { ...x.mcp.value, measurement: structuredClone(d) } },
    ledgerRows: { ok: true as const, value: x.ledgerRows.value.map((r) => ({ ...r, l2_schema: "match", l2_reading: "match" })) },
  };
  const c = compareListing(y, registry()).checks.find((k) => k.rule === "l2_same_row");
  assert.ok(c, "l2_same_row was not compared");
  assert.equal(c.ok, false, JSON.stringify(c.values));
});

// ---- 取り直しと読み直し（2026-11-03。失敗 24 run の切り分けで計器側の誤報が 13 run、定義差の語彙が 7、キャッシュが 2、504 が 1） ----

test("取り直し: 504 は 429・503 と同じ。他の 5xx・4xx は取り直さない", () => {
  for (const code of [429, 503, 504]) assert.equal(isRetryableStatus(code), true, String(code));
  for (const code of [200, 400, 404, 500, 502]) assert.equal(isRetryableStatus(code), false, String(code));
});

test("取り直しの待ち: Retry-After → ratelimit-reset → 15 秒から倍々。2 秒〜90 秒に収める", () => {
  const now = 1_800_000_000_000;
  assert.equal(retryBackoffMs(new Headers({ "retry-after": "7" }), now, 0), 7_000);
  assert.equal(retryBackoffMs(new Headers({ "ratelimit-reset": String(now / 1000 + 20) }), now, 0), 20_000);
  assert.equal(retryBackoffMs(new Headers(), now, 0), 15_000);
  assert.equal(retryBackoffMs(new Headers(), now, 1), 30_000);
  assert.equal(retryBackoffMs(new Headers(), now, 2), 60_000);
  assert.equal(retryBackoffMs(new Headers({ "retry-after": "1" }), now, 0), 2_000);
  assert.equal(retryBackoffMs(new Headers({ "retry-after": "900" }), now, 0), 90_000);
});

function staleSellerPage(listings: ListingInput[]) {
  const x = listings[1]!;
  assert.ok(x.sellerPage.ok === true);
  const fresh = x.sellerPage;
  x.sellerPage = { ok: true, value: { ...x.sellerPage.value, whoseSide: "seller's side" } };
  return { x, fresh };
}

function recheckOf(listings: ListingInput[]) {
  const { checks, skips } = compareAll(listings, registry());
  return { checks, skips, waitedMs: 360_000, listings: listings.map((l) => l.resourceKey), failed: [] };
}

test("読み直し: 1 回目の食い違いが読み直しで一致すれば赤にせず、値を残す", () => {
  const listings = consistentSample();
  const fixed = structuredClone(listings);
  const { x } = staleSellerPage(listings);
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length), recheck: recheckOf(fixed) });
  assert.deepEqual(r.discrepancies, []);
  assert.equal(r.ok, true, r.failReasons.join(" | "));
  assert.equal(r.firstReadDiscrepancies, 1);
  assert.deepEqual(r.clearedOnRecheck.map((c) => `${c.rule}:${c.listing}`), [`latest_row_side:${x.resourceKey}`]);
  assert.ok(JSON.stringify(r.clearedOnRecheck[0]!.values).includes("seller's side"), "the first read's values are kept");
  assert.equal(r.recheck?.waitedMs, 360_000);
});

test("読み直し: 読み直しでも残れば赤で、読み直しの値を出す", () => {
  const listings = consistentSample();
  staleSellerPage(listings);
  const again = structuredClone(listings);
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length), recheck: recheckOf(again) });
  assert.equal(r.ok, false);
  assert.equal(r.discrepancies.length, 1);
  assert.equal(r.discrepancies[0]!.rule, "latest_row_side");
  assert.deepEqual(r.clearedOnRecheck, []);
  assert.ok(r.failReasons.some((f) => f.startsWith("1 discrepancies")));
});

test("読み直し: 比べられなかった食い違い（読み直しで面が取れない）は赤のまま", () => {
  const listings = consistentSample();
  const { x } = staleSellerPage(listings);
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length), recheck: { checks: [], skips: [], waitedMs: 360_000, listings: [], failed: [{ surface: "sellers", listing: "(global)", error: "HTTP 504" }] } });
  assert.equal(r.ok, false);
  assert.equal(r.discrepancies[0]!.listing, x.resourceKey);
  assert.match(r.discrepancies[0]!.detail ?? "", /not compared on every surface on the re-read/);
  assert.equal(r.recheck?.failedList.length, 1);
});

test("読み直し: 読み直しで初めて出た食い違いは赤に数えず、値を残す", () => {
  const ok = (rule: string): Check => ({ item: "side", rule, listing: "a", observatoryId: "1", ok: true, values: [] });
  const bad = (rule: string): Check => ({ ...ok(rule), ok: false });
  const s = settleAfterRecheck([bad("r1")], [ok("r1"), bad("r2")]);
  assert.deepEqual(s.persisted, []);
  assert.deepEqual(s.cleared.map((c) => c.rule), ["r1"]);
  assert.deepEqual(s.appeared.map((c) => c.rule), ["r2"]);
});

test("読み直し: 同じ出品の鍵は同じ resource_key でも endpoint で分ける", () => {
  const c = (id: string, ok: boolean): Check => ({ item: "side", rule: "r", listing: "same/key", observatoryId: id, ok, values: [] });
  const s = settleAfterRecheck([c("base", false)], [c("base", true), c("tempo", false)]);
  assert.deepEqual(s.persisted, []);
  assert.deepEqual(s.appeared.map((x) => x.observatoryId), ["tempo"]);
});

// ---- 面の欠けた読み直しは「消えた」に数えない（確かめ役の再現 2026-11-03） ----

test("読み直し: 食い違った面が読み直しで取れない（売り手頁の 504）なら赤のまま", () => {
  const listings = consistentSample();
  const { x } = staleSellerPage(listings);
  const again = structuredClone(listings);
  again[1]!.sellerPage = { ok: false, error: "HTTP 504" };
  const { checks, skips } = compareAll(again, registry());
  const r = buildReport({
    listings,
    registry: registry(),
    tally: tallyFor(listings.length),
    recheck: { checks, skips, waitedMs: 360_000, listings: again.map((l) => l.resourceKey), failed: [{ surface: "seller_page", listing: x.resourceKey, error: "HTTP 504" }] },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.clearedOnRecheck, []);
  assert.deepEqual(r.discrepancies.map((c) => c.rule), ["latest_row_side"]);
  assert.match(r.discrepancies[0]!.detail ?? "", /not compared on every surface/);
});

test("読み直し: 売り手頁が先頭の頁に無い（n/a）・読み置きで外された時も赤のまま", () => {
  const listings = consistentSample();
  staleSellerPage(listings);
  const na = structuredClone(listings);
  na[1]!.sellerPage = { ok: "n/a", why: "not on the first 4 pages" };
  const a = compareAll(na, registry());
  assert.deepEqual(buildReport({ listings, registry: registry(), tally: tallyFor(listings.length), recheck: { ...a, waitedMs: 1, listings: [], failed: [] } }).clearedOnRecheck, []);
  const stale = structuredClone(listings);
  const y = stale[1]!;
  assert.ok(y.sellerPage.ok === true);
  y.sellerPage = { ok: true, value: notTriedPageReadAt(y, "2026-09-20 11:00") };
  const b = compareAll(stale, registry());
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length), recheck: { ...b, waitedMs: 1, listings: [], failed: [] } });
  assert.deepEqual(r.clearedOnRecheck, []);
  assert.equal(r.ok, false);
});

test("読み直し: 登録簿の llms-full が読み直しで取れない時、llms.txt の一致では消さない", () => {
  const c = (surface: string, ok: boolean): Check => ({ item: "reason_codes", rule: "llms_codes_defined", listing: "(registry)", observatoryId: null, ok, values: [{ surface, value: "" }, { surface: "openapi", value: "" }] });
  const s = settleAfterRecheck([c("llms-full.txt", false)], [c("llms.txt", true)]);
  assert.equal(s.cleared.length, 0);
  assert.equal(s.persisted.length, 1);
  assert.deepEqual(settleAfterRecheck([c("llms-full.txt", false)], [c("llms.txt", true), c("llms-full.txt", true)]).cleared.length, 1);
});

for (const [rule, first, partial, full] of [
  ["latest_row_status", ["sellers", "seller_page", "record"], ["sellers", "record"], ["sellers", "seller_page", "record"]],
  ["l0_published_state", ["decision", "l0", "record"], ["decision", "l0"], ["decision", "l0", "record"]],
  ["l2_same_row", ["decision", "ledger", "record"], ["decision", "ledger"], ["decision", "ledger", "record"]],
  ["rules_version_everywhere", ["decision", "docs", "openapi"], ["docs", "openapi"], ["decision", "docs", "openapi"]],
] as const) {
  test(`読み直し: ${rule} は 1 回目の面が全部そろった一致でだけ消える`, () => {
    const c = (surfaces: readonly string[], ok: boolean): Check => ({ item: "side", rule, listing: "a", observatoryId: "1", ok, values: surfaces.map((surface) => ({ surface, value: "v" })) });
    assert.equal(settleAfterRecheck([c(first, false)], [c(partial, true)]).cleared.length, 0);
    assert.equal(settleAfterRecheck([c(first, false)], [c(full, true)]).cleared.length, 1);
  });
}

test("block_vs_unmeasured: 一致の値に読めた面を残す。面が取れない一致では 1 回目の食い違いを消さない", () => {
  const bad: Check = { item: "verdict", rule: "block_vs_unmeasured", listing: "a", observatoryId: "1", ok: false, values: [{ surface: "decision", value: "BLOCK" }, { surface: "record", value: "unverified" }] };
  const decisionOnly: Check = { ...bad, ok: true, values: [{ surface: "decision", value: "BLOCK" }] };
  const withRecord: Check = { ...bad, ok: true, values: [{ surface: "decision", value: "BLOCK" }, { surface: "record", value: "fail" }] };
  assert.equal(settleAfterRecheck([bad], [decisionOnly]).cleared.length, 0);
  assert.equal(settleAfterRecheck([bad], [withRecord]).cleared.length, 1);
  // 本体: 未プローブの BLOCK で他の面が「未確定」と言わない時、ok の比較は読めた面を値に持つ
  const x = listing(1, "block_l0", ["unprobed"]);
  assert.ok(x.decision.ok === true && x.mcp.ok === true);
  const d = structuredClone(x.decision.value);
  d.reason_codes = ["l0_unverified_no_recent_probe"];
  x.decision = { ok: true, value: d };
  // 他の面は「未確定・まだ試していない」と言わない（BLOCK と矛盾しない）形にする
  assert.ok(x.sellersRow.ok === true && x.sellerPage.ok === true);
  x.sellersRow = { ok: true, value: { ...x.sellersRow.value, outcome: "seller" } };
  x.sellerPage = { ok: true, value: { ...x.sellerPage.value, latestAttempt: "2026-09-20 12:00 UTC" } };
  const reg: Registry = { ...registry(), docs: { ...registry().docs!, rows: registry().docs!.rows.map((row) => (row.code.startsWith("l0_unverified_") ? { ...row, verdict: "BLOCK" } : row)) } };
  const got = compareListing(x, reg).checks.find((k) => k.rule === "block_vs_unmeasured");
  assert.ok(got, "block_vs_unmeasured was not compared");
  assert.equal(got.ok, true, JSON.stringify(got.values));
  assert.deepEqual(got.values.map((v) => v.surface), ["decision", "l0", "record", "sellers", "seller_page"]);
});

/** 判定だけが「測っていない」で BLOCK し、他の面は矛盾しない出品。 */
function blockListing(): ListingInput {
  const x = listing(1, "block_l0", ["unprobed"]);
  assert.ok(x.decision.ok === true && x.sellersRow.ok === true && x.sellerPage.ok === true);
  const d = structuredClone(x.decision.value);
  d.reason_codes = ["l0_unverified_no_recent_probe"];
  x.decision = { ok: true, value: d };
  x.sellersRow = { ok: true, value: { ...x.sellersRow.value, outcome: "seller" } };
  x.sellerPage = { ok: true, value: { ...x.sellerPage.value, latestAttempt: "2026-09-20 12:00 UTC" } };
  return x;
}
const blockReg = (): Registry => ({ ...registry(), docs: { ...registry().docs!, rows: registry().docs!.rows.map((row) => (row.code.startsWith("l0_unverified_") ? { ...row, verdict: "BLOCK" } : row)) } });
const ruleOf = (x: ListingInput, r: string) => compareListing(x, blockReg()).checks.filter((k) => k.rule === r);

test("読み直し: block_vs_unmeasured は記録頁が取れても状態が読めなければ消さない。読めて矛盾しなければ消す", () => {
  const first = blockListing();
  assert.ok(first.record.ok === true);
  const recVal = first.record.value;
  first.record = { ok: true, value: { ...recVal, publishedState: "unverified" } };
  const a = ruleOf(first, "block_vs_unmeasured");
  assert.equal(a[0]?.ok, false);
  const unreadable = structuredClone(first);
  unreadable.record = { ok: true, value: { ...recVal, publishedState: null as never } };
  const s = settleAfterRecheck(a, ruleOf(unreadable, "block_vs_unmeasured"));
  assert.deepEqual([s.persisted.length, s.cleared.length], [1, 0]);
  const failed = structuredClone(first);
  failed.record = { ok: false, error: "HTTP 504" };
  assert.deepEqual(settleAfterRecheck(a, ruleOf(failed, "block_vs_unmeasured")).cleared, []);
  const readable = structuredClone(first);
  readable.record = { ok: true, value: { ...recVal, publishedState: "fail" } };
  assert.equal(settleAfterRecheck(a, ruleOf(readable, "block_vs_unmeasured")).cleared.length, 1);
});

test("読み直し: 売り手頁が取れても誰の側かの語が読めなければ、食い違いを消さない", () => {
  const listings = consistentSample();
  staleSellerPage(listings);
  const again = structuredClone(listings);
  const y = again[1]!;
  assert.ok(y.sellerPage.ok === true);
  y.sellerPage = { ok: true, value: { ...y.sellerPage.value, whoseSide: "layout changed" } };
  const { checks, skips } = compareAll(again, registry());
  const v = checks.find((c) => c.rule === "latest_row_side" && c.listing === y.resourceKey)!.values.find((w) => w.surface === "seller_page");
  assert.equal(v?.unread, true);
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length), recheck: { checks, skips, waitedMs: 360_000, listings: [], failed: [] } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.clearedOnRecheck, []);
  assert.equal(r.discrepancies.length, 1);
});

test("読み直し: 1 回目から語が読めなかった面は、読み直しの一致の条件にしない", () => {
  const c = (values: Check["values"], ok: boolean): Check => ({ item: "side", rule: "latest_row_side", listing: "a", observatoryId: "1", ok, values });
  const first = c([{ surface: "sellers", value: "seller" }, { surface: "record", value: "vet402" }, { surface: "seller_page", value: "?", unread: true }], false);
  const second = c([{ surface: "sellers", value: "seller" }, { surface: "record", value: "seller" }], true);
  assert.equal(settleAfterRecheck([first], [second]).cleared.length, 1);
});

test("規則の版の読み直し: 版ごとに 1 件は入れ、足りなければ最低の数まで足す", () => {
  const listings = consistentSample();
  const last = listings[listings.length - 1]!;
  assert.ok(last.decision.ok === true);
  last.decision = { ok: true, value: { ...last.decision.value, rules_version: "2026-09-29.4" } };
  const ids = listingsForRegistryRecheck(listings, 3);
  assert.ok(ids.includes(last.observatoryId), "the listing with the other version is re-read");
  assert.ok(ids.includes(listings[0]!.observatoryId));
  assert.equal(ids.length, 3);
  // 版が最低の数より多ければ全部の版を入れる
  const many = consistentSample().map((l, i) => {
    assert.ok(l.decision.ok === true);
    return { ...l, decision: { ok: true as const, value: { ...l.decision.value, rules_version: `v${i}` } } };
  });
  assert.equal(listingsForRegistryRecheck(many, 3).length, many.length);
  assert.match(readFileSync(join(process.cwd(), "scripts/surface-consistency-canary.ts"), "utf8"), /listingsForRegistryRecheck\(listings, RECHECK_REGISTRY_LISTINGS\)/);
});

test("締切で止めた回は赤で、理由を報告に残す", () => {
  const listings = consistentSample();
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length), stoppedEarly: "the 50-minute deadline passed" });
  assert.equal(r.ok, false);
  assert.equal(r.stoppedEarly, "the 50-minute deadline passed");
  assert.ok(r.failReasons.some((f) => f.startsWith("stopped before reading everything")));
  const script = readFileSync(join(process.cwd(), "scripts/surface-consistency-canary.ts"), "utf8");
  assert.match(script, /--deadline-min/);
  const yml = readFileSync(join(process.cwd(), ".github/workflows/surface-canary.yml"), "utf8");
  assert.match(yml, /- name: Open or update an alert issue on failure[\s\S]*?if: failure\(\) \|\| cancelled\(\)/);
  assert.match(yml, /outputs\.summary \|\| 'the run was cancelled or timed out/);
});

test("step summary: 消えたものと読み直しで初めて出たものを値ごと出す", () => {
  const listings = consistentSample();
  const fixed = structuredClone(listings);
  const { x } = staleSellerPage(listings);
  const r = buildReport({ listings, registry: registry(), tally: tallyFor(listings.length), recheck: recheckOf(fixed) });
  const md = recheckSummaryMarkdown({ ...r, appearedOnRecheck: [{ item: "side", rule: "later", listing: "b", observatoryId: "2", ok: false, values: [{ surface: "record", value: "w" }] }] });
  assert.match(md, /Cleared on the re-read \(1\):/);
  assert.ok(md.includes(x.resourceKey));
  assert.match(md, /First seen on the re-read, not counted \(1\):/);
  assert.match(md, /`side\/later` b: record=w/);
  assert.match(recheckSummaryMarkdown(buildReport({ listings: consistentSample(), registry: registry(), tally: tallyFor(40) })), /nothing was re-read/);
  assert.match(readFileSync(join(process.cwd(), "scripts/surface-consistency-canary.ts"), "utf8"), /GITHUB_STEP_SUMMARY/);
});

// 2026-10-04〜10-30 の赤のうち定義差と切り分けた語の組（判定 / 台帳 / 記録頁）。どれも同じ状態を別の語で言っているので赤にしない。
for (const [dec, row, rec, who] of [
  ["undeclared", "not_checked", "not_checked", "fairseal・oneshotagent・cultos・witnessd・remix.live・datasieve"],
  ["not_checked", "no_declaration", "no_declaration", "x402engine・fetchdelta・linkrra"],
  ["undeclared", "no_declaration", "no_declaration", "従来どおり"],
  ["not_checked", "", "", "空欄の行"],
] as const) {
  test(`定義差の語彙: 判定 ${dec} × 行 ${row || "(空欄)"} × 記録頁 ${rec || "(空欄)"} は食い違いではない（${who}）`, () => {
    const c = l2SameRow(dec, row, rec);
    assert.equal(c.ok, true, JSON.stringify(c.values));
  });
}

test("workflow: report を赤でも緑でも成果物に残す（版は SHA で固定）", () => {
  const yml = readFileSync(join(process.cwd(), ".github/workflows/surface-canary.yml"), "utf8");
  const step = /- name: Keep the report as an artifact[\s\S]*?if-no-files-found: warn/.exec(yml)?.[0] ?? "";
  assert.match(step, /if: always\(\)/);
  assert.match(step, /actions\/upload-artifact@[0-9a-f]{40} /);
  assert.match(step, /runner\.temp \}\}\/surface-canary\.json/);
  assert.match(yml, /--out "\$RUNNER_TEMP\/surface-canary\.json"/);
  const script = readFileSync(join(process.cwd(), "scripts/surface-consistency-canary.ts"), "utf8");
  assert.match(script, /isRetryableStatus\(res\.status\)/);
  assert.match(script, /recheckDiscrepancies\(/);
});
