// ============================================================
// 購入元残高の関門の単体（Issue #29・2026-09-17）。ランナーを通した検査は
// tests/l1-body-and-funds.pg.test.ts が持つ。ここは台帳の算術と fail-closed だけ。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPayerFunds, defaultPayerUsdcBalance, redactForLog } from "@/lib/observatory/payer-funds";

test("残高が額以上なら ok、未満なら insufficient（等号は ok）", async () => {
  const f = createPayerFunds(async () => 3000n);
  assert.deepEqual(await f.check("base", "0x1", 3000n), { ok: true });
  const g = createPayerFunds(async () => 2999n);
  const v = await g.check("base", "0x1", 3000n);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "insufficient");
});

test("バッチ内で署名した額を差し引く・チェーンは別々に数える", async () => {
  const f = createPayerFunds(async ({ chain }) => (chain === "base" ? 5000n : 4000n));
  assert.equal((await f.check("base", "0x1", 3000n)).ok, true);
  f.commit("base", "0x1", 3000n);
  assert.equal((await f.check("base", "0x1", 3000n)).ok, false);
  assert.equal((await f.check("base", "0x1", 2000n)).ok, true);
  assert.equal((await f.check("solana", "So1", 4000n)).ok, true, "Base の署名は Solana の残高を減らさない");
});

test("読み手はチェーンごとに 1 回だけ呼ばれる（失敗もキャッシュ）", async () => {
  let calls = 0;
  const f = createPayerFunds(async () => {
    calls++;
    throw new Error("rpc down");
  });
  for (let i = 0; i < 5; i++) {
    const v = await f.check("base", "0x1", 1n);
    assert.equal(v.ok === false && v.reason, "unreadable");
  }
  assert.equal(calls, 1);
});

test("負の値・bigint 以外は読めなかった扱い（署名しない側）", async () => {
  const neg = createPayerFunds(async () => -1n);
  assert.equal((await neg.check("base", "0x1", 1n)).ok, false);
  const wrong = createPayerFunds((async () => 10 as unknown as bigint) as never);
  assert.equal((await wrong.check("base", "0x1", 1n)).ok, false);
});

test("既定の読み手は RPC の URL が無ければ throw する（公開 RPC へ無言で倒れない）", async () => {
  const saved = { base: process.env.BASE_RPC_URL, sol: process.env.SOLANA_RPC_URL };
  delete process.env.BASE_RPC_URL;
  delete process.env.SOLANA_RPC_URL;
  try {
    await assert.rejects(defaultPayerUsdcBalance({ chain: "base", owner: "0x0000000000000000000000000000000000000001" }), /base_rpc_unset/);
    await assert.rejects(defaultPayerUsdcBalance({ chain: "solana", owner: "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd" }), /solana_rpc_unset/);
  } finally {
    if (saved.base !== undefined) process.env.BASE_RPC_URL = saved.base;
    if (saved.sol !== undefined) process.env.SOLANA_RPC_URL = saved.sol;
  }
});

// ---- Arc（2026-09-17 Arc レーン）----
test("arc は base・solana と別のチェーンとして数える（Base の署名は Arc の残高を減らさない）", async () => {
  const f = createPayerFunds(async ({ chain }) => (chain === "arc" ? 20_000n : 5000n));
  assert.equal((await f.check("base", "0x1", 5000n)).ok, true);
  f.commit("base", "0x1", 5000n);
  assert.equal((await f.check("base", "0x1", 1n)).ok, false, "Base は使い切った");
  assert.equal((await f.check("arc", "0x1", 20_000n)).ok, true, "同じ EOA でも Arc の USDC は別の残高");
  f.commit("arc", "0x1", 20_000n);
  assert.equal((await f.check("arc", "0x1", 1n)).ok, false);
});

test("Arc の RPC は ARC_RPC_URL、無ければ公開 RPC https://rpc.mainnet.arc.io（オーナー指定 2026-09-17）", async () => {
  const { arcRpcUrl, ARC_PUBLIC_RPC_URL } = await import("@/lib/chain/arc");
  const saved = process.env.ARC_RPC_URL;
  try {
    delete process.env.ARC_RPC_URL;
    assert.equal(ARC_PUBLIC_RPC_URL, "https://rpc.mainnet.arc.io");
    assert.equal(arcRpcUrl(), ARC_PUBLIC_RPC_URL);
    process.env.ARC_RPC_URL = "  ";
    assert.equal(arcRpcUrl(), ARC_PUBLIC_RPC_URL, "空白は未設定");
    process.env.ARC_RPC_URL = "https://arc.example.invalid";
    assert.equal(arcRpcUrl(), "https://arc.example.invalid");
  } finally {
    if (saved === undefined) delete process.env.ARC_RPC_URL;
    else process.env.ARC_RPC_URL = saved;
  }
});

