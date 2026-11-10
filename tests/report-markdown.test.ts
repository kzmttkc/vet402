import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseReportMarkdown,
  reportDocumentText,
  reportInlineText,
  type ReportInline,
} from "@/lib/reports/markdown";

const REPORT_MD = readFileSync(
  join(process.cwd(), "content", "reports", "state-of-x402-2026-11.md"),
  "utf8",
);

test("parses the November 2026 report title and sections", () => {
  const doc = parseReportMarkdown(REPORT_MD);
  assert.equal(doc.title, "State of x402: November 2026");
  assert.deepEqual(
    doc.sections.map((s) => s.heading),
    [
      "Headline numbers",
      "By chain",
      "Why calls did not complete",
      "What sellers can do",
      "What agent builders can do",
      "Method",
    ],
  );
  assert.equal(doc.preamble.length, 2);
  assert.equal(doc.preamble[1]?.kind, "paragraph");
});

test("parses tables, bullets, bold, code, and bare URLs", () => {
  const sample = `# Title

Intro **bold** with \`code\` and https://vet402.com/x402.

## One

| A | B |
| --- | --- |
| 1 | 2 |

- first
- second with https://example.com/path

`;
  const doc = parseReportMarkdown(sample);
  const para = doc.preamble[0];
  assert.equal(para?.kind, "paragraph");
  if (para?.kind !== "paragraph") return;
  const kinds = para.inlines.map((n) => n.kind);
  // 文末の "." はリンクの外のテキスト（2026-11-10）。
  assert.deepEqual(kinds, ["text", "bold", "text", "code", "text", "link", "text"]);
  const method = doc.sections.find((s) => s.heading === "One");
  assert.equal(method?.blocks[0]?.kind, "table");
  assert.equal(method?.blocks[1]?.kind, "list");
});

test("throws on unsupported markdown", () => {
  assert.throws(() => parseReportMarkdown("# T\n\n### deep\n"), /Unsupported markdown/);
  assert.throws(() => parseReportMarkdown("# T\n\n[label](https://x.com)\n"), /reference link/);
  assert.throws(() => parseReportMarkdown("# T\n\n```\ncode\n```\n"), /fenced code/);
});

test("reportInlineText round-trips links as URL text", () => {
  const nodes: ReportInline[] = [
    { kind: "text", value: "See " },
    { kind: "link", href: "https://vet402.com/x402" },
  ];
  assert.equal(nodes.map(reportInlineText).join(""), "See https://vet402.com/x402");
});

test("full report document text includes headline rate", () => {
  const text = reportDocumentText(parseReportMarkdown(REPORT_MD));
  assert.ok(text.includes("87.9 percent"));
  assert.ok(text.includes("l1Rates.deliveredOfFinalOutcomePct"));
});


test("a URL at the end of a sentence does not swallow the period", async () => {
  const { parseReportMarkdown } = await import("../src/lib/reports/markdown");
  const tree = JSON.stringify(parseReportMarkdown("# T\n\nFull state: https://vet402.com/api/v1/observatory/state. CSV export: https://vet402.com/a.csv. Data.\n"));
  assert.ok(tree.includes('"href":"https://vet402.com/api/v1/observatory/state"'), tree);
  assert.ok(tree.includes('"href":"https://vet402.com/a.csv"'), tree);
  assert.ok(!tree.includes('state."'), tree);
});
