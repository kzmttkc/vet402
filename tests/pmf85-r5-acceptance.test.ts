// PMF85 r5: /connect keyless paths, /status 7-day roll-up and Cause column, /legal/notice dates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforePaySnippets } from "@/lib/find/snippets";
import {
  CONNECT_KEYLESS_CHECK_CURL,
  CONNECT_KEYLESS_SDK,
  CONNECT_MCP,
  CONNECT_PASTE_HREF,
  CONNECT_CHOICES,
} from "@/lib/connect/snippets";
import {
  publicCausesFromSnapshotDetail,
  rollupSevenDaySamples,
  sevenUtcDaysEndingYesterday,
  summarizeByDay,
} from "@/lib/health/snapshot";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// connect/snippets.ts does not export SAMPLE_URL — use the memo snippets anchor URL instead.
const DEMO_URL = "https://llm.gedx402.com/v1/chat/code";

test("B: /connect leads with three keyless paths and MCP after them", () => {
  const page = read("src/app/connect/page.tsx");
  assert.match(page, /Three ways that work without a key today/);
  assert.match(page, /CONNECT_KEYLESS_CHECK_CURL/);
  assert.match(page, /CONNECT_PASTE_HREF/);
  assert.match(page, /CONNECT_KEYLESS_SDK/);
  assert.match(page, /CONNECT_MCP/);
  const keylessPos = page.indexOf("connect-keyless-heading");
  const mcpPos = page.indexOf("connect-mcp-heading");
  const chooserPos = page.indexOf("<ConnectChooser");
  assert.ok(keylessPos > 0 && mcpPos > keylessPos && chooserPos > mcpPos, "keyless → MCP → chooser");
  const memo = beforePaySnippets(DEMO_URL);
  assert.equal(CONNECT_KEYLESS_CHECK_CURL, memo.find((s) => s.id === "curl")!.code);
  assert.equal(CONNECT_KEYLESS_SDK, memo.find((s) => s.id === "ts")!.code);
  assert.equal(CONNECT_PASTE_HREF, "https://vet402.com/#lp-paste-url");
  const buyStacks = CONNECT_CHOICES.find((c) => c.id === "buy")!.stacks.map((s) => s.stack);
  assert.deepEqual(buyStacks, ["curl", "TypeScript", "Python", "No-code"]);
  assert.ok(CONNECT_MCP.code.includes("https://vet402.com/mcp"));
});

test("F: public cause labels map detail tokens and never echo raw detail", () => {
  const cases: [string, string[]][] = [
    [
      "scoring=degraded fresh: feedback_stats_unavailable(index_absent); payee=ok cached",
      ["score input slow (feedback)"],
    ],
    [
      "scoring=degraded fresh: wallet_metrics_unavailable(upstream_error:Error); payee=ok cached",
      ["score input slow (wallet)"],
    ],
    [
      "scoring=degraded fresh: sybil_checks_unavailable(deadline:sybil); payee=ok cached",
      ["score input slow (sybil)"],
    ],
    ["scoring=ok cached; payee=error fresh: deadline:payee_probe", ["payee lookup slow"]],
    ["scoring=error fresh: engine_down", ["other"]],
  ];
  for (const [detail, labels] of cases) {
    assert.deepEqual(publicCausesFromSnapshotDetail(detail), labels, detail);
    for (const label of labels) {
      assert.ok(!label.includes("_unavailable"), label);
    }
    assert.doesNotMatch(detail, new RegExp(labels.join("|")));
  }
});

test("F: seven-day roll-up matches the daily table sums for the same UTC window", () => {
  const now = new Date("2026-11-16T15:00:00Z");
  const window = sevenUtcDaysEndingYesterday(now);
  assert.deepEqual(window, [
    "2026-11-09",
    "2026-11-10",
    "2026-11-11",
    "2026-11-12",
    "2026-11-13",
    "2026-11-14",
    "2026-11-15",
  ]);
  const rows = [
    { checkedAt: new Date("2026-11-14T10:00:00Z"), status: "degraded", detail: "scoring=degraded fresh: feedback_stats_unavailable(x); payee=ok cached" },
    { checkedAt: new Date("2026-11-14T11:00:00Z"), status: "ok" },
    { checkedAt: new Date("2026-11-15T08:00:00Z"), status: "error" },
    { checkedAt: new Date("2026-11-16T01:00:00Z"), status: "ok" },
  ];
  const days = summarizeByDay(rows);
  const roll = rollupSevenDaySamples(days, window);
  let total = 0;
  let degraded = 0;
  let error = 0;
  for (const d of days) {
    if (!window.includes(d.date)) continue;
    total += d.total;
    degraded += d.degraded;
    error += d.error;
  }
  assert.deepEqual(roll, { total, degraded, error });
  assert.equal(roll.degraded, 1);
  assert.equal(roll.error, 1);
  const day = days.find((d) => d.date === "2026-11-14")!;
  assert.deepEqual(day!.causes, ["score input slow (feedback)"]);
  const status = read("src/app/status/page.tsx");
  assert.match(status, /Last 7 days:/);
  assert.match(status, /rollupSevenDaySamples/);
  assert.match(status, />Cause</);
});

test("G: /legal/notice revision and last updated use LEGAL_NOTICE_DISPLAY", async () => {
  const { LEGAL_NOTICE_DISPLAY } = await import("@/lib/legal/document-dates");
  const notice = read("src/app/legal/notice/page.tsx");
  assert.match(notice, /LEGAL_NOTICE_DISPLAY/);
  assert.match(notice, new RegExp(`Last updated: \\{LEGAL_NOTICE_DISPLAY\\}`));
  assert.doesNotMatch(notice, /Last updated: November 8, 2026/);
  assert.equal(LEGAL_NOTICE_DISPLAY, "November 28, 2026");
});