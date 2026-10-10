// ============================================================
// vet402 Observatory L1 — the Celo row of the EVM chain table (Celo lane, 2026-10-10).
//
// Celo mainnet (eip155:42220) is the third EVM chain the x402 payer can sign EIP-3009 on.
// The funnel is the one Base and Arc already pass through: every accept is a refusal unless
// it matches a pinned row exactly — network, USDC address and EIP-712 domain are ours, never
// the seller's and never the facilitator's.
//
// Measured 2026-10-10 by RPC against https://forno.celo.org (not re-derived here):
//   eth_chainId 0xa4ec = 42220 / USDC 0xcebA9300f2b948710d2653dD7B07f33A8B32118C / decimals() 6 /
//   name() "USDC", version() "2" /
//   DOMAIN_SEPARATOR() 0xb2ce31d2838445fa765a491f550e7c78ac7280ab0f3bc9d6063a86df9c3fb578 /
//   authorizationState(address,bytes32) present (EIP-3009).
// The domain-separator test below recomputes the EIP-712 domain hash from the pinned row and
// compares it with that on-chain value, so a wrong pin (name, version, chain id or contract)
// fails here instead of producing signatures that can never settle.
//
// Fixtures are 402 challenges read without paying on 2026-10-10:
//   agent402.tools/api/hash          Base first, Celo ninth, the same payTo on both, amount 1000
//   api.blockscout.com/42220/api/v2/addresses   Celo first, Base second, a DIFFERENT payTo per chain
// and the non-USDC assets the Celo facilitator (api.x402.celo.org/supported) lists on this chain.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { hashDomain, verifyTypedData } from "viem";
import {
  ARC_CAIP2,
  ARC_CHAIN,
  ARC_USDC,
  BASE_CAIP2,
  BASE_CHAIN,
  BASE_USDC,
  CELO_CAIP2,
  CELO_CHAIN,
  CELO_USDC,
  CELO_USDC_DOMAIN_SEPARATOR,
  EVM_PAY_CHAINS,
  MAX_PER_PURCHASE_UNITS,
  buildAuthorization,
  declaredPayTosFor,
  encodePaymentHeader,
  evmChainFor,
  hasCanonicalUsdcDomain,
  isCeloL1Enabled,
  isEvmPayChainEnabled,
  selectAccept,
  signX402Payment,
} from "@/lib/observatory/x402-payer";
import { CELO_CAIP2 as CELO_CAIP2_READ, CELO_CHAIN_ID, CELO_PUBLIC_RPC_URL, CELO_USDC_ADDRESS, celoRpcUrl } from "@/lib/chain/celo";
import { EVM_INDEX_CHAINS, isEvmChainIndexable, perChainBudgetMs } from "@/lib/settlements/index-evm";
import { chainLabel, explorerTxUrl, isMainnet, isTestnet } from "@/lib/observatory/chains";

// Well-known throwaway test key (anvil #0) — never funded on mainnet by us.
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_PK);

const AGENT402_PAYTO = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const BLOCKSCOUT_CELO_PAYTO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
const BLOCKSCOUT_BASE_PAYTO = "0xd441D9F4c59CB26253E2F0A7a62ac9cE7823b4b4";
const ROGUE_PAYTO = "0x1111111111111111111111111111111111111111";

/** agent402.tools/api/hash — the Celo accept (ninth in the wall's list). */
const AGENT402_CELO = {
  scheme: "exact",
  network: "eip155:42220",
  amount: "1000",
  asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  payTo: AGENT402_PAYTO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};
/** agent402.tools/api/hash — the Base accept (first; the catalog's declared price and payTo). */
const AGENT402_BASE = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "1000",
  asset: BASE_USDC,
  payTo: AGENT402_PAYTO,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};
