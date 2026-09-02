// ============================================================
// レジストリ配線（C4）。金の経路に触るフックなので分岐を全て固定:
//  - フラグOFF（既定）→ disabled・鍵もagent解決も触らない
//  - Solana/不正payTo → not_evm
//  - 鍵なし → key_missing（フラグONでも書かない）
// 2026-09-02 監査 P1-6 / 是正:
//  - REGISTRY_WRITE_TIERS（既定 C2,C3）に入らない階層は書かない（tier_excluded）
//  - 同じ purchase_id は 2 回書かない（台帳の request_hash を先に引く。RPC に触れない）
//  - 1 日の上限 REGISTRY_DAILY_MAX_WRITES（既定 200）を超えたら書かない
//  - 残高が REGISTRY_MIN_BALANCE_WEI（既定 0.0005 ETH）未満なら書かず fail-loud
// 実書込は registry-writes.test.ts が担う——ここは配線の門番だけ。viem は注入で差し替える。
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import {
  publishL1OutcomeToRegistry,
  publishL2OutcomeToRegistry,
  type RegistryHookDeps,
} from "@/lib/chain/registry-hook";
import type { PublishOutcome } from "@/lib/chain/registry";

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

afterEach(() => {
  delete process.env.REGISTRY_WRITES_ENABLED;
  delete process.env.REGISTRY_OPERATOR_PRIVATE_KEY;
  delete process.env.REGISTRY_WRITE_TIERS;
  delete process.env.REGISTRY_DAILY_MAX_WRITES;
  delete process.env.REGISTRY_MIN_BALANCE_WEI;
});

const BASE_INPUT = {
  endpointId: "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a",
  payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
  settled: true,
  txHash: `0x${"ab".repeat(32)}`,
  network: "eip155:8453",
};

function armed() {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  process.env.REGISTRY_OPERATOR_PRIVATE_KEY = TEST_PK;
}

/** 全部本物の代わり——呼ばれた事実を記録する偽物。上書きで分岐を作る。 */
function fakeDeps(overrides: Partial<RegistryHookDeps> = {}) {
  const published: Parameters<NonNullable<RegistryHookDeps["publish"]>>[0][] = [];
  const calls = { resolveAgentId: 0, getBalance: 0, estimateFees: 0 };
  const deps: RegistryHookDeps = {
    resolveTier: async () => "C2",
    resolveAgentId: async () => {
      calls.resolveAgentId++;
      return 42n;
    },
    hasExistingWrite: async () => false,
    countWritesToday: async () => 0,
    chain: {
      estimateFees: async () => {
        calls.estimateFees++;
        return 1n;
      },
      getBalance: async () => {
        calls.getBalance++;
        return 10n ** 18n;
      },
    },
    createWallet: () => ({ account: { address: "0x1111111111111111111111111111111111111111" }, chain: { id: 8453 } }) as never,
    publish: async (input): Promise<PublishOutcome> => {
      published.push(input);
      return { status: "submitted", txHash: "0xtx" };
    },
    ...overrides,
  };
  return { deps, published, calls };
}

test("既定はOFF → disabled", async () => {
  const out = await publishL1OutcomeToRegistry(BASE_INPUT);
  assert.deepEqual(out, { status: "disabled" });
});

test("Solana payTo → not_evm（フラグONでも）", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  const out = await publishL1OutcomeToRegistry({
    ...BASE_INPUT,
    payTo: "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM",
  });
  assert.deepEqual(out, { status: "not_evm" });
});

test("鍵なし → key_missing（agent解決・RPCに触る前に帰る）", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  const out = await publishL1OutcomeToRegistry(BASE_INPUT);
  assert.deepEqual(out, { status: "key_missing" });
});

test("settled 確定 → verdict pass・requestKey は purchase_id（chain:tx_hash）・agentId が載る", async () => {
  armed();
  const f = fakeDeps();
  const out = await publishL1OutcomeToRegistry(BASE_INPUT, f.deps);
  assert.deepEqual(out, { status: "submitted", txHash: "0xtx" });
  assert.equal(f.published.length, 1);
  const rec = f.published[0].record;
  assert.equal(rec.level, "l1");
  assert.equal(rec.verdict, "pass");
  assert.equal(rec.agentId, 42n);
  assert.equal(rec.requestKey, `eip155:8453:${BASE_INPUT.txHash}`);
  assert.equal(f.published[0].currentMaxFeeWei, 1n);
});

test("refuted → verdict fail（response 0）", async () => {
  armed();
  const f = fakeDeps();
  await publishL1OutcomeToRegistry({ ...BASE_INPUT, settled: false }, f.deps);
  assert.equal(f.published[0].record.verdict, "fail");
  assert.equal(f.published[0].record.response, 0);
});

test("tier フィルタ: 既定 C2,C3 に入らない C1 は tier_excluded・RPC にも publish にも触れない", async () => {
  armed();
  const f = fakeDeps({ resolveTier: async () => "C1" });
  const out = await publishL1OutcomeToRegistry(BASE_INPUT, f.deps);
  assert.deepEqual(out, { status: "tier_excluded", tier: "C1" });
  assert.equal(f.published.length, 0);
  assert.equal(f.calls.resolveAgentId, 0);
  assert.equal(f.calls.getBalance, 0);
});

test("tier フィルタ: C3 は既定で書く", async () => {
  armed();
  const f = fakeDeps({ resolveTier: async () => "C3" });
  const out = await publishL1OutcomeToRegistry(BASE_INPUT, f.deps);
  assert.equal(out.status, "submitted");
});

test("tier フィルタ: REGISTRY_WRITE_TIERS=C1,C2 なら C1 も書く・C3 は書かない", async () => {
  armed();
  process.env.REGISTRY_WRITE_TIERS = "C1,C2";
  const c1 = fakeDeps({ resolveTier: async () => "C1" });
  assert.equal((await publishL1OutcomeToRegistry(BASE_INPUT, c1.deps)).status, "submitted");
  const c3 = fakeDeps({ resolveTier: async () => "C3" });
  assert.deepEqual(await publishL1OutcomeToRegistry(BASE_INPUT, c3.deps), { status: "tier_excluded", tier: "C3" });
});

test("冪等: 同じ purchase_id が台帳にあれば duplicate——agent 解決・RPC・publish に触れない", async () => {
  armed();
  const expectedHash = keccak256(toBytes(`eip155:8453:${BASE_INPUT.txHash}`));
  const seen: string[] = [];
  const f = fakeDeps({
    hasExistingWrite: async (requestHash) => {
      seen.push(requestHash);
      return true;
    },
  });
  const out = await publishL1OutcomeToRegistry(BASE_INPUT, f.deps);
  assert.deepEqual(out, { status: "duplicate" });
  assert.deepEqual(seen, [expectedHash]);
  assert.equal(f.calls.resolveAgentId, 0);
  assert.equal(f.calls.estimateFees, 0);
  assert.equal(f.published.length, 0);
});

test("日次上限: 既定 200 に達していたら daily_cap・publish しない", async () => {
  armed();
  const f = fakeDeps({ countWritesToday: async () => 200 });
  const out = await publishL1OutcomeToRegistry(BASE_INPUT, f.deps);
  assert.deepEqual(out, { status: "daily_cap", count: 200, max: 200 });
  assert.equal(f.published.length, 0);
  assert.equal(f.calls.resolveAgentId, 0);
});

test("日次上限: REGISTRY_DAILY_MAX_WRITES=3 で 2 件なら書く・3 件なら止まる", async () => {
  armed();
  process.env.REGISTRY_DAILY_MAX_WRITES = "3";
  const two = fakeDeps({ countWritesToday: async () => 2 });
  assert.equal((await publishL1OutcomeToRegistry(BASE_INPUT, two.deps)).status, "submitted");
  const three = fakeDeps({ countWritesToday: async () => 3 });
  assert.deepEqual(await publishL1OutcomeToRegistry(BASE_INPUT, three.deps), { status: "daily_cap", count: 3, max: 3 });
});

test("残高不足: 既定 0.0005 ETH 未満なら balance_low・fail-loud（console.error）・publish しない", async () => {
  armed();
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const f = fakeDeps({ chain: { estimateFees: async () => 1n, getBalance: async () => 499_999_999_999_999n } });
    const out = await publishL1OutcomeToRegistry(BASE_INPUT, f.deps);
    assert.deepEqual(out, { status: "balance_low", balanceWei: "499999999999999", minWei: "500000000000000" });
    assert.equal(f.published.length, 0);
    assert.ok(errors.some((e) => e.includes("registry.hook.balance_low")), `fail-loud が無い: ${JSON.stringify(errors)}`);
  } finally {
    console.error = orig;
  }
});

test("残高: ちょうど閾値なら書く（REGISTRY_MIN_BALANCE_WEI で閾値を変えられる）", async () => {
  armed();
  process.env.REGISTRY_MIN_BALANCE_WEI = "1000";
  const f = fakeDeps({ chain: { estimateFees: async () => 1n, getBalance: async () => 1000n } });
  assert.equal((await publishL1OutcomeToRegistry(BASE_INPUT, f.deps)).status, "submitted");
});

test("agent に解決できない payTo → no_agent（残高も見ない・publish しない）", async () => {
  armed();
  const f = fakeDeps({ resolveAgentId: async () => null });
  assert.deepEqual(await publishL1OutcomeToRegistry(BASE_INPUT, f.deps), { status: "no_agent" });
  assert.equal(f.calls.getBalance, 0);
  assert.equal(f.published.length, 0);
});

test("L2 hook: conform → l2 pass・requestKey は purchase_id + ':l2'（L1 と別の request_hash）", async () => {
  armed();
  const f = fakeDeps();
  const out = await publishL2OutcomeToRegistry({ ...BASE_INPUT, l2: "conform" }, f.deps);
  assert.equal(out.status, "submitted");
  const rec = f.published[0].record;
  assert.equal(rec.level, "l2");
  assert.equal(rec.verdict, "pass");
  assert.equal(rec.requestKey, `eip155:8453:${BASE_INPUT.txHash}:l2`);
});

test("L2 hook: mismatch → l2 fail・同じ tier / 上限 / 冪等の門を通る", async () => {
  armed();
  const f = fakeDeps({ resolveTier: async () => "C1" });
  assert.deepEqual(await publishL2OutcomeToRegistry({ ...BASE_INPUT, l2: "mismatch" }, f.deps), { status: "tier_excluded", tier: "C1" });
  const g = fakeDeps();
  await publishL2OutcomeToRegistry({ ...BASE_INPUT, l2: "mismatch" }, g.deps);
  assert.equal(g.published[0].record.verdict, "fail");
});
