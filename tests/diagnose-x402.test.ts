// B2: 未掲載 URL の払う前の診断。鍵なし・無料・財布なし。
// 直す前のコードではこのファイルの import が落ちる。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { handleDiagnose } from "@/lib/api/diagnose-handler";
import { DIAGNOSE_BODY_CAP_BYTES, diagnoseLive, judgeChallenge, type DiagnoseBody, type JudgeInput } from "@/lib/diagnose/diagnose";
import { CHECK_IDS, VERDICTS, publicEnglishFaults } from "@/lib/diagnose/copy";
import { XRPL_RPC_URL_DEFAULT } from "@/lib/observatory/xrpl402-payer";
import { BASE_USDC, ARC_USDC, CELO_USDC, ARBITRUM_USDC, AVALANCHE_USDC } from "@/lib/observatory/x402-payer";
import { SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";
import { TEMPO_USDC_E } from "@/lib/observatory/mpp-payer";
import { pinnedAssetFor } from "@/lib/diagnose/assets";

const NOW = new Date("2026-11-12T00:00:00.000Z");
const SELLER = "https://seller.example/paid";
const PAY = "0x1111111111111111111111111111111111111111";
const POLY = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const SOL_PAY = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const SOL_FEE = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const XRPL_PAY = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const XRPL_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const STELLAR_PAY = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const STELLAR_ASSET = `USDC:${STELLAR_PAY}`;

function challenge(accepts: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ x402Version: 2, resource: { url: SELLER }, accepts, ...extra });
}

function accept(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: BASE_USDC,
    payTo: PAY,
    ...over,
  };
}

function judge(body: string, over: Partial<JudgeInput> = {}): DiagnoseBody {
  return judgeChallenge({
    requestedUrl: SELLER,
    method: "GET",
    httpStatus: 402,
    headers: new Headers(),
    bodyText: body,
    now: NOW,
    catalog: { listed: false, check_url: null },
    ...over,
  });
}

function one(body: DiagnoseBody, id: string): string | undefined {
  return body.checks.find((c) => c.id === id)?.status;
}

function assertEnglish(text: string): void {
  const faults = publicEnglishFaults(text);
  assert.deepEqual(faults, [], `${text} :: ${faults.join(",")}`);
  assert.equal(text.includes("\n"), false);
}

function assertPartition(body: DiagnoseBody): void {
  const extra = body.not_checked.map((n) => n.id).filter((id) => id !== "catalog");
  const ids = [...body.checked, ...extra];
  assert.deepEqual([...ids].sort(), [...CHECK_IDS].sort());
  const overlap = body.checked.filter((id) => body.not_checked.some((n) => n.id === id));
  assert.deepEqual(overlap, []);
  assert.ok(VERDICTS.includes(body.verdict), body.verdict);
  for (const check of body.checks) assertEnglish(check.fix);
  for (const row of body.not_checked) assertEnglish(row.reason);
}

const clean = () => judge(challenge([accept()]));

test("clean Base 402 is ALLOW and names the cheapest accept", () => {
  const body = judge(challenge([accept({ amount: "5000" }), accept({ amount: "1000", payTo: "0x2222222222222222222222222222222222222222" })]));
  assertPartition(body);
  assert.equal(body.verdict, "ALLOW");
  assert.equal(body.as_of, NOW.toISOString());
  assert.equal(body.recommended_accept?.amount, "1000");
  assert.equal(body.recommended_accept?.usd_atomic, "1000");
  assert.equal(body.recommended_accept?.scheme, "exact");
  assert.equal(one(body, "returns_402"), "pass");
  assert.equal(one(body, "x402_shape"), "pass");
  assert.equal(one(body, "header_body"), "pass");
  assert.equal(one(body, "resource_url"), "pass");
  assert.equal(one(body, "amount_atomic"), "pass");
  assert.equal(one(body, "network_caip2"), "pass");
  assert.equal(one(body, "asset_usdc"), "pass");
  assert.equal(one(body, "payto"), "pass");
  assert.equal(one(body, "testnet_only"), "pass");
  assert.equal(one(body, "scheme"), "pass");
  assert.ok(body.not_checked.some((n) => n.id === "solana_fee_payer"));
  assert.ok(body.not_checked.some((n) => n.id === "account_readiness"));
  assert.equal(body.catalog?.listed, false);
});

