// ============================================================
// delivery の 3 値と delivery.csv route（DB なし中心）。
// Run: env -u DATABASE_URL npx tsx --test tests/delivery-values.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import {
  countDeliveryValues,
  DELIVERY_VALUE_DEFINITIONS,
  DELIVERY_VALUES_SOURCE_NOTE,
  deliveryOutcomeOf,
  type DeliveryValueInput,
} from "@/lib/observatory/delivery-values";
import { DELIVERY_CSV_COLUMN_NOTES, DELIVERY_CSV_COLUMNS } from "@/lib/observatory/delivery-export";
import { isDelivered } from "@/lib/observatory/delivery";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const HTTP_CODES = [
  null,
  100,
  101,
  199,
  200,
  201,
  202,
  204,
  299,
  300,
  307,
  399,
  400,
  402,
  404,
  422,
  499,
  500,
  503,
  599,
  600,
] as const;

const NON_SETTLED_STATUSES = ["settle_failed", "settle_claimed", "delivered_no_receipt"] as const;

function assertAsciiNoBannedEnglish(text: string, label: string) {
  assert.match(text, /^[\x20-\x7E\n\r\t]*$/, `${label} must be ASCII`);
  assert.doesNotMatch(text, /\b(we|our|us)\b/i, `${label} must not use we/our/us`);
  assert.doesNotMatch(text, /[—–]|&mdash;|&ndash;/, `${label} must not use dashes`);
  assert.doesNotMatch(text, /;/, `${label} must not use semicolons`);
}

test("境界: 200＋本文→delivered・202→not_established・200＋空→no_body_observed・500→no_body_observed", () => {
  assert.deepEqual(deliveryOutcomeOf({ status: "settled", httpStatusPaid: 200, payloadNonEmpty: true }), {
    delivery: "delivered",
    reason: null,
  });
  assert.deepEqual(deliveryOutcomeOf({ status: "settled", httpStatusPaid: 202 }), {
    delivery: "not_established",
    reason: "http_202",
  });
  assert.deepEqual(deliveryOutcomeOf({ status: "settled", httpStatusPaid: 200, payloadNonEmpty: false }), {
    delivery: "no_body_observed",
    reason: "empty_2xx",
  });
  assert.deepEqual(deliveryOutcomeOf({ status: "settled", httpStatusPaid: 500 }), {
    delivery: "no_body_observed",
    reason: "http_5xx",
  });
});

test("境界: 決済後 404→not_established・状態なし→not_established・307→not_established", () => {
  assert.deepEqual(deliveryOutcomeOf({ status: "settled", httpStatusPaid: 404 }), {
    delivery: "not_established",
    reason: "settled_4xx",
  });
  assert.deepEqual(deliveryOutcomeOf({ status: "settled", httpStatusPaid: null }), {
    delivery: "not_established",
    reason: "no_http_status",
  });
  assert.deepEqual(deliveryOutcomeOf({ status: "settled", httpStatusPaid: 307 }), {
    delivery: "not_established",
    reason: "http_3xx",
  });
});

test("境界: 101→other_http・settled でない行→null", () => {
  assert.deepEqual(deliveryOutcomeOf({ status: "settled", httpStatusPaid: 101 }), {
    delivery: "not_established",
    reason: "other_http",
  });
  assert.equal(deliveryOutcomeOf({ status: "settle_failed", httpStatusPaid: 200 }), null);
});

test("境界: 理由を期待値で固定（100・199・600→other_http・402→settled_4xx・200＋本文の記録なし→delivered）", () => {
  const o = (h: number | null, p?: boolean | null) => deliveryOutcomeOf({ status: "settled", httpStatusPaid: h, payloadNonEmpty: p });
  for (const h of [100, 199, 600]) assert.deepEqual(o(h, true), { delivery: "not_established", reason: "other_http" }, String(h));
  assert.deepEqual(o(402), { delivery: "not_established", reason: "settled_4xx" });
  assert.deepEqual(o(200, null), { delivery: "delivered", reason: null });
  assert.deepEqual(o(204, false), { delivery: "no_body_observed", reason: "empty_2xx" });
  assert.deepEqual(o(599), { delivery: "no_body_observed", reason: "http_5xx" });
  assert.deepEqual(o(202, false), { delivery: "not_established", reason: "http_202" });
});

