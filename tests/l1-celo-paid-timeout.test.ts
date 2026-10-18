// ============================================================
// Celo の支払い付き要求だけ 45 秒（2026-10-18）。
// 無払いの要求と、ほかのチェーンの支払い付き要求は 20 秒のまま。
// Run: npx tsx --test tests/l1-celo-paid-timeout.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CELO_CAIP2 } from "@/lib/observatory/x402-payer";
import {
  L1_CELO_NETWORK,
  L1_CELO_PAID_TIMEOUT_MS,
  L1_CELO_PAID_TIMEOUT_SINCE,
  L1_REQUEST_TIMEOUT_MS,
  l1PaidTimeoutMs,
} from "@/lib/observatory/l1-timing";
import {
  L1_BATCH_BUDGET_MS,
  L1_PURCHASE_SLACK_MS,
  canStartAnotherPurchase,
  paidTimeoutForBudget,
  worstCasePurchaseMs,
} from "@/lib/observatory/l1-runner";

test("支払い付きの待ちは Celo だけ 45 秒。ほかは 20 秒。近傍の network は広げない", () => {
  assert.equal(L1_CELO_NETWORK, CELO_CAIP2);
  assert.equal(L1_CELO_PAID_TIMEOUT_MS, 45_000);
  assert.equal(L1_REQUEST_TIMEOUT_MS, 20_000);
  assert.equal(l1PaidTimeoutMs("eip155:42220"), 45_000);
  assert.equal(l1PaidTimeoutMs("eip155:8453"), 20_000);
  assert.equal(l1PaidTimeoutMs("eip155:5042"), 20_000);
  assert.equal(l1PaidTimeoutMs("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), 20_000);
  assert.equal(l1PaidTimeoutMs("eip155:42221"), 20_000);
  assert.equal(l1PaidTimeoutMs("eip155:42220 "), 20_000);
  assert.equal(l1PaidTimeoutMs(null), 20_000);
  assert.equal(l1PaidTimeoutMs("eip155:42220", { timeoutMs: 20_000, celoPaidTimeoutMs: 45_000 }), 45_000);
  assert.equal(l1PaidTimeoutMs("eip155:8453", { timeoutMs: 20_000, celoPaidTimeoutMs: 45_000 }), 20_000);
  // 差し込み口は Celo の上書きと、ほかのチェーンの timeoutMs を別々に持つ。
  assert.equal(l1PaidTimeoutMs("eip155:42220", { timeoutMs: 30, celoPaidTimeoutMs: 80 }), 80);
  assert.equal(l1PaidTimeoutMs("eip155:8453", { timeoutMs: 30, celoPaidTimeoutMs: 80 }), 30);
});

test("予算: Celo レーンは支払い付き 45 秒を見込み、バッチ予算との和は maxDuration 300 秒の内側", () => {
  const basePaid = paidTimeoutForBudget({ network: "eip155:8453", laneChain: null }, L1_REQUEST_TIMEOUT_MS);
  const celoPaid = paidTimeoutForBudget({ network: "eip155:8453", laneChain: "celo" }, L1_REQUEST_TIMEOUT_MS);
  const celoPrimary = paidTimeoutForBudget({ network: "eip155:42220", laneChain: null }, L1_REQUEST_TIMEOUT_MS);
  assert.equal(basePaid, 20_000);
  assert.equal(celoPaid, 45_000);
  assert.equal(celoPrimary, 45_000);
  const baseWorst = worstCasePurchaseMs(L1_REQUEST_TIMEOUT_MS, basePaid);
  const celoWorst = worstCasePurchaseMs(L1_REQUEST_TIMEOUT_MS, celoPaid);
  assert.equal(baseWorst, 60_000);
  assert.equal(celoWorst, 20_000 + 45_000 + L1_PURCHASE_SLACK_MS);
  assert.equal(canStartAnotherPurchase(celoWorst, L1_REQUEST_TIMEOUT_MS, celoPaid), true);
  assert.equal(canStartAnotherPurchase(celoWorst - 1, L1_REQUEST_TIMEOUT_MS, celoPaid), false);
  // 無払い 20 秒のままなので 45 秒を 2 本にはしない。210 + 85 = 295 <= 300。
  assert.ok(L1_BATCH_BUDGET_MS + celoWorst <= 300_000);
  assert.ok(L1_BATCH_BUDGET_MS + baseWorst <= 300_000);
});

test("方法論の since は l1-timing の定数。頁に日付のリテラルを書かない", () => {
  assert.equal(L1_CELO_PAID_TIMEOUT_SINCE, "2026-10-19");
  const page = readFileSync(join(process.cwd(), "src/app/observatory/methodology/page.tsx"), "utf8");
  assert.match(page, /L1_CELO_PAID_TIMEOUT_SINCE/);
  assert.equal(page.includes("since 2026-10-18"), false);
  assert.equal(page.includes("2026-10-19"), false);
  const timing = readFileSync(join(process.cwd(), "src/lib/observatory/l1-timing.ts"), "utf8");
  assert.match(timing, /L1_CELO_PAID_TIMEOUT_SINCE = "2026-10-19"/);
});