test("returns_402 fail when the status is not 402", () => {
  const body = judge(challenge([accept()]), { httpStatus: 200 });
  assertPartition(body);
  assert.equal(one(body, "returns_402"), "fail");
  assert.equal(body.verdict, "BLOCK");
  assert.equal(body.recommended_accept, null);
  assert.equal(body.checked.length, 1);
});

test("x402_shape fail on a 402 that is not v1 or v2", () => {
  const body = judge("not json");
  assertPartition(body);
  assert.equal(one(body, "returns_402"), "pass");
  assert.equal(one(body, "x402_shape"), "fail");
  assert.equal(body.verdict, "BLOCK");
});

test("x402 v1 body with maxAmountRequired passes the shape check", () => {
  const raw = JSON.stringify({
    x402Version: 1,
    accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "1000", asset: BASE_USDC, payTo: PAY, resource: SELLER }],
  });
  const body = judge(raw);
  assert.equal(one(body, "x402_shape"), "pass");
  assert.equal(body.verdict, "ALLOW");
});

test("header and body pass when only the body is present", () => {
  assert.equal(one(clean(), "header_body"), "pass");
});

test("header and body fail when the amount disagrees", () => {
  const header = challenge([accept({ amount: "1000" })]);
  const bodyText = challenge([accept({ amount: "2000" })]);
  const headers = new Headers({ "payment-required": Buffer.from(header).toString("base64") });
  const body = judge(bodyText, { headers });
  assert.equal(one(body, "header_body"), "fail");
  assert.equal(body.verdict, "BLOCK");
  assert.equal(body.recommended_accept, null);
});

test("header and body pass when the body carries only an error message", () => {
  const header = challenge([accept()]);
  const headers = new Headers({ "payment-required": Buffer.from(header).toString("base64") });
  const body = judge(JSON.stringify({ error: "Proceed with API key or make a X402 payment to continue" }), { headers });
  assert.equal(one(body, "header_body"), "pass");
  assert.notEqual(body.verdict, "BLOCK");
  assert.notEqual(body.recommended_accept, null);
});

test("header and body fail when the body carries accepts under an unreadable version", () => {
  const header = challenge([accept({ amount: "1000" })]);
  const headers = new Headers({ "payment-required": Buffer.from(header).toString("base64") });
  const bodyText = JSON.stringify({ x402Version: 9, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "999999", asset: BASE_USDC, payTo: PAY }] });
  const body = judge(bodyText, { headers });
  assert.equal(one(body, "header_body"), "fail");
  assert.equal(body.verdict, "BLOCK");
});

test("resource_url pass and fail", () => {
  assert.equal(one(clean(), "resource_url"), "pass");
  const bad = judge(challenge([accept()], { resource: { url: "https://evil.example/other" } }));
  assert.equal(one(bad, "resource_url"), "fail");
  assert.equal(bad.verdict, "BLOCK");
  const missing = judge(JSON.stringify({ x402Version: 2, accepts: [accept()] }));
  assert.equal(one(missing, "resource_url"), "warn");
  assert.equal(missing.verdict, "WARN");
  assert.ok(missing.recommended_accept);
});

test("amount_atomic pass and fail", () => {
  assert.equal(one(clean(), "amount_atomic"), "pass");
  const bad = judge(challenge([accept({ amount: "0.01" })]));
  assert.equal(one(bad, "amount_atomic"), "fail");
  assert.equal(bad.verdict, "BLOCK");
  const mixed = judge(challenge([accept({ amount: "0.01" }), accept({ amount: "1000" })]));
  assert.equal(one(mixed, "amount_atomic"), "fail");
  assert.equal(mixed.verdict, "WARN");
  assert.equal(mixed.recommended_accept?.amount, "1000");
});

test("network_caip2 pass, legacy warn, unknown fail", () => {
  assert.equal(one(clean(), "network_caip2"), "pass");
  const legacy = judge(challenge([accept({ network: "base" })]));
  assert.equal(one(legacy, "network_caip2"), "warn");
  assert.equal(legacy.verdict, "WARN");
  assert.equal(legacy.recommended_accept?.network, "base");
  const unknown = judge(challenge([accept({ network: "mainnet" })]));
  assert.equal(one(unknown, "network_caip2"), "fail");
  assert.equal(unknown.verdict, "BLOCK");
});

test("asset_usdc pass on the pinned token and fail on another network's USDC", () => {
  assert.equal(one(clean(), "asset_usdc"), "pass");
  const mixed = judge(challenge([accept({ asset: POLY })]));
  assert.equal(one(mixed, "asset_usdc"), "fail");
  assert.equal(mixed.verdict, "BLOCK");
  const unknown = judge(challenge([accept({ asset: "0x00000000000000000000000000000000000000ab" })]));
  assert.equal(one(unknown, "asset_usdc"), "warn");
  assert.equal(unknown.verdict, "BLOCK");
});

test("pinned USDC table matches the pay lanes", () => {
  assert.equal(pinnedAssetFor("eip155:8453", BASE_USDC)?.kind, "usdc");
  assert.equal(pinnedAssetFor("eip155:5042", ARC_USDC)?.kind, "usdc");
  assert.equal(pinnedAssetFor("eip155:42220", CELO_USDC)?.kind, "usdc");
  assert.equal(pinnedAssetFor("eip155:42161", ARBITRUM_USDC)?.kind, "usdc");
  assert.equal(pinnedAssetFor("eip155:43114", AVALANCHE_USDC)?.kind, "usdc");
  assert.equal(pinnedAssetFor("eip155:137", POLY)?.kind, "usdc");
  assert.equal(pinnedAssetFor("eip155:4217", TEMPO_USDC_E)?.kind, "usdc");
  assert.equal(pinnedAssetFor(SOL_NET, SOLANA_USDC_MINT)?.kind, "usdc");
});

test("payto pass, zero fail, burn fail", () => {
  assert.equal(one(clean(), "payto"), "pass");
  const zero = judge(challenge([accept({ payTo: "0x0000000000000000000000000000000000000000" })]));
  assert.equal(one(zero, "payto"), "fail");
  assert.equal(zero.verdict, "BLOCK");
  const dead = judge(challenge([accept({ payTo: "0x000000000000000000000000000000000000dEaD" })]));
  assert.equal(one(dead, "payto"), "fail");
  assert.equal(dead.verdict, "BLOCK");
});

test("testnet_only pass, fail, and warn", () => {
  assert.equal(one(clean(), "testnet_only"), "pass");
  const only = judge(challenge([accept({ network: "eip155:84532", asset: BASE_USDC })]));
  assert.equal(one(only, "testnet_only"), "fail");
  assert.equal(only.verdict, "BLOCK");
  const mix = judge(challenge([accept(), accept({ network: "eip155:84532", amount: "1" })]));
  assert.equal(one(mix, "testnet_only"), "warn");
  assert.equal(mix.verdict, "WARN");
  assert.equal(mix.recommended_accept?.network, "eip155:8453");
});

test("solana feePayer pass when it differs and fail when it equals payTo", () => {
  const ok = judge(challenge([accept({ network: SOL_NET, asset: SOLANA_USDC_MINT, payTo: SOL_PAY, extra: { feePayer: SOL_FEE } })]));
  assert.equal(one(ok, "solana_fee_payer"), "pass");
  assert.equal(ok.verdict, "ALLOW");
  const same = judge(challenge([accept({ network: SOL_NET, asset: SOLANA_USDC_MINT, payTo: SOL_PAY, extra: { feePayer: SOL_PAY } })]));
  assert.equal(one(same, "solana_fee_payer"), "fail");
  assert.equal(same.verdict, "BLOCK");
  const missing = judge(challenge([accept({ network: SOL_NET, asset: SOLANA_USDC_MINT, payTo: SOL_PAY })]));
  assert.equal(one(missing, "solana_fee_payer"), "fail");
  assert.equal(missing.verdict, "BLOCK");
});

test("scheme exact upto batch-settlement and auth-capture pass, other schemes are info", () => {
  for (const scheme of ["exact", "upto", "batch-settlement", "auth-capture"]) {
    const body = judge(challenge([accept({ scheme })]));
    assert.equal(one(body, "scheme"), "pass", scheme);
    assert.equal(body.verdict, "ALLOW", scheme);
    assert.equal(body.recommended_accept?.scheme, scheme);
  }
  const info = judge(challenge([accept({ scheme: "l402" })]));
  assert.equal(one(info, "scheme"), "info");
  assert.equal(info.verdict, "BLOCK");
  assert.equal(info.recommended_accept, null);
  const beside = judge(challenge([accept({ scheme: "l402", amount: "1" }), accept()]));
  assert.equal(one(beside, "scheme"), "info");
  assert.equal(beside.verdict, "WARN");
  assert.equal(beside.recommended_accept?.scheme, "exact");
});

test("XRPL readiness pass and fail stay inside the three verdict words", () => {
  const xrpl = accept({
    network: "xrpl:0",
    asset: "RLUSD",
    payTo: XRPL_PAY,
    extra: { issuer: XRPL_ISSUER },
  });
  const ready = judge(challenge([xrpl]), { readiness: { [XRPL_PAY]: "ready" } });
  assert.equal(one(ready, "account_readiness"), "pass");
  assert.equal(ready.verdict, "ALLOW");
  const inactive = judge(challenge([xrpl]), { readiness: { [XRPL_PAY]: "inactive" } });
  assert.equal(one(inactive, "account_readiness"), "fail");
  assert.equal(inactive.verdict, "BLOCK");
  const noLine = judge(challenge([xrpl]), { readiness: { [XRPL_PAY]: "no_trustline" } });
  assert.equal(one(noLine, "account_readiness"), "fail");
  assert.equal(noLine.verdict, "BLOCK");
  const unread = judge(challenge([xrpl]), { readiness: { [XRPL_PAY]: "unreadable" } });
  assert.equal(one(unread, "account_readiness"), undefined);
  assert.ok(unread.not_checked.some((n) => n.id === "account_readiness"));
  assert.equal(unread.verdict, "WARN");
  assert.ok(unread.recommended_accept);
});

test("Stellar trustline pass and fail", () => {
  const row = accept({ network: "stellar:pubnet", asset: STELLAR_ASSET, payTo: STELLAR_PAY, amount: "10000000" });
  const ready = judge(challenge([row]), { readiness: { [STELLAR_PAY]: "ready" } });
  assert.equal(one(ready, "account_readiness"), "pass");
  assert.equal(ready.verdict, "ALLOW");
  assert.equal(ready.recommended_accept?.usd_atomic, "1000000");
  const missing = judge(challenge([row]), { readiness: { [STELLAR_PAY]: "no_trustline" } });
  assert.equal(one(missing, "account_readiness"), "fail");
  assert.equal(missing.verdict, "BLOCK");
});

test("a catalogued URL points at GET /api/v1/check", () => {
  const check_url = `https://vet402.com/api/v1/check?url=${encodeURIComponent(SELLER)}&method=GET`;
  const body = judge(challenge([accept()]), { catalog: { listed: true, check_url } });
  assert.equal(body.catalog?.listed, true);
  assert.equal(body.catalog?.check_url, check_url);
  assert.equal(body.verdict, "ALLOW");
});

test("verdict never leaves ALLOW WARN BLOCK", () => {
  const samples = [
    clean(),
    judge(challenge([accept()]), { httpStatus: 404 }),
    judge("nope"),
    judge(challenge([accept({ scheme: "l402" })])),
    judge(challenge([accept({ network: "base" })])),
    judge(challenge([accept({ amount: "0.01" }), accept()])),
  ];
  for (const body of samples) assert.ok(VERDICTS.includes(body.verdict));
  const src = readdirSync("src/lib/diagnose")
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join("src/lib/diagnose", name), "utf8"))
    .join("\n");
  assert.equal(src.includes("NO_GO"), false);
  assert.equal(src.includes("no_go"), false);
  assert.equal(/\bcaution\b/.test(src), false);
});

const PUBLIC = [{ address: "1.1.1.1", family: 4 }];

