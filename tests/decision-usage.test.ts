// 判定のチェーン集計と、公開文の声。DB は使わない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stripComments } from "@/lib/claims/extract";
import {
  monthlyUsageErrorMessage,
  parseMonthlyUsageQuery,
  PUBLIC_USAGE_CHAINS,
  usageChainOf,
  USAGE_MONTHLY_CHAIN_INVALID_MESSAGE,
  USAGE_MONTHLY_CHAIN_MESSAGE,
  USAGE_MONTHLY_CHAIN_UNLISTED_MESSAGE,
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

test("usageChainOf は CAIP-2 を残し、celo を eip155:42220 に寄せ、空は空文字、長さだけ切る", () => {
  assert.equal(usageChainOf(null), "");
  assert.equal(usageChainOf(""), "");
  assert.equal(usageChainOf("   "), "");
  assert.equal(usageChainOf("base"), "eip155:8453");
  assert.equal(usageChainOf("celo"), "eip155:42220");
  assert.equal(usageChainOf("Celo"), "eip155:42220");
  assert.equal(usageChainOf("eip155:42220"), "eip155:42220");
  const algorand = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
  assert.equal(usageChainOf(algorand), algorand);
  const long = `eip155:${"a".repeat(300)}`;
  assert.equal(usageChainOf(long).length, 200);
  assert.ok(usageChainOf(long).startsWith("eip155:"));
});

test("月次クエリは公開一覧のチェーンと UTC の月を受け、一覧の外は 400 の理由に分ける", () => {
  const ok = parseMonthlyUsageQuery("eip155:42220", "2026-10");
  assert.deepEqual(ok, { ok: true, chain: "eip155:42220", month: "2026-10", start: "2026-10-01", end: "2026-11-01" });
  const celo = parseMonthlyUsageQuery("celo", "2026-12");
  assert.equal(celo.ok && celo.chain, "eip155:42220");
  assert.equal(celo.ok && celo.end, "2027-01-01");
  const base = parseMonthlyUsageQuery("base", "2026-12");
  assert.equal(base.ok, false);
  if (!base.ok) assert.equal(base.error, "chain_unlisted");
  const other = parseMonthlyUsageQuery("eip155:8453", "2026-10");
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.error, "chain_unlisted");
  assert.equal(parseMonthlyUsageQuery(null, "2026-10").ok, false);
  assert.equal(parseMonthlyUsageQuery("eip155:42220", null).ok, false);
  assert.equal(parseMonthlyUsageQuery("eip155:42220", "2026-13").ok, false);
  assert.equal(parseMonthlyUsageQuery("eip155 42220", "2026-10").ok, false);
  assert.equal(monthlyUsageErrorMessage("chain_required"), USAGE_MONTHLY_CHAIN_MESSAGE);
  assert.equal(monthlyUsageErrorMessage("chain_unlisted"), USAGE_MONTHLY_CHAIN_UNLISTED_MESSAGE);
  assert.equal(monthlyUsageErrorMessage("month_invalid"), USAGE_MONTHLY_MONTH_INVALID_MESSAGE);
  assert.deepEqual([...PUBLIC_USAGE_CHAINS], ["eip155:42220"]);
});

test("公開の月次ページと JSON の文に、禁じ手の言い回しが無い", () => {
  const messages = [
    USAGE_MONTHLY_CHAIN_MESSAGE,
    USAGE_MONTHLY_CHAIN_INVALID_MESSAGE,
    USAGE_MONTHLY_CHAIN_UNLISTED_MESSAGE,
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

test("本番 SQL は 1 本で足すだけ。client_usage_daily は変えない", () => {
  const sqlText = readFileSync("scripts/sql/2026-10-26-decision-usage-chain.sql", "utf8");
  assert.match(sqlText, /本番の vouch DB に、push の直前に流す/);
  assert.match(sqlText, /Safe to re-run/);
  assert.match(sqlText, /BEGIN;/);
  assert.match(sqlText, /SET LOCAL lock_timeout = '3s'/);
  assert.match(sqlText, /COMMIT;/);
  assert.match(sqlText, /CREATE TABLE IF NOT EXISTS decision_usage_daily/);
  assert.match(sqlText, /owner_relation/);
  assert.doesNotMatch(sqlText, /ALTER TABLE client_usage_daily/);
  assert.doesNotMatch(sqlText, /CONCURRENTLY/);
  assert.doesNotMatch(sqlText, /PRIMARY KEY USING INDEX/);
  assert.doesNotMatch(sqlText, /本番には流さない/);
  assert.equal(existsSync("scripts/sql/2026-10-26-decision-usage-chain-pk.sql"), false);
  const route = readFileSync("src/app/api/v1/resources/[resourceId]/decision/route.ts", "utf8");
  assert.match(route, /recordClientUsage\(request\.headers, "decision"\)/);
  assert.doesNotMatch(route, /recordClientUsage\([^)]*usageChainOf/);
});

test("公開の月次ページは noindex で、ポリシーは鍵なしを元の文に戻し、鍵ありの合計と削除を書く", () => {
  const page = readFileSync("src/app/usage/monthly/page.tsx", "utf8");
  const privacy = readFileSync("src/app/legal/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  assert.match(page, /noindex:\s*true/);
  assert.match(page, /Calls made without a key are not counted per chain/);
  assert.match(privacy, /made without an API key, a count per UTC day, client name and API route/);
  assert.match(privacy, /day, client name and API route, and holds nothing that identifies who made the calls/);
  assert.doesNotMatch(privacy, /API route and chain/);
  assert.doesNotMatch(privacy, /A resolve row stores an empty chain/);
  assert.doesNotMatch(privacy, /Decision answers made without a key stay/);
  assert.match(privacy, /Calls made without a key are not counted per chain, so this table does not list them/);
  assert.match(privacy, /A relation with fewer than 3 keys shows/);
  assert.match(privacy, /The table leaves out the key, the email address, and the name/);
  assert.match(
    privacy,
    /Deleting an account keeps the keyed decision counts as numbers and drops the link between those counts and the account/,
  );
  const added = [
    privacy.match(/<strong>Keyed decision counts<\/strong>[\s\S]*?<\/li>/)?.[0] ?? "",
    privacy.match(/<strong>Public monthly table<\/strong>[\s\S]*?<\/li>/)?.[0] ?? "",
    "Keyed decision counts are kept without an expiry date. Each row is a count for one key, one UTC day and one chain, and holds no email address and no name.",
  ].join("\n");
  assert.match(privacy, /Keyed decision counts are kept without an expiry date/);
  assert.doesNotMatch(added, /\b(we|our|us)\b/i);
  assert.doesNotMatch(added, /;/);
  assert.doesNotMatch(added, /—|–|--/);
  assert.doesNotMatch(added, /, not\b/);
  assert.doesNotMatch(privacy, /key-1/);
  assert.doesNotMatch(page, /key-1/);
  const openapi = readFileSync("docs/openapi.yaml", "utf8");
  for (const chain of PUBLIC_USAGE_CHAINS) assert.ok(openapi.includes(chain), chain);
  assert.match(openapi, /chain_unlisted/);
  assert.doesNotMatch(openapi, /keyless:/);
});
