// ============================================================
// /api/tokyo の鍵なしの入口の IP ごとの枠（2026-11-02 監査 M2）と、/api/frame の画像の枠。
// /api/tokyo は W01 で @/lib/api/ip-rate-limit を import しない（読む env を増やさない）ので、
// 同じ表 ip_rate_limits を1文で数える小さな関門（_lib/rate-limit.ts）を持つ。
// DB 無し（メモリの桶）で動かす。チェーンへも facilitator へも出ない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { __setDbForTests } from "@/lib/db/client";
import { TOKYO_LIMITS, tokyoRateLimit, __resetTokyoRateLimitForTests } from "@/app/api/tokyo/_lib/rate-limit";

delete process.env.DATABASE_URL;
__setDbForTests(null);

const from = (ip: string, path = "verify?name=a") =>
  new Request(`http://localhost/api/tokyo/${path}`, { headers: { "x-vercel-forwarded-for": ip } });
const rule = { bucket: "t", limit: 2 };

test("枠の内は null、超えたら 429・Retry-After・no-store。別の IP は別の枠", async () => {
  __resetTokyoRateLimitForTests();
  assert.equal(await tokyoRateLimit(from("203.0.113.1"), rule), null);
  assert.equal(await tokyoRateLimit(from("203.0.113.1"), rule), null);
  const over = await tokyoRateLimit(from("203.0.113.1"), rule);
  assert.ok(over);
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { error: "rate_limited" });
  assert.ok(Number(over.headers.get("retry-after")) >= 1);
  assert.equal(over.headers.get("cache-control"), "no-store");
  assert.equal(await tokyoRateLimit(from("203.0.113.2"), rule), null);
});

test("IPv6 は /64 で数える（下位 64 bit を回しても同じ枠）・IPv4 射影は IPv4", async () => {
  __resetTokyoRateLimitForTests();
  assert.equal(await tokyoRateLimit(from("2001:db8:1:2::1"), rule), null);
  assert.equal(await tokyoRateLimit(from("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd"), rule), null);
  assert.equal((await tokyoRateLimit(from("2001:db8:1:2::ffff"), rule))?.status, 429);
  assert.equal(await tokyoRateLimit(from("::ffff:203.0.113.9"), rule), null);
  assert.equal(await tokyoRateLimit(from("203.0.113.9"), rule), null);
  assert.equal((await tokyoRateLimit(from("203.0.113.9"), rule))?.status, 429);
});

test("枠の表に届かないとき: 既定は 503（refuse）、allow は通す。例外の文言を返さない", async () => {
  __resetTokyoRateLimitForTests();
  __setDbForTests({
    execute: async () => {
      throw new Error("db down postgres://user:pw@host/db");
    },
  } as never);
  try {
    const shut = await tokyoRateLimit(from("203.0.113.3"), rule);
    assert.equal(shut?.status, 503);
    const text = await shut!.text();
    assert.deepEqual(JSON.parse(text), { error: "temporarily_unavailable" });
    assert.equal(await tokyoRateLimit(from("203.0.113.3"), rule, "allow"), null);
  } finally {
    __setDbForTests(null);
  }
});

test("DB の数え方は ip_rate_limits の1文 upsert。窓が切れていれば数え直す", async () => {
  __resetTokyoRateLimitForTests();
  const seen: string[] = [];
  __setDbForTests({
    execute: async (q: { queryChunks?: unknown[] }) => {
      seen.push(JSON.stringify(q.queryChunks ?? q));
      return { rows: [{ count: 3 }] };
    },
  } as never);
  try {
    const over = await tokyoRateLimit(from("203.0.113.4"), rule);
    assert.equal(over?.status, 429);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /INSERT INTO ip_rate_limits/);
    assert.match(seen[0], /ON CONFLICT \(bucket_key\) DO UPDATE/);
  } finally {
    __setDbForTests(null);
  }
});

