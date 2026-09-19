// ============================================================
// 伏字の規則そのもの（2026-09-19 横断監査 W4 → 独立レビュー W-1）。
//
// 元は payer-funds.ts の中にあり、`https?://` だけを見ていた。レビューで 2 つ穴が出た:
//   - Solana の `Connection` は https の RPC URL から wss を内部生成し、エラー本文には
//     `wss://…/v2/<key>` の形で出る。postgres の接続文字列も同じ危険（DATABASE_URL）。
//   - DB へ書く側だけ伏せてサーバログは素通し、という組み合わせが l1-runner に 3 か所あった。
//     ログへ流すときの包み（redactedError）をここに置き、呼び手がそれを使う。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactForLog, redactUrls, redactedError } from "@/lib/observatory/redact";

test("redactUrls: https / http / wss / ws / postgres / postgresql を伏せる（長さは切らない）", () => {
  assert.equal(redactUrls("a https://x.example/v2/K b"), "a <url> b");
  assert.equal(redactUrls("a http://x.example/v2/K b"), "a <url> b");
  assert.equal(redactUrls("a wss://x.example/v2/K b"), "a <url> b");
  assert.equal(redactUrls("a ws://x.example/v2/K b"), "a <url> b");
  assert.equal(redactUrls("a postgres://user:pw@host/db b"), "a <url> b");
  assert.equal(redactUrls("a postgresql://user:pw@host/db b"), "a <url> b");
  assert.equal(redactUrls("x".repeat(400)).length, 400, "ログ用は切らない（切るのは redactForLog）");
});

test("redactForLog: 伏せたうえで 300 字に切る（台帳・summary 用）", () => {
  const out = redactForLog(new Error("solana: wss://api.example/v2/SECRETKEY failed"));
  assert.equal(out.includes("SECRETKEY"), false, out);
  assert.match(out, /wss を含めて伏せる|<url>/);
  assert.equal(redactForLog("x".repeat(400)).length, 300);
});

test("redactedError: logServerError へ渡す Error は本文が伏字（長さは保つ）", () => {
  const e = redactedError(new Error(`HTTP request failed. URL: https://tempo.example/v2/SECRETKEY. ${"d".repeat(400)}`));
  assert.ok(e instanceof Error);
  assert.equal(e.message.includes("SECRETKEY"), false, e.message);
  assert.ok(e.message.includes("<url>"));
  assert.ok(e.message.length > 300, "ログは 300 字で切らない（診断が消える）");
});
