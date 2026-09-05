// `pay` の唯一の不変条件: **`--live` が無ければ署名器に到達しない。**
//
// 数え方は `packages/sdk/test/pay-or-refuse.test.mjs` と同じ手（第1層）——
// account を Proxy で包み、**`sign*` へのプロパティ参照**を数える。呼び出し回数ではなく
// 参照を見るのは、配線を間違えたテストが緑になるのを防ぐため。
// そして 0 回が配線ミスでないことを、同じハーネスの**ネガティブコントロール**で示す。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runPay, PAY_TARGET, SDK_AUTHORIZATION_WINDOW_SECONDS } from "../src/pay.ts";
import { createEmitter } from "../src/emit.ts";

const PAYER = "0xDB62BD202914609830fA656F87996b91be3Aa673";

/** 第1層: signer への「参照」を記録する Proxy。 */
function watchedAccount() {
  const accessed = [];
  const account = new Proxy(
    { address: PAYER, signTypedData: async () => "0x" + "11".repeat(65) },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

const ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "10000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: PAY_TARGET.payee,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
};

const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

/** ALLOW まで到達できる世界を作る。ここで止まらなければ、止めているのは `--live` の判定だけ。 */
function allowingFetch() {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}`);
    const reply = (status, body, headers = {}) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Map(Object.entries(headers)),
    });
    if (u.includes("/decision")) return reply(404, { error: "not_found" });
    if (u.includes("gateway.thegraph.com") && !u.includes("/api/x402/")) {
      return reply(200, {
        data: {
          _meta: { block: { number: 50890586, timestamp: 1788570519 }, deployment: "QmDemoDeployment" },
          x402AddressSummaries: [
            { role: "RECIPIENT", totalPayments: "253", totalVolumeDecimal: "2.53", firstPaymentTimestamp: "1", lastPaymentTimestamp: "2" },
          ],
        },
      });
    }
    if (u.includes("/payees/")) {
      return reply(200, { payee: PAY_TARGET.payee, score: 90, recommendation: "ALLOW", degraded: false, signalsUnavailable: [] });
    }
    if (u.includes("/payments/x402")) return reply(200, { ok: true });
    // 売り手。支払いヘッダが無ければ 402、有れば 200 + レシート。
    const paid = init?.headers && Object.keys(init.headers).some((k) => k.toUpperCase() === "PAYMENT-SIGNATURE");
    if (paid) {
      return reply(200, { ok: true }, {
        "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: PAYER }),
      });
    }
    return reply(402, {}, { "payment-required": b64({ x402Version: 2, accepts: [ACCEPT] }) });
  };
  return { fetch, calls };
}

const env = { GRAPH_API_KEY: "graphkey-0123456789", VOUCH_API_KEY: "vouchkey-0123456789", DEMO_PAYER_PRIVATE_KEY: "0x" + "cd".repeat(32) };
const sink = () => (() => {});

test("既定（--live 無し）では、ALLOW に到達できる世界でも署名器に触れない", async () => {
  const w = watchedAccount();
  const f = allowingFetch();
  const out = [];
  const result = await runPay({
    live: false,
    env,
    fetch: f.fetch,
    account: w.account,
    emit: createEmitter({ sink: (l) => out.push(l), secrets: [] }),
  });
  assert.deepEqual(w.signAccesses(), [], "空撃ちで signer に触れている");
  assert.equal(result.result, null, "空撃ちで payOrRefuse を走らせている");
  assert.match(out.join("\n"), /DRY RUN/);
  assert.match(out.join("\n"), /no signature was created/i);
  // 支払いヘッダ付きの再送が1本も出ていない
  assert.equal(f.calls.some((c) => c.includes("PAYMENT")), false);
});

// ネガティブコントロール。0 回が「配線ミスで何も動いていない」ではないことを示す。
test("--live を明示すると、同じハーネスで signTypedData がちょうど1回参照される", async () => {
  const w = watchedAccount();
  const f = allowingFetch();
  const out = [];
  const result = await runPay({
    live: true,
    env,
    fetch: f.fetch,
    account: w.account,
    emit: createEmitter({ sink: (l) => out.push(l), secrets: [] }),
  });
  assert.deepEqual(w.signAccesses(), ["signTypedData"], "ネガティブコントロールが署名していない");
  assert.equal(result.result.status, "paid");
  assert.equal(result.result.signed, true);
  assert.match(String(result.result.nonce), /^0x[0-9a-f]{64}$/);
});

test("空撃ちでも「何に署名するはずだったか」は本物の 402 から取る", async () => {
  const out = [];
  const f = allowingFetch();
  const { view } = await runPay({
    live: false,
    env,
    fetch: f.fetch,
    account: watchedAccount().account,
    emit: createEmitter({ sink: (l) => out.push(l), secrets: [] }),
  });
  assert.equal(view.accept.amount, "10000");
  assert.equal(view.accept.payTo, PAY_TARGET.payee);
  assert.equal(view.subgraph.block.number, 50890586);
  assert.equal(view.payeeScore.recommendation, "ALLOW");
});

test("鍵が無ければ、足りない名前だけを言って落ちる（値は出さない）", async () => {
  await assert.rejects(
    () => runPay({
      live: false,
      env: { VOUCH_API_KEY: "vouchkey-0123456789" },
      fetch: allowingFetch().fetch,
      account: watchedAccount().account,
      emit: createEmitter({ sink: sink(), secrets: [] }),
    }),
    (error) => {
      assert.match(error.message, /GRAPH_API_KEY/);
      assert.equal(/vouchkey-0123456789/.test(error.message), false, "他の鍵の値が漏れている");
      return true;
    },
  );
});

// 画に出す「認可の窓」は SDK の実装値でなければ意味が無い。手で書いた数字が古くなるのを止める。
test("画に出す認可の窓は、SDK が実際に使う値と一致している", () => {
  const source = readFileSync(new URL("../../../packages/sdk/dist/x402-pay.js", import.meta.url), "utf8");
  const found = /MAX_AUTHORIZATION_WINDOW_SECONDS\s*=\s*(\d+)/.exec(source);
  assert.ok(found, "SDK 側の定数が見つからない（改名された？）");
  assert.equal(Number(found[1]), SDK_AUTHORIZATION_WINDOW_SECONDS);
});

// 「支払いモジュールは読み込まれてすらいない」を主張として書いた以上、計器にする。
// SDK 側は `packages/sdk/test/no-static-payment-import.test.mjs` が dist の静的グラフで
// 同じことを見ている。デモ側は**自分が x402-pay を静的に掴んでいないこと**を見る。
test("デモの src は支払いモジュールを静的 import しない", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/", import.meta.url).pathname;
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const body = readFileSync(dir + name, "utf8");
    if (/^\s*import[^\n]*x402-pay/m.test(body)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test("payOrRefuse 自体も、--live の枝の中でだけ import される", async () => {
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(new URL("../src/pay.ts", import.meta.url).pathname, "utf8");
  assert.equal(/^\s*import\s*\{[^}]*payOrRefuse/m.test(body), false, "payOrRefuse を静的 import している");
  assert.match(body, /await import\((?:"|')\.\.\/\.\.\/\.\.\/packages\/sdk\/dist\/index\.js(?:"|')\)/);
});
