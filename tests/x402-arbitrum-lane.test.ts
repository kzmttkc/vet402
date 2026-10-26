// ============================================================
// vet402 Observatory L1 — the Arbitrum row of the EVM chain table (Arbitrum lane, 2026-10-22).
//
// Arbitrum One (eip155:42161) is the fifth EVM chain the x402 payer can sign EIP-3009 on.
// The funnel is the one Base, Arc, Celo and BNB already pass through: every accept is a refusal unless
// it matches a pinned row exactly — network, USDC address and EIP-712 domain are ours, never
// the seller's and never the facilitator's.
//
// Measured 2026-10-22T11:16:31Z by RPC against https://arb1.arbitrum.io/rpc (not re-derived here):
//   eth_chainId 0xa4b1 = 42161 / USDC 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 / decimals() 6 /
//   name() "USD Coin", version() "2" /
//   DOMAIN_SEPARATOR() 0x08d11903f8419e68b1b8721bcbe2e9fc68569122a77ef18c216f10b3b5112c78 /
//   authorizationState(address,bytes32) present (EIP-3009).
// The domain-separator test below recomputes the EIP-712 domain hash from the pinned row and
// compares it with that on-chain value, so a wrong pin (name, version, chain id or contract)
// fails here instead of producing signatures that can never settle.
// Bridged USDC.e (0xFF970A61…5CC8) is not pinned: an accept that names it is never signed.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { hashDomain, verifyTypedData } from "viem";
import {
  ARC_CAIP2,
  ARC_CHAIN,
  ARC_USDC,
  ARBITRUM_CAIP2,
  ARBITRUM_CHAIN,
  ARBITRUM_USDC,
  ARBITRUM_USDC_DOMAIN_SEPARATOR,
  ARBITRUM_USDC_E,
  BASE_CAIP2,
  BASE_CHAIN,
  BASE_USDC,
  BNB_CAIP2,
  CELO_CAIP2,
  EVM_PAY_CHAINS,
  MAX_PER_PURCHASE_UNITS,
  buildAuthorization,
  declaredPayTosFor,
  encodePaymentHeader,
  evmChainFor,
  hasCanonicalUsdcDomain,
  isArbitrumL1Enabled,
  isEvmPayChainEnabled,
  selectAccept,
  signX402Payment,
} from "@/lib/observatory/x402-payer";
import {
  ARBITRUM_CAIP2 as ARBITRUM_CAIP2_READ,
  ARBITRUM_CHAIN_ID,
  ARBITRUM_PUBLIC_RPC_URL,
  ARBITRUM_USDC_ADDRESS,
  ARBITRUM_USDC_E_ADDRESS,
  arbitrumRpcUrl,
} from "@/lib/chain/arbitrum";
import { EVM_INDEX_CHAINS, isEvmChainIndexable, perChainBudgetMs } from "@/lib/settlements/index-evm";
import { chainLabel, explorerTxUrl, isMainnet, isTestnet } from "@/lib/observatory/chains";

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_PK);

const AGENT402_PAYTO = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const BLOCKSCOUT_ARB_PAYTO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
const BLOCKSCOUT_BASE_PAYTO = "0xd441D9F4c59CB26253E2F0A7a62ac9cE7823b4b4";
const ROGUE_PAYTO = "0x1111111111111111111111111111111111111111";

const AGENT402_ARB = {
  scheme: "exact",
  network: "eip155:42161",
  amount: "1000",
  asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  payTo: AGENT402_PAYTO,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};
const AGENT402_BASE = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "1000",
  asset: BASE_USDC,
  payTo: AGENT402_PAYTO,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};
const BLOCKSCOUT_ARB = {
  scheme: "exact",
  network: "eip155:42161",
  amount: "2000",
  asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  payTo: BLOCKSCOUT_ARB_PAYTO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};
const BLOCKSCOUT_BASE = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "2000",
  asset: BASE_USDC,
  payTo: BLOCKSCOUT_BASE_PAYTO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const EIP712_DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  const restore = () => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  };
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  let out: T;
  try {
    out = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}
