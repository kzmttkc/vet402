// The front page purchase uses the public export's day window, not a second rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { __setDbForTests } from "@/lib/db/client";
import { CheckPanel } from "@/components/site/home/CheckPanel";
import { ReceiptSlip } from "@/components/site/home/ReceiptSlip";
import {
  PUBLIC_EXPORT_EXCLUDED_STATUSES,
  formatSettledReceipt,
  getHomeExampleCached,
  ledgerL2Word,
  lowestChainShareLine,
  readHomeExample,
  unitsToAmount,
  type HomeDecision,
  type HomeReceipt,
} from "@/lib/observatory/home-example";

const route = readFileSync("src/app/api/v1/observatory/export.csv/route.ts", "utf8");

test("the home receipt excludes the same statuses as export.csv", () => {
  const listed = route.match(/pu\.status NOT IN \(([^)]+)\)/);
  assert.ok(listed, "the export route names the excluded statuses");
  assert.equal(
    listed[1],
    PUBLIC_EXPORT_EXCLUDED_STATUSES.map((s) => `'${s}'`).join(", "),
  );
  const src = readFileSync("src/lib/observatory/home-example.ts", "utf8");
  assert.ok(src.includes("make_interval(days => 1)"), "the window is one day, the same as export.csv?days=1");
  assert.ok(src.includes("ORDER BY pu.attempted_at DESC, pu.id ASC"), "ties keep the smaller purchase id");
});

test("a settled export row becomes one receipt, and a bad amount becomes none", () => {
  assert.equal(unitsToAmount("1500000"), "1.5");
  const row = {
    attempted_at: "2026-10-22T00:02:27Z",
    resource_key: "api.example.com/v1/quote",
    network: "eip155:8453",
    spent_units: "1500000",
    confirmed_units: "1500000",
    tx_hash: "0xabc123def4567890",
    http_status_paid: "200",
    l2_schema: "match",
    l2_reading: "match",
    settlement_source: "seller_claim",
    id: "11111111-2222-3333-4444-555555555555",
  };
  const receipt = formatSettledReceipt(row, { rows: 12, settled: 4, from: "2026-10-21T00:00:00Z", to: "2026-10-22T00:02:27Z" });
  assert.ok(receipt);
  assert.equal(receipt.host, "api.example.com");
  assert.equal(receipt.path, "/v1/quote");
  assert.equal(receipt.amount, "1.5");
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.held, false);
  assert.equal(receipt.chain, "Base");
  assert.equal(receipt.l2, "match");
  assert.equal(formatSettledReceipt({ ...row, confirmed_units: "nope", spent_units: "nope" }, { rows: 1, settled: 1, from: "", to: "" }), null);
});

const WINDOW = { rows: 3, settled: 3, from: "2026-10-21T00:00:00Z", to: "2026-10-22T00:02:27Z" };

function exportRow(over: Record<string, unknown> = {}) {
  return {
    attempted_at: "2026-10-22T00:02:27Z",
    resource_key: "api.example.com/v1/quote",
    network: "eip155:8453",
    spent_units: "1500000",
    confirmed_units: "1500000",
    tx_hash: "0xabc123def4567890",
    http_status_paid: "200",
    payload_non_empty: true,
    held_reason: null,
    endpoint_id: "22222222-2222-4222-8222-222222222222",
    l2_schema: "match",
    l2_reading: "match",
    settlement_source: "seller_claim",
    id: "11111111-2222-3333-4444-555555555555",
    ...over,
  };
}

function slipHtml(over: Partial<HomeReceipt>): string {
  const formatted = formatSettledReceipt(exportRow(), WINDOW);
  assert.ok(formatted);
  return renderToStaticMarkup(createElement(ReceiptSlip, { receipt: { ...formatted, ...over } }));
}

function deliveredCell(html: string): string {
  const at = html.indexOf(">Delivered<");
  assert.ok(at >= 0, html);
  const end = html.indexOf("</dd>", at);
  assert.ok(end >= 0, html);
  return html.slice(at, end + "</dd>".length);
}