// ---- 2026-09-17 レビュー 6: 記録する誤り文字列から URL（鍵入りの RPC URL）を伏せる ----
test("redactForLog: https?:// で始まる語は <url> に置き換わり、300 字に切る", () => {
  const e = new Error("HTTP request failed. URL: https://base-mainnet.g.alchemy.com/v2/SECRETKEY123 Request body: {}");
  const out = redactForLog(e);
  assert.ok(!out.includes("SECRETKEY123"), out);
  assert.ok(!out.includes("alchemy.com"), out);
  assert.match(out, /URL: <url> Request body/);
  assert.equal(redactForLog("a http://x.example/k?key=1 b https://y.example/z c"), "a <url> b <url> c");
  assert.equal(redactForLog("x".repeat(400)).length, 300);
});

test("残高が読めなかったときの verdict.error に RPC の URL が残らない", async () => {
  const f = createPayerFunds(async () => {
    throw new Error("fetch failed: https://rpc.example/v2/topsecret (timeout)");
  });
  const v = await f.check("arc", "0x1", 1n);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "unreadable");
  const err = v.ok === false && v.reason === "unreadable" ? v.error : "";
  assert.ok(!err.includes("topsecret") && !err.includes("rpc.example"), err);
  assert.match(err, /<url>/);
});

// ---- Celo（2026-10-10 Celo レーン）----
test("celo は base・arc と別のチェーンとして数える（Base の残高で Celo の署名を通さない）", async () => {
  const f = createPayerFunds(async ({ chain }) => (chain === "celo" ? 0n : 60_000_000n));
  assert.equal((await f.check("base", "0x1", 1000n)).ok, true);
  assert.equal((await f.check("arc", "0x1", 1000n)).ok, true);
  const v = await f.check("celo", "0x1", 1000n);
  assert.equal(v.ok, false, "同じ EOA でも Celo の USDC は別の残高");
  assert.equal(v.ok === false && v.reason, "insufficient");
  const g = createPayerFunds(async ({ chain }) => (chain === "celo" ? 3000n : 0n));
  assert.equal((await g.check("celo", "0x1", 3000n)).ok, true);
  g.commit("celo", "0x1", 3000n);
  assert.equal((await g.check("celo", "0x1", 1n)).ok, false, "このバッチで署名した額を差し引く");
});

test("既定の読み手: chain \"celo\" は CELO_RPC_URL の RPC に、Celo の USDC の balanceOf(owner) を問う", async () => {
  const { createServer } = await import("node:http");
  const { CELO_USDC } = await import("@/lib/observatory/x402-payer");
  const OWNER = "0xc9c7b38C0942914fC8EA12063BC92dcd3b581670";
  const calls: { method: string; to?: string; data?: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body) as { id: number; method: string; params: [{ to?: string; data?: string }] };
      calls.push({ method: rpc.method, to: rpc.params?.[0]?.to, data: rpc.params?.[0]?.data });
      res.setHeader("content-type", "application/json");
      // 123456 units（0.123456 USDC）
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: `0x${(123_456).toString(16).padStart(64, "0")}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const saved = process.env.CELO_RPC_URL;
  try {
    process.env.CELO_RPC_URL = `http://127.0.0.1:${port}`;
    const balance = await defaultPayerUsdcBalance({ chain: "celo", owner: OWNER });
    assert.equal(balance, 123_456n);
    const ethCalls = calls.filter((c) => c.method === "eth_call");
    assert.equal(ethCalls.length, 1);
    assert.equal(ethCalls[0].to?.toLowerCase(), CELO_USDC.toLowerCase(), "Celo の USDC（Base や Arc の USDC ではない）");
    assert.equal(ethCalls[0].data?.toLowerCase(), `0x70a08231${OWNER.slice(2).toLowerCase().padStart(64, "0")}`, "balanceOf(owner)");
  } finally {
    if (saved === undefined) delete process.env.CELO_RPC_URL;
    else process.env.CELO_RPC_URL = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("既定の読み手: Celo の RPC が答えなければ throw（読めない＝署名しない側へ倒れる）", async () => {
  const saved = process.env.CELO_RPC_URL;
  try {
    // 何も待ち受けていないポート。公開 RPC へは出ない。
    process.env.CELO_RPC_URL = "http://127.0.0.1:9";
    const f = createPayerFunds(defaultPayerUsdcBalance);
    const v = await f.check("celo", "0xc9c7b38C0942914fC8EA12063BC92dcd3b581670", 1n);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "unreadable");
    const err = v.ok === false && v.reason === "unreadable" ? v.error : "";
    assert.ok(!err.includes("127.0.0.1"), `RPC の URL を残さない: ${err}`);
  } finally {
    if (saved === undefined) delete process.env.CELO_RPC_URL;
    else process.env.CELO_RPC_URL = saved;
  }
});
