// ============================================================
// vet402 Observatory L1 — the Avalanche row of the EVM chain table (Avalanche lane, 2026-10-26).
//
// Avalanche C-Chain (eip155:43114) is the sixth EVM chain the x402 payer can sign EIP-3009 on.
// The funnel is the one Base, Arc, Celo and BNB already pass through: every accept is a refusal unless
// it matches a pinned row exactly — network, USDC address and EIP-712 domain are ours, never
// the seller's and never the facilitator's.
//
// Measured 2026-10-26T10:42:23.389Z by RPC against https://api.avax.network/ext/bc/C/rpc (not re-derived here):
//   eth_chainId 0xa86a = 43114 / USDC 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E / decimals() 6 /
//   name() "USD Coin", version() "2" /
//   DOMAIN_SEPARATOR() 0xbbea200329a938bc3438984a49cb0732e66d66d7bd59c127abacc1710e77f7b3 /
//   authorizationState(address,bytes32) present (EIP-3009).
// The domain-separator test below recomputes the EIP-712 domain hash from the pinned row and
// compares it with that on-chain value, so a wrong pin (name, version, chain id or contract)
// fails here instead of producing signatures that can never settle.
// Bridged USDC.e (0xA7D7079b…C664) is not pinned: an accept that names it is never signed.
// EURC (0xC891EB4c…2ACD) is not pinned. extra.name GatewayWalletBatched is not signed.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { hashDomain, verifyTypedData } from "viem";
import {
  ARC_CAIP2,
  ARC_CHAIN,
  ARC_USDC,
  ARBITRUM_CAIP2,
  ARBITRUM_CHAIN,
  AVALANCHE_CAIP2,
  AVALANCHE_CHAIN,
  AVALANCHE_USDC,
  AVALANCHE_USDC_DOMAIN_SEPARATOR,
  AVALANCHE_USDC_E,
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
  isAvalancheL1Enabled,
  isEvmPayChainEnabled,
  selectAccept,
  signX402Payment,
} from "@/lib/observatory/x402-payer";
import {
  AVALANCHE_CAIP2 as AVALANCHE_CAIP2_READ,
  AVALANCHE_CHAIN_ID,
  AVALANCHE_PUBLIC_RPC_URL,
  AVALANCHE_USDC_ADDRESS,
  AVALANCHE_USDC_E_ADDRESS,
  avalancheRpcUrl,
} from "@/lib/chain/avalanche";
import { EVM_INDEX_CHAINS, isEvmChainIndexable, perChainBudgetMs } from "@/lib/settlements/index-evm";
import { chainLabel, explorerTxUrl, isMainnet, isTestnet, publicChainLabel } from "@/lib/observatory/chains";
import { otherChainQueryUnsentUntil } from "@/lib/observatory/request-query";

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_PK);

const AGENT402_PAYTO = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const BLOCKSCOUT_AVAX_PAYTO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
const BLOCKSCOUT_BASE_PAYTO = "0xd441D9F4c59CB26253E2F0A7a62ac9cE7823b4b4";
const ROGUE_PAYTO = "0x1111111111111111111111111111111111111111";

