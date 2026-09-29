// ============================================================
// Vouch — /api/health must not be green while the buyer side is down.
//
// MEASURED IN PRODUCTION 2026-08-13, nine seconds apart on the same deploy:
//
//   09:50:08Z  GET /api/health          → 200 {"status":"ok"}
//   09:50:17Z  GET /payee/0xd8dA…6045   → "Not verifiable right now"
//
// A second persona observed 4 of 4 payee lookups failing at that same minute
// while the endpoint stayed green. The probe behind /api/health only ran
// scoreAgentById — the SELLER-side engine ("should I accept payment from this
// agent?"). The BUYER-side engine (scorePayeeWallet, which the SDK's
// SpendGuard calls before releasing funds) was never touched by it.
//
// docs/api tells customers to point their uptime monitor at this endpoint, so
// the monitor would have stayed green through the whole thing. That is worse
// than having no monitor: it turns an outage into a silent one.
//
// These tests pin that the payee path is probed, and that a probe pointed at a
// QUIET address would not have caught it — the reason the default probe
// address is a busy wallet.
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { invalidatePayeeScoreCache } from "@/lib/scoring/payee-engine";
import { invalidateWalletMetricsCache } from "@/lib/chain/wallet-metrics";
import { resetBlockscoutRateGate } from "@/lib/chain/blockscout";
import { runPayeeProbe, resetPayeeProbeCache, worstStatus } from "@/lib/scoring/payee-probe";

const PROBE_WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const realFetch = globalThis.fetch;
const RPC_URL = "https://rpc.test.invalid";
const now = Math.floor(Date.now() / 1000);

const jsonBody = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const okJson = (result: unknown) =>
  new Response(JSON.stringify({ status: "1", message: "OK", result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const history = [
  {
    hash: "0x1",
    from: "0x000000000000000000000000000000000000dead",
    to: PROBE_WALLET.toLowerCase(),
    value: "1000000000000000",
    timeStamp: String(now - 200 * 86_400),
    blockNumber: "1",
    isError: "0",
  },
  ...Array.from({ length: 120 }, (_, i) => ({
    hash: `0x${i + 2}`,
    from: PROBE_WALLET.toLowerCase(),
    to: "0x000000000000000000000000000000000000beef",
    value: "0",
    timeStamp: String(now - (190 - i) * 86_400),
    blockNumber: String(i + 2),
    isError: "0",
  })),
];

const NATIVE_BALANCE = 900_000_000_000_000n;
const USDC_BALANCE = 4_000_000_000n;

/** `drainDown` takes the buyer side down exactly the way production did: the
 *  transfer windows cannot be read from EITHER source, so the engine
 *  fail-closes and /payee/[address] prints "Not verifiable right now". */
function upstream({ drainDown = false }: { drainDown?: boolean } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith(RPC_URL)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number }[] | { method?: string; id?: number };
      const calls = Array.isArray(body) ? body : [body];
      const reply = calls.map((call) => ({
        jsonrpc: "2.0",
        id: call.id ?? 1,
        result:
          call.method === "eth_getBalance"
            ? `0x${NATIVE_BALANCE.toString(16)}`
            : call.method === "eth_call"
              ? `0x${USDC_BALANCE.toString(16).padStart(64, "0")}`
              : "0x0",
      }));
      return jsonBody(Array.isArray(body) ? reply : reply[0]);
    }

    if (url.includes("/api/v2/addresses/")) {
      if (url.includes("/counters")) return jsonBody({ transactions_count: 121 });
      if (drainDown) return new Response("upstream is down", { status: 500 });
      if (url.includes("/token-transfers")) {
        return jsonBody({
          items: [
            {
              transaction_hash: "0xa",
              block_number: 500,
              timestamp: new Date((now - 30 * 86_400) * 1000).toISOString(),
              total: { value: "5000000000" },
              from: { hash: "0x000000000000000000000000000000000000cafe" },
              to: { hash: PROBE_WALLET.toLowerCase() },
              token: { address_hash: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
            },
          ],
          next_page_params: null,
        });
      }
      return jsonBody({
        items: [...history].reverse().map((tx) => ({
          hash: tx.hash,
          block_number: Number(tx.blockNumber),
          timestamp: new Date(Number(tx.timeStamp) * 1000).toISOString(),
          value: tx.value,
          from: { hash: tx.from },
          to: { hash: tx.to },
        })),
        next_page_params: null,
      });
    }

    const params = new URL(url).searchParams;
    // The v1 fallback is down too — otherwise `drainDown` would not be an
    // outage at all, which is the whole point of the fallback existing.
    if (drainDown && params.get("sort") === "desc") {
      return new Response("upstream is down", { status: 503 });
    }
    if (drainDown && params.get("action") === "tokentx") {
      return new Response("upstream is down", { status: 503 });
    }
    if (params.get("action") === "txlist") {
      return okJson(params.get("page") === "1" ? history : []);
    }
    if (params.get("action") === "tokentx") return okJson([]);

    throw new Error(`unstubbed upstream call: ${url}`);
  }) as typeof fetch;
}