const withArbFlag = <T>(value: string | undefined, fn: () => T): T =>
  withEnv("OBSERVATORY_ARBITRUM_L1_ENABLED", value, () => {
    // A blank RPC closes the lane on its own. Flag-off cases still set one, so a mutant that
    // drops the flag (flagEnv null) is caught here and not hidden by the RPC check.
    if (process.env.ARBITRUM_RPC_URL?.trim()) return fn();
    return withEnv("ARBITRUM_RPC_URL", "http://127.0.0.1:9", fn);
  });

test("the table pins Arbitrum as measured on-chain 2026-10-22, next to Base, Arc, Celo and BNB and nothing else", () => {
  assert.deepEqual(
    EVM_PAY_CHAINS.slice(0, 5).map((c) => c.caip2),
    [BASE_CAIP2, ARC_CAIP2, CELO_CAIP2, BNB_CAIP2, ARBITRUM_CAIP2],
    "the first five rows stay Base, Arc, Celo, BNB and Arbitrum",
  );
  assert.equal(ARBITRUM_CAIP2, "eip155:42161");
  assert.equal(ARBITRUM_CHAIN.caip2, ARBITRUM_CAIP2);
  assert.equal(ARBITRUM_CHAIN.chainId, 42161);
  assert.equal(ARBITRUM_USDC, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  assert.equal(ARBITRUM_CHAIN.usdc, ARBITRUM_USDC);
  assert.equal(ARBITRUM_CHAIN.eip712Name, "USD Coin", "Arbitrum USDC reports name() \"USD Coin\" — like Base, not Celo's \"USDC\"");
  assert.equal(ARBITRUM_CHAIN.eip712Version, "2");
  assert.equal(ARBITRUM_CHAIN.label, "Arbitrum");
  assert.equal(ARBITRUM_CHAIN.v1Slug, null, "no v1 slug in the money path");
  assert.equal(ARBITRUM_CHAIN.flagEnv, "OBSERVATORY_ARBITRUM_L1_ENABLED");
  assert.equal(ARBITRUM_CHAIN.requiredEnv, "ARBITRUM_RPC_URL");
  assert.equal(EVM_PAY_CHAINS[0], BASE_CHAIN);
  assert.equal(EVM_PAY_CHAINS[1], ARC_CHAIN);
  assert.equal(EVM_PAY_CHAINS[4], ARBITRUM_CHAIN);
});

test("the pinned Arbitrum domain hashes to the DOMAIN_SEPARATOR() the token itself returned on-chain", () => {
  const computed = hashDomain({
    domain: {
      name: ARBITRUM_CHAIN.eip712Name,
      version: ARBITRUM_CHAIN.eip712Version,
      chainId: BigInt(ARBITRUM_CHAIN.chainId),
      verifyingContract: ARBITRUM_CHAIN.usdc as `0x${string}`,
    },
    types: EIP712_DOMAIN_TYPES,
  });
  assert.equal(ARBITRUM_USDC_DOMAIN_SEPARATOR, "0x08d11903f8419e68b1b8721bcbe2e9fc68569122a77ef18c216f10b3b5112c78");
  assert.equal(computed, ARBITRUM_USDC_DOMAIN_SEPARATOR);
  const variant = (domain: Record<string, unknown>) => hashDomain({ domain: domain as never, types: EIP712_DOMAIN_TYPES });
  const pinned = { name: "USD Coin", version: "2", chainId: 42161, verifyingContract: ARBITRUM_USDC };
  assert.notEqual(variant({ ...pinned, name: "USDC" }), ARBITRUM_USDC_DOMAIN_SEPARATOR, "Celo/Arc token name");
  assert.notEqual(variant({ ...pinned, version: "1" }), ARBITRUM_USDC_DOMAIN_SEPARATOR);
  assert.notEqual(variant({ ...pinned, chainId: 8453 }), ARBITRUM_USDC_DOMAIN_SEPARATOR, "Base shares name and version, not the chain id");
  assert.notEqual(variant({ ...pinned, chainId: 42220 }), ARBITRUM_USDC_DOMAIN_SEPARATOR);
  assert.notEqual(variant({ ...pinned, verifyingContract: ARBITRUM_USDC_E }), ARBITRUM_USDC_DOMAIN_SEPARATOR, "bridged USDC.e");
});

test("the read-side constants (chain/arbitrum.ts) agree with the pinned row, and the settlement index has an Arbitrum row", () => {
  assert.equal(ARBITRUM_CHAIN_ID, ARBITRUM_CHAIN.chainId);
  assert.equal(ARBITRUM_CAIP2_READ, ARBITRUM_CHAIN.caip2);
  assert.equal(ARBITRUM_USDC_ADDRESS, ARBITRUM_CHAIN.usdc);
  assert.equal(ARBITRUM_USDC_E_ADDRESS, ARBITRUM_USDC_E);
  const row = EVM_INDEX_CHAINS.find((c) => c.chainId === 42161);
  assert.ok(row, "eip155:42161 missing from EVM_INDEX_CHAINS");
  assert.equal(row.caip2, ARBITRUM_CAIP2);
  assert.equal(row.usdc, ARBITRUM_USDC);
  assert.equal(row.rpcEnv, "ARBITRUM_RPC_URL");
  assert.equal(row.blocksPerDay, 310_500n, "278.25 ms blocks measured 2026-10-22");
  assert.equal(row.subWindowBlocks, 10_000n, "the index filters by payee, and the public RPC answered a payee-filtered 10,000-block query on 2026-10-22");
  assert.ok(row.maxBlocksPerRun >= row.blocksPerDay, "a daily cron must be able to keep up");
});

test("the Arbitrum RPC: env first, the public RPC only as the balance-read default; the index stays off without ARBITRUM_RPC_URL", () => {
  withEnv("ARBITRUM_RPC_URL", undefined, () => {
    assert.equal(arbitrumRpcUrl(), ARBITRUM_PUBLIC_RPC_URL);
    assert.equal(ARBITRUM_PUBLIC_RPC_URL, "https://arb1.arbitrum.io/rpc");
    const row = EVM_INDEX_CHAINS.find((c) => c.chainId === 42161)!;
    assert.equal(isEvmChainIndexable(row), false, "no silent fallback to the public RPC for the index");
    withEnv("ARC_RPC_URL", undefined, () =>
      withEnv("POLYGON_RPC_URL", undefined, () =>
        withEnv("TEMPO_RPC_URL", undefined, () =>
          withEnv("CELO_RPC_URL", undefined, () =>
            withEnv("BNB_RPC_URL", undefined, () =>
              withEnv("AVALANCHE_RPC_URL", undefined, () => assert.equal(perChainBudgetMs(120_000), 120_000)),
            ),
          ),
        ),
      ),
    );
  });
  withEnv("ARBITRUM_RPC_URL", "  https://arb.example/rpc  ", () => {
    assert.equal(arbitrumRpcUrl(), "https://arb.example/rpc");
    assert.equal(isEvmChainIndexable(EVM_INDEX_CHAINS.find((c) => c.chainId === 42161)!), true);
  });
});

test("evmChainFor resolves eip155:42161 and none of Arbitrum's other spellings or testnets", () => {
  assert.equal(evmChainFor("eip155:42161")?.chainId, 42161);
  assert.equal(evmChainFor("arbitrum"), null, "the v1 slug is not resolved in the money path");
  assert.equal(evmChainFor("Arbitrum"), null);
  assert.equal(evmChainFor("eip155:421614"), null, "Arbitrum Sepolia is not a purchase chain");
  assert.equal(evmChainFor("eip155:42170"), null, "Nova is not a purchase chain");
  assert.equal(evmChainFor("eip155:4216"), null);
  assert.equal(evmChainFor("eip155:421610"), null);
});

test("Arbitrum is off unless OBSERVATORY_ARBITRUM_L1_ENABLED is exactly \"true\"; its flag does not move Base or Celo", () => {
  withArbFlag(undefined, () => {
    assert.equal(isArbitrumL1Enabled(), false);
    assert.equal(isEvmPayChainEnabled(ARBITRUM_CHAIN), false);
    assert.equal(isEvmPayChainEnabled(BASE_CHAIN), true);
  });
  for (const v of ["1", "TRUE", "True", "on", "yes", " true", "true "]) {
    withArbFlag(v, () => {
      assert.equal(isArbitrumL1Enabled(), false, `value ${JSON.stringify(v)}`);
      assert.equal(isEvmPayChainEnabled(ARBITRUM_CHAIN), false, `value ${JSON.stringify(v)}`);
    });
  }
  withArbFlag("true", () => {
    assert.equal(isArbitrumL1Enabled(), true);
    assert.equal(isEvmPayChainEnabled(ARBITRUM_CHAIN), true);
    assert.equal(isEvmPayChainEnabled(BASE_CHAIN), true);
    withEnv("OBSERVATORY_CELO_L1_ENABLED", undefined, () => assert.equal(isEvmPayChainEnabled(EVM_PAY_CHAINS.find((c) => c.caip2 === CELO_CAIP2)!), false, "the Arbitrum flag does not open Celo"));
  });
  withEnv("OBSERVATORY_CELO_L1_ENABLED", "true", () =>
    withArbFlag(undefined, () => assert.equal(isEvmPayChainEnabled(ARBITRUM_CHAIN), false, "the Celo flag does not open Arbitrum")),
  );
});

test("flag off: a real Arbitrum accept is no_eligible_accept, and a Base-first wall still buys on Base", () => {
  withArbFlag(undefined, () => {
    const only = selectAccept([AGENT402_ARB], { declaredAmount: "1000", declaredPayTo: AGENT402_PAYTO.toLowerCase() });
    assert.equal(only.accept, null);
    assert.equal(only.reason, "no_eligible_accept");
    const preferred = selectAccept([AGENT402_BASE, AGENT402_ARB], {
      declaredAmount: "1000",
      declaredPayTo: AGENT402_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [ARBITRUM_CAIP2],
      declaredPayTosByNetwork: { [ARBITRUM_CAIP2]: [AGENT402_PAYTO.toLowerCase()] },
    });
    assert.equal(preferred.accept?.network, BASE_CAIP2);
  });
});

test("flag off: signX402Payment refuses an Arbitrum accept even if a caller skips the gate", async () => {
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  await withArbFlag(undefined, async () => {
    await assert.rejects(() => signX402Payment({ account, accept: AGENT402_ARB, authorization }), /the Arbitrum lane is not enabled/);
  });
});

test("flag on but ARBITRUM_RPC_URL empty or blank: a Base accept that falls off does not select or sign Arbitrum", async () => {
  const fallen = [{ ...AGENT402_BASE, asset: "0x0000000000000000000000000000000000000001" }, AGENT402_ARB];
  const opts = { declaredAmount: "1000", declaredPayTo: AGENT402_PAYTO.toLowerCase() };
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  const check = () => {
    assert.equal(isArbitrumL1Enabled(), true);
    assert.equal(isEvmPayChainEnabled(ARBITRUM_CHAIN), false);
    const chosen = selectAccept(fallen, opts);
    assert.equal(chosen.accept, null);
    assert.equal(chosen.reason, "no_eligible_accept");
  };
  await withEnv("OBSERVATORY_ARBITRUM_L1_ENABLED", "true", async () => {
    withEnv("ARBITRUM_RPC_URL", undefined, check);
    withEnv("ARBITRUM_RPC_URL", "   ", check);
    await withEnv("ARBITRUM_RPC_URL", undefined, async () => {
      await assert.rejects(() => signX402Payment({ account, accept: AGENT402_ARB, authorization }), /the Arbitrum lane is not enabled/);
    });
    await withEnv("ARBITRUM_RPC_URL", "   ", async () => {
      await assert.rejects(() => signX402Payment({ account, accept: AGENT402_ARB, authorization }), /the Arbitrum lane is not enabled/);
    });
  });
});

test("flag on: the Arbitrum USDC accept is selected at the declared price and payee", () => {
  withArbFlag("true", () => {
    const chosen = selectAccept([BLOCKSCOUT_ARB, BLOCKSCOUT_BASE], {
      declaredAmount: "2000",
      declaredPayTo: BLOCKSCOUT_ARB_PAYTO,
      declaredNetwork: ARBITRUM_CAIP2,
    });
    assert.ok(chosen.accept, `expected the Arbitrum accept, got ${chosen.reason}`);
    assert.equal(chosen.accept.network, ARBITRUM_CAIP2);
    assert.equal(chosen.accept.asset, ARBITRUM_USDC);
    assert.equal(chosen.accept.payTo, BLOCKSCOUT_ARB_PAYTO, "the wall's own spelling is what gets signed");
    assert.equal(chosen.accept.amount, "2000");
  });
});

test("flag on: nothing but the pinned native USDC is eligible on Arbitrum — USDC.e, another chain's USDC", () => {
  withArbFlag("true", () => {
    const opts = { declaredAmount: "1000", declaredPayTo: null };
    const refused = (accept: unknown, why: string) => {
      const r = selectAccept([accept], opts);
      assert.equal(r.accept, null, why);
      assert.equal(r.reason, "no_eligible_accept", why);
    };
    refused({ ...AGENT402_ARB, asset: ARBITRUM_USDC_E, extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" } }, "bridged USDC.e as the wall lists it");
    refused({ ...AGENT402_ARB, asset: ARBITRUM_USDC_E, extra: { name: "USD Coin", version: "2" } }, "USDC.e dressed in native USDC's domain words");
    refused({ ...AGENT402_ARB, asset: ARBITRUM_USDC_E, extra: undefined }, "USDC.e with no extra at all");
    refused({ ...AGENT402_ARB, asset: BASE_USDC }, "Base's USDC address on the Arbitrum network");
    refused({ ...AGENT402_ARB, asset: ARC_USDC }, "Arc's USDC address on the Arbitrum network");
    refused({ ...AGENT402_BASE, asset: ARBITRUM_USDC }, "Arbitrum's USDC address on Base");
    withEnv("OBSERVATORY_ARC_L1_ENABLED", "true", () => refused({ ...AGENT402_ARB, network: ARC_CAIP2 }, "Arbitrum's USDC address on Arc"));
    const mixed = selectAccept([{ ...AGENT402_ARB, asset: ARBITRUM_USDC_E, extra: { name: "USD Coin", version: "2" } }, AGENT402_ARB], opts);
    assert.equal(mixed.accept?.asset, ARBITRUM_USDC);
  });
});

test("flag on: scheme, transfer method and the EIP-712 domain are pinned on Arbitrum exactly as on Base", () => {
  withArbFlag("true", () => {
    const opts = { declaredAmount: "1000", declaredPayTo: null };
    const refused = (accept: unknown, why: string) => assert.equal(selectAccept([accept], opts).accept, null, why);
    refused({ ...AGENT402_ARB, scheme: "upto" }, "scheme upto");
    refused({ ...AGENT402_ARB, scheme: undefined }, "no scheme — the signing path does not guess one");
    refused({ ...AGENT402_ARB, extra: { ...AGENT402_ARB.extra, assetTransferMethod: "permit2" } }, "permit2 on USDC");
    refused({ ...AGENT402_ARB, extra: { name: "USDC", version: "2" } }, "Celo/Arc domain name on an Arbitrum accept");
    refused({ ...AGENT402_ARB, extra: { name: "USD Coin", version: "1" } }, "wrong version");
    refused({ ...AGENT402_ARB, extra: { name: "USD Coin", version: "2", chainId: 8453 } }, "Base's chain id");
    refused({ ...AGENT402_ARB, extra: { name: "USD Coin", version: "2", chainId: 42220 } }, "Celo's chain id");
    refused({ ...AGENT402_ARB, extra: { name: "USD Coin", version: "2", verifyingContract: ARBITRUM_USDC_E } }, "USDC.e as verifying contract");
    refused({ ...AGENT402_ARB, extra: { name: "USD Coin", version: "2", salt: `0x${"11".repeat(32)}` } }, "a salt");
    refused({ ...AGENT402_ARB, payTo: "0xABF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" }, "a payTo whose checksum is wrong cannot be signed");
    refused({ ...AGENT402_ARB, maxTimeoutSeconds: 120.5 }, "a fractional timeout cannot be signed");
    assert.ok(selectAccept([{ ...AGENT402_ARB, extra: { name: "USD Coin", version: "2", chainId: 42161, verifyingContract: ARBITRUM_USDC } }], opts).accept);
    assert.ok(selectAccept([{ ...AGENT402_ARB, extra: undefined }], opts).accept);
    assert.equal(hasCanonicalUsdcDomain({ name: "USD Coin", version: "2" }, ARBITRUM_CHAIN), true);
    assert.equal(hasCanonicalUsdcDomain({ chainId: "42161" }, ARBITRUM_CHAIN), true);
    assert.equal(hasCanonicalUsdcDomain({ chainId: "0xa4b1" }, ARBITRUM_CHAIN), false, "hex form is not the pinned shape");
  });
});

test("flag on: payto_mismatch, price_mismatch and over_cap fire on Arbitrum as they do on Base", () => {
  withArbFlag("true", () => {
    const wrongPayee = selectAccept([{ ...BLOCKSCOUT_ARB, payTo: ROGUE_PAYTO }], { declaredAmount: "2000", declaredPayTo: BLOCKSCOUT_ARB_PAYTO, declaredNetwork: ARBITRUM_CAIP2 });
    assert.equal(wrongPayee.accept, null);
    assert.equal(wrongPayee.reason, "payto_mismatch");
    for (const amount of ["2001", "20000", "1999"]) {
      const r = selectAccept([{ ...BLOCKSCOUT_ARB, amount }], { declaredAmount: "2000", declaredPayTo: BLOCKSCOUT_ARB_PAYTO, declaredNetwork: ARBITRUM_CAIP2 });
      assert.equal(r.accept, null, `amount ${amount}`);
      assert.equal(r.reason, "price_mismatch", `amount ${amount}`);
    }
    const over = String(MAX_PER_PURCHASE_UNITS + 1n);
    const overNoDecl = selectAccept([{ ...BLOCKSCOUT_ARB, amount: over }], { declaredAmount: null, declaredPayTo: BLOCKSCOUT_ARB_PAYTO });
    assert.equal(overNoDecl.accept, null);
    assert.equal(overNoDecl.reason, "over_cap");
    const overDecl = selectAccept([{ ...BLOCKSCOUT_ARB, amount: over }], { declaredAmount: over, declaredPayTo: BLOCKSCOUT_ARB_PAYTO, declaredNetwork: ARBITRUM_CAIP2 });
    assert.equal(overDecl.accept, null);
    assert.equal(overDecl.reason, "over_cap");
    for (const amount of ["0", "-1", "0.001", "1e3", ""]) {
      assert.equal(selectAccept([{ ...BLOCKSCOUT_ARB, amount }], { declaredAmount: null, declaredPayTo: null }).accept, null, `amount ${JSON.stringify(amount)}`);
    }
  });
});

test("lane preference: a Base-first wall is bought on Arbitrum only when the catalog declared that Arbitrum payee, at no more than the listing price", () => {
  withArbFlag("true", () => {
    const base = {
      declaredAmount: "1000",
      declaredPayTo: AGENT402_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
    };
    assert.equal(selectAccept([AGENT402_BASE, AGENT402_ARB], base).accept?.network, BASE_CAIP2);
    const lane = { ...base, preferNetworks: [ARBITRUM_CAIP2], declaredPayTosByNetwork: { [ARBITRUM_CAIP2]: [AGENT402_PAYTO.toLowerCase()] } };
    assert.equal(selectAccept([AGENT402_BASE, AGENT402_ARB], lane).accept?.network, ARBITRUM_CAIP2);
    const rogue = selectAccept([AGENT402_BASE, { ...AGENT402_ARB, payTo: ROGUE_PAYTO }], lane);
    assert.equal(rogue.accept?.network, BASE_CAIP2);
    assert.equal(rogue.accept?.payTo, AGENT402_PAYTO);
    const rogueOnly = selectAccept([{ ...AGENT402_ARB, payTo: ROGUE_PAYTO }], lane);
    assert.equal(rogueOnly.accept, null);
    assert.equal(rogueOnly.reason, "payto_mismatch");
    const dearer = selectAccept([AGENT402_BASE, { ...AGENT402_ARB, amount: "1001" }], lane);
    assert.equal(dearer.accept?.network, BASE_CAIP2);
    const cheaper = selectAccept([AGENT402_BASE, { ...AGENT402_ARB, amount: "999" }], lane);
    assert.equal(cheaper.accept?.network, ARBITRUM_CAIP2);
    assert.equal(cheaper.accept?.amount, "999");
    const blockscout = selectAccept([BLOCKSCOUT_BASE, BLOCKSCOUT_ARB], {
      declaredAmount: "2000",
      declaredPayTo: BLOCKSCOUT_BASE_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [ARBITRUM_CAIP2],
      declaredPayTosByNetwork: { [ARBITRUM_CAIP2]: [BLOCKSCOUT_ARB_PAYTO] },
    });
    assert.equal(blockscout.accept?.network, ARBITRUM_CAIP2);
    assert.equal(blockscout.accept?.payTo, BLOCKSCOUT_ARB_PAYTO);
    const arcOnly = selectAccept([BLOCKSCOUT_BASE, BLOCKSCOUT_ARB], {
      declaredAmount: "2000",
      declaredPayTo: BLOCKSCOUT_BASE_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [ARBITRUM_CAIP2],
      declaredPayTosByNetwork: { [ARC_CAIP2]: [BLOCKSCOUT_ARB_PAYTO] },
    });
    assert.equal(arcOnly.accept?.network, BASE_CAIP2, "no Arbitrum declaration ⇒ the Arbitrum accept is checked against the head pay_to and fails");
  });
});

test("declaredPayTosFor(ARBITRUM_CHAIN): only an accept this module could sign on Arbitrum declares a payee", () => {
  const raw = [
    AGENT402_BASE,
    AGENT402_ARB,
    BLOCKSCOUT_ARB,
    { ...AGENT402_ARB, asset: ARBITRUM_USDC_E, payTo: ROGUE_PAYTO, extra: { name: "USD Coin", version: "2" } },
    { ...AGENT402_ARB, scheme: "upto", payTo: ROGUE_PAYTO },
    { ...AGENT402_ARB, network: "arbitrum", payTo: ROGUE_PAYTO },
    { ...AGENT402_ARB, network: "eip155:421614", payTo: ROGUE_PAYTO },
    { ...AGENT402_ARB, extra: { name: "USDC", version: "2" }, payTo: ROGUE_PAYTO },
  ];
  for (const flag of [undefined, "true"]) {
    withArbFlag(flag, () => {
      assert.deepEqual(declaredPayTosFor(ARBITRUM_CHAIN, raw).sort(), [BLOCKSCOUT_ARB_PAYTO, AGENT402_PAYTO.toLowerCase()].sort());
      assert.deepEqual(declaredPayTosFor(ARBITRUM_CHAIN, JSON.stringify(raw)).sort(), [BLOCKSCOUT_ARB_PAYTO, AGENT402_PAYTO.toLowerCase()].sort());
      assert.deepEqual(declaredPayTosFor(ARC_CHAIN, raw), [], "an Arbitrum accept declares nothing for Arc");
      assert.deepEqual(declaredPayTosFor(ARBITRUM_CHAIN, null), []);
      assert.deepEqual(declaredPayTosFor(ARBITRUM_CHAIN, "not json"), []);
    });
  }
});

test("signX402Payment signs an Arbitrum accept under the pinned Arbitrum domain and under no other", async () => {
  await withArbFlag("true", async () => {
    const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
    const { signature } = await signX402Payment({ account, accept: AGENT402_ARB, authorization });
    const message = {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    };
    const under = (domain: { name: string; version: string; chainId: number; verifyingContract: string }) =>
      verifyTypedData({
        address: account.address,
        domain: { ...domain, verifyingContract: domain.verifyingContract as `0x${string}` },
        types: TRANSFER_TYPES,
        primaryType: "TransferWithAuthorization",
        message,
        signature: signature as `0x${string}`,
      });
    assert.equal(await under({ name: "USD Coin", version: "2", chainId: 42161, verifyingContract: ARBITRUM_USDC }), true);
    assert.equal(await under({ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC }), false, "not valid on Base (same name, different chain id)");
    assert.equal(await under({ name: "USDC", version: "2", chainId: 42220, verifyingContract: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" }), false, "not valid on Celo");
    assert.equal(await under({ name: "USD Coin", version: "2", chainId: 42161, verifyingContract: ARBITRUM_USDC_E }), false, "not valid for USDC.e");
    assert.equal(authorization.to, AGENT402_PAYTO);
    assert.equal(authorization.value, "1000");
    assert.equal(Number(authorization.validBefore) - 1_760_000_000, 120);
  });
});

test("signX402Payment refuses an Arbitrum accept whose extra contradicts the pinned domain", async () => {
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  await withArbFlag("true", async () => {
    await assert.rejects(
      () => signX402Payment({ account, accept: { ...AGENT402_ARB, extra: { name: "USDC", version: "2" } }, authorization }),
      /canonical Arbitrum USDC EIP-712 domain/,
    );
    await assert.rejects(
      () => signX402Payment({ account, accept: { ...AGENT402_ARB, network: "eip155:421614" }, authorization }),
      /not a pinned EVM purchase chain/,
    );
  });
});

test("encodePaymentHeader carries the Arbitrum accept verbatim in v2 and the CAIP-2 id in v1", () => {
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  const payload = { signature: "0xabc", authorization };
  const v2 = encodePaymentHeader({ x402Version: 2, accept: AGENT402_ARB, payload, resourceUrl: "https://agent402.tools/api/hash" });
  assert.equal(v2.headerName, "PAYMENT-SIGNATURE");
  const decoded2 = JSON.parse(Buffer.from(v2.headerValue, "base64").toString());
  assert.equal(decoded2.accepted.network, "eip155:42161");
  assert.equal(decoded2.accepted.asset, ARBITRUM_USDC);
  assert.equal(decoded2.accepted.payTo, AGENT402_PAYTO);
  assert.equal(decoded2.accepted.amount, "1000");
  const v1 = encodePaymentHeader({ x402Version: 1, accept: AGENT402_ARB, payload, resourceUrl: "https://agent402.tools/api/hash" });
  assert.equal(JSON.parse(Buffer.from(v1.headerValue, "base64").toString()).network, "eip155:42161");
});

test("Arbitrum's label, mainnet scope and receipt link; testnets get no link", () => {
  assert.equal(chainLabel("eip155:42161"), "Arbitrum");
  assert.equal(chainLabel("eip155:42161"), ARBITRUM_CHAIN.label, "the lane's label is the join key into l1.byChain");
  assert.equal(isMainnet("eip155:42161"), true);
  assert.equal(isTestnet("eip155:42161"), false);
  const tx = `0x${"ab".repeat(32)}`;
  assert.equal(explorerTxUrl("eip155:42161", tx), `https://arbiscan.io/tx/${tx}`);
  assert.equal(explorerTxUrl("eip155:42161", "not-a-hash"), null, "a malformed tx gets no link");
  assert.equal(explorerTxUrl("eip155:42161", `0x${"ab".repeat(31)}`), null);
  assert.equal(explorerTxUrl("eip155:421614", tx), null, "Arbitrum Sepolia");
  assert.equal(explorerTxUrl("eip155:8453", tx), `https://basescan.org/tx/${tx}`);
  assert.equal(explorerTxUrl("eip155:5042", tx), `https://explorer.arc.io/tx/${tx}`);
});
