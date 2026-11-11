// 試験の中から本物の DB に届かせない関門（src/lib/db/client.ts・2026-11-11 の停止事故）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isInsideTestRun, testRunDatabaseRefusal } from "@/lib/db/client";

const FAKE_TEST_DB = "postgres://user:pw@127.0.0.1:5432/vouch_test";
const OTHER_DB = "postgres://user:pw@db.example.com:5432/other";

test("node:test の中だと分かる（NODE_TEST_CONTEXT）", () => {
  assert.equal(isInsideTestRun({ NODE_TEST_CONTEXT: "child-v8" }, ["node", "x.ts"]), true);
});

test("--test なしで試験ファイルを直に走らせても、試験の中と分かる", () => {
  assert.equal(isInsideTestRun({}, ["node", "/repo/tests/spending-halt-route.test.ts"]), true);
  assert.equal(isInsideTestRun({}, ["node", "/repo/src/a.spec.mts"]), true);
});

test("本番の入口と運用のスクリプトは試験の中ではない", () => {
  assert.equal(isInsideTestRun({}, ["node", "/repo/scripts/backfill.ts"]), false);
  assert.equal(isInsideTestRun({}, ["node", "/var/task/.next/server/app/api/route.js"]), false);
});

test("試験の中では DATABASE_URL が TEST_DATABASE_URL と違えば拒む（本番の URL を環境に持ったシェルで流れた形）", () => {
  const r = testRunDatabaseRefusal(OTHER_DB, { NODE_TEST_CONTEXT: "child-v8" }, ["node", "t.ts"]);
  assert.match(r ?? "", /must equal TEST_DATABASE_URL/);
});

test("試験の中でも TEST_DATABASE_URL と同じなら通す（DB の試験の形）", () => {
  const env = { NODE_TEST_CONTEXT: "child-v8", TEST_DATABASE_URL: FAKE_TEST_DB };
  assert.equal(testRunDatabaseRefusal(FAKE_TEST_DB, env, ["node", "t.ts"]), null);
});

test("試験の外では何も拒まない（本番の Vercel・運用のスクリプト）", () => {
  assert.equal(testRunDatabaseRefusal(OTHER_DB, {}, ["node", "/repo/scripts/x.ts"]), null);
});

test("getDb は試験の中で拒んだら例外で落ちる（黙って null にしない）", async () => {
  const saved = { url: process.env.DATABASE_URL, t: process.env.TEST_DATABASE_URL };
  try {
    process.env.DATABASE_URL = OTHER_DB;
    delete process.env.TEST_DATABASE_URL;
    const mod = await import("@/lib/db/client");
    assert.throws(() => mod.getDb(), /db: inside a test run DATABASE_URL must equal TEST_DATABASE_URL/);
  } finally {
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
    if (saved.t === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = saved.t;
  }
});