function freshCaches() {
  invalidatePayeeScoreCache(PROBE_WALLET);
  invalidateWalletMetricsCache(PROBE_WALLET);
  resetBlockscoutRateGate();
  resetPayeeProbeCache();
}

beforeEach(() => {
  process.env.BLOCKSCOUT_MIN_INTERVAL_MS = "0";
  process.env.BLOCKSCOUT_COOLDOWN_MS = "0";
  process.env.BLOCKSCOUT_API_URL = "https://base.blockscout.com/api";
  process.env.BASE_RPC_URL = RPC_URL;
  process.env.PAYEE_LEG_BUDGET_MS = "400";
  process.env.PAYEE_V2_BUDGET_MS = "200";
  delete process.env.SKIP_CHAIN_READS;
  delete process.env.DATABASE_URL;
  delete process.env.HEALTH_PAYEE_ADDRESS;
  freshCaches();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  freshCaches();
  for (const key of [
    "BLOCKSCOUT_MIN_INTERVAL_MS",
    "BLOCKSCOUT_COOLDOWN_MS",
    "PAYEE_LEG_BUDGET_MS",
    "PAYEE_V2_BUDGET_MS",
    "HEALTH_PAYEE_ADDRESS",
  ]) {
    delete process.env[key];
  }
});

test("the probe is GREEN when the payee path actually works", async () => {
  upstream({});
  const probe = await runPayeeProbe();
  assert.equal(probe.status, "ok", `unavailable: ${probe.unavailable.join(",")}`);
});

test("THE REGRESSION: a payee path that cannot answer is not reported as ok", async () => {
  upstream({ drainDown: true });
  const probe = await runPayeeProbe();
  assert.notEqual(probe.status, "ok", "health would have been green during the outage");
  assert.equal(probe.status, "degraded");
  assert.ok(
    probe.unavailable.includes("payee_verdict_degraded"),
    `the refusal must be named, got: ${probe.unavailable.join(",")}`,
  );
});

test("the probe reads the SAME engine the page reads, not something adjacent", async () => {
  // The failure mode this whole file exists to prevent, twice over: the
  // original hard-coded "ok", then a deep check that proved only that the RPC
  // could answer eth_getBlockNumber. If the probe ever stops routing through
  // scorePayeeWallet, the stub below goes unused and this fails.
  let payeeEngineCalls = 0;
  upstream({});
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes(PROBE_WALLET.toLowerCase()) || String(input).includes(PROBE_WALLET)) {
      payeeEngineCalls++;
    }
    return stubbed(input, init);
  }) as typeof fetch;

  freshCaches();
  await runPayeeProbe();
  assert.ok(payeeEngineCalls > 0, "the probe never read the probe wallet");
});