test("SSRF rejects private targets before fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("fetch should not run");
  };
  const cases = [
    "https://127.0.0.1/latest",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/admin",
    "https://10.1.2.3/x",
    "https://seller.example/paid",
  ];
  for (const url of cases) {
    calls = 0;
    const resolve = async () => (url.includes("seller.example") ? [{ address: "10.1.2.3", family: 4 }] : PUBLIC);
    const out = await diagnoseLive({
      url,
      fetchImpl,
      resolve,
      now: () => NOW,
      dbPresent: false,
      catalogLookup: async () => "absent",
    });
    assert.equal(out.ok, false, url);
    if (!out.ok) assert.equal(out.error, "unsafe_target", url);
    assert.equal(calls, 0, url);
  }
});

test("one unpaid fetch, no payment header, no global fetch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("global fetch");
  };
  const calls: { url: string; method: string; headers: string; body: string | null }[] = [];
  try {
    const out = await diagnoseLive({
      url: SELLER,
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          method: String(init?.method ?? "GET"),
          headers: [...headers.entries()].map(([k, v]) => `${k}:${v}`).join("\n").toLowerCase(),
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response(challenge([accept()]), { status: 402, headers: { "content-type": "application/json" } });
      },
      resolve: async () => PUBLIC,
      now: () => NOW,
      dbPresent: false,
      catalogLookup: async () => "absent",
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.body.verdict, "ALLOW");
      assert.equal(out.body.http_status, 402);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.headers.includes("x-payment"), false);
    assert.equal(calls[0]?.headers.includes("payment-signature"), false);
    assert.equal(calls[0]?.body, null);
  } finally {
    globalThis.fetch = original;
  }
});

test("POST is fetched once with an empty json body and still does not pay", async () => {
  const calls: string[] = [];
  const out = await diagnoseLive({
    url: SELLER,
    method: "POST",
    fetchImpl: async (_url, init) => {
      calls.push(String(init?.method));
      calls.push(String(init?.body));
      const headers = new Headers(init?.headers);
      calls.push(headers.get("payment-signature") ?? "");
      return new Response(challenge([accept()]), { status: 402 });
    },
    resolve: async () => PUBLIC,
    now: () => NOW,
    dbPresent: false,
    catalogLookup: async () => "listed",
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.body.catalog?.listed, true);
    assert.match(out.body.catalog?.check_url ?? "", /^https:\/\/vet402\.com\/api\/v1\/check\?/);
    assert.match(out.body.catalog?.check_url ?? "", /method=POST/);
  }
  assert.deepEqual(calls.slice(0, 2), ["POST", "{}"]);
  assert.equal(calls[2], "");
});

test("a hung fetch ends as BLOCK without a second try", async () => {
  let calls = 0;
  const out = await diagnoseLive({
    url: SELLER,
    timeoutMs: 30,
    fetchImpl: (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
    resolve: async () => PUBLIC,
    now: () => NOW,
    dbPresent: false,
    catalogLookup: async () => "absent",
  });
  assert.equal(calls, 1);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.body.verdict, "BLOCK");
    assert.equal(out.body.http_status, null);
  }
});

test("the body reader stops at the cap", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled > DIAGNOSE_BODY_CAP_BYTES + 64 * 1024) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(8 * 1024);
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const out = await diagnoseLive({
    url: SELLER,
    fetchImpl: async () => new Response(stream, { status: 402 }),
    resolve: async () => PUBLIC,
    now: () => NOW,
    dbPresent: false,
    catalogLookup: async () => "absent",
  });
  assert.ok(pulled < DIAGNOSE_BODY_CAP_BYTES + 16 * 1024, `pulled ${pulled}`);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.body.verdict, "BLOCK");
});