test("delivered は isDelivered と一致", () => {
  const payloadOpts = [true, false, null] as const;
  for (const status of ["settled", ...NON_SETTLED_STATUSES] as const) {
    for (const http of HTTP_CODES) {
      for (const payloadNonEmpty of payloadOpts) {
        const row: DeliveryValueInput = { status, httpStatusPaid: http, payloadNonEmpty };
        const outcome = deliveryOutcomeOf(row);
        if (status !== "settled") {
          assert.equal(outcome, null);
          continue;
        }
        assert.ok(outcome);
        assert.equal(outcome.delivery === "delivered", isDelivered(row));
        assert.ok(["delivered", "no_body_observed", "not_established"].includes(outcome.delivery));
      }
    }
  }
  const settledRows: DeliveryValueInput[] = [];
  for (const http of HTTP_CODES) {
    for (const payloadNonEmpty of payloadOpts) {
      settledRows.push({ status: "settled", httpStatusPaid: http, payloadNonEmpty });
    }
  }
  const counts = countDeliveryValues(settledRows);
  assert.equal(counts.delivered + counts.no_body_observed + counts.not_established, settledRows.length);
});

async function compareDaysPaths(search: string, ip: string) {
  const ledger = await import("@/app/api/v1/observatory/export.csv/route");
  const delivery = await import("@/app/api/v1/observatory/delivery.csv/route");
  const base = "https://vet402.com";
  const req = (path: string) =>
    new NextRequest(`${base}${path}${search}`, { headers: { "x-forwarded-for": ip } });
  const rL = await ledger.GET(req("/api/v1/observatory/export.csv"));
  const rD = await delivery.GET(req("/api/v1/observatory/delivery.csv"));
  assert.equal(rD.status, rL.status, search);
  if (rL.status === 308) {
    assert.equal(new URL(rD.headers.get("location") ?? "").search, new URL(rL.headers.get("location") ?? "").search);
    const jL = (await rL.json()) as Record<string, unknown>;
    const jD = (await rD.json()) as Record<string, unknown>;
    assert.equal(jL.error, "moved");
    assert.equal(jD.error, "moved");
    assert.equal(
      new URL(String(jL.location)).search,
      new URL(String(jD.location)).search,
      search,
    );
    return;
  }
  const ctL = rL.headers.get("content-type") ?? "";
  const ctD = rD.headers.get("content-type") ?? "";
  if (ctL.includes("application/json")) {
    assert.equal(ctD, ctL);
    const jL = (await rL.json()) as Record<string, unknown>;
    const jD = (await rD.json()) as Record<string, unknown>;
    // 2026-11-17: export.csv だけが ?include=erc8004_agent を受ける（ERC-8004 段階 B・既定の列は不変）。
    // 未知の引数の誤りで返す allowed は、export が delivery の一覧に include を足した物であること。それ以外は同じ。
    if (Array.isArray(jL.allowed) && Array.isArray(jD.allowed)) {
      assert.deepEqual(jL.allowed, [...(jD.allowed as unknown[]), "include"], search);
      assert.deepEqual({ ...jD, allowed: null }, { ...jL, allowed: null }, search);
    } else {
      assert.deepEqual(jD, jL);
    }
  }
}

test("既定と同じ days の扱い", async () => {
  const savedDb = process.env.DATABASE_URL;
  const savedProxy = process.env.PROXY_HEADER_SOURCE;
  delete process.env.DATABASE_URL;
  process.env.PROXY_HEADER_SOURCE = "generic";
  let n = 200;
  try {
    const cases = [
      "",
      "?days=365",
      "?days=0",
      "?days=400",
      "?days=007",
      "?days=abc",
      "?days=90.5",
      "?days=1e2",
      "?cb=1",
      "?days=1&days=2",
    ];
    for (const search of cases) {
      n++;
      await compareDaysPaths(search, `203.0.113.${n}`);
    }
    const ledger = await import("@/app/api/v1/observatory/export.csv/route");
    const delivery = await import("@/app/api/v1/observatory/delivery.csv/route");
    for (const search of ["", "?days=365"]) {
      n++;
      const ip = `203.0.113.${n}`;
      const rL = await ledger.GET(
        new NextRequest(`https://vet402.com/api/v1/observatory/export.csv${search}`, { headers: { "x-forwarded-for": ip } }),
      );
      const rD = await delivery.GET(
        new NextRequest(`https://vet402.com/api/v1/observatory/delivery.csv${search}`, { headers: { "x-forwarded-for": ip } }),
      );
      assert.equal(rL.status, 503);
      assert.equal(rD.status, 503);
      assert.deepEqual(await rL.json(), { error: "observatory_unavailable" });
      assert.deepEqual(await rD.json(), { error: "observatory_unavailable" });
    }
  } finally {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
    else process.env.PROXY_HEADER_SOURCE = savedProxy;
  }
});

