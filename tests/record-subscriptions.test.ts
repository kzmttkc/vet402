// ============================================================
// vet402 — 段 2「名前を取る」（2026-09-02 敵対的監査 F6 / F7）。
//
// endpoint 記録頁で価値を受け取った直後に、判定変更の通知（notify）と記録への
// 異議（dispute）で email を受け取る。固定する性質:
//  - 入力検証は純関数（email 形式・kind・dispute は理由 20〜2,000 字・honeypot）
//  - 同一 email × endpoint × kind は upsert（二重登録しない）
//  - 受付番号は id の先頭 8 桁
//  - IP は生で保存せず sha256
//  - 送信は RESEND_API_KEY / MAIL_FROM 未設定なら送らず skipped を返す（fail-loud）
//  - 通知は last_verdict と現在の公開判定が違うものだけ
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __setDbForTests } from "@/lib/db/client";
import {
  validateSubscription,
  submitSubscription,
  subscriptionsToNotify,
  hashIp,
  SUBSCRIBE_RL_LIMIT,
  SUBSCRIBE_RL_WINDOW_MS,
} from "@/lib/observatory/record-subscriptions";
import { sendMail } from "@/lib/mail/send";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const ENDPOINT_ID = "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a";
const REASON = "The wall answered 402 with a valid accepts[] at 12:07 UTC; your probe says no_402.";

afterEach(() => {
  __setDbForTests(null);
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
});

test("validate: notify needs a well-formed email and a uuid endpoint", () => {
  const ok = validateSubscription({ endpointId: ENDPOINT_ID, email: " Bob@Example.com ", kind: "notify" });
  assert.deepEqual(ok, {
    ok: true,
    value: { endpointId: ENDPOINT_ID, email: "bob@example.com", kind: "notify", reason: null },
  });
  assert.deepEqual(validateSubscription({ endpointId: "nope", email: "a@b.co", kind: "notify" }), {
    ok: false,
    reason: "invalid_endpoint",
  });
  assert.deepEqual(validateSubscription({ endpointId: ENDPOINT_ID, email: "not-an-email", kind: "notify" }), {
    ok: false,
    reason: "invalid_email",
  });
  assert.deepEqual(validateSubscription({ endpointId: ENDPOINT_ID, email: "a@b.co", kind: "alert" }), {
    ok: false,
    reason: "invalid_kind",
  });
});

test("validate: dispute requires a reason of 20–2,000 characters", () => {
  assert.deepEqual(validateSubscription({ endpointId: ENDPOINT_ID, email: "a@b.co", kind: "dispute" }), {
    ok: false,
    reason: "reason_required",
  });
  assert.deepEqual(
    validateSubscription({ endpointId: ENDPOINT_ID, email: "a@b.co", kind: "dispute", reason: "too short" }),
    { ok: false, reason: "reason_length" },
  );
  assert.deepEqual(
    validateSubscription({ endpointId: ENDPOINT_ID, email: "a@b.co", kind: "dispute", reason: "x".repeat(2001) }),
    { ok: false, reason: "reason_length" },
  );
  const ok = validateSubscription({ endpointId: ENDPOINT_ID, email: "a@b.co", kind: "dispute", reason: REASON });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.reason, REASON);
});

test("validate: a filled honeypot is rejected", () => {
  assert.deepEqual(
    validateSubscription({ endpointId: ENDPOINT_ID, email: "a@b.co", kind: "notify", website: "http://spam" }),
    { ok: false, reason: "honeypot" },
  );
});

test("hashIp never stores the raw address and is stable", () => {
  const h = hashIp("203.0.113.9");
  assert.notEqual(h, "203.0.113.9");
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(h, hashIp("203.0.113.9"));
});

test("rate limit is 5 per hour per IP", () => {
  assert.equal(SUBSCRIBE_RL_LIMIT, 5);
  assert.equal(SUBSCRIBE_RL_WINDOW_MS, 3_600_000);
});

function fakeDb(opts: { endpointExists: boolean; verdicts: string[]; inserted: unknown[]; conflict: unknown[] }) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return { limit: async () => (opts.endpointExists ? [{ id: ENDPOINT_ID }] : []) };
            },
          };
        },
      };
    },
    execute: async () => ({ rows: [{ verdicts: opts.verdicts }] }),
    insert() {
      return {
        values(v: unknown) {
          opts.inserted.push(v);
          return {
            onConflictDoUpdate(c: unknown) {
              opts.conflict.push(c);
              return { returning: async () => [{ id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }] };
            },
          };
        },
      };
    },
  };
}

test("submit: unknown endpoint → endpoint_not_found", async () => {
  __setDbForTests(fakeDb({ endpointExists: false, verdicts: [], inserted: [], conflict: [] }));
  const r = await submitSubscription(
    { endpointId: ENDPOINT_ID, email: "a@b.co", kind: "notify", reason: null },
    "203.0.113.9",
  );
  assert.deepEqual(r, { ok: false, reason: "endpoint_not_found" });
});

