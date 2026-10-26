// 判定のチェーン集計と、公開文の声。DB は使わない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "@/lib/claims/extract";
import {
  monthlyUsageErrorMessage,
  parseMonthlyUsageQuery,
  usageChainOf,
  USAGE_MONTHLY_CHAIN_INVALID_MESSAGE,
  USAGE_MONTHLY_CHAIN_MESSAGE,
  USAGE_MONTHLY_EMPTY_MESSAGE,
  USAGE_MONTHLY_MONTH_INVALID_MESSAGE,
  USAGE_MONTHLY_MONTH_MESSAGE,
  USAGE_MONTHLY_UNAVAILABLE_MESSAGE,
} from "@/lib/api/decision-usage";

const PUBLIC_FILES = ["src/app/usage/monthly/page.tsx", "src/app/api/v1/usage/monthly/route.ts"];

function publicProse(src: string): string {
  const stripped = stripComments(src);
  const parts: string[] = [];
  for (const match of stripped.matchAll(/"((?:[^"\\]|\\.)*)"/g)) parts.push(match[1]);
  for (const line of stripped.split("\n")) {
    const text = line.replace(/\{[^}]*\}/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!text || !/[A-Za-z]/.test(text)) continue;
    if (/[;={}]/.test(text) || text.includes("=>") || text.includes("&&")) continue;
    if (/^(import |export |const |let |function |return |if |for |await )/.test(text)) continue;
    parts.push(text);
  }
  return parts.join("\n");
}

test("usageChainOf は CAIP-2 を残し、空は空文字、長さだけ切る", () => {
  assert.equal(usageChainOf(null), "");
  assert.equal(usageChainOf(""), "");
  assert.equal(usageChainOf("base"), "eip155:8453");
  assert.equal(usageChainOf("eip155:42220"), "eip155:42220");
  const algorand = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
  assert.equal(usageChainOf(algorand), algorand);
  const long = `eip155:${"a".repeat(300)}`;
  assert.equal(usageChainOf(long).length, 200);
  assert.ok(usageChainOf(long).startsWith("eip155:"));
});

test("月次クエリは UTC の月と CAIP-2 を受け、壊れた値は分ける", () => {
  const ok = parseMonthlyUsageQuery("eip155:42220", "2026-10");
  assert.deepEqual(ok, { ok: true, chain: "eip155:42220", month: "2026-10", start: "2026-10-01", end: "2026-11-01" });
  const slug = parseMonthlyUsageQuery("base", "2026-12");
  assert.equal(slug.ok && slug.chain, "eip155:8453");
  assert.equal(slug.ok && slug.end, "2027-01-01");
  assert.equal(parseMonthlyUsageQuery(null, "2026-10").ok, false);
  assert.equal(parseMonthlyUsageQuery("eip155:42220", null).ok, false);
  assert.equal(parseMonthlyUsageQuery("eip155:42220", "2026-13").ok, false);
  assert.equal(parseMonthlyUsageQuery("eip155 42220", "2026-10").ok, false);
  assert.equal(monthlyUsageErrorMessage("chain_required"), USAGE_MONTHLY_CHAIN_MESSAGE);
  assert.equal(monthlyUsageErrorMessage("month_invalid"), USAGE_MONTHLY_MONTH_INVALID_MESSAGE);
});

test("公開の月次ページと JSON の文に、禁じ手の言い回しが無い", () => {
  const messages = [
    USAGE_MONTHLY_CHAIN_MESSAGE,
    USAGE_MONTHLY_CHAIN_INVALID_MESSAGE,
    USAGE_MONTHLY_MONTH_MESSAGE,
    USAGE_MONTHLY_MONTH_INVALID_MESSAGE,
    USAGE_MONTHLY_EMPTY_MESSAGE,
    USAGE_MONTHLY_UNAVAILABLE_MESSAGE,
  ].join("\n");
  const prose = `${messages}\n${PUBLIC_FILES.map((file) => publicProse(readFileSync(file, "utf8"))).join("\n")}`;
  assert.doesNotMatch(prose, /\b(we|our|us)\b/i);
  assert.doesNotMatch(prose, /;/);
  assert.doesNotMatch(prose, /—|–|--/);
  assert.doesNotMatch(prose, /\bKite\b|\bBlockRun\b/i);
  assert.doesNotMatch(prose, /, not\b/);
  assert.doesNotMatch(prose, /\b(daily|every|all|always|never|only)\b/i);
  assert.doesNotMatch(prose, /100\s*%/);
});