/** api.blockscout.com — Celo first (lower-case payTo, as served), Base second with another payTo. */
const BLOCKSCOUT_CELO = {
  scheme: "exact",
  network: "eip155:42220",
  amount: "2000",
  asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  payTo: BLOCKSCOUT_CELO_PAYTO,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
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

/** The other assets the Celo facilitator lists (api.x402.celo.org/supported, 2026-10-10). None is pinned. */
const CELO_USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const CELO_USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";
const CELO_WARS = "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D";

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
const withCeloFlag = <T>(value: string | undefined, fn: () => T): T => withEnv("OBSERVATORY_CELO_L1_ENABLED", value, fn);

// ---- the pinned row ----------------------------------------------------------

test("the table pins Celo as measured on-chain 2026-10-10, next to Base and Arc and nothing else", () => {
  assert.deepEqual(
    EVM_PAY_CHAINS.map((c) => c.caip2),
    [BASE_CAIP2, ARC_CAIP2, CELO_CAIP2],
    "Base, Arc, Celo — nothing else can be signed on",
  );
  assert.equal(CELO_CAIP2, "eip155:42220");
  assert.equal(CELO_CHAIN.caip2, CELO_CAIP2);
  assert.equal(CELO_CHAIN.chainId, 42220);
  assert.equal(CELO_USDC, "0xcebA9300f2b948710d2653dD7B07f33A8B32118C");
  assert.equal(CELO_CHAIN.usdc, CELO_USDC);
  assert.equal(CELO_CHAIN.eip712Name, "USDC", "Celo USDC reports name() \"USDC\" — not Base's \"USD Coin\"");
  assert.equal(CELO_CHAIN.eip712Version, "2");
  assert.equal(CELO_CHAIN.label, "Celo");
  assert.equal(CELO_CHAIN.v1Slug, null, "no v1 slug in the money path");
  assert.equal(CELO_CHAIN.flagEnv, "OBSERVATORY_CELO_L1_ENABLED");
  // The Base and Arc rows are the same objects as before.
  assert.equal(EVM_PAY_CHAINS[0], BASE_CHAIN);
  assert.equal(EVM_PAY_CHAINS[1], ARC_CHAIN);
});

test("the pinned Celo domain hashes to the DOMAIN_SEPARATOR() the token itself returned on-chain", () => {
  const computed = hashDomain({
    domain: {
      name: CELO_CHAIN.eip712Name,
      version: CELO_CHAIN.eip712Version,
      chainId: BigInt(CELO_CHAIN.chainId),
      verifyingContract: CELO_CHAIN.usdc as `0x${string}`,
    },
    types: EIP712_DOMAIN_TYPES,
  });
  assert.equal(CELO_USDC_DOMAIN_SEPARATOR, "0xb2ce31d2838445fa765a491f550e7c78ac7280ab0f3bc9d6063a86df9c3fb578");
  assert.equal(computed, CELO_USDC_DOMAIN_SEPARATOR);
  // Each pinned field is load-bearing: change any one and the hash is another value.
  const variant = (domain: Record<string, unknown>) => hashDomain({ domain: domain as never, types: EIP712_DOMAIN_TYPES });
  const pinned = { name: "USDC", version: "2", chainId: 42220, verifyingContract: CELO_USDC };
  assert.notEqual(variant({ ...pinned, name: "USD Coin" }), CELO_USDC_DOMAIN_SEPARATOR, "Base's token name");
  assert.notEqual(variant({ ...pinned, version: "1" }), CELO_USDC_DOMAIN_SEPARATOR);
  assert.notEqual(variant({ ...pinned, chainId: 8453 }), CELO_USDC_DOMAIN_SEPARATOR);
  assert.notEqual(variant({ ...pinned, chainId: 5042 }), CELO_USDC_DOMAIN_SEPARATOR, "Arc shares name and version, not the chain id");
  assert.notEqual(variant({ ...pinned, verifyingContract: CELO_USDT }), CELO_USDC_DOMAIN_SEPARATOR);
});

test("the read-side constants (chain/celo.ts) agree with the pinned row, and the settlement index has a Celo row", () => {
  assert.equal(CELO_CHAIN_ID, CELO_CHAIN.chainId);
  assert.equal(CELO_CAIP2_READ, CELO_CHAIN.caip2);
  assert.equal(CELO_USDC_ADDRESS, CELO_CHAIN.usdc);
  const row = EVM_INDEX_CHAINS.find((c) => c.chainId === 42220);
  assert.ok(row, "eip155:42220 missing from EVM_INDEX_CHAINS");
  assert.equal(row.caip2, CELO_CAIP2);
  assert.equal(row.usdc, CELO_USDC);
  assert.equal(row.rpcEnv, "CELO_RPC_URL");
  assert.equal(row.blocksPerDay, 86_400n, "one-second blocks (measured 2026-10-10)");
  assert.ok(row.maxBlocksPerRun >= row.blocksPerDay, "a daily cron must be able to keep up");
});

test("the Celo RPC: env first, the public RPC only as the balance-read default; the index stays off without CELO_RPC_URL", () => {
  withEnv("CELO_RPC_URL", undefined, () => {
    assert.equal(celoRpcUrl(), CELO_PUBLIC_RPC_URL);
    assert.equal(CELO_PUBLIC_RPC_URL, "https://forno.celo.org");
    const row = EVM_INDEX_CHAINS.find((c) => c.chainId === 42220)!;
    assert.equal(isEvmChainIndexable(row), false, "no silent fallback to the public RPC for the index");
    // A skipped row takes no share of the budget (the Arc review's rule): Base keeps what it had.
    withEnv("ARC_RPC_URL", undefined, () =>
      withEnv("POLYGON_RPC_URL", undefined, () =>
        withEnv("TEMPO_RPC_URL", undefined, () => assert.equal(perChainBudgetMs(120_000), 120_000)),
      ),
    );
  });
  withEnv("CELO_RPC_URL", "  https://celo.example/rpc  ", () => {
    assert.equal(celoRpcUrl(), "https://celo.example/rpc");
    assert.equal(isEvmChainIndexable(EVM_INDEX_CHAINS.find((c) => c.chainId === 42220)!), true);
  });
});

test("evmChainFor resolves eip155:42220 and none of Celo's other spellings or testnets", () => {
  assert.equal(evmChainFor("eip155:42220")?.chainId, 42220);
  assert.equal(evmChainFor("celo"), null, "the v1 slug is not resolved in the money path");
  assert.equal(evmChainFor("Celo"), null);
  assert.equal(evmChainFor("eip155:11142220"), null, "Celo Sepolia is not a purchase chain");
  assert.equal(evmChainFor("eip155:44787"), null, "Alfajores is not a purchase chain");
  assert.equal(evmChainFor("eip155:4222"), null);
  assert.equal(evmChainFor("eip155:422200"), null);
});

test("Celo is off unless OBSERVATORY_CELO_L1_ENABLED is exactly \"true\"; its flag does not move Base or Arc", () => {
  withCeloFlag(undefined, () => {
    assert.equal(isCeloL1Enabled(), false);
    assert.equal(isEvmPayChainEnabled(CELO_CHAIN), false);
    assert.equal(isEvmPayChainEnabled(BASE_CHAIN), true);
  });
  for (const v of ["1", "TRUE", "True", "on", "yes", " true", "true "]) {
    withCeloFlag(v, () => {
      assert.equal(isCeloL1Enabled(), false, `value ${JSON.stringify(v)}`);
      assert.equal(isEvmPayChainEnabled(CELO_CHAIN), false, `value ${JSON.stringify(v)}`);
    });
  }
  withCeloFlag("true", () => {
    assert.equal(isCeloL1Enabled(), true);
    assert.equal(isEvmPayChainEnabled(CELO_CHAIN), true);
    assert.equal(isEvmPayChainEnabled(BASE_CHAIN), true);
    withEnv("OBSERVATORY_ARC_L1_ENABLED", undefined, () => assert.equal(isEvmPayChainEnabled(ARC_CHAIN), false, "the Celo flag does not open Arc"));
  });
  withEnv("OBSERVATORY_ARC_L1_ENABLED", "true", () =>
    withCeloFlag(undefined, () => assert.equal(isEvmPayChainEnabled(CELO_CHAIN), false, "the Arc flag does not open Celo")),
  );
});

// ---- selectAccept: flag off ---------------------------------------------------

test("flag off: a real Celo accept is no_eligible_accept, and a Base-first wall still buys on Base", () => {
  withCeloFlag(undefined, () => {
    const only = selectAccept([AGENT402_CELO], { declaredAmount: "1000", declaredPayTo: AGENT402_PAYTO.toLowerCase() });
    assert.equal(only.accept, null);
    assert.equal(only.reason, "no_eligible_accept");
    // Even when the caller asks for the Celo lane, a disabled lane's accept is not eligible.
    const preferred = selectAccept([AGENT402_BASE, AGENT402_CELO], {
      declaredAmount: "1000",
      declaredPayTo: AGENT402_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [CELO_CAIP2],
      declaredPayTosByNetwork: { [CELO_CAIP2]: [AGENT402_PAYTO.toLowerCase()] },
    });
    assert.equal(preferred.accept?.network, BASE_CAIP2);
  });
});

test("flag off: signX402Payment refuses a Celo accept even if a caller skips the gate", async () => {
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  await withCeloFlag(undefined, async () => {
    await assert.rejects(() => signX402Payment({ account, accept: AGENT402_CELO, authorization }), /the Celo lane is not enabled/);
  });
});

// ---- selectAccept: flag on — the same gates as Base ---------------------------

test("flag on: the Celo USDC accept is selected at the declared price and payee", () => {
  withCeloFlag("true", () => {
    const chosen = selectAccept([BLOCKSCOUT_CELO, BLOCKSCOUT_BASE], {
      declaredAmount: "2000",
      declaredPayTo: BLOCKSCOUT_CELO_PAYTO,
      declaredNetwork: CELO_CAIP2,
    });
    assert.ok(chosen.accept, `expected the Celo accept, got ${chosen.reason}`);
    assert.equal(chosen.accept.network, CELO_CAIP2);
    assert.equal(chosen.accept.asset, CELO_USDC);
    assert.equal(chosen.accept.payTo, BLOCKSCOUT_CELO_PAYTO, "the wall's own spelling is what gets signed");
    assert.equal(chosen.accept.amount, "2000");
  });
});

test("flag on: nothing but the pinned USDC is eligible on Celo — USDT, USAT, permit2 tokens, another chain's USDC", () => {
  withCeloFlag("true", () => {
    const opts = { declaredAmount: "1000", declaredPayTo: null };
    const refused = (accept: unknown, why: string) => {
      const r = selectAccept([accept], opts);
      assert.equal(r.accept, null, why);
      assert.equal(r.reason, "no_eligible_accept", why);
    };
    refused({ ...AGENT402_CELO, asset: CELO_USDT, extra: { name: "Tether USD", version: "1", assetTransferMethod: "eip3009" } }, "USDT as the facilitator lists it");
    refused({ ...AGENT402_CELO, asset: CELO_USDT, extra: { name: "USDC", version: "2" } }, "USDT dressed in USDC's domain words");
    refused({ ...AGENT402_CELO, asset: CELO_USDT, extra: undefined }, "USDT with no extra at all");
    refused({ ...AGENT402_CELO, asset: CELO_USAT, extra: { name: "Tether America USD", version: "1" } }, "USAT");
    refused({ ...AGENT402_CELO, asset: CELO_WARS, extra: { name: "Peso Argentino", version: "1", assetTransferMethod: "permit2" } }, "a permit2 token");
    refused({ ...AGENT402_CELO, asset: BASE_USDC }, "Base's USDC address on the Celo network");
    refused({ ...AGENT402_CELO, asset: ARC_USDC }, "Arc's USDC address on the Celo network");
    // And the reverse: Celo's USDC address on another pinned network is not that network's USDC.
    refused({ ...AGENT402_BASE, asset: CELO_USDC }, "Celo's USDC address on Base");
    withEnv("OBSERVATORY_ARC_L1_ENABLED", "true", () => refused({ ...AGENT402_CELO, network: ARC_CAIP2 }, "Celo's USDC address on Arc"));
    // A wall that offers USDT next to USDC is paid in USDC.
    const mixed = selectAccept(
      [{ ...AGENT402_CELO, asset: CELO_USDT, extra: { name: "Tether USD", version: "1" } }, AGENT402_CELO],
      opts,
    );
    assert.equal(mixed.accept?.asset, CELO_USDC);
  });
});

test("flag on: scheme, transfer method and the EIP-712 domain are pinned on Celo exactly as on Base and Arc", () => {
  withCeloFlag("true", () => {
    const opts = { declaredAmount: "1000", declaredPayTo: null };
    const refused = (accept: unknown, why: string) => assert.equal(selectAccept([accept], opts).accept, null, why);
    refused({ ...AGENT402_CELO, scheme: "upto" }, "scheme upto");
    refused({ ...AGENT402_CELO, scheme: undefined }, "no scheme — the signing path does not guess one");
    refused({ ...AGENT402_CELO, extra: { ...AGENT402_CELO.extra, assetTransferMethod: "permit2" } }, "permit2 on USDC");
    refused({ ...AGENT402_CELO, extra: { name: "USD Coin", version: "2" } }, "Base's domain name on a Celo accept");
    refused({ ...AGENT402_CELO, extra: { name: "USDC", version: "1" } }, "wrong version");
    refused({ ...AGENT402_CELO, extra: { name: "USDC", version: "2", chainId: 8453 } }, "Base's chain id");
    refused({ ...AGENT402_CELO, extra: { name: "USDC", version: "2", chainId: 5042 } }, "Arc's chain id");
    refused({ ...AGENT402_CELO, extra: { name: "USDC", version: "2", verifyingContract: CELO_USDT } }, "another verifying contract");
    refused({ ...AGENT402_CELO, extra: { name: "USDC", version: "2", salt: `0x${"11".repeat(32)}` } }, "a salt");
    refused({ ...AGENT402_CELO, payTo: "0xABF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" }, "a payTo whose checksum is wrong cannot be signed");
    refused({ ...AGENT402_CELO, maxTimeoutSeconds: 120.5 }, "a fractional timeout cannot be signed");
    // Present and equal to the pin is fine; absent is fine (the pinned values are used).
    assert.ok(selectAccept([{ ...AGENT402_CELO, extra: { name: "USDC", version: "2", chainId: 42220, verifyingContract: CELO_USDC } }], opts).accept);
    assert.ok(selectAccept([{ ...AGENT402_CELO, extra: undefined }], opts).accept);
    assert.equal(hasCanonicalUsdcDomain({ name: "USDC", version: "2" }, CELO_CHAIN), true);
    assert.equal(hasCanonicalUsdcDomain({ chainId: "42220" }, CELO_CHAIN), true);
    assert.equal(hasCanonicalUsdcDomain({ chainId: "0xa4ec" }, CELO_CHAIN), false, "hex form is not the pinned shape");
  });
});

test("flag on: payto_mismatch, price_mismatch and over_cap fire on Celo as they do on Base", () => {
  withCeloFlag("true", () => {
    // Another payee than the catalog declared.
    const wrongPayee = selectAccept([{ ...BLOCKSCOUT_CELO, payTo: ROGUE_PAYTO }], { declaredAmount: "2000", declaredPayTo: BLOCKSCOUT_CELO_PAYTO, declaredNetwork: CELO_CAIP2 });
    assert.equal(wrongPayee.accept, null);
    assert.equal(wrongPayee.reason, "payto_mismatch");
    // The wall asks more (or less) than the catalog declared.
    for (const amount of ["2001", "20000", "1999"]) {
      const r = selectAccept([{ ...BLOCKSCOUT_CELO, amount }], { declaredAmount: "2000", declaredPayTo: BLOCKSCOUT_CELO_PAYTO, declaredNetwork: CELO_CAIP2 });
      assert.equal(r.accept, null, `amount ${amount}`);
      assert.equal(r.reason, "price_mismatch", `amount ${amount}`);
    }
    // Above the hard per-purchase ceiling, with and without a declared price.
    const over = String(MAX_PER_PURCHASE_UNITS + 1n);
    const overNoDecl = selectAccept([{ ...BLOCKSCOUT_CELO, amount: over }], { declaredAmount: null, declaredPayTo: BLOCKSCOUT_CELO_PAYTO });
    assert.equal(overNoDecl.accept, null);
    assert.equal(overNoDecl.reason, "over_cap");
    const overDecl = selectAccept([{ ...BLOCKSCOUT_CELO, amount: over }], { declaredAmount: over, declaredPayTo: BLOCKSCOUT_CELO_PAYTO, declaredNetwork: CELO_CAIP2 });
    assert.equal(overDecl.accept, null);
    assert.equal(overDecl.reason, "over_cap");
    // Zero, negative and non-integer amounts are never signed.
    for (const amount of ["0", "-1", "0.001", "1e3", ""]) {
      assert.equal(selectAccept([{ ...BLOCKSCOUT_CELO, amount }], { declaredAmount: null, declaredPayTo: null }).accept, null, `amount ${JSON.stringify(amount)}`);
    }
  });
});

// ---- lane preference: a Base-first listing bought on Celo ----------------------

test("lane preference: a Base-first wall is bought on Celo only when the catalog declared that Celo payee, at no more than the listing price", () => {
  withCeloFlag("true", () => {
    const base = {
      declaredAmount: "1000",
      declaredPayTo: AGENT402_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
    };
    // Without a preference the seller's order stands: Base.
    assert.equal(selectAccept([AGENT402_BASE, AGENT402_CELO], base).accept?.network, BASE_CAIP2);
    // The Celo lane prefers its own network.
    const lane = { ...base, preferNetworks: [CELO_CAIP2], declaredPayTosByNetwork: { [CELO_CAIP2]: [AGENT402_PAYTO.toLowerCase()] } };
    assert.equal(selectAccept([AGENT402_BASE, AGENT402_CELO], lane).accept?.network, CELO_CAIP2);
    // The wall puts another payee on its Celo accept: not paid on Celo; the declared Base accept is bought instead.
    const rogue = selectAccept([AGENT402_BASE, { ...AGENT402_CELO, payTo: ROGUE_PAYTO }], lane);
    assert.equal(rogue.accept?.network, BASE_CAIP2);
    assert.equal(rogue.accept?.payTo, AGENT402_PAYTO);
    // …and with no Base accept to fall back to, nothing is paid.
    const rogueOnly = selectAccept([{ ...AGENT402_CELO, payTo: ROGUE_PAYTO }], lane);
    assert.equal(rogueOnly.accept, null);
    assert.equal(rogueOnly.reason, "payto_mismatch");
    // The Celo accept priced above the listing is not bought on Celo (the lane may cost less, never more).
    const dearer = selectAccept([AGENT402_BASE, { ...AGENT402_CELO, amount: "1001" }], lane);
    assert.equal(dearer.accept?.network, BASE_CAIP2);
    const cheaper = selectAccept([AGENT402_BASE, { ...AGENT402_CELO, amount: "999" }], lane);
    assert.equal(cheaper.accept?.network, CELO_CAIP2);
    assert.equal(cheaper.accept?.amount, "999");
    // A Celo-first seller whose Base accept names another payee: the payee set is per network.
    const blockscout = selectAccept([BLOCKSCOUT_BASE, BLOCKSCOUT_CELO], {
      declaredAmount: "2000",
      declaredPayTo: BLOCKSCOUT_BASE_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [CELO_CAIP2],
      declaredPayTosByNetwork: { [CELO_CAIP2]: [BLOCKSCOUT_CELO_PAYTO] },
    });
    assert.equal(blockscout.accept?.network, CELO_CAIP2);
    assert.equal(blockscout.accept?.payTo, BLOCKSCOUT_CELO_PAYTO);
    // The Arc declaration is not a Celo declaration.
    const arcOnly = selectAccept([BLOCKSCOUT_BASE, BLOCKSCOUT_CELO], {
      declaredAmount: "2000",
      declaredPayTo: BLOCKSCOUT_BASE_PAYTO.toLowerCase(),
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [CELO_CAIP2],
      declaredPayTosByNetwork: { [ARC_CAIP2]: [BLOCKSCOUT_CELO_PAYTO] },
    });
    assert.equal(arcOnly.accept?.network, BASE_CAIP2, "no Celo declaration ⇒ the Celo accept is checked against the head pay_to and fails");
  });
});

test("declaredPayTosFor(CELO_CHAIN): only an accept this module could sign on Celo declares a payee", () => {
  const raw = [
    AGENT402_BASE,
    AGENT402_CELO,
    BLOCKSCOUT_CELO,
    { ...AGENT402_CELO, asset: CELO_USDT, payTo: ROGUE_PAYTO, extra: { name: "Tether USD", version: "1" } },
    { ...AGENT402_CELO, scheme: "upto", payTo: ROGUE_PAYTO },
    { ...AGENT402_CELO, network: "celo", payTo: ROGUE_PAYTO },
    { ...AGENT402_CELO, network: "eip155:11142220", payTo: ROGUE_PAYTO },
    { ...AGENT402_CELO, extra: { name: "USD Coin", version: "2" }, payTo: ROGUE_PAYTO },
  ];
  // Flag-agnostic: a declaration is a fact about the catalog, not a permission.
  for (const flag of [undefined, "true"]) {
    withCeloFlag(flag, () => {
      assert.deepEqual(declaredPayTosFor(CELO_CHAIN, raw).sort(), [BLOCKSCOUT_CELO_PAYTO, AGENT402_PAYTO.toLowerCase()].sort());
      assert.deepEqual(declaredPayTosFor(CELO_CHAIN, JSON.stringify(raw)).sort(), [BLOCKSCOUT_CELO_PAYTO, AGENT402_PAYTO.toLowerCase()].sort());
      assert.deepEqual(declaredPayTosFor(ARC_CHAIN, raw), [], "a Celo accept declares nothing for Arc");
      assert.deepEqual(declaredPayTosFor(CELO_CHAIN, null), []);
      assert.deepEqual(declaredPayTosFor(CELO_CHAIN, "not json"), []);
    });
  }
});

// ---- signing ------------------------------------------------------------------

test("signX402Payment signs a Celo accept under the pinned Celo domain and under no other", async () => {
  await withCeloFlag("true", async () => {
    const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
    const { signature } = await signX402Payment({ account, accept: AGENT402_CELO, authorization });
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
    assert.equal(await under({ name: "USDC", version: "2", chainId: 42220, verifyingContract: CELO_USDC }), true);
    assert.equal(await under({ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC }), false, "not valid on Base");
    assert.equal(await under({ name: "USDC", version: "2", chainId: 5042, verifyingContract: ARC_USDC }), false, "not valid on Arc (same name and version)");
    assert.equal(await under({ name: "USDC", version: "2", chainId: 42220, verifyingContract: CELO_USDT }), false, "not valid for USDT");
    // The authorization moves exactly what the accept asked, to exactly the accept's payee, for at most 120 seconds.
    assert.equal(authorization.to, AGENT402_PAYTO);
    assert.equal(authorization.value, "1000");
    assert.equal(Number(authorization.validBefore) - 1_760_000_000, 120);
  });
});

test("signX402Payment refuses a Celo accept whose extra contradicts the pinned domain", async () => {
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  await withCeloFlag("true", async () => {
    await assert.rejects(
      () => signX402Payment({ account, accept: { ...AGENT402_CELO, extra: { name: "USD Coin", version: "2" } }, authorization }),
      /canonical Celo USDC EIP-712 domain/,
    );
    await assert.rejects(
      () => signX402Payment({ account, accept: { ...AGENT402_CELO, network: "eip155:11142220" }, authorization }),
      /not a pinned EVM purchase chain/,
    );
  });
});

test("encodePaymentHeader carries the Celo accept verbatim in v2 and the CAIP-2 id in v1", () => {
  const authorization = buildAuthorization({ from: account.address, to: AGENT402_PAYTO, value: "1000", nowSec: 1_760_000_000, maxTimeoutSeconds: 300 });
  const payload = { signature: "0xabc", authorization };
  const v2 = encodePaymentHeader({ x402Version: 2, accept: AGENT402_CELO, payload, resourceUrl: "https://agent402.tools/api/hash" });
  assert.equal(v2.headerName, "PAYMENT-SIGNATURE");
  const decoded2 = JSON.parse(Buffer.from(v2.headerValue, "base64").toString());
  assert.equal(decoded2.accepted.network, "eip155:42220");
  assert.equal(decoded2.accepted.asset, CELO_USDC);
  assert.equal(decoded2.accepted.payTo, AGENT402_PAYTO);
  assert.equal(decoded2.accepted.amount, "1000");
  const v1 = encodePaymentHeader({ x402Version: 1, accept: AGENT402_CELO, payload, resourceUrl: "https://agent402.tools/api/hash" });
  assert.equal(JSON.parse(Buffer.from(v1.headerValue, "base64").toString()).network, "eip155:42220");
});

// ---- public labels and receipt links -------------------------------------------

test("Celo's label, mainnet scope and receipt link; testnets get no link", () => {
  assert.equal(chainLabel("eip155:42220"), "Celo");
  assert.equal(chainLabel("eip155:42220"), CELO_CHAIN.label, "the lane's label is the join key into l1.byChain");
  assert.equal(isMainnet("eip155:42220"), true);
  assert.equal(isTestnet("eip155:42220"), false);
  const tx = `0x${"ab".repeat(32)}`;
  assert.equal(explorerTxUrl("eip155:42220", tx), `https://celoscan.io/tx/${tx}`);
  assert.equal(explorerTxUrl("eip155:42220", "not-a-hash"), null, "a malformed tx gets no link");
  assert.equal(explorerTxUrl("eip155:42220", `0x${"ab".repeat(31)}`), null);
  assert.equal(explorerTxUrl("eip155:11142220", tx), null, "Celo Sepolia");
  assert.equal(explorerTxUrl("eip155:44787", tx), null, "Alfajores");
  // The existing links are unchanged.
  assert.equal(explorerTxUrl("eip155:8453", tx), `https://basescan.org/tx/${tx}`);
  assert.equal(explorerTxUrl("eip155:5042", tx), `https://explorer.arc.io/tx/${tx}`);
});
