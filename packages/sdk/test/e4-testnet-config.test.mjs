import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  TESTNET_CHAIN_ID,
  DEFAULT_RPC,
  PRICE_UNITS,
  TOTAL_CAP_UNITS,
  E4_TESTNET_SCENARIOS,
  assertTestnetChainId,
  resolveConfig,
  readPrivateKeyFile,
  preflight,
  assertSpendWithinCap,
  plannedBuyerOutflowUnits,
  assertNoSecretsInText,
  rpcOriginForRecord,
  minEthWei,
} from "../scripts/e4-testnet-config.mjs";

test("assertTestnetChainId accepts 84532 only", () => {
  assertTestnetChainId(84532);
  for (const bad of [8453, 1, "84532", undefined]) {
    assert.throws(() => assertTestnetChainId(bad), /e4_testnet_wrong_chain/);
  }
});

test("resolveConfig defaults and required env", () => {
  const cfg = resolveConfig({
    E4_BUYER_KEY_FILE: "/tmp/buyer.key",
    E4_OPERATOR_KEY_FILE: "/tmp/op.key",
    E4_OUT: "/tmp/out.json",
  });
  assert.equal(cfg.rpc, DEFAULT_RPC);
  assert.equal(cfg.buyerKeyFile, "/tmp/buyer.key");
  assert.equal(cfg.reclaimWaitMaxSec, 420);
  assert.throws(
    () => resolveConfig({ E4_OPERATOR_KEY_FILE: "x", E4_OUT: "y" }),
    /E4_BUYER_KEY_FILE/,
  );
  assert.throws(
    () => resolveConfig({ E4_BUYER_KEY_FILE: "x", E4_OUT: "y" }),
    /E4_OPERATOR_KEY_FILE/,
  );
  assert.throws(
    () =>
      resolveConfig({
        E4_BUYER_KEY_FILE: "x",
        E4_OPERATOR_KEY_FILE: "y",
      }),
    /E4_OUT/,
  );
  assert.throws(
    () =>
      resolveConfig({
        E4_BUYER_KEY_FILE: "x",
        E4_OPERATOR_KEY_FILE: "y",
        E4_OUT: "z",
        E4_TESTNET_RPC: "wss://evil",
      }),
    (e) => e.message.includes("e4_testnet_bad_rpc") && e.message.includes("wss://evil") && !e.message.includes("user:"),
  );
  assert.throws(
    () =>
      resolveConfig({
        E4_BUYER_KEY_FILE: "x",
        E4_OPERATOR_KEY_FILE: "y",
        E4_OUT: "z",
        E4_TESTNET_RPC: "wss://user:pass@sepolia.base.org/path?q=1",
      }),
    (e) => {
      assert.match(e.message, /e4_testnet_bad_rpc: wss:\/\/sepolia\.base\.org/);
      assert.doesNotMatch(e.message, /user:pass/);
      assert.doesNotMatch(e.message, /\?q=/);
      return true;
    },
  );
  assert.throws(
    () =>
      resolveConfig({
        E4_BUYER_KEY_FILE: "x",
        E4_OPERATOR_KEY_FILE: "y",
        E4_OUT: "z",
        E4_TESTNET_RPC: "not-a-url",
      }),
  /e4_testnet_bad_rpc: unparseable/,
  );
});

test("rpcOriginForRecord strips userinfo and query", () => {
  assert.equal(rpcOriginForRecord("https://sepolia.base.org"), "https://sepolia.base.org");
  assert.equal(
    rpcOriginForRecord("https://user:pass@sepolia.base.org/path?q=1"),
    "https://sepolia.base.org",
  );
});

test("E4_TESTNET_SCENARIOS has eight ids and planned outflow 20000", () => {
  assert.equal(E4_TESTNET_SCENARIOS.length, 8);
  assert.deepEqual(
    E4_TESTNET_SCENARIOS.map((s) => s.id),
    [
      "delivered",
      "fail500",
      "empty200",
      "accepted202",
      "official202",
      "ceiling_sdk",
      "ceiling_chain",
      "vanish_reclaim",
    ],
  );
  assert.equal(plannedBuyerOutflowUnits(E4_TESTNET_SCENARIOS), 20000n);
  assert.equal(plannedBuyerOutflowUnits(), 20000n);
  assert.ok(plannedBuyerOutflowUnits() <= TOTAL_CAP_UNITS);
});

test("preflight checks chain before readKeyFile", async () => {
  let reads = 0;
  await assert.rejects(
    () =>
      preflight(
        {
          E4_BUYER_KEY_FILE: "/b",
          E4_OPERATOR_KEY_FILE: "/o",
          E4_OUT: "/out",
        },
        {
          fetchChainId: async () => 8453,
          readKeyFile: () => {
            reads += 1;
            return `0x${"22".repeat(32)}`;
          },
        },
      ),
    /e4_testnet_wrong_chain/,
  );
  assert.equal(reads, 0);

  reads = 0;
  const out = await preflight(
    {
      E4_BUYER_KEY_FILE: "/b",
      E4_OPERATOR_KEY_FILE: "/o",
      E4_OUT: "/out",
    },
    {
      fetchChainId: async () => TESTNET_CHAIN_ID,
      readKeyFile: (p) => {
        reads += 1;
        return `0x${"11".repeat(32)}`;
      },
    },
  );
  assert.equal(reads, 2);
  assert.equal(out.chainId, TESTNET_CHAIN_ID);
});

test("readPrivateKeyFile rejects bad content without leaking it", () => {
  const bad = "0xdeadbeefnota32bytekeyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  assert.throws(
    () => readPrivateKeyFile("/fake", () => bad),
    (e) => e.message.includes("/fake") && !e.message.includes("deadbeef"),
  );
  const good = `0x${"11".repeat(32)}`;
  assert.equal(readPrivateKeyFile("/ok", () => good), good);
});

test("assertNoSecretsInText catches variants", () => {
  const secret = `0x${"AbCdEf01".repeat(8)}`;
  const body = "log ok";
  assertNoSecretsInText(body, [secret]);
  assert.throws(
    () => assertNoSecretsInText(`seen ${secret}`, [secret]),
    /e4_testnet_secret_in_output/,
  );
  assert.throws(
    () => assertNoSecretsInText(secret.slice(2), [secret]),
    /e4_testnet_secret_in_output/,
  );
  assert.throws(
    () => assertNoSecretsInText(secret.toUpperCase(), [secret]),
    /e4_testnet_secret_in_output/,
  );
});

test("assertSpendWithinCap", () => {
  assertSpendWithinCap(10n * PRICE_UNITS);
  assert.throws(() => assertSpendWithinCap(11n * PRICE_UNITS), /e4_testnet_spend_over_cap/);
});

test("minEthWei", () => {
  assert.equal(minEthWei(100n, 450000n), 45000000n);
});

test("e4-testnet-run.mjs guards mainnet chain usage", () => {
  const runSrc = readFileSync(new URL("../scripts/e4-testnet-run.mjs", import.meta.url), "utf8");
  assert.match(runSrc, /E4_TESTNET_SCENARIOS/);
  assert.doesNotMatch(runSrc, /\b8453\b/);
  assert.doesNotMatch(runSrc, /mainnet/i);
});

test("e4-testnet-run.mjs reads keys only inside preflight readKeyFile and runs preflight before accounts", () => {
  const runSrc = readFileSync(new URL("../scripts/e4-testnet-run.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(runSrc, /readFileSync\s*\(/);
  assert.match(runSrc, /readPrivateKeyFile\s*\(\s*path\s*,\s*readFileSync\s*\)/);
  assert.match(runSrc, /fetchChainId:\s*\(\)\s*=>\s*pub\.getChainId\s*\(\)/);
  assert.ok(runSrc.indexOf("preflight(") < runSrc.indexOf("privateKeyToAccount("));
  assert.match(runSrc, /function safeLog/);
  // The report object must exist before anything writes to it (a TDZ crash stopped a real run once).
  const decl = runSrc.indexOf("const report = {");
  assert.ok(decl > 0);
  assert.equal(runSrc.slice(0, decl).match(/\breport\./), null);
  assert.match(runSrc, /assertNoSecretsInText\(line, runSecrets\)/);
});
