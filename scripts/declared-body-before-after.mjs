#!/usr/bin/env node
// ============================================================
// Before/after the declared POST body — recomputed from the public export only.
//
//   node scripts/declared-body-before-after.mjs                  # fetches the public export (90 days)
//   node scripts/declared-body-before-after.mjs --days 120
//   node scripts/declared-body-before-after.mjs --file ledger.csv   # a copy you already downloaded
//   node scripts/declared-body-before-after.mjs --json
//
// Since 2026-09-17 vet402 sends a paid POST with the body the seller's own 402 declares
// (extensions.bazaar.info.input.body) instead of `{}`. The question this answers: for the SAME
// endpoint, how often did the paid request come back 2xx before that change, and how often
// since, when the declared body was sent?
//
// Input is https://vet402.com/api/v1/observatory/export.csv and nothing else: no database, no
// key, no file from this repository. Anyone can run it and must get the same counts from the
// same CSV. No number this prints is written into any document; run it to get today's.
//
// How it counts (every rule reads a published column):
//   paid row      status is one where vet402 signed a payment: settled, settle_failed,
//                 delivered_no_receipt, settle_claimed, settle_claimed_unverifiable,
//                 settle_claim_refuted. Other statuses never sent a paid request.
//   left out      held_reason = payer_unfunded (vet402's own wallet was empty; says nothing
//                 about the request body or the seller).
//   2xx           http_status_paid is 200..299 (the same boundary as `delivered`). Settlement is
//                 NOT required: this measures whether the request was accepted, not who got paid.
//   cutover       the attempted_at of the first row whose request_body is declared.
//                 Derived from the CSV, not hard-coded.
//   declared set  endpoints (resource_key) with at least one declared row.
//                 before = their paid rows earlier than the cutover;
//                 after  = their paid rows with request_body = declared.
//                 Only endpoints with at least one row on BOTH sides are paired.
//   comparison    endpoints with no declared row at all, paid rows before vs. from the
//                 cutover on. They got no new body, so their change is the background drift
//                 (catalog churn, seller outages) the declared set also lived through.
//   emptyBody     the part of the comparison set that is closest to the declared set: endpoints
//                 bought after the cutover with request_body = empty, i.e. a POST whose 402
//                 declared no body, so vet402 still sent `{}`. after = their empty rows.
//
// What the CSV cannot tell you, so this cannot either:
//   - Rows before 2026-09-17 carry no request_body. The methodology states every paid POST then
//     carried `{}`; the row itself does not record the method, so "before" is "whatever vet402
//     sent then", not a per-row proof of `{}`.
//   - The export window is at most 366 days and 50,000 rows.
// ============================================================
import { readFileSync } from "node:fs";

const PAID_STATUSES = new Set([
  "settled",
  "settle_failed",
  "delivered_no_receipt",
  "settle_claimed",
  "settle_claimed_unverifiable",
  "settle_claim_refuted",
]);
const REQUIRED = ["attempted_at", "resource_key", "status", "http_status_paid", "held_reason", "request_body"];

function args(argv) {
  const out = { file: null, url: null, days: 90, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--days") out.days = Number(argv[++i]);
    else fail(`unknown argument ${a}`);
  }
  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 366) fail("--days must be an integer 1..366");
  return out;
}

function fail(msg) {
  process.stderr.write(`declared-body-before-after: ${msg}\n`);
  process.exit(2);
}