test("GET /api/tokyo/verify: 枠を超えると読む前に 429", async () => {
  __resetTokyoRateLimitForTests();
  const { GET } = await import("@/app/api/tokyo/verify/route");
  const req = () => from("203.0.113.5", "verify?name=" + encodeURIComponent("bad name"));
  for (let i = 0; i < TOKYO_LIMITS.verify.limit; i++) assert.equal((await GET(req())).status, 400);
  assert.equal((await GET(req())).status, 429);
});

test("GET /api/tokyo/state: 枠を超えると deps を作る前に 429", async () => {
  __resetTokyoRateLimitForTests();
  const { GET } = await import("@/app/api/tokyo/state/route");
  const req = () => from("203.0.113.6", "state");
  for (let i = 0; i < TOKYO_LIMITS.state.limit; i++) assert.equal(await tokyoRateLimit(req(), TOKYO_LIMITS.state), null);
  assert.equal((await GET(req())).status, 429);
});

test("GET /api/tokyo/seller: 支払いの無い 402 は数えない。支払いつきは枠を超えると facilitator の前に 429", async () => {
  __resetTokyoRateLimitForTests();
  const { GET } = await import("@/app/api/tokyo/seller/route");
  const headers = { "x-vercel-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < TOKYO_LIMITS.seller.limit + 5; i++) {
    assert.equal((await GET(new NextRequest("http://localhost/api/tokyo/seller", { headers }))).status, 402);
  }
  const accepted = {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "10000",
    payTo: "0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6",
    maxTimeoutSeconds: 120,
  };
  const pay = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signature: "0x" } })).toString("base64");
  const real = globalThis.fetch;
  let facilitatorCalls = 0;
  globalThis.fetch = (async () => {
    facilitatorCalls += 1;
    return new Response(JSON.stringify({ isValid: false, invalidReason: "nope" }), { status: 200 });
  }) as typeof fetch;
  try {
    const paying = () =>
      new NextRequest("http://localhost/api/tokyo/seller", { headers: { ...headers, "PAYMENT-SIGNATURE": pay } });
    for (let i = 0; i < TOKYO_LIMITS.seller.limit; i++) assert.equal((await GET(paying())).status, 402);
    const before = facilitatorCalls;
    assert.ok(before > 0, "支払いの形が読めていない（facilitator まで届いていない）");
    assert.equal((await GET(paying())).status, 429);
    assert.equal(facilitatorCalls, before);
  } finally {
    globalThis.fetch = real;
  }
});

test("GET /api/frame/endpoint/:id/image: UUID でない・未知の ID は描かずに 404、枠を超えると 429", async () => {
  const { GET } = await import("@/app/api/frame/endpoint/[id]/image/route");
  const call = (id: string, ip = "203.0.113.8") =>
    GET(new NextRequest(`http://localhost/api/frame/endpoint/${id}/image`, { headers: { "x-vercel-forwarded-for": ip } }), {
      params: Promise.resolve({ id }),
    });
  const bad = await call("not-a-uuid");
  assert.equal(bad.status, 404);
  assert.match(bad.headers.get("content-type") ?? "", /json/);
  const unknown = "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a";
  let status = 0;
  let notFound = 0;
  for (let i = 0; i < 61 && status !== 429; i++) {
    status = (await call(unknown)).status;
    if (status === 404) notFound += 1;
  }
  assert.equal(notFound, 60, "未知の ID は枠の内では 404");
  assert.equal(status, 429);
  // 形の悪い ID は枠も DB も使わない（枠を使い切った後でも 404 のまま）。
  assert.equal((await call("not-a-uuid")).status, 404);
});

test("POST /api/tokyo/reset: 枠を超えると本文を読む前に 429", async () => {
  __resetTokyoRateLimitForTests();
  const { POST } = await import("@/app/api/tokyo/reset/route");
  const req = () =>
    new Request("http://localhost/api/tokyo/reset", {
      method: "POST",
      headers: { "x-vercel-forwarded-for": "203.0.113.9", "content-type": "application/json" },
      body: '{"to":"10000"}',
    });
  for (let i = 0; i < TOKYO_LIMITS.reset.limit; i++) assert.equal(await tokyoRateLimit(req(), TOKYO_LIMITS.reset), null);
  const over = await POST(req());
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { error: "rate_limited" });
});

