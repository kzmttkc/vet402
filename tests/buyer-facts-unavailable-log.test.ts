// ============================================================
// role=payee の入力が読めなかったとき、判定は fail-closed のまま、理由をサーバログへ残す（2026-11-02・監査 H3）。
// catch が理由を捨てていたので、Base の payer が全部 erc8004_unavailable（BLOCK）でも本番で原因が読めなかった。
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";
import { loadBuyerFacts } from "@/lib/decision/buyer-facts";
import { decidePayee } from "@/lib/decision/rules";
import { logServerErrorChainSafe } from "@/lib/util/log-safe";

after(() => __setDbForTests(null));

const PAYER = "eip155:8453:0x00000000000000000000000000000000000000b7";

test("索引が読めない → erc8004 と funder_index が unavailable・BLOCK・ログに原因の鎖が出る", async (t) => {
  // 集計の execute は通し、funder と索引の読みだけ失敗させる。
  const fake = {
    execute: async (q: unknown) => {
      const text = JSON.stringify(q);
      if (text.includes("funder_wallets")) throw new Error("funder read failed https://rpc.example/v2/SECRETKEY");
      return { rows: [] };
    },
    select: () => {
      throw new Error("index read failed https://rpc.example/v2/SECRETKEY");
    },
  };
  __setDbForTests(fake);
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args.map(String).join(" ")));

  const f = await loadBuyerFacts(PAYER);
  assert.deepEqual(f.sybil.unavailable, ["funder_index", "erc8004"]);
  const d = decidePayee(f, { now: new Date() });
  assert.equal(d.recommendation, "BLOCK");
  assert.ok(d.reason_codes.includes("erc8004_unavailable"));

  const text = logged.join("\n");
  assert.match(text, /decision\.buyer_facts\.erc8004/);
  assert.match(text, /agent_resolve_unavailable \| cause: index read failed/);
  assert.match(text, /decision\.buyer_facts\.funder_index/);
  assert.doesNotMatch(text, /SECRETKEY/, "URL の鍵を出さない");
});

test("logServerErrorChainSafe: 鎖を段ごとに伏せてつなぐ・循環で止まる・同じ文を繰り返さない", (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  const root = new Error("deadline_exceeded:getLogsChunked:3000ms");
  const loop = new Error("agent_resolve_unavailable", { cause: root });
  (root as Error & { cause?: unknown }).cause = loop;
  logServerErrorChainSafe("ctx", loop);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /agent_resolve_unavailable \| cause: deadline_exceeded:getLogsChunked:3000ms/);
  assert.equal(logged[0]!.match(/agent_resolve_unavailable/g)?.length, 1);
});
