// ============================================================
// demo/verify の日次デモ予算の精算（2026-11-02 独立レビュー）。
// 返すのは「資金が動かなかったとき」に 1 回だけ。読み直しで投げても二重に返さない。
// 資金が動いた後に投げても返さない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDemoPurchaseWithBudget } from "@/lib/demo/l1-budget";

function harness(spent: string, opts: { readThrows?: boolean; runThrows?: boolean } = {}) {
  const log: string[] = [];
  return {
    log,
    deps: {
      run: async () => {
        log.push("run");
        if (opts.runThrows) throw new Error("batch");
        return { spentUnitsTotal: spent };
      },
      readPurchases: async () => {
        log.push("read");
        if (opts.readThrows) throw new Error("read");
        return ["row"];
      },
      refundBudget: async () => {
        log.push("refund");
      },
    },
  };
}

test("資金が動かなければ 1 回返す", async () => {
  const h = harness("0");
  const out = await runDemoPurchaseWithBudget(h.deps);
  assert.deepEqual(h.log, ["run", "refund", "read"]);
  assert.deepEqual(out.purchases, ["row"]);
  assert.equal(out.summary.spentUnitsTotal, "0");
});

test("spentUnitsTotal が空でも資金は動いていない扱いで 1 回返す", async () => {
  const h = harness("");
  await runDemoPurchaseWithBudget(h.deps);
  assert.deepEqual(h.log, ["run", "refund", "read"]);
});

test("資金が動けば返さない", async () => {
  const h = harness("1000");
  await runDemoPurchaseWithBudget(h.deps);
  assert.deepEqual(h.log, ["run", "read"]);
});

test("spent=0 の返金の後に読み直しが投げても二重に返さない", async () => {
  const h = harness("0", { readThrows: true });
  await assert.rejects(runDemoPurchaseWithBudget(h.deps), /read/);
  assert.deepEqual(h.log, ["run", "refund", "read"]);
});

test("spent>0 の購入の後に読み直しが投げても返さない", async () => {
  const h = harness("1000", { readThrows: true });
  await assert.rejects(runDemoPurchaseWithBudget(h.deps), /read/);
  assert.deepEqual(h.log, ["run", "read"]);
});

test("バッチが投げたら 1 回返す", async () => {
  const h = harness("0", { runThrows: true });
  await assert.rejects(runDemoPurchaseWithBudget(h.deps), /batch/);
  assert.deepEqual(h.log, ["run", "refund"]);
});

test("ルートはこの部品で精算し、catch で自分では返さない", () => {
  const src = readFileSync("src/app/api/v1/demo/verify/route.ts", "utf8");
  assert.match(src, /runDemoPurchaseWithBudget\(\{/);
  const tail = src.slice(src.indexOf("runDemoPurchaseWithBudget({"), src.indexOf("await lease.release()"));
  assert.equal(tail.match(/refundIpRateLimit\(/g)?.length, 1, "渡す refundBudget の 1 か所だけ");
});
