// ============================================================
// ETHGlobal Tokyo 2026 B4a — /api/tokyo/seller（Base Sepolia の最小の x402 売り手）
//
// 約束（ENS の `x402-offer` に書く 266 バイトの1行 JSON・PLAN_v4.3 §3.3.1）と、
// 402 の提示がバイト単位で食い違わないことを縛る。食い違うと attester が署名を拒み、
// 約束を書き直せば全証明が失効する。
//
// facilitator は globalThis.fetch を偽物に差し替えて注入する（外へは1本も出さない）。
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET, dynamic } from "@/app/api/tokyo/seller/route";

// 約束の逐語（PLAN_v4.3 §3.3.1）。ここを変えるときは約束そのものが変わっている。
const OFFER_RAW =
  '{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","amount":"10000","payTo":"0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6","output":{"required":["result","observed_at"]}}';
const OFFER = JSON.parse(OFFER_RAW) as {
  resource: string; method: string; network: string; asset: string; amount: string; payTo: string;
  output: { required: string[] };
};

const URL_ = "https://vet402.com/api/tokyo/seller";
const FACILITATOR = "https://x402.org/facilitator";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; body: unknown };
function fakeFacilitator(opts: {
  verify?: unknown; settle?: unknown; verifyStatus?: number; settleStatus?: number; throwOn?: "verify" | "settle";
}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const which = url.endsWith("/verify") ? "verify" : url.endsWith("/settle") ? "settle" : null;
    if (!which) throw new Error(`unexpected fetch ${url}`);
    if (opts.throwOn === which) throw new Error(`fake ${which} down`);
    const payload = which === "verify" ? opts.verify : opts.settle;
    const status = (which === "verify" ? opts.verifyStatus : opts.settleStatus) ?? 200;
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function paymentHeader(over: Record<string, unknown> = {}): string {
  // 買い手 SDK の encodePaymentHeader（v2）と同じ形。
  return b64json({
    x402Version: 2,
    resource: { url: URL_ },
    accepted: {
      scheme: "exact",
      network: OFFER.network,
      amount: OFFER.amount,
      asset: OFFER.asset,
      payTo: OFFER.payTo,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
      ...over,
    },
    payload: {
      signature: "0x" + "11".repeat(65),
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: OFFER.payTo,
        value: OFFER.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0x" + "22".repeat(32),
      },
    },
  });
}

function decodeHeader(res: Response, name: string): Record<string, unknown> {
  const raw = res.headers.get(name);
  assert.ok(raw, `${name} header missing`);
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

test("支払い無しの GET は 402・PAYMENT-REQUIRED の accepts[0] が約束とバイト単位で一致", async () => {
  const calls = fakeFacilitator({});
  const res = await GET(new NextRequest(URL_));
  assert.equal(res.status, 402);
  assert.equal(calls.length, 0, "支払い無しで facilitator を呼ばない");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);

  const pr = decodeHeader(res, "payment-required") as {
    x402Version: number; resource: { url: string }; accepts: Array<Record<string, unknown>>;
  };
  assert.equal(pr.x402Version, 2);
  assert.equal(pr.resource.url, OFFER.resource);
  assert.equal(pr.accepts.length, 1);
  const a = pr.accepts[0] as { scheme: string; network: string; asset: string; amount: string; payTo: string;
    extra: { name: string; version: string } };
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, OFFER.network);
  assert.equal(a.asset, OFFER.asset);
  assert.equal(a.amount, OFFER.amount);
  assert.equal(a.payTo, OFFER.payTo);
  assert.equal(a.extra.name, "USDC");
  assert.equal(a.extra.version, "2");

  // 本文も同じ提示（curl で読めるように）。ヘッダと1バイトも違わない。
  const body = await res.json();
  assert.deepEqual(body, pr);
});

test("約束の method は GET。route が出すのは GET だけ", async () => {
  const mod = await import("@/app/api/tokyo/seller/route");
  assert.equal(OFFER.method, "GET");
  for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((mod as Record<string, unknown>)[verb], undefined, `${verb} を export しない`);
  }
  assert.equal(dynamic, "force-dynamic");
});

