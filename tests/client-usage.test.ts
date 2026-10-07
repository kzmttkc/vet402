// ============================================================
// client_usage_daily の記帳（2026-10-07）— DB を持ち込まない側。
//
//  1. User-Agent が `vet402-hermes/` で始まるときだけ数える。他の UA・UA 無しは何も予約しない
//  2. 保存する client は `vet402-hermes/<版>` か `vet402-hermes/other` だけ（UA の残り・長い版は捨てる）
//  3. DB が投げても（同期でも非同期でも）記帳は外へ投げない
// 本物の DB とルートを通す検査は tests/client-usage.pg.test.ts。
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";
import { setAfterResponseSchedulerForTest } from "@/lib/util/after-response";
import { HERMES_OTHER_VERSION, clientUsageLabel, recordClientUsage, upsertClientUsage } from "@/lib/api/client-usage";

afterEach(() => {
  setAfterResponseSchedulerForTest(null);
  __setDbForTests(null);
});

test("clientUsageLabel: vet402-hermes/ で始まる UA だけを数え、版だけを残す", () => {
  assert.equal(clientUsageLabel("vet402-hermes/0.1.0"), "vet402-hermes/0.1.0");
  assert.equal(clientUsageLabel("vet402-hermes/0.2.0 (+https://github.com/kzmttkc/vet402-hermes)"), "vet402-hermes/0.2.0");
  assert.equal(clientUsageLabel("vet402-hermes/1.0.0; python-httpx/0.27"), "vet402-hermes/1.0.0");
  // 版は数字 3 組の semver だけ。プレリリース・自由な文字列・4 桁は other
  assert.equal(clientUsageLabel("vet402-hermes/0.2.0-rc.1"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/abc"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/1000.0.0"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/0.1"), HERMES_OTHER_VERSION);
  // 版の形でないもの・長すぎる版は版の文字列を保存しない
  assert.equal(clientUsageLabel("vet402-hermes/"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/<script>"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/0.1.0?q=https://example.com/x"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel(`vet402-hermes/${"1".repeat(33)}`), HERMES_OTHER_VERSION);
  // 数えない
  assert.equal(clientUsageLabel(null), null);
  assert.equal(clientUsageLabel(""), null);
  assert.equal(clientUsageLabel("curl/8.7.1"), null);
  assert.equal(clientUsageLabel("Mozilla/5.0 vet402-hermes/0.1.0"), null);
  assert.equal(clientUsageLabel("VET402-HERMES/0.1.0"), null);
  assert.equal(clientUsageLabel("vet402-hermes-fork/0.1.0"), null);
});

test("recordClientUsage: 一致しない UA は応答後の処理を予約しない", () => {
  const tasks: Array<() => Promise<void>> = [];
  setAfterResponseSchedulerForTest((task) => tasks.push(task));
  recordClientUsage(new Headers({ "user-agent": "curl/8.7.1" }), "resolve");
  recordClientUsage(new Headers(), "decision");
  assert.equal(tasks.length, 0);
  recordClientUsage(new Headers({ "user-agent": "vet402-hermes/0.1.0" }), "resolve");
  assert.equal(tasks.length, 1);
});

test("recordClientUsage: 書く値は日・client・route と 1 だけ（URL や IP は渡らない）", async () => {
  const tasks: Array<() => Promise<void>> = [];
  setAfterResponseSchedulerForTest((task) => tasks.push(task));
  const seen: string[] = [];
  __setDbForTests({
    execute: async (q: unknown) => {
      seen.push(JSON.stringify(q));
      return { rows: [] };
    },
  });
  recordClientUsage(
    new Headers({ "user-agent": "vet402-hermes/0.1.0", "x-forwarded-for": "203.0.113.7", authorization: "Bearer vk_live_secret" }),
    "decision",
  );
  assert.equal(tasks.length, 1);
  await tasks[0]();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /client_usage_daily/);
  assert.match(seen[0], /vet402-hermes\/0\.1\.0/);
  assert.match(seen[0], /"decision"/);
  assert.doesNotMatch(seen[0], /203\.0\.113\.7/);
  assert.doesNotMatch(seen[0], /vk_live_secret/);
});

test("upsertClientUsage: DB が投げても外へ投げない（非同期の失敗・同期の失敗・DB 未設定）", async () => {
  __setDbForTests({
    execute: async () => {
      throw new Error('relation "client_usage_daily" does not exist');
    },
  });
  assert.equal(await upsertClientUsage("vet402-hermes/0.1.0", "resolve"), undefined);
  __setDbForTests({
    execute: () => {
      throw new Error("sync failure");
    },
  });
  assert.equal(await upsertClientUsage("vet402-hermes/0.1.0", "resolve"), undefined);
  __setDbForTests(null);
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.equal(await upsertClientUsage("vet402-hermes/0.1.0", "resolve"), undefined);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test("プライバシーポリシーがこの表と保存しない値を書いている", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync("src/app/legal/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  assert.match(page, /<code>client_usage_daily<\/code>/);
  assert.match(page, /<code>vet402-hermes\/<\/code>/);
  assert.match(page, /We do not store the IP address, the URL or query being looked up, or any API key/);
});