const AGENT402_AVAX = {
  scheme: "exact",
  network: "eip155:43114",
  amount: "1000",
  asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
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
const BLOCKSCOUT_AVAX = {
  scheme: "exact",
  network: "eip155:43114",
  amount: "2000",
  asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  payTo: BLOCKSCOUT_AVAX_PAYTO,
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
const withAvaxFlag = <T>(value: string | undefined, fn: () => T): T =>
  withEnv("OBSERVATORY_AVALANCHE_L1_ENABLED", value, () => {
    // A blank RPC closes the lane on its own. Flag-off cases still set one, so a mutant that
    // drops the flag (flagEnv null) is caught here and not hidden by the RPC check.
    if (process.env.AVALANCHE_RPC_URL?.trim()) return fn();
    return withEnv("AVALANCHE_RPC_URL", "http://127.0.0.1:9", fn);
  });

test("the table pins Avalanche as measured on-chain 2026-10-26, after Base, Arc, Celo, BNB and Arbitrum", () => {
  assert.deepEqual(
    EVM_PAY_CHAINS.slice(0, 5).map((c) => c.caip2),
    [BASE_CAIP2, ARC_CAIP2, CELO_CAIP2, BNB_CAIP2, ARBITRUM_CAIP2],
    "the first five rows stay Base, Arc, Celo, BNB and Arbitrum",
  );
  assert.deepEqual(
    EVM_PAY_CHAINS.map((c) => c.caip2),
    [BASE_CAIP2, ARC_CAIP2, CELO_CAIP2, BNB_CAIP2, ARBITRUM_CAIP2, AVALANCHE_CAIP2],
    "Base, Arc, Celo, BNB, Arbitrum and Avalanche. Nothing else can be signed on",
  );
  assert.equal(AVALANCHE_CAIP2, "eip155:43114");
  assert.equal(AVALANCHE_CHAIN.caip2, AVALANCHE_CAIP2);
  assert.equal(AVALANCHE_CHAIN.chainId, 43114);
  assert.equal(AVALANCHE_USDC, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E");
  assert.equal(AVALANCHE_CHAIN.usdc, AVALANCHE_USDC);
  assert.equal(AVALANCHE_CHAIN.eip712Name, "USD Coin", "Avalanche USDC reports name() \"USD Coin\" — like Base, not Celo's \"USDC\"");
  assert.equal(AVALANCHE_CHAIN.eip712Version, "2");
  assert.equal(AVALANCHE_CHAIN.label, "Avalanche");
  assert.equal(AVALANCHE_CHAIN.v1Slug, null, "no v1 slug in the money path");
  assert.equal(AVALANCHE_CHAIN.flagEnv, "OBSERVATORY_AVALANCHE_L1_ENABLED");
  assert.equal(AVALANCHE_CHAIN.requiredEnv, "AVALANCHE_RPC_URL");
  assert.equal(BASE_CHAIN.requiredEnv, null);
  assert.equal(ARC_CHAIN.requiredEnv, null);
  assert.equal(EVM_PAY_CHAINS.find((c) => c.caip2 === CELO_CAIP2)!.requiredEnv, null);
  assert.equal(ARBITRUM_CHAIN.requiredEnv, "ARBITRUM_RPC_URL");
  assert.equal(EVM_PAY_CHAINS.find((c) => c.caip2 === BNB_CAIP2)!.requiredEnv, "BNB_RPC_URL");
  assert.equal(EVM_PAY_CHAINS[0], BASE_CHAIN);
  assert.equal(EVM_PAY_CHAINS[1], ARC_CHAIN);
  assert.equal(EVM_PAY_CHAINS[4], ARBITRUM_CHAIN);
  assert.equal(EVM_PAY_CHAINS[5], AVALANCHE_CHAIN);
  assert.equal(publicChainLabel(AVALANCHE_CAIP2), "Avalanche C-Chain");
  assert.equal(otherChainQueryUnsentUntil("eip155:43114"), null);
  assert.equal(otherChainQueryUnsentUntil("eip155:42161"), null);
});

test("the pinned Avalanche domain hashes to the DOMAIN_SEPARATOR() the token itself returned on-chain", () => {
  const computed = hashDomain({
    domain: {
      name: AVALANCHE_CHAIN.eip712Name,
      version: AVALANCHE_CHAIN.eip712Version,
      chainId: BigInt(AVALANCHE_CHAIN.chainId),
      verifyingContract: AVALANCHE_CHAIN.usdc as `0x${string}`,
    },
    types: EIP712_DOMAIN_TYPES,
  });
  assert.equal(AVALANCHE_USDC_DOMAIN_SEPARATOR, "0xbbea200329a938bc3438984a49cb0732e66d66d7bd59c127abacc1710e77f7b3");
  assert.equal(computed, AVALANCHE_USDC_DOMAIN_SEPARATOR);
  const variant = (domain: Record<string, unknown>) => hashDomain({ domain: domain as never, types: EIP712_DOMAIN_TYPES });
  const pinned = { name: "USD Coin", version: "2", chainId: 43114, verifyingContract: AVALANCHE_USDC };
  assert.notEqual(variant({ ...pinned, name: "USDC" }), AVALANCHE_USDC_DOMAIN_SEPARATOR, "Celo/Arc token name");
  assert.notEqual(variant({ ...pinned, version: "1" }), AVALANCHE_USDC_DOMAIN_SEPARATOR);
  assert.notEqual(variant({ ...pinned, chainId: 8453 }), AVALANCHE_USDC_DOMAIN_SEPARATOR, "Base shares name and version, not the chain id");
  assert.notEqual(variant({ ...pinned, chainId: 42220 }), AVALANCHE_USDC_DOMAIN_SEPARATOR);
  assert.notEqual(variant({ ...pinned, verifyingContract: AVALANCHE_USDC_E }), AVALANCHE_USDC_DOMAIN_SEPARATOR, "bridged USDC.e");
});

test("the read-side constants (chain/avalanche.ts) agree with the pinned row, and the settlement index has an Avalanche row", () => {
  assert.equal(AVALANCHE_CHAIN_ID, AVALANCHE_CHAIN.chainId);
  assert.equal(AVALANCHE_CAIP2_READ, AVALANCHE_CHAIN.caip2);
  assert.equal(AVALANCHE_USDC_ADDRESS, AVALANCHE_CHAIN.usdc);
  assert.equal(AVALANCHE_USDC_E_ADDRESS, AVALANCHE_USDC_E);
  const row = EVM_INDEX_CHAINS.find((c) => c.chainId === 43114);
  assert.ok(row, "eip155:43114 missing from EVM_INDEX_CHAINS");
  assert.equal(row.caip2, AVALANCHE_CAIP2);
  assert.equal(row.usdc, AVALANCHE_USDC);
  assert.equal(row.rpcEnv, "AVALANCHE_RPC_URL");
  assert.equal(row.blocksPerDay, 89_111n, "969.578 ms blocks measured 2026-10-26");
  assert.equal(row.subWindowBlocks, 100n, "inclusive eth_getLogs cap measured 2026-10-26 is 100 blocks");
  assert.equal(row.confirmations, 64n);
  assert.equal(row.initialLookbackBlocks, 89_111n * 3n);
  assert.equal(row.maxBlocksPerRun, 89_111n * 2n);
  assert.ok(row.maxBlocksPerRun >= row.blocksPerDay, "a daily cron must be able to keep up");
});

test("the Avalanche RPC: env first, the public RPC only as the balance-read default; the index stays off without AVALANCHE_RPC_URL", () => {
  withEnv("AVALANCHE_RPC_URL", undefined, () => {
    assert.equal(avalancheRpcUrl(), AVALANCHE_PUBLIC_RPC_URL);
    assert.equal(AVALANCHE_PUBLIC_RPC_URL, "https://api.avax.network/ext/bc/C/rpc");
    const row = EVM_INDEX_CHAINS.find((c) => c.chainId === 43114)!;
    assert.equal(isEvmChainIndexable(row), false, "no silent fallback to the public RPC for the index");
    withEnv("ARC_RPC_URL", undefined, () =>
      withEnv("POLYGON_RPC_URL", undefined, () =>
        withEnv("TEMPO_RPC_URL", undefined, () =>
          withEnv("CELO_RPC_URL", undefined, () =>
            withEnv("BNB_RPC_URL", undefined, () =>
              withEnv("AVALANCHE_RPC_URL", undefined, () =>
                withEnv("ARBITRUM_RPC_URL", undefined, () => assert.equal(perChainBudgetMs(120_000), 120_000)),
              ),
            ),
          ),
        ),
      ),
    );
  });
  withEnv("AVALANCHE_RPC_URL", "  https://avax.example/rpc  ", () => {
    assert.equal(avalancheRpcUrl(), "https://avax.example/rpc");
    assert.equal(isEvmChainIndexable(EVM_INDEX_CHAINS.find((c) => c.chainId === 43114)!), true);
  });
});

test("evmChainFor resolves eip155:43114 and none of Avalanche's other spellings or testnets", () => {
  assert.equal(evmChainFor("eip155:43114")?.chainId, 43114);
  assert.equal(evmChainFor("avalanche"), null, "the v1 slug is not resolved in the money path");
  assert.equal(evmChainFor("Avalanche"), null);
  assert.equal(evmChainFor("eip155:43113"), null, "Avalanche Fuji is not a purchase chain");
  assert.equal(evmChainFor("eip155:43115"), null, "a nearby chain id is not a purchase chain");
  assert.equal(evmChainFor("eip155:4311"), null);
  assert.equal(evmChainFor("eip155:431140"), null);
});

test("Avalanche is off unless OBSERVATORY_AVALANCHE_L1_ENABLED is exactly \"true\"; its flag does not move Base or Celo", () => {
  withAvaxFlag(undefined, () => {
    assert.equal(isAvalancheL1Enabled(), false);
    assert.equal(isEvmPayChainEnabled(AVALANCHE_CHAIN), false);
    assert.equal(isEvmPayChainEnabled(BASE_CHAIN), true);
  });
  for (const v of ["1", "TRUE", "True", "on", "yes", " true", "true "]) {
    withAvaxFlag(v, () => {
      assert.equal(isAvalancheL1Enabled(), false, `value ${JSON.stringify(v)}`);
      assert.equal(isEvmPayChainEnabled(AVALANCHE_CHAIN), false, `value ${JSON.stringify(v)}`);
    });
  }
  withAvaxFlag("true", () => {
    assert.equal(isAvalancheL1Enabled(), true);
    assert.equal(isEvmPayChainEnabled(AVALANCHE_CHAIN), true);
    assert.equal(isEvmPayChainEnabled(BASE_CHAIN), true);
    withEnv("OBSERVATORY_CELO_L1_ENABLED", undefined, () => assert.equal(isEvmPayChainEnabled(EVM_PAY_CHAINS.find((c) => c.caip2 === CELO_CAIP2)!), false, "the Avalanche flag does not open Celo"));
  });
  withEnv("OBSERVATORY_CELO_L1_ENABLED", "true", () =>
    withAvaxFlag(undefined, () => assert.equal(isEvmPayChainEnabled(AVALANCHE_CHAIN), false, "the Celo flag does not open Avalanche")),
  );
});

test("flag off: a real Avalanche accept is no_eligible_accept, and a Base-first wall still buys on Base", () => {
  withAvaxFlag(undefined, () => {
    const only = selectAccept([AGENT402_AVAX], { declaredAmount: "1000", declaredPayTo: AGENT402_PAYTO.toLowerCase() });
    assert.equal(only.accept, null);
    assert.equal(only.reason, "no_eligible_accept");
    const preferred = selectAccept([AGENT402_BASE, AGENT402_AVAX], {
      declaredAmount: "1000",
      declaredPayTo: AGENT402_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [AVALANCHE_CAIP2],
      declaredPayTosByNetwork: { [AVALANCHE_CAIP2]: [AGENT402_PAYTO.toLowerCase()] },
    });
    assert.equal(preferred.accept?.network, BASE_CAIP2);
  });
});

test("flag off: signX402Payment refuses an Avalanche accept even if a caller skips the gate", async () => {
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  await withAvaxFlag(undefined, async () => {
    await assert.rejects(() => signX402Payment({ account, accept: AGENT402_AVAX, authorization }), /the Avalanche lane is not enabled/);
  });
});

test("flag on but AVALANCHE_RPC_URL empty or blank: a Base accept that falls off does not select or sign Avalanche", async () => {
  const fallen = [{ ...AGENT402_BASE, asset: "0x0000000000000000000000000000000000000001" }, AGENT402_AVAX];
  const opts = { declaredAmount: "1000", declaredPayTo: AGENT402_PAYTO.toLowerCase() };
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  const check = () => {
    assert.equal(isAvalancheL1Enabled(), true);
    assert.equal(isEvmPayChainEnabled(AVALANCHE_CHAIN), false);
    const chosen = selectAccept(fallen, opts);
    assert.equal(chosen.accept, null);
    assert.equal(chosen.reason, "no_eligible_accept");
  };
  await withEnv("OBSERVATORY_AVALANCHE_L1_ENABLED", "true", async () => {
    withEnv("AVALANCHE_RPC_URL", undefined, check);
    withEnv("AVALANCHE_RPC_URL", "   ", check);
    await withEnv("AVALANCHE_RPC_URL", undefined, async () => {
      await assert.rejects(() => signX402Payment({ account, accept: AGENT402_AVAX, authorization }), /the Avalanche lane is not enabled/);
    });
    await withEnv("AVALANCHE_RPC_URL", "   ", async () => {
      await assert.rejects(() => signX402Payment({ account, accept: AGENT402_AVAX, authorization }), /the Avalanche lane is not enabled/);
    });
  });
});

test("flag on: the Avalanche USDC accept is selected at the declared price and payee", () => {
  withAvaxFlag("true", () => {
    const chosen = selectAccept([BLOCKSCOUT_AVAX, BLOCKSCOUT_BASE], {
      declaredAmount: "2000",
      declaredPayTo: BLOCKSCOUT_AVAX_PAYTO,
      declaredNetwork: AVALANCHE_CAIP2,
    });
    assert.ok(chosen.accept, `expected the Avalanche accept, got ${chosen.reason}`);
    assert.equal(chosen.accept.network, AVALANCHE_CAIP2);
    assert.equal(chosen.accept.asset, AVALANCHE_USDC);
    assert.equal(chosen.accept.payTo, BLOCKSCOUT_AVAX_PAYTO, "the wall's own spelling is what gets signed");
    assert.equal(chosen.accept.amount, "2000");
  });
});

test("flag on: nothing but the pinned native USDC is eligible on Avalanche — USDC.e, another chain's USDC", () => {
  withAvaxFlag("true", () => {
    const opts = { declaredAmount: "1000", declaredPayTo: null };
    const refused = (accept: unknown, why: string) => {
      const r = selectAccept([accept], opts);
      assert.equal(r.accept, null, why);
      assert.equal(r.reason, "no_eligible_accept", why);
    };
    refused({ ...AGENT402_AVAX, asset: AVALANCHE_USDC_E, extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" } }, "bridged USDC.e as the wall lists it");
    refused({ ...AGENT402_AVAX, asset: AVALANCHE_USDC_E, extra: { name: "USD Coin", version: "2" } }, "USDC.e dressed in native USDC's domain words");
    refused({ ...AGENT402_AVAX, asset: AVALANCHE_USDC_E, extra: undefined }, "USDC.e with no extra at all");
    refused({ ...AGENT402_AVAX, extra: { name: "GatewayWalletBatched", version: "2" } }, "GatewayWalletBatched on the native USDC address");
    refused(
      { ...AGENT402_AVAX, asset: "0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD", extra: { name: "Euro Coin", version: "2" } },
      "EURC",
    );
    refused({ ...AGENT402_AVAX, asset: BASE_USDC }, "Base's USDC address on the Avalanche network");
    refused({ ...AGENT402_AVAX, asset: ARC_USDC }, "Arc's USDC address on the Avalanche network");
    refused({ ...AGENT402_BASE, asset: AVALANCHE_USDC }, "Avalanche's USDC address on Base");
    withEnv("OBSERVATORY_ARC_L1_ENABLED", "true", () => refused({ ...AGENT402_AVAX, network: ARC_CAIP2 }, "Avalanche's USDC address on Arc"));
    const mixed = selectAccept([{ ...AGENT402_AVAX, asset: AVALANCHE_USDC_E, extra: { name: "USD Coin", version: "2" } }, AGENT402_AVAX], opts);
    assert.equal(mixed.accept?.asset, AVALANCHE_USDC);
  });
});

test("flag on: scheme, transfer method and the EIP-712 domain are pinned on Avalanche exactly as on Base", () => {
  withAvaxFlag("true", () => {
    const opts = { declaredAmount: "1000", declaredPayTo: null };
    const refused = (accept: unknown, why: string) => assert.equal(selectAccept([accept], opts).accept, null, why);
    refused({ ...AGENT402_AVAX, scheme: "upto" }, "scheme upto");
    refused({ ...AGENT402_AVAX, scheme: undefined }, "no scheme — the signing path does not guess one");
    refused({ ...AGENT402_AVAX, extra: { ...AGENT402_AVAX.extra, assetTransferMethod: "permit2" } }, "permit2 on USDC");
    refused({ ...AGENT402_AVAX, extra: { name: "USDC", version: "2" } }, "Celo/Arc domain name on an Avalanche accept");
    refused({ ...AGENT402_AVAX, extra: { name: "USD Coin", version: "1" } }, "wrong version");
    refused({ ...AGENT402_AVAX, extra: { name: "USD Coin", version: "2", chainId: 8453 } }, "Base's chain id");
    refused({ ...AGENT402_AVAX, extra: { name: "USD Coin", version: "2", chainId: 42220 } }, "Celo's chain id");
    refused({ ...AGENT402_AVAX, extra: { name: "USD Coin", version: "2", verifyingContract: AVALANCHE_USDC_E } }, "USDC.e as verifying contract");
    refused({ ...AGENT402_AVAX, extra: { name: "USD Coin", version: "2", salt: `0x${"11".repeat(32)}` } }, "a salt");
    refused({ ...AGENT402_AVAX, payTo: "0xABF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" }, "a payTo whose checksum is wrong cannot be signed");
    refused({ ...AGENT402_AVAX, maxTimeoutSeconds: 120.5 }, "a fractional timeout cannot be signed");
    assert.ok(selectAccept([{ ...AGENT402_AVAX, extra: { name: "USD Coin", version: "2", chainId: 43114, verifyingContract: AVALANCHE_USDC } }], opts).accept);
    assert.ok(selectAccept([{ ...AGENT402_AVAX, extra: undefined }], opts).accept);
    assert.equal(hasCanonicalUsdcDomain({ name: "USD Coin", version: "2" }, AVALANCHE_CHAIN), true);
    assert.equal(hasCanonicalUsdcDomain({ chainId: "43114" }, AVALANCHE_CHAIN), true);
    assert.equal(hasCanonicalUsdcDomain({ chainId: "0xa86a" }, AVALANCHE_CHAIN), false, "hex form is not the pinned shape");
  });
});

test("flag on: payto_mismatch, price_mismatch and over_cap fire on Avalanche as they do on Base", () => {
  withAvaxFlag("true", () => {
    const wrongPayee = selectAccept([{ ...BLOCKSCOUT_AVAX, payTo: ROGUE_PAYTO }], { declaredAmount: "2000", declaredPayTo: BLOCKSCOUT_AVAX_PAYTO, declaredNetwork: AVALANCHE_CAIP2 });
    assert.equal(wrongPayee.accept, null);
    assert.equal(wrongPayee.reason, "payto_mismatch");
    for (const amount of ["2001", "20000", "1999"]) {
      const r = selectAccept([{ ...BLOCKSCOUT_AVAX, amount }], { declaredAmount: "2000", declaredPayTo: BLOCKSCOUT_AVAX_PAYTO, declaredNetwork: AVALANCHE_CAIP2 });
      assert.equal(r.accept, null, `amount ${amount}`);
      assert.equal(r.reason, "price_mismatch", `amount ${amount}`);
    }
    const over = String(MAX_PER_PURCHASE_UNITS + 1n);
    const overNoDecl = selectAccept([{ ...BLOCKSCOUT_AVAX, amount: over }], { declaredAmount: null, declaredPayTo: BLOCKSCOUT_AVAX_PAYTO });
    assert.equal(overNoDecl.accept, null);
    assert.equal(overNoDecl.reason, "over_cap");
    const overDecl = selectAccept([{ ...BLOCKSCOUT_AVAX, amount: over }], { declaredAmount: over, declaredPayTo: BLOCKSCOUT_AVAX_PAYTO, declaredNetwork: AVALANCHE_CAIP2 });
    assert.equal(overDecl.accept, null);
    assert.equal(overDecl.reason, "over_cap");
    for (const amount of ["0", "-1", "0.001", "1e3", ""]) {
      assert.equal(selectAccept([{ ...BLOCKSCOUT_AVAX, amount }], { declaredAmount: null, declaredPayTo: null }).accept, null, `amount ${JSON.stringify(amount)}`);
    }
  });
});

test("lane preference: a Base-first wall is bought on Avalanche only when the catalog declared that Avalanche payee, at no more than the listing price", () => {
  withAvaxFlag("true", () => {
    const base = {
      declaredAmount: "1000",
      declaredPayTo: AGENT402_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
    };
    assert.equal(selectAccept([AGENT402_BASE, AGENT402_AVAX], base).accept?.network, BASE_CAIP2);
    const lane = { ...base, preferNetworks: [AVALANCHE_CAIP2], declaredPayTosByNetwork: { [AVALANCHE_CAIP2]: [AGENT402_PAYTO.toLowerCase()] } };
    assert.equal(selectAccept([AGENT402_BASE, AGENT402_AVAX], lane).accept?.network, AVALANCHE_CAIP2);
    const rogue = selectAccept([AGENT402_BASE, { ...AGENT402_AVAX, payTo: ROGUE_PAYTO }], lane);
    assert.equal(rogue.accept?.network, BASE_CAIP2);
    assert.equal(rogue.accept?.payTo, AGENT402_PAYTO);
    const rogueOnly = selectAccept([{ ...AGENT402_AVAX, payTo: ROGUE_PAYTO }], lane);
    assert.equal(rogueOnly.accept, null);
    assert.equal(rogueOnly.reason, "payto_mismatch");
    const dearer = selectAccept([AGENT402_BASE, { ...AGENT402_AVAX, amount: "1001" }], lane);
    assert.equal(dearer.accept?.network, BASE_CAIP2);
    const cheaper = selectAccept([AGENT402_BASE, { ...AGENT402_AVAX, amount: "999" }], lane);
    assert.equal(cheaper.accept?.network, AVALANCHE_CAIP2);
    assert.equal(cheaper.accept?.amount, "999");
    const blockscout = selectAccept([BLOCKSCOUT_BASE, BLOCKSCOUT_AVAX], {
      declaredAmount: "2000",
      declaredPayTo: BLOCKSCOUT_BASE_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [AVALANCHE_CAIP2],
      declaredPayTosByNetwork: { [AVALANCHE_CAIP2]: [BLOCKSCOUT_AVAX_PAYTO] },
    });
    assert.equal(blockscout.accept?.network, AVALANCHE_CAIP2);
    assert.equal(blockscout.accept?.payTo, BLOCKSCOUT_AVAX_PAYTO);
    const arcOnly = selectAccept([BLOCKSCOUT_BASE, BLOCKSCOUT_AVAX], {
      declaredAmount: "2000",
      declaredPayTo: BLOCKSCOUT_BASE_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [AVALANCHE_CAIP2],
      declaredPayTosByNetwork: { [ARC_CAIP2]: [BLOCKSCOUT_AVAX_PAYTO] },
    });
    assert.equal(arcOnly.accept?.network, BASE_CAIP2, "no Avalanche declaration ⇒ the Avalanche accept is checked against the head pay_to and fails");
  });
});

test("declaredPayTosFor(AVALANCHE_CHAIN): only an accept this module could sign on Avalanche declares a payee", () => {
  const raw = [
    AGENT402_BASE,
    AGENT402_AVAX,
    BLOCKSCOUT_AVAX,
    { ...AGENT402_AVAX, asset: AVALANCHE_USDC_E, payTo: ROGUE_PAYTO, extra: { name: "USD Coin", version: "2" } },
    { ...AGENT402_AVAX, scheme: "upto", payTo: ROGUE_PAYTO },
    { ...AGENT402_AVAX, network: "avalanche", payTo: ROGUE_PAYTO },
    { ...AGENT402_AVAX, network: "eip155:43113", payTo: ROGUE_PAYTO },
    { ...AGENT402_AVAX, extra: { name: "USDC", version: "2" }, payTo: ROGUE_PAYTO },
  ];
  for (const flag of [undefined, "true"]) {
    withAvaxFlag(flag, () => {
      assert.deepEqual(declaredPayTosFor(AVALANCHE_CHAIN, raw).sort(), [BLOCKSCOUT_AVAX_PAYTO, AGENT402_PAYTO.toLowerCase()].sort());
      assert.deepEqual(declaredPayTosFor(AVALANCHE_CHAIN, JSON.stringify(raw)).sort(), [BLOCKSCOUT_AVAX_PAYTO, AGENT402_PAYTO.toLowerCase()].sort());
      assert.deepEqual(declaredPayTosFor(ARC_CHAIN, raw), [], "an Avalanche accept declares nothing for Arc");
      assert.deepEqual(declaredPayTosFor(AVALANCHE_CHAIN, null), []);
      assert.deepEqual(declaredPayTosFor(AVALANCHE_CHAIN, "not json"), []);
    });
  }
});

test("signX402Payment signs an Avalanche accept under the pinned Avalanche domain and under no other", async () => {
  await withAvaxFlag("true", async () => {
    const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
    const { signature } = await signX402Payment({ account, accept: AGENT402_AVAX, authorization });
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
    assert.equal(await under({ name: "USD Coin", version: "2", chainId: 43114, verifyingContract: AVALANCHE_USDC }), true);
    assert.equal(await under({ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC }), false, "not valid on Base (same name, different chain id)");
    assert.equal(await under({ name: "USDC", version: "2", chainId: 42220, verifyingContract: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" }), false, "not valid on Celo");
    assert.equal(await under({ name: "USD Coin", version: "2", chainId: 43114, verifyingContract: AVALANCHE_USDC_E }), false, "not valid for USDC.e");
    assert.equal(authorization.to, AGENT402_PAYTO);
    assert.equal(authorization.value, "1000");
    assert.equal(Number(authorization.validBefore) - 1_760_000_000, 120);
  });
});

test("signX402Payment refuses an Avalanche accept whose extra contradicts the pinned domain", async () => {
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  await withAvaxFlag("true", async () => {
    await assert.rejects(
      () => signX402Payment({ account, accept: { ...AGENT402_AVAX, extra: { name: "USDC", version: "2" } }, authorization }),
      /canonical Avalanche USDC EIP-712 domain/,
    );
    await assert.rejects(
      () => signX402Payment({ account, accept: { ...AGENT402_AVAX, network: "eip155:43113" }, authorization }),
      /not a pinned EVM purchase chain/,
    );
  });
});

test("encodePaymentHeader carries the Avalanche accept verbatim in v2 and the CAIP-2 id in v1", () => {
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  const payload = { signature: "0xabc", authorization };
  const v2 = encodePaymentHeader({ x402Version: 2, accept: AGENT402_AVAX, payload, resourceUrl: "https://agent402.tools/api/hash" });
  assert.equal(v2.headerName, "PAYMENT-SIGNATURE");
  const decoded2 = JSON.parse(Buffer.from(v2.headerValue, "base64").toString());
  assert.equal(decoded2.accepted.network, "eip155:43114");
  assert.equal(decoded2.accepted.asset, AVALANCHE_USDC);
  assert.equal(decoded2.accepted.payTo, AGENT402_PAYTO);
  assert.equal(decoded2.accepted.amount, "1000");
  const v1 = encodePaymentHeader({ x402Version: 1, accept: AGENT402_AVAX, payload, resourceUrl: "https://agent402.tools/api/hash" });
  assert.equal(JSON.parse(Buffer.from(v1.headerValue, "base64").toString()).network, "eip155:43114");
});

test("the Avalanche secondary predicate drops GatewayWalletBatched and the Celo host-spread return stays", () => {
  const src = readFileSync("src/lib/observatory/l1-runner.ts", "utf8");
  const at = src.indexOf("avalanche: sql`");
  assert.ok(at > 0);
  const clause = src.slice(at, at + 320);
  assert.match(clause, /AVALANCHE_CHAIN\.usdc\.toLowerCase\(\)/);
  assert.match(clause, /eip3009/);
  assert.match(clause, /GatewayWalletBatched/);
  assert.match(src, /return celoLane && lane \? celoDiversifiedCandidatesSql\(query, lane\.limit\) : query/);
  assert.match(src, /if \(avalancheLane && lane\) return avalancheDiversifiedCandidatesSql\(query, lane\.limit\);/);
});

test("Avalanche's label, mainnet scope and receipt link; testnets get no link", () => {
  assert.equal(chainLabel("eip155:43114"), "Avalanche");
  assert.equal(chainLabel("eip155:43114"), AVALANCHE_CHAIN.label, "the lane's label is the join key into l1.byChain");
  assert.equal(isMainnet("eip155:43114"), true);
  assert.equal(isTestnet("eip155:43114"), false);
  const tx = `0x${"ab".repeat(32)}`;
  assert.equal(explorerTxUrl("eip155:43114", tx), `https://snowtrace.io/tx/${tx}`);
  assert.equal(explorerTxUrl("eip155:43114", "not-a-hash"), null, "a malformed tx gets no link");
  assert.equal(explorerTxUrl("eip155:43114", `0x${"ab".repeat(31)}`), null);
  assert.equal(explorerTxUrl("eip155:43113", tx), null, "Avalanche Fuji");
  assert.equal(explorerTxUrl("eip155:8453", tx), `https://basescan.org/tx/${tx}`);
  assert.equal(explorerTxUrl("eip155:5042", tx), `https://explorer.arc.io/tx/${tx}`);
});
