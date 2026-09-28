// ============================================================
// 通知購読のダブルオプトインと配信停止（2026-09-28 監査）— 実 Postgres で固定する性質:
//  - 受付は pending。DB には確認トークンの sha256 だけ。確認メールは 1 通
//  - 未確定・停止済み・旧行（トークン無し）の宛先へ、通知は 1 通も出ない
//  - 確定も停止も GET では起きない（ルートに GET が無い）。POST でだけ変わる
//  - 確認トークンは 1 回限り・72 時間
//  - 全通知に List-Unsubscribe / List-Unsubscribe-Post（one-click）と停止頁のリンク
//  - 確定済みの行は第三者の再送信で動かない。確認メールは宛先ごと 3 通 / 24h
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("record subscription opt-in (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  process.env.API_KEY_PEPPER = "test-pepper-".padEnd(48, "x");

  test("record subscription opt-in", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { NextRequest } = await import("next/server");
    const lib = await import("@/lib/observatory/record-subscriptions");
    const confirmRoute = await import("@/app/api/v1/observatory/subscriptions/confirm/route");
    const unsubRoute = await import("@/app/api/v1/observatory/subscriptions/unsubscribe/route");
    type MailInput = import("@/lib/mail/send").MailInput;
    const db = getDb()!;
    const rows = (raw: unknown) =>
      (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    await db.execute(sql`TRUNCATE record_subscriptions, ip_rate_limits, x402_l0_probes, x402_endpoints`);
    const endpointId = String(
      rows(
        await db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset)
          VALUES ('seller.example/api/x', 'https://seller.example/api/x', 'GET', 'eip155:8453', '0x0000000000000000000000000000000000000001', '1000', '0xusdc')
          RETURNING id::text AS id
        `),
      )[0].id,
    );
    const probe = async (verdict: "pass" | "fail", minutesAgo: number) =>
      db.execute(sql`
        INSERT INTO x402_l0_probes (endpoint_id, method, verdict, http_status, fail_reason, probed_at)
        VALUES (${endpointId}::uuid, 'GET', ${verdict}, ${verdict === "pass" ? 402 : 500}, ${verdict === "pass" ? null : "no_402"}, now() - make_interval(mins => ${minutesAgo}))
      `);
    await probe("pass", 300);
    await probe("pass", 240);

    const outbox: MailInput[] = [];
    const send = async (m: MailInput) => (outbox.push(m), { sent: true as const, id: `m${outbox.length}` });
    const allow = { consumeLimit: async () => ({ allowed: true }) };
    const row = async (email: string) =>
      rows(
        await db.execute(sql`
          SELECT id::text AS id, confirm_token_hash, confirm_sent_at, confirmed_at, unsubscribed_at, last_verdict
          FROM record_subscriptions WHERE email = ${email} AND kind = 'notify'
        `),
      )[0];
    const tokenFrom = (m: MailInput) => /#t=([A-Za-z0-9_-]{43})/.exec(m.text)![1];
    const post = (path: string, body: string, type = "application/json") =>
      new NextRequest(`https://vet402.com${path}`, { method: "POST", headers: { "content-type": type }, body });

    let pendingToken = "";

    await t.test("受付は pending・DB にはハッシュだけ・確認メールは 1 通", async () => {
      const r = await lib.submitSubscription(
        { endpointId, email: "pending@a.test", kind: "notify", reason: null },
        "203.0.113.9",
        { ...allow, send },
      );
      assert.equal(r.ok && r.confirmation, "sent");
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].to, "pending@a.test");
      pendingToken = tokenFrom(outbox[0]);
      const r0 = await row("pending@a.test");
      assert.equal(r0.confirmed_at, null);
      assert.notEqual(r0.confirm_sent_at, null);
      assert.equal(r0.confirm_token_hash, lib.hashConfirmToken(pendingToken));
      const all = JSON.stringify(rows(await db.execute(sql`SELECT * FROM record_subscriptions`)));
      assert.ok(!all.includes(pendingToken), "the raw token is nowhere in the table");
    });

    await t.test("未確認・停止済み・旧行の宛先への送信は 0（確定済みだけに届く）", async () => {
      await db.execute(sql`
        INSERT INTO record_subscriptions (endpoint_id, email, kind, last_verdict, confirmed_at, unsubscribed_at)
        VALUES (${endpointId}::uuid, 'confirmed@a.test', 'notify', 'pass', now(), NULL),
               (${endpointId}::uuid, 'stopped@a.test',   'notify', 'pass', now(), now()),
               (${endpointId}::uuid, 'legacy@a.test',    'notify', 'pass', NULL,  NULL)
      `);
      await probe("fail", 20);
      await probe("fail", 10); // 公開判定 pass → fail
      outbox.length = 0;
      const run = await lib.notifySubscribers(500, { send });
      assert.deepEqual(outbox.map((m) => m.to), ["confirmed@a.test"]);
      assert.equal("checked" in run && run.checked, 1, "pending / unsubscribed rows are not even read");
      const m = outbox[0];
      assert.equal(m.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
      assert.match(m.headers?.["List-Unsubscribe"] ?? "", /^<https:\/\/.+\/api\/v1\/observatory\/subscriptions\/unsubscribe\?id=[0-9a-f-]{36}&t=[A-Za-z0-9_-]{43}>$/);
      assert.match(m.text, /\/observatory\/unsubscribe#id=[0-9a-f-]{36}&t=[A-Za-z0-9_-]{43}/);
      assert.equal((await row("pending@a.test")).last_verdict, "pass", "pending row was not advanced either");
    });

    await t.test("GET では確定しない（ルートに GET が無い＝Next は 405）", async () => {
      assert.equal((confirmRoute as Record<string, unknown>).GET, undefined);
      assert.equal((unsubRoute as Record<string, unknown>).GET, undefined);
      assert.equal((await row("pending@a.test")).confirmed_at, null, "still pending after the email link was issued");
    });

    await t.test("POST で確定・トークンは 1 回限り・誤トークンは 400", async () => {
      const bad = await confirmRoute.POST(post("/api/v1/observatory/subscriptions/confirm", JSON.stringify({ token: "A".repeat(43) })));
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error, "invalid_token");
      const ok = await confirmRoute.POST(post("/api/v1/observatory/subscriptions/confirm", JSON.stringify({ token: pendingToken })));
      assert.equal(ok.status, 200);
      const r0 = await row("pending@a.test");
      assert.notEqual(r0.confirmed_at, null);
      assert.equal(r0.confirm_token_hash, null, "token consumed");
      const again = await confirmRoute.POST(post("/api/v1/observatory/subscriptions/confirm", JSON.stringify({ token: pendingToken })));
      assert.equal(again.status, 400, "single use");
    });

    await t.test("72 時間を過ぎたトークンは確定できない", async () => {
      outbox.length = 0;
      await lib.submitSubscription({ endpointId, email: "late@a.test", kind: "notify", reason: null }, "x", { ...allow, send });
      const token = tokenFrom(outbox[0]);
      await db.execute(sql`UPDATE record_subscriptions SET confirm_sent_at = now() - interval '73 hours' WHERE email = 'late@a.test'`);
      assert.deepEqual(await lib.confirmSubscription(token), { ok: false, reason: "invalid_token" });
      assert.equal((await row("late@a.test")).confirmed_at, null);
    });

    await t.test("確定後は通知が届き、one-click POST で停止すると以後 0 通", async () => {
      outbox.length = 0;
      await lib.notifySubscribers(500, { send });
      assert.deepEqual(outbox.map((m) => m.to), ["pending@a.test"], "newly confirmed row catches up on pass → fail");
      const header = outbox[0].headers!["List-Unsubscribe"].slice(1, -1);
      const u = new URL(header);

      const wrong = await unsubRoute.POST(
        post(`${u.pathname}?id=${u.searchParams.get("id")}&t=${"B".repeat(43)}`, "List-Unsubscribe=One-Click", "application/x-www-form-urlencoded"),
      );
      assert.equal(wrong.status, 400);
      assert.equal((await row("pending@a.test")).unsubscribed_at, null);

      const res = await unsubRoute.POST(post(`${u.pathname}${u.search}`, "List-Unsubscribe=One-Click", "application/x-www-form-urlencoded"));
      assert.equal(res.status, 200);
      assert.notEqual((await row("pending@a.test")).unsubscribed_at, null);
      const twice = await unsubRoute.POST(post(`${u.pathname}${u.search}`, "List-Unsubscribe=One-Click", "application/x-www-form-urlencoded"));
      assert.equal(twice.status, 200, "idempotent");

      await probe("pass", 2);
      await probe("pass", 1); // fail → pass
      outbox.length = 0;
      await lib.notifySubscribers(500, { send });
      assert.deepEqual(outbox.map((m) => m.to), ["confirmed@a.test"], "the unsubscribed address gets nothing");
    });

    await t.test("停止頁のボタン（JSON）でも停止できる", async () => {
      const id = String((await row("confirmed@a.test")).id);
      const res = await unsubRoute.POST(
        post("/api/v1/observatory/subscriptions/unsubscribe", JSON.stringify({ id, token: lib.unsubscribeToken(id) })),
      );
      assert.equal(res.status, 200);
      assert.notEqual((await row("confirmed@a.test")).unsubscribed_at, null);
    });

    await t.test("確定済みの行は第三者の再送信で動かない・メールも出ない", async () => {
      await db.execute(sql`
        INSERT INTO record_subscriptions (endpoint_id, email, kind, last_verdict, confirmed_at)
        VALUES (${endpointId}::uuid, 'steady@a.test', 'notify', 'fail', now())
      `);
      outbox.length = 0;
      const r = await lib.submitSubscription({ endpointId, email: "steady@a.test", kind: "notify", reason: null }, "y", { ...allow, send });
      assert.equal(r.ok && r.confirmation, "already_confirmed");
      assert.equal(outbox.length, 0);
      const r0 = await row("steady@a.test");
      assert.equal(r0.last_verdict, "fail", "baseline not moved (a pending change is not swallowed)");
      assert.notEqual(r0.confirmed_at, null);
    });

    await t.test("停止済みの宛先が再登録すると pending に戻り、確認し直すまで届かない", async () => {
      outbox.length = 0;
      const r = await lib.submitSubscription({ endpointId, email: "stopped@a.test", kind: "notify", reason: null }, "z", { ...allow, send });
      assert.equal(r.ok && r.confirmation, "sent");
      const r0 = await row("stopped@a.test");
      assert.equal(r0.confirmed_at, null);
      assert.equal(r0.unsubscribed_at, null);
    });

    await t.test("確認メールは宛先ごと 3 通 / 24h（実の ip_rate_limits）。4 通目は送らず、前のリンクは生きる", async () => {
      outbox.length = 0;
      const results: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await lib.submitSubscription({ endpointId, email: "flood@a.test", kind: "notify", reason: null }, `10.0.0.${i}`, { send });
        results.push(r.ok ? r.confirmation : "error");
      }
      assert.deepEqual(results, ["sent", "sent", "sent", "rate_limited"]);
      assert.equal(outbox.length, 3);
      const last = tokenFrom(outbox[2]);
      assert.equal((await row("flood@a.test")).confirm_token_hash, lib.hashConfirmToken(last), "4th submission kept the 3rd link");
      assert.deepEqual(await lib.confirmSubscription(last), { ok: true });
      const keys = rows(await db.execute(sql`SELECT bucket_key FROM ip_rate_limits`)).map((r) => String(r.bucket_key));
      assert.ok(!keys.some((k) => k.includes("flood@a.test")), "no raw address in the limiter table");
    });
  });
}