async function withStoreDown<T>(run: (facilitatorCalls: () => number) => Promise<T>): Promise<T> {
  __resetTokyoRateLimitForTests();
  __setDbForTests({
    execute: async () => {
      throw new Error("db down");
    },
  } as never);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("no network in this test");
  }) as typeof fetch;
  process.env.TOKYO_JUDGE_BUTTON_DISABLED = "1";
  try {
    return await run(() => calls);
  } finally {
    delete process.env.TOKYO_JUDGE_BUTTON_DISABLED;
    globalThis.fetch = realFetch;
    __setDbForTests(null);
  }
}

test("枠の表が落ちたとき: verify は 503（読みに進まない）", async () => {
  await withStoreDown(async (calls) => {
    const { GET } = await import("@/app/api/tokyo/verify/route");
    const res = await GET(from("203.0.113.30", "verify?name=seller-a.eth"));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "temporarily_unavailable" });
    assert.equal(calls(), 0);
  });
});

test("枠の表が落ちたとき: 支払いつきの seller は 503（facilitator へ出ない）", async () => {
  await withStoreDown(async (calls) => {
    const { GET } = await import("@/app/api/tokyo/seller/route");
    const accepted = {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "10000",
      payTo: "0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6",
    };
    const pay = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signature: "0x" } })).toString("base64");
    const res = await GET(new NextRequest("http://localhost/api/tokyo/seller", { headers: { "PAYMENT-SIGNATURE": pay } }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "temporarily_unavailable" });
    assert.equal(calls(), 0);
  });
});

test("枠の表が落ちたとき: state は通して押せない理由の1行を返す（200）", async () => {
  await withStoreDown(async () => {
    const { GET } = await import("@/app/api/tokyo/state/route");
    const res = await GET(from("203.0.113.31", "state"));
    assert.equal(res.status, 200);
    const j = (await res.json()) as { blockers: { error: string }[]; canPress: boolean };
    assert.equal(j.canPress, false);
    assert.ok(j.blockers.some((b) => b.error === "state_unavailable"), JSON.stringify(j.blockers));
  });
});

test("枠の表が落ちたとき: reset は通して自分の理由を返す（temporarily_unavailable にしない）", async () => {
  await withStoreDown(async () => {
    const { POST } = await import("@/app/api/tokyo/reset/route");
    const res = await POST(
      new Request("http://localhost/api/tokyo/reset", {
        method: "POST",
        headers: { "x-vercel-forwarded-for": "203.0.113.32" },
        body: '{"to":"10000"}',
      }),
    );
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, "button_disabled");
  });
});

test("GET /api/frame/endpoint/:id/image: 知っている ID は PNG を描き、60 秒のキャッシュと枠の見出しを付ける", async () => {
  const id = "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a";
  const endpoint = { id, resourceKey: "seller.example/api", resourceUrl: "https://seller.example/api", network: "base", status: "listed", declaredSchema: null };
  let selects = 0;
  const chain = (rows: unknown[]): unknown =>
    new Proxy(function () {}, {
      get: (_t, k) => {
        if (k === "then") return (ok: (v: unknown) => unknown) => ok(rows);
        return () => chain(rows);
      },
    });
  __setDbForTests({
    select: () => chain(selects++ === 0 ? [endpoint] : []),
    insert: () => chain([]),
    execute: async () => ({ rows: [] }),
  } as never);
  try {
    const { GET } = await import("@/app/api/frame/endpoint/[id]/image/route");
    const res = await GET(new NextRequest(`http://localhost/api/frame/endpoint/${id}/image`, { headers: { "x-vercel-forwarded-for": "203.0.113.40" } }), {
      params: Promise.resolve({ id }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "public, max-age=60, s-maxage=60, stale-while-revalidate=300");
    const png = Buffer.from(await res.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), "PNG");
  } finally {
    __setDbForTests(null);
  }
});
