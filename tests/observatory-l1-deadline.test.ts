// ============================================================
// vet402 Observatory L1 — バッチ全体のデッドライン（2026-08-22 監査）。
//
// 守りたい性質は1つ:「**署名済み・予約済みの購入が、記帳される前に
// maxDuration で殺されない**」。runL1Batch は limit=100 を逐次処理するので、
// 1件ずつのタイムアウトだけでは全体を縛れない（20s × 100件 = 2000s）。
// ここでは判定を担う純関数と、予算とルートの maxDuration の関係を固定する。
// Run: npx tsx --test tests/observatory-l1-deadline.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  L1_BATCH_BUDGET_MS,
  L1_PURCHASE_SLACK_MS,
  canStartAnotherPurchase,
  paidTimeoutForBudget,
  worstCasePurchaseMs,
} from "@/lib/observatory/l1-runner";
import { L1_CELO_PAID_TIMEOUT_MS, L1_REQUEST_TIMEOUT_MS } from "@/lib/observatory/l1-timing";

test("1件の最悪ケース = HTTP2本 + 署名/DB/RPC の余裕", () => {
  assert.equal(worstCasePurchaseMs(20_000), 20_000 * 2 + L1_PURCHASE_SLACK_MS);
  assert.equal(worstCasePurchaseMs(0), L1_PURCHASE_SLACK_MS);
});

test("残り時間が1件の最悪ケースを下回ったら新しい購入を始めない", () => {
  const worst = worstCasePurchaseMs(20_000);
  assert.equal(canStartAnotherPurchase(worst, 20_000), true);
  assert.equal(canStartAnotherPurchase(worst - 1, 20_000), false);
  assert.equal(canStartAnotherPurchase(0, 20_000), false);
  // 無制限（createDeadline(undefined) の remaining）は常に開始可。
  assert.equal(canStartAnotherPurchase(Infinity, 20_000), true);
});

test("予算 + 1件の最悪ケース は cron ルートの maxDuration の内側", () => {
  // ルート宣言を実ファイルから読む——定数を片方だけ動かしたら落ちる。
  // vercel.json はこの cron の maxDuration を持たない。上限はルートの export。
  const route = readFileSync(join(process.cwd(), "src/app/api/cron/l1-purchase/route.ts"), "utf8");
  const declared = /export const maxDuration = (\d+)/.exec(route);
  assert.ok(declared, "maxDuration の宣言が読み取れない");
  const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
    functions?: Record<string, { maxDuration?: number }>;
  };
  const fromVercel = Object.values(vercel.functions ?? {})
    .map((fn) => fn.maxDuration)
    .filter((n): n is number => typeof n === "number");
  const maxDurationSec = fromVercel.length > 0 ? Math.min(Number(declared[1]), ...fromVercel) : Number(declared[1]);
  const maxDurationMs = maxDurationSec * 1_000;
  const baseWorst = worstCasePurchaseMs(20_000);
  assert.ok(
    L1_BATCH_BUDGET_MS + baseWorst <= maxDurationMs,
    `budget(${L1_BATCH_BUDGET_MS}) + worst(${baseWorst}) > maxDuration(${maxDurationMs})`,
  );
  // Celo の候補は支払い付き 45 秒。無払いは 20 秒のままなので 85 秒。210 + 85 = 295 <= 300。
  const celoPaid = paidTimeoutForBudget(
    { network: "eip155:42220", laneChain: "celo" },
    L1_REQUEST_TIMEOUT_MS,
    L1_CELO_PAID_TIMEOUT_MS,
  );
  assert.equal(celoPaid, L1_CELO_PAID_TIMEOUT_MS);
  const celoWorst = worstCasePurchaseMs(L1_REQUEST_TIMEOUT_MS, celoPaid);
  assert.equal(celoWorst, L1_REQUEST_TIMEOUT_MS + L1_CELO_PAID_TIMEOUT_MS + L1_PURCHASE_SLACK_MS);
  assert.ok(
    L1_BATCH_BUDGET_MS + celoWorst <= maxDurationMs,
    `budget(${L1_BATCH_BUDGET_MS}) + celoWorst(${celoWorst}) > maxDuration(${maxDurationMs})`,
  );
});

test("Celo レーンの候補だけ、予算は支払い付きの大きい方を見込む", () => {
  assert.equal(paidTimeoutForBudget({ network: "eip155:8453", laneChain: null }, 20_000, 45_000), 20_000);
  assert.equal(paidTimeoutForBudget({ network: "eip155:8453", laneChain: "base" }, 20_000, 45_000), 20_000);
  assert.equal(paidTimeoutForBudget({ network: "eip155:8453", laneChain: "celo" }, 20_000, 45_000), 45_000);
  assert.equal(paidTimeoutForBudget({ network: "eip155:42220", laneChain: null }, 20_000, 45_000), 45_000);
  // 無払いの timeoutMs の方が長いときは、そちらを下回らない（大きい方）。
  assert.equal(paidTimeoutForBudget({ network: "eip155:42220", laneChain: "celo" }, 60_000, 45_000), 60_000);
  const celoWorst = worstCasePurchaseMs(20_000, 45_000);
  assert.equal(canStartAnotherPurchase(celoWorst, 20_000, 45_000), true);
  assert.equal(canStartAnotherPurchase(celoWorst - 1, 20_000, 45_000), false);
  // 2 引数のままなら Base の最悪（60 秒）で、Celo の 45 秒は混ざらない。
  assert.equal(canStartAnotherPurchase(worstCasePurchaseMs(20_000), 20_000), true);
  assert.equal(canStartAnotherPurchase(worstCasePurchaseMs(20_000) - 1, 20_000), false);
});