test("支払いが検証・決済できたら 200・本文の最上位に output.required の全キー", async () => {
  const calls = fakeFacilitator({
    verify: { isValid: true, payer: "0x1111111111111111111111111111111111111111" },
    settle: { success: true, transaction: "0x" + "ab".repeat(32), network: OFFER.network,
      payer: "0x1111111111111111111111111111111111111111" },
  });
  const res = await GET(new NextRequest(URL_, { headers: { "PAYMENT-SIGNATURE": paymentHeader() } }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  for (const key of OFFER.output.required) assert.ok(key in body, `本文に ${key} が無い`);
  assert.equal(typeof body.result, "string");
  assert.ok(!Number.isNaN(Date.parse(String(body.observed_at))), "observed_at は ISO 時刻");

  // 決済レシートはヘッダに（買い手 SDK の parseSettlementResponse が読む所）。
  const receipt = decodeHeader(res, "payment-response");
  assert.equal(receipt.success, true);
  assert.equal(receipt.transaction, "0x" + "ab".repeat(32));

  // facilitator へ渡す paymentRequirements は売り手の定数（買い手の申告を信じない）。
  assert.deepEqual(calls.map((c) => c.url), [`${FACILITATOR}/verify`, `${FACILITATOR}/settle`]);
  for (const c of calls) {
    const b = c.body as { x402Version: number; paymentRequirements: Record<string, unknown>; paymentPayload: unknown };
    assert.equal(b.x402Version, 2);
    assert.equal(b.paymentRequirements.payTo, OFFER.payTo);
    assert.equal(b.paymentRequirements.amount, OFFER.amount);
    assert.equal(b.paymentRequirements.network, OFFER.network);
    assert.equal(b.paymentRequirements.asset, OFFER.asset);
  }
});

test("accepted が約束と違う（amount・payTo・network・asset・scheme）→ facilitator を呼ばず 402", async () => {
  for (const over of [
    { amount: "1" },
    { payTo: "0x0000000000000000000000000000000000000001" },
    { network: "eip155:8453" },
    { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    { scheme: "upto" },
  ]) {
    const calls = fakeFacilitator({ verify: { isValid: true }, settle: { success: true } });
    const res = await GET(new NextRequest(URL_, { headers: { "PAYMENT-SIGNATURE": paymentHeader(over) } }));
    assert.equal(res.status, 402, JSON.stringify(over));
    assert.equal(calls.length, 0, `facilitator を呼ばない: ${JSON.stringify(over)}`);
  }
});

test("壊れたヘッダ・v1 の X-PAYMENT だけ → 402（facilitator を呼ばない）", async () => {
  for (const headers of [
    { "PAYMENT-SIGNATURE": "not-base64-json" } as Record<string, string>,
    { "PAYMENT-SIGNATURE": b64json({ x402Version: 1 }) },
    { "X-PAYMENT": b64json({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} }) },
  ]) {
    const calls = fakeFacilitator({ verify: { isValid: true }, settle: { success: true } });
    const res = await GET(new NextRequest(URL_, { headers }));
    assert.equal(res.status, 402);
    assert.equal(calls.length, 0);
    assert.ok(res.headers.get("payment-required"));
  }
});

test("verify が isValid:false → 402・settle を呼ばない", async () => {
  const calls = fakeFacilitator({ verify: { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" } });
  const res = await GET(new NextRequest(URL_, { headers: { "PAYMENT-SIGNATURE": paymentHeader() } }));
  assert.equal(res.status, 402);
  assert.equal(calls.length, 1);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /invalid_exact_evm_payload_signature/);
  assert.ok(!("result" in body), "払われていないのに result を返さない");
});

test("settle が success:false → 402・result を返さない", async () => {
  fakeFacilitator({
    verify: { isValid: true, payer: "0x1111111111111111111111111111111111111111" },
    settle: { success: false, errorReason: "insufficient_funds", transaction: "", network: OFFER.network },
  });
  const res = await GET(new NextRequest(URL_, { headers: { "PAYMENT-SIGNATURE": paymentHeader() } }));
  assert.equal(res.status, 402);
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(!("result" in body));
  assert.match(String(body.error), /insufficient_funds/);
});

test("facilitator に届かない・5xx → 502（払ったことにしない）", async () => {
  for (const opts of [{ throwOn: "verify" as const }, { verify: { error: "x" }, verifyStatus: 503 }]) {
    fakeFacilitator(opts);
    const res = await GET(new NextRequest(URL_, { headers: { "PAYMENT-SIGNATURE": paymentHeader() } }));
    assert.equal(res.status, 502);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(!("result" in body));
  }
  fakeFacilitator({ verify: { isValid: true }, throwOn: "settle" });
  const res = await GET(new NextRequest(URL_, { headers: { "PAYMENT-SIGNATURE": paymentHeader() } }));
  assert.equal(res.status, 502);
});

test("W01: route は既存 lib を許可の3本以外 import しない・env を読まない・秘密鍵と署名器を持たない", () => {
  const src = readFileSync("src/app/api/tokyo/seller/route.ts", "utf8");
  const libs = [...src.matchAll(/from\s+["'](@\/lib\/[^"']+)["']/g)].map((m) => m[1]);
  const allowed = new Set(["@/lib/db/client", "@/lib/util/log", "@/lib/cron/lease"]);
  for (const l of libs) assert.ok(allowed.has(l), `許可外の lib: ${l}`);
  assert.doesNotMatch(src, /import\(/, "動的 import なし");
  assert.doesNotMatch(src, /process\.env/, "env を読まない");
  assert.doesNotMatch(src, /PRIVATE_KEY|signTypedData|privateKeyToAccount|mnemonic/i);
  // 約束の resource は URL に焼き込まれる。1文字でも違えば全証明が失効する。
  assert.ok(src.includes(`"${OFFER.resource}"`));
});
