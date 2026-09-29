// ============================================================
// 2026-09-29 敵対的監査 4 周目: Resend への fetch に期限が無かった。
// 応答しない Resend は呼び手（購読の確認・通知 cron）を maxDuration まで止める。
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendMail, MAIL_SEND_TIMEOUT_MS } from "@/lib/mail/send";
import { probeSegment } from "@/lib/health/probe-detail";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
});

test("既定の期限は 10 秒以下", () => {
  assert.ok(MAIL_SEND_TIMEOUT_MS > 0 && MAIL_SEND_TIMEOUT_MS <= 10_000);
});

test("応答しない Resend は期限で打ち切り、mail_timeout（送ったとは扱わない）", async () => {
  process.env.RESEND_API_KEY = "re_test_dummy";
  process.env.MAIL_FROM = "vet402 <noreply@example.test>";
  let sawSignal = false;
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      sawSignal = init?.signal instanceof AbortSignal;
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  const started = Date.now();
  const r = await sendMail({ to: "a@example.test", subject: "s", text: "t" }, { timeoutMs: 50 });
  assert.ok(sawSignal, "fetch に signal を渡している");
  assert.deepEqual(r, { sent: false, error: "mail_timeout" });
  assert.ok(Date.now() - started < 2_000);
});

test("probeSegment: stale は cached と別の語で書く", () => {
  assert.equal(probeSegment("payee", "ok", true, null, true), "payee=ok stale");
  assert.equal(probeSegment("payee", "ok", true, null), "payee=ok cached");
});