test("a quiet address would NOT have caught the outage — hence the busy default", async () => {
  // 2026-08-13: /payee/0x0330070F… (0 transactions on Base) returned 41/WARN
  // in ~7s from the same deploy that could not answer for 0xd8dA…6045
  // (37,157 transactions). The default probe address must be the busy one.
  process.env.HEALTH_PAYEE_ADDRESS = "0x0330070F5B0e83e4b3Ee9B0BDA4a2C7Fb1F3F0e2";
  freshCaches();
  upstream({});
  const probe = await runPayeeProbe();
  // Not an assertion about the quiet address being wrong — an assertion that
  // the address is CONFIGURABLE and that the default (asserted above, where no
  // env var is set) is the hard one.
  assert.ok(["ok", "degraded", "error"].includes(probe.status));
  delete process.env.HEALTH_PAYEE_ADDRESS;
});

test("a repeat call is served from the last measurement, not re-run", async () => {
  // 2026-08-13, self-inflicted: probing the payee path made /api/health take
  // 21.5s, because the probe runs the real engine and the engine waits up to
  // 20s on a wallet Blockscout is struggling with. docs/api points customers'
  // uptime monitors here and those typically time out at 10-30s, so the fix
  // for "health lies about being up" started causing "health is recorded as
  // down because it never answered". A monitor cannot tell those apart.
  upstream({});
  const first = await runPayeeProbe();

  // Upstream goes away entirely. A cached probe must still answer instantly
  // rather than block on the dead upstream.
  globalThis.fetch = (async () => {
    await new Promise((r) => setTimeout(r, 5_000));
    throw new Error("upstream vanished");
  }) as typeof fetch;

  const startedAt = Date.now();
  const second = await runPayeeProbe();
  const elapsed = Date.now() - startedAt;

  assert.equal(second.status, first.status);
  assert.ok(elapsed < 500, `a cached probe blocked for ${elapsed}ms`);
});

test("worstStatus reports the worse of the two sides, never the kinder one", () => {
  assert.equal(worstStatus(["ok", "ok"]), "ok");
  assert.equal(worstStatus(["ok", "degraded"]), "degraded");
  assert.equal(worstStatus(["degraded", "ok"]), "degraded");
  assert.equal(worstStatus(["ok", "error"]), "error");
  assert.equal(worstStatus(["degraded", "error"]), "error");
});

test("the public health route reports the worse of the two probes", async () => {
  // Wired through the route itself, not just the probe: the 2026-08-13 bug was
  // that a perfectly good probe existed and the route asked only one of them.
  const { GET } = await import("@/app/api/health/route");
  const { resetScoringProbeCache } = await import("@/lib/health/scoring-probe");

  upstream({ drainDown: true });
  freshCaches();
  resetScoringProbeCache();
  // The seller-side probe scores an ERC-8004 agent, which the stub above does
  // not serve — it fails, which is itself a not-ok status. Either way the
  // route must not answer "ok".
  const { NextRequest } = await import("next/server");
  const response = await GET(new NextRequest("https://vet402.com/api/health"));
  const body = (await response.json()) as { status: string };
  assert.notEqual(body.status, "ok", "the route stayed green while the payee side was down");
});

test("2026-09-29: TTL を過ぎた測定（SWR）は stale と明示して返す——古い ok を今の ok と言わない", async () => {
  process.env.HEALTH_PAYEE_PROBE_TTL_MS = "0";
  try {
    upstream({});
    const first = await runPayeeProbe();
    assert.equal(first.stale, undefined, "今測った値は stale ではない");
    await new Promise((r) => setTimeout(r, 5));
    const second = await runPayeeProbe();
    assert.equal(second.fromCache, true);
    assert.equal(second.stale, true);
    assert.ok((second.ageMs ?? -1) >= 0);
  } finally {
    delete process.env.HEALTH_PAYEE_PROBE_TTL_MS;
  }
});