test("XRPL readiness uses the public RPC through the injected fetch only", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("global fetch");
  };
  const hosts: string[] = [];
  try {
    const out = await diagnoseLive({
      url: SELLER,
      fetchImpl: async (url, init) => {
        const href = String(url);
        hosts.push(new URL(href).host);
        if (href.startsWith(SELLER)) {
          const row = accept({ network: "xrpl:0", asset: "RLUSD", payTo: XRPL_PAY, extra: { issuer: XRPL_ISSUER } });
          return new Response(challenge([row]), { status: 402 });
        }
        const payload = JSON.parse(String(init?.body));
        if (payload.method === "account_info") {
          return new Response(JSON.stringify({ result: { status: "success", account_data: { Account: XRPL_PAY } } }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            result: {
              status: "success",
              lines: [{ currency: "524C555344000000000000000000000000000000", account: XRPL_ISSUER }],
            },
          }),
          { status: 200 },
        );
      },
      resolve: async () => PUBLIC,
      now: () => NOW,
      dbPresent: false,
      catalogLookup: async () => "absent",
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(one(out.body, "account_readiness"), "pass");
      assert.equal(out.body.verdict, "ALLOW");
    }
    assert.equal(hosts.filter((h) => h === "seller.example").length, 1);
    assert.ok(hosts.some((h) => h === new URL(XRPL_RPC_URL_DEFAULT).host));
    assert.equal(hosts.every((h) => h === "seller.example" || h === new URL(XRPL_RPC_URL_DEFAULT).host), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("handler rejects bad queries and does not fetch", async () => {
  let calls = 0;
  const deps = {
    fetchImpl: async () => {
      calls += 1;
      throw new Error("no fetch");
    },
    resolve: async () => PUBLIC,
    now: () => NOW,
    dbPresent: false as const,
    catalogLookup: async () => "absent" as const,
  };
  const req = (qs: string) => new Request(`https://vet402.com/api/v1/diagnose${qs}`);
  assert.equal((await handleDiagnose(req(""), deps)).status, 400);
  assert.equal((await handleDiagnose(req("?url=http%3A%2F%2Fseller.example%2Fpaid"), deps)).status, 400);
  assert.equal((await handleDiagnose(req("?url=https%3A%2F%2Fseller.example%2Fpaid&method=PUT"), deps)).status, 400);
  assert.equal((await handleDiagnose(req("?url=https%3A%2F%2Fseller.example%2Fpaid&cb=1"), deps)).status, 400);
  assert.equal(calls, 0);
  const ok = await handleDiagnose(req(`?url=${encodeURIComponent(SELLER)}`), {
    ...deps,
    fetchImpl: async () => new Response(challenge([accept()]), { status: 402 }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.verdict, "ALLOW");
  assert.equal(ok.headers.get("x-robots-tag"), "noindex");
});

test("diagnose source does not call payment or signing functions", () => {
  const banned = ["signTypedData", "signX402Payment", "createStellarPaymentPayload", "payOrRefuse", "privateKey", "--pay", "--send", "X-PAYMENT", "PAYMENT-SIGNATURE"];
  const files = readdirSync("src/lib/diagnose").filter((name) => name.endsWith(".ts"));
  assert.ok(files.length >= 4);
  for (const name of files) {
    const src = readFileSync(join("src/lib/diagnose", name), "utf8");
    for (const word of banned) assert.equal(src.includes(word), false, `${name} contains ${word}`);
  }
  const route = readFileSync("src/app/api/v1/diagnose/route.ts", "utf8");
  assert.ok(route.includes("publicRateLimit"));
  assert.ok(route.includes("diagnose"));
  assert.ok(readFileSync("public/llms.txt", "utf8").includes("/api/v1/diagnose"));
  assert.ok(readFileSync("src/app/docs/api/page.tsx", "utf8").includes("/api/v1/diagnose"));
  assert.ok(readFileSync("docs/openapi.yaml", "utf8").includes("/api/v1/diagnose"));
  const llms = readFileSync("public/llms.txt", "utf8");
  const line = llms.split("\n").find((row) => row.includes("/api/v1/diagnose"));
  assert.ok(line);
  assert.deepEqual(publicEnglishFaults(line!), []);
});

test("catalog lookup is skipped when the database is not in play", async () => {
  const out = await diagnoseLive({
    url: SELLER,
    fetchImpl: async () => new Response(challenge([accept()]), { status: 402 }),
    resolve: async () => PUBLIC,
    now: () => NOW,
    dbPresent: false,
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.body.catalog, null);
    assert.ok(out.body.not_checked.some((n) => n.id === "catalog"));
    assert.equal(out.body.verdict, "ALLOW");
  }
});