test("鍵なしで読める", () => {
  const route = read("src/app/api/v1/observatory/delivery.csv/route.ts");
  assert.equal(/authorization|api[_-]?key|bearer/i.test(route), false);
  const openapi = read("docs/openapi.yaml");
  const start = openapi.indexOf("operationId: exportObservatoryDeliveryCsv");
  assert.ok(start >= 0);
  const slice = openapi.slice(start, start + 4000);
  assert.match(slice, /security: \[\]/);
  assert.match(slice, /text\/csv:/);
});

test("英語の決まり: DELIVERY_VALUE_DEFINITIONS と DELIVERY_CSV_COLUMN_NOTES", () => {
  for (const [k, v] of Object.entries(DELIVERY_VALUE_DEFINITIONS)) {
    assertAsciiNoBannedEnglish(v, `DELIVERY_VALUE_DEFINITIONS.${k}`);
  }
  assertAsciiNoBannedEnglish(DELIVERY_CSV_COLUMN_NOTES, "DELIVERY_CSV_COLUMN_NOTES");
});

test("英語の決まり: openapi・llms.txt・methodology・CHANGELOG の delivery.csv の新しい文", () => {
  const openapi = read("docs/openapi.yaml");
  const oStart = openapi.indexOf("  /api/v1/observatory/delivery.csv:");
  const oEnd = openapi.indexOf("  /api/v1/observatory/l0/export.csv:", oStart);
  assert.ok(oStart >= 0 && oEnd > oStart, "openapi の delivery.csv の節");
  assertAsciiNoBannedEnglish(openapi.slice(oStart, oEnd), "openapi delivery.csv");

  const llms = (read("public/llms-full-prose.txt") + "\n" + read("public/llms.txt"));
  const llmsLines = llms.split("\n").filter((l) => l.includes("/api/v1/observatory/delivery.csv"));
  assert.ok(llmsLines.length >= 2, "llms.txt の API 行と Freshness 行");
  for (const l of llmsLines.filter((x) => x.startsWith("- `GET /api/v1/observatory/delivery.csv") || x.includes("delivery.csv`:"))) {
    assertAsciiNoBannedEnglish(l, "llms.txt delivery.csv");
  }

  const page = read("src/app/observatory/methodology/page.tsx");
  const mStart = page.indexOf('id="delivery-values"');
  const mEnd = page.indexOf("What changed on 2026-08-23", mStart);
  assert.ok(mStart >= 0 && mEnd > mStart, "methodology の delivery-values 節");
  // JSX の式（{" "} や .map の矢印関数）を除いた文だけを見る。
  const prose = page.slice(mStart, mEnd).replace(/\{[^{}]*\}/g, " ").replace(/<[^>]+>/g, " ");
  assertAsciiNoBannedEnglish(prose, "methodology delivery-values");

  const changelog = read("docs/handoffs/CHANGELOG.md");
  const cStart = changelog.indexOf("## 2026-11-15 delivery.csv");
  const cEnd = changelog.indexOf("\n## ", cStart + 5);
  assert.ok(cStart >= 0 && cEnd > cStart, "CHANGELOG の節");
  assertAsciiNoBannedEnglish(changelog.slice(cStart, cEnd), "CHANGELOG delivery.csv");
});

test("DELIVERY_VALUES_SOURCE_NOTE が methodology のソースに使われている", () => {
  const page = read("src/app/observatory/methodology/page.tsx");
  assert.ok(page.includes("DELIVERY_VALUES_SOURCE_NOTE"));
  assert.ok(page.includes('id="delivery-values"'));
});

test("DELIVERY_CSV_COLUMNS の順は delivery-export の正典", () => {
  assert.deepEqual(
    DELIVERY_CSV_COLUMNS,
    [
      "purchase_id",
      "attempted_at",
      "latency_ms",
      "observed_at",
      "resource_key",
      "network",
      "delivery",
      "delivery_reason",
      "http_status_paid",
      "body_bytes",
      "payload_non_empty",
      "held_reason",
      "tx_hash",
      "buyer",
      "payer",
    ],
  );
});