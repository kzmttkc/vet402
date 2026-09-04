// ============================================================
// /api/admin/spending-halt — 支出を止める操作卓（2026-09-05 監査 P0）。
//
// この口は「事故の最中に 1 回だけ叩かれる」ことを前提に設計する。だから
// ここで固定するのは、便利さではなく**止められること**の性質:
//   - 鍵が無い / 違う呼び出しは 401（切り替えは運用者だけ）
//   - 理由なしの停止・再開は 400（行が履歴になるので、なぜが空の行を作らない）
//   - **停止（enabled=true）はレート制限で拒否されない。** 止めるボタンが
//     「呼びすぎ」を理由に閉まるのは、止められないのと同じ。
//     読み取りと再開は従来どおり絞る。
// DB を要求しないものだけをここに置く（実際に止まることの実測は
// tests/l1-kill-switch.pg.test.ts）。
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { consumeIpRateLimit } from "@/lib/api/ip-rate-limit";
import { GET, POST } from "@/app/api/admin/spending-halt/route";

const SECRET = "test-admin-secret-spending-halt-0905";
const URL_ = "http://localhost/api/admin/spending-halt";

const post = (body: unknown, auth = `Bearer ${SECRET}`) =>
  new NextRequest(URL_, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => {
  delete process.env.ADMIN_SECRET;
});

test("ADMIN_SECRET が未設定なら誰も切り替えられない", async () => {
  const res = await POST(post({ enabled: true, reason: "x" }));
  assert.equal(res.status, 401);
});

test("鍵違いは 401（GET も POST も）", async () => {
  process.env.ADMIN_SECRET = SECRET;
  assert.equal((await POST(post({ enabled: true, reason: "x" }, "Bearer wrong"))).status, 401);
  const res = await GET(new NextRequest(URL_, { headers: { authorization: "Bearer wrong" } }));
  assert.equal(res.status, 401);
});

test("enabled が boolean でなければ 400（'true' という文字列で止まったつもりにさせない）", async () => {
  process.env.ADMIN_SECRET = SECRET;
  const res = await POST(post({ enabled: "true", reason: "x" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_enabled");
});

test("理由なしは 400——行がそのまま履歴になるので、なぜが空の行を作らない", async () => {
  process.env.ADMIN_SECRET = SECRET;
  const res = await POST(post({ enabled: true, reason: "   " }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "reason_required");
});

test("壊れた JSON は 400", async () => {
  process.env.ADMIN_SECRET = SECRET;
  const res = await POST(
    new NextRequest(URL_, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: "{",
    }),
  );
  assert.equal(res.status, 400);
});

// このテストは IP バケツを使い切るので最後に置く（getClientIp は "unknown" 固定）。
test("バケツを使い切っても停止は通る。再開と読み取りだけが 429 になる", async () => {
  process.env.ADMIN_SECRET = SECRET;
  for (let i = 0; i < 60; i++) await consumeIpRateLimit("admin-spending-halt:unknown", 60, 60_000);

  const resume = await POST(post({ enabled: false, reason: "resume" }));
  assert.equal(resume.status, 429, "再開は絞ってよい");
  const read = await GET(new NextRequest(URL_, { headers: { authorization: `Bearer ${SECRET}` } }));
  assert.equal(read.status, 429, "読み取りは絞ってよい");

  const halt = await POST(post({ enabled: true, reason: "stop the money" }));
  assert.notEqual(halt.status, 429, "**止めるボタンだけは、呼びすぎを理由に閉めない**");
  // この suite は DB を持たないので書き込み自体は 500 で落ちる（上に出る
  // `admin.spending_halt.write` の 1 行はその fail-loud）。ここで見たいのは
  // 「レート制限に閉められていない」ことで、実際に止まることの実測は
  // tests/l1-kill-switch.pg.test.ts が持つ。
  assert.equal(halt.status, 500);
});