test("submit: upserts on (endpoint, email, kind), stores the hashed ip and the current verdict, returns an 8-char receipt", async () => {
  const inserted: Record<string, unknown>[] = [];
  const conflict: unknown[] = [];
  __setDbForTests(fakeDb({ endpointExists: true, verdicts: ["fail", "fail"], inserted, conflict }));
  const r = await submitSubscription(
    { endpointId: ENDPOINT_ID, email: "a@b.co", kind: "notify", reason: null },
    "203.0.113.9",
  );
  assert.deepEqual(r, { ok: true, id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", receipt: "0a1b2c3d", lastVerdict: "fail" });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]!.ipHash, hashIp("203.0.113.9"));
  assert.equal(inserted[0]!.lastVerdict, "fail");
  assert.equal(inserted[0]!.email, "a@b.co");
  assert.equal(conflict.length, 1, "insert goes through onConflictDoUpdate (upsert)");
});

test("submit: a single fail is published as unverified (same gate as the register)", async () => {
  __setDbForTests(fakeDb({ endpointExists: true, verdicts: ["fail", "pass"], inserted: [], conflict: [] }));
  const r = await submitSubscription(
    { endpointId: ENDPOINT_ID, email: "a@b.co", kind: "notify", reason: null },
    "unknown",
  );
  assert.equal(r.ok && r.lastVerdict, "unverified");
});

test("subscriptionsToNotify: only rows whose verdict changed", () => {
  const subs = [
    { id: "a", endpointId: "e1", email: "x@y.z", lastVerdict: "pass" },
    { id: "b", endpointId: "e2", email: "x@y.z", lastVerdict: "fail" },
    { id: "c", endpointId: "e3", email: "x@y.z", lastVerdict: "unverified" },
  ];
  const now = new Map([
    ["e1", "fail"],
    ["e2", "fail"],
  ]);
  assert.deepEqual(
    subscriptionsToNotify(subs, now).map((s) => [s.id, s.lastVerdict, s.currentVerdict]),
    [["a", "pass", "fail"]],
  );
});

test("sendMail: without RESEND_API_KEY / MAIL_FROM nothing is sent and the caller learns it", async () => {
  const r = await sendMail({ to: "a@b.co", subject: "s", text: "t" });
  assert.deepEqual(r, { skipped: "mail_unset" });
});

test("sendMail: posts to the Resend HTTP API with the bearer key", async () => {
  process.env.RESEND_API_KEY = "re_test_123";
  process.env.MAIL_FROM = "vet402 <records@vet402.com>";
  const calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await sendMail({ to: "a@b.co", subject: "Verdict changed", text: "body" });
    assert.deepEqual(r, { sent: true, id: "msg_1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.resend.com/emails");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer re_test_123");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.from, "vet402 <records@vet402.com>");
    assert.deepEqual(body.to, ["a@b.co"]);
    assert.equal(body.subject, "Verdict changed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("surfaces: route, cron, schema, DDL, env example, ToS §8, endpoint page", () => {
  const route = read("src/app/api/v1/observatory/endpoints/[id]/subscribe/route.ts");
  assert.ok(route.includes("SUBSCRIBE_RL_LIMIT"));
  assert.ok(route.includes("export async function POST"));
  const cron = read("src/app/api/cron/notify-subscribers/route.ts");
  assert.ok(cron.includes("authorizeCron"));
  const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const job = vercel.crons.find((c) => c.path === "/api/cron/notify-subscribers");
  assert.ok(job, "vercel.json schedules notify-subscribers");
  assert.match(job!.schedule, /^\d+ \d+ \* \* \*$/, "daily (Hobby plan cannot run more often)");
  const schema = read("src/lib/db/schema.ts");
  assert.ok(schema.includes('"record_subscriptions"'));
  const ddl = read("scripts/sql/2026-09-02-record-subscriptions.sql");
  assert.ok(ddl.includes("CREATE TABLE IF NOT EXISTS record_subscriptions"));
  assert.ok(ddl.includes("CREATE UNIQUE INDEX IF NOT EXISTS"));
  const env = read(".env.example");
  assert.ok(env.includes("RESEND_API_KEY"));
  assert.ok(env.includes("MAIL_FROM"));
  const terms = read("src/app/legal/terms/page.tsx");
  const sec8 = terms.slice(terms.indexOf('sec-no">8.'), terms.indexOf('sec-no">9.'));
  assert.match(sec8, /endpoint record/i);
  assert.match(sec8, /Dispute this record/);
  const page = read("src/app/observatory/e/[id]/page.tsx");
  assert.ok(page.includes("RecordSubscribe"));
  assert.ok(page.includes("Dispute this record"));
  const client = read("src/components/site/RecordSubscribe.tsx");
  assert.ok(client.includes('"record_subscribe"'));
  assert.ok(client.includes("doc-input"));
  assert.ok(client.includes("buttonClass"));
});
