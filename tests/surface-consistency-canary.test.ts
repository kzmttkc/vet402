// 面の間のずれを見る計器（scripts/surface-consistency-canary.ts）の本体の検査。
// 本番は叩かない。公開面の出力の形（HTML・CSV・JSON・YAML）を固定具で作り、
//   - 全部そろった固定具 → PASS
//   - 食い違いを作った固定具 → FAIL（どの項目・どの面かまで）
//   - 0 件・面が取れない → FAIL（緑にしない）
// を確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  parseDocsReasonTable,
  parseLlmsText,
  parseOpenApiReasonCodes,
  parseRecordPage,
  parseSellerHostPage,
  sideFromWords,
} from "@/lib/surface-canary/parse";
import { buildReport, compareListing, type DecisionBody, type ListingInput, type Registry, type SurfaceTally } from "@/lib/surface-canary/compare";
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