test("202, an empty 200, and a held 4xx are not delivered on the receipt", () => {
  const accepted = formatSettledReceipt(exportRow({ http_status_paid: "202", payload_non_empty: true }), WINDOW);
  const empty = formatSettledReceipt(exportRow({ http_status_paid: "200", payload_non_empty: false }), WINDOW);
  const held = formatSettledReceipt(exportRow({ http_status_paid: "400", payload_non_empty: true, held_reason: "settled_4xx" }), WINDOW);
  assert.ok(accepted && empty && held);
  assert.equal(accepted.delivered, false);
  assert.equal(accepted.held, false);
  assert.equal(empty.delivered, false);
  assert.equal(empty.held, false);
  assert.equal(held.delivered, false);
  assert.equal(held.held, true);

  const acceptedHtml = renderToStaticMarkup(createElement(ReceiptSlip, { receipt: accepted }));
  const emptyHtml = renderToStaticMarkup(createElement(ReceiptSlip, { receipt: empty }));
  const heldHtml = renderToStaticMarkup(createElement(ReceiptSlip, { receipt: held }));
  assert.equal(deliveredCell(acceptedHtml).includes("yes, 2xx"), false);
  assert.equal(deliveredCell(emptyHtml).includes("yes, 2xx"), false);
  assert.match(deliveredCell(acceptedHtml), />not confirmed, 202 accepted</);
  assert.equal(deliveredCell(acceptedHtml).includes("font-semibold"), false);
  assert.match(deliveredCell(emptyHtml), />no, empty body</);
  assert.match(deliveredCell(heldHtml), />held, inconclusive</);
  assert.equal(deliveredCell(heldHtml).includes("font-semibold"), false);
  assert.equal(heldHtml.includes("no 2xx"), false);

  const filled = formatSettledReceipt(exportRow({ http_status_paid: "200", payload_non_empty: true }), WINDOW);
  assert.equal(filled?.delivered, true);
  assert.match(deliveredCell(renderToStaticMarkup(createElement(ReceiptSlip, { receipt: filled! }))), />yes, 2xx</);
});

test("the receipt and the panel use the ledger L2 words", () => {
  assert.equal(ledgerL2Word("conform"), "match");
  assert.equal(ledgerL2Word("undeclared"), "no_declaration");
  assert.equal(ledgerL2Word("mismatch"), "mismatch");
  assert.equal(ledgerL2Word("not_checked"), "not_checked");
  assert.equal(ledgerL2Word("no_declaration"), "no_declaration");
  assert.equal(ledgerL2Word(null), "not_checked");
  const receipt = formatSettledReceipt(exportRow({ l2_schema: "no_declaration", l2_reading: "no_declaration" }), WINDOW);
  assert.equal(receipt?.l2, "no_declaration");
  const html = renderToStaticMarkup(createElement(ReceiptSlip, { receipt: receipt! }));
  assert.match(html, />no_declaration</);
  assert.equal(html.includes("no declaration"), false);

  const decision: HomeDecision = {
    method: "POST",
    observatoryId: "22222222-2222-4222-8222-222222222222",
    l0: { status: "pass", observedAt: "2026-10-22T00:00:00Z" },
    l1: { attempts: 2, settled: 1, delivered: 1, windowDays: 30 },
    l2: "not_checked",
  };
  const panel = renderToStaticMarkup(
    createElement(CheckPanel, { example: { receipt: receipt!, decision } }),
  );
  assert.match(panel, />not_checked</);
  assert.equal(panel.includes("not checked"), false);
  assert.equal(panel.includes("undeclared"), false);
  assert.match(panel, /1 delivered/);
  assert.equal(panel.includes("answered 2xx"), false);
});

test("the reproduce command uses the same one day window as the receipt", () => {
  const html = slipHtml({});
  assert.match(html, /export\.csv\?days=1/);
  assert.equal(html.includes("days=90"), false);
});

test("the lowest chain share drops held settled rows from the denominator", () => {
  const chain = (label: string, settled: number, delivered: number, inconclusiveSettled: number) => ({
    label,
    settled,
    delivered,
    inconclusiveSettled,
  });
  // Base is 100/200. Solana is 80/100 once the 100 held rows leave the denominator.
  // The old delivered/settled ratio would have named Solana (80/200). Polygon has nothing left to judge.
  const line = lowestChainShareLine([
    chain("Base", 200, 100, 0),
    chain("Solana", 200, 80, 100),
    chain("Polygon", 150, 0, 150),
  ]);
  assert.equal(line, " Lowest share among chains with 100 or more settled, over settled purchases that are not held: Base, 100 of 200.");
  assert.equal(lowestChainShareLine([chain("Base", 50, 40, 0)]), "");
  assert.doesNotMatch(line, /\b(we|our|us)\b/i);
  assert.equal(line.includes(";"), false);
  assert.equal(line.includes("—"), false);
});

function sqlText(q: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown, depth: number) => {
    if (node == null || depth > 8) return;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      const o = node as { value?: unknown; queryChunks?: unknown };
      if (Array.isArray(o.value)) parts.push(o.value.filter((v) => typeof v === "string").join(""));
      if (o.queryChunks) walk(o.queryChunks, depth + 1);
    }
  };
  walk((q as { queryChunks?: unknown }).queryChunks ?? q, 0);
  return parts.join(" ");
}

const SAME_URL = "https://api.example.com/v1/quote";
const GET_ID = "11111111-1111-4111-8111-111111111111";
const POST_ID = "22222222-2222-4222-8222-222222222222";