/** RFC 4180: quoted cells may hold commas, quotes ("") and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

const tally = () => ({ paid: 0, http2xx: 0 });
const is2xx = (v) => /^\d+$/.test(v) && Number(v) >= 200 && Number(v) <= 299;

export function compute(csvText) {
  const table = parseCsv(csvText);
  if (table.length === 0) return { error: "the CSV is empty" };
  const header = table[0];
  const col = Object.fromEntries(header.map((name, i) => [name, i]));
  const missing = REQUIRED.filter((c) => !(c in col));
  if (missing.length) {
    return { error: `the CSV has no ${missing.join(", ")} column — request_body ships in exports retrieved on or after 2026-09-20` };
  }
  const rows = table.slice(1).map((r) => ({
    at: r[col.attempted_at],
    key: r[col.resource_key],
    status: r[col.status],
    http: r[col.http_status_paid] ?? "",
    held: r[col.held_reason] ?? "",
    shape: r[col.request_body] ?? "",
  }));

  const declaredRows = rows.filter((r) => r.shape === "declared");
  if (declaredRows.length === 0) {
    return { error: "no declared row in this CSV, so there is no cutover and nothing to compare (not the same as a rate of zero)" };
  }
  const cutover = declaredRows.reduce((min, r) => (r.at < min ? r.at : min), declaredRows[0].at);
  const declaredKeys = new Set(declaredRows.map((r) => r.key));
  const emptyKeys = new Set(rows.filter((r) => r.shape === "empty" && r.at >= cutover && !declaredKeys.has(r.key)).map((r) => r.key));

  const excluded = { payerUnfunded: 0, noPaidRequest: 0, declaredSetOtherShapeAfterCutover: 0 };
  /** key -> { before, after } */
  const declared = new Map();
  const comparison = new Map();
  const emptyBody = new Map();
  const slot = (map, key) => {
    if (!map.has(key)) map.set(key, { before: tally(), after: tally() });
    return map.get(key);
  };
  for (const r of rows) {
    if (!PAID_STATUSES.has(r.status)) {
      excluded.noPaidRequest++;
      continue;
    }
    if (r.held === "payer_unfunded") {
      excluded.payerUnfunded++;
      continue;
    }
    const isBefore = r.at < cutover;
    let side;
    if (declaredKeys.has(r.key)) {
      if (isBefore) side = slot(declared, r.key).before;
      else if (r.shape === "declared") side = slot(declared, r.key).after;
      else {
        // The endpoint declared a body on another day but not on this one; this row is not a
        // declared-body purchase and would blur the comparison either way.
        excluded.declaredSetOtherShapeAfterCutover++;
        continue;
      }
    } else {
      side = isBefore ? slot(comparison, r.key).before : slot(comparison, r.key).after;
      if (emptyKeys.has(r.key) && (isBefore || r.shape === "empty")) {
        const sub = isBefore ? slot(emptyBody, r.key).before : slot(emptyBody, r.key).after;
        sub.paid++;
        if (is2xx(r.http)) sub.http2xx++;
      }
    }
    side.paid++;
    if (is2xx(r.http)) side.http2xx++;
  }

  const summarize = (map) => {
    const paired = { endpoints: 0, before: tally(), after: tally() };
    const endpointsWithAny2xx = { before: 0, after: 0 };
    let endpointsWithoutBefore = 0;
    let endpointsWithoutAfter = 0;
    for (const v of map.values()) {
      if (v.before.paid === 0) endpointsWithoutBefore++;
      if (v.after.paid === 0) endpointsWithoutAfter++;
      if (v.before.paid === 0 || v.after.paid === 0) continue;
      paired.endpoints++;
      for (const k of ["before", "after"]) {
        paired[k].paid += v[k].paid;
        paired[k].http2xx += v[k].http2xx;
        if (v[k].http2xx > 0) endpointsWithAny2xx[k]++;
      }
    }
    return { paired, endpointsWithAny2xx, endpointsWithoutBefore, endpointsWithoutAfter };
  };

  const ats = rows.map((r) => r.at).sort();
  return {
    source: null,
    rows: rows.length,
    window: { first: ats[0] ?? null, last: ats[ats.length - 1] ?? null },
    cutover,
    declared: summarize(declared),
    comparison: summarize(comparison),
    emptyBody: summarize(emptyBody),
    excluded,
  };
}

const pct = (t) => (t.paid === 0 ? "n/a" : `${((t.http2xx / t.paid) * 100).toFixed(1)}%`);
function render(out) {
  const line = (label, s) =>
    `${label}\n` +
    `  endpoints with paid rows on both sides: ${s.paired.endpoints}` +
    ` (no row before: ${s.endpointsWithoutBefore}, no row after: ${s.endpointsWithoutAfter})\n` +
    `  before  ${s.paired.before.http2xx}/${s.paired.before.paid} paid requests answered 2xx (${pct(s.paired.before)}); ${s.endpointsWithAny2xx.before} endpoints had at least one\n` +
    `  after   ${s.paired.after.http2xx}/${s.paired.after.paid} paid requests answered 2xx (${pct(s.paired.after)}); ${s.endpointsWithAny2xx.after} endpoints had at least one\n`;
  return (
    `source   ${out.source}\n` +
    `rows     ${out.rows} (${out.window.first} .. ${out.window.last})\n` +
    `cutover  ${out.cutover} (first declared row in this CSV)\n\n` +
    line("Endpoints vet402 has bought with a declared body (after = declared rows only)", out.declared) +
    "\n" +
    line("Endpoints never bought with a declared body (background drift over the same dates)", out.comparison) +
    "\n" +
    line("  of those, endpoints bought after the cutover with an empty body — a POST that declared none (after = empty rows only)", out.emptyBody) +
    `\nleft out  ${out.excluded.payerUnfunded} payer_unfunded rows, ${out.excluded.noPaidRequest} rows with no paid request, ` +
    `${out.excluded.declaredSetOtherShapeAfterCutover} rows of declared-set endpoints sent without a declared body after the cutover\n` +
    `note      rows before 2026-09-17 carry no request_body; see the header of this script for what that limits.\n`
  );
}

async function main() {
  const a = args(process.argv.slice(2));
  let text;
  let source;
  if (a.file) {
    source = a.file;
    try {
      text = readFileSync(a.file, "utf8");
    } catch (e) {
      fail(`cannot read ${a.file}: ${e.message}`);
    }
  } else {
    source = a.url ?? `https://vet402.com/api/v1/observatory/export.csv?days=${a.days}`;
    const res = await fetch(source);
    if (!res.ok) fail(`${source} answered ${res.status}`);
    if (res.headers.get("x-vet402-truncated") === "true") {
      process.stderr.write("note: the export was truncated at its row cap; narrow --days\n");
    }
    text = await res.text();
  }
  const out = compute(text);
  if (out.error) fail(out.error);
  out.source = source;
  process.stdout.write(a.json ? `${JSON.stringify(out, null, 2)}\n` : render(out));
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main().catch((e) => fail(e.message));