/** Two listings on one URL. The settled purchase belongs to the POST listing. */
function listingsDb(mode: "ok" | "decision-throws") {
  const asked: string[] = [];
  return {
    asked,
    db: {
      execute: async (q: unknown) => {
        const text = sqlText(q);
        if (text.includes("window_rows")) {
          return {
            rows: [{ window_rows: 2, window_settled: 1, window_from: "2026-10-21T00:00:00Z", window_to: "2026-10-22T00:02:27Z" }],
          };
        }
        if (text.includes("resource_key") && text.includes("held_reason")) {
          return {
            rows: [
              {
                id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                attempted_at: "2026-10-22T00:02:27Z",
                resource_key: "api.example.com/v1/quote",
                network: "eip155:8453",
                spent_units: "1000000",
                tx_hash: "0x" + "ab".repeat(32),
                endpoint_id: POST_ID,
                http_status_paid: "200",
                payload_non_empty: true,
                held_reason: null,
                l2_schema: "match",
                settlement_source: "seller_claim",
                confirmed_units: "1000000",
                l2_detail: null,
                l2_body_head: null,
                l2_content_type: "application/json",
                l2_declared_schema: null,
              },
            ],
          };
        }
        if (mode === "decision-throws") throw new Error("decision read failed");
        if (text.includes("FROM x402_endpoints WHERE id")) {
          const id = text.includes(POST_ID) ? POST_ID : text.includes(GET_ID) ? GET_ID : "";
          asked.push(id || "missing");
          if (!id) return { rows: [] };
          const method = id === POST_ID ? "POST" : "GET";
          return {
            rows: [
              {
                id,
                resource_id: method === "POST" ? "post-rid" : "get-rid",
                endpoint_hash: method === "POST" ? "post-hash" : "get-hash",
                canonical_url: SAME_URL,
                method,
                pay_to: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
                network: "eip155:8453",
                payee_id: null,
                declared_schema: null,
                raw_method: method,
                declared_input: null,
                listing_status: "active",
              },
            ],
          };
        }
        if (text.includes("x402_l0_probes")) {
          return {
            rows: [
              {
                probed_at: "2026-10-22 00:00:00+00",
                verdict: "pass",
                dialect: null,
                fail_reason: null,
                price_consistent: true,
                metadata_consistent: true,
              },
            ],
          };
        }
        if (text.includes("FROM x402_l1_purchases p")) {
          const post = text.includes(POST_ID);
          return {
            rows: [
              {
                attempted_at: "2026-10-22 00:02:27.000+00",
                attempted_at_utc: "2026-10-22T00:02:27Z",
                status: "settled",
                latency_ms: 40,
                http_status_paid: post ? 200 : 500,
                payload_non_empty: true,
                l2_schema: post ? "match" : "mismatch",
                tx_hash: "0x" + (post ? "ab" : "cd").repeat(32),
                network: "eip155:8453",
                content_type: "application/json",
                l2_detail: null,
                body_head: null,
                request_meta: null,
                amount_units: "1000000",
                payer: "0x0000000000000000000000000000000000000001",
                auth_nonce: "nonce",
                settlement_confirmed: null,
              },
            ],
          };
        }
        if (text.includes("AS last_signed")) {
          return [{ last_signed: "2026-10-22 00:02:27+00", last_delivered: text.includes(POST_ID) ? "2026-10-22 00:02:27+00" : null }];
        }
        if (text.includes("is_mpp")) return { rows: [] };
        if (text.includes("wash_flag")) return { rows: [{ raw: 0, real: 0, test: 0, payers: 0 }] };
        if (text.includes("AS attempted_at, status")) {
          return { rows: [{ attempted_at: "2026-10-22 00:02:27.000+00", status: "settled" }] };
        }
        return { rows: [] };
      },
    },
  };
}

test("the example decision is loaded from the purchase endpoint, not the other listing on the same URL", async () => {
  const fixture = listingsDb("ok");
  __setDbForTests(fixture.db);
  try {
    const example = await readHomeExample();
    assert.ok(example);
    assert.equal(example.receipt.endpointId, POST_ID);
    assert.equal(example.receipt.url, SAME_URL);
    assert.ok(example.decision);
    assert.equal(example.decision.observatoryId, POST_ID);
    assert.equal(example.decision.method, "POST");
    assert.equal(example.decision.l1.delivered, 1);
    assert.equal(example.decision.l2, "no_declaration");
    assert.deepEqual(fixture.asked, [POST_ID]);
    const src = readFileSync("src/lib/observatory/home-example.ts", "utf8");
    assert.equal(src.includes('from "@/lib/resolve/lookup"'), false);
    assert.match(src, /loadSellerFacts\(endpointId\)/);
    const reader = src.slice(src.indexOf("export async function readHomeExample"), src.indexOf("const readHomeExampleCached"));
    assert.equal(reader.includes("catch"), false);
  } finally {
    __setDbForTests(null);
  }
});

test("a thrown decision read is not stored as decision null inside the cached read", async () => {
  const fixture = listingsDb("decision-throws");
  __setDbForTests(fixture.db);
  try {
    await assert.rejects(readHomeExample(), /decision read failed/);
    assert.equal(await getHomeExampleCached(), null);
  } finally {
    __setDbForTests(null);
  }
});
