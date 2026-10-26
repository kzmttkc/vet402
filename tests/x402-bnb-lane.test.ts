// ============================================================
// vet402 Observatory L1 — the BNB row of the EVM chain table (BNB lane, 2026-10-19, stage B1).
//
// BNB Chain mainnet (eip155:56) is the fourth EVM chain the x402 payer can sign EIP-3009 on.
// The token is USD1 (18 decimals), not USDC. The ledger stays 6 decimals (×10^12).
// The lane is off unless OBSERVATORY_BNB_L1_ENABLED is exactly "true".
// Measured 2026-10-19 against https://bsc-dataseed.bnbchain.org. These tests do not call it.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { bsc } from "viem/chains";
import {
  BASE_CAIP2,
  BASE_USDC,
  BNB_CAIP2,
  BNB_CHAIN,
  BNB_CHAIN_ID,
  BNB_LEDGER_SCALE,
  BNB_USD1,
  BNB_USD1_EIP712_NAME,
  BNB_USD1_EIP712_VERSION,
  EVM_PAY_CHAINS,
  MAX_PER_PURCHASE_UNITS,
  bnbLedgerUnits,
  declaredPayTosFor,
  evmChainFor,
  hasCanonicalUsdcDomain,
  isBnbL1Enabled,
  isEvmPayChainEnabled,
  ledgerUnitsToBnbAssetUnits,
  selectAccept,
  signX402Payment,
  type ChallengeAccept,
} from "@/lib/observatory/x402-payer";
import {
  BNB_CAIP2 as BNB_CAIP2_READ,
  BNB_CHAIN_ID as BNB_CHAIN_ID_READ,
  BNB_PUBLIC_RPC_URL,
  BNB_USD1_ADDRESS,
  BNB_USD1_DECIMALS,
  bnbRpcUrl,
} from "@/lib/chain/bnb";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const DIME = 10n ** 17n; // $0.10 in 18-digit USD1
const DIME_LEDGER = 100_000n; // $0.10 in 6-digit ledger units
const DIME_TEXT = DIME.toString();

const bnbAccept = (over: Partial<ChallengeAccept> = {}): ChallengeAccept => ({
  scheme: "exact",
  network: BNB_CAIP2,
  amount: DIME_TEXT,
  asset: BNB_USD1,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "World Liberty Financial USD", version: "1", assetTransferMethod: "eip3009" },
  ...over,
});

const baseAccept = (over: Partial<ChallengeAccept> = {}): ChallengeAccept => ({
  scheme: "exact",
  network: BASE_CAIP2,
  amount: DIME_LEDGER.toString(),
  asset: BASE_USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
  ...over,
});

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const savedFlag = process.env.OBSERVATORY_BNB_L1_ENABLED;
  const savedRpc = process.env.BNB_RPC_URL;
  // A blank RPC closes the lane on its own. Flag-off cases still set one, so a mutant that
  // drops the flag (flagEnv null) is caught here and not hidden by the RPC check.
  const fillRpc = !savedRpc?.trim();
  if (value === undefined) delete process.env.OBSERVATORY_BNB_L1_ENABLED;
  else process.env.OBSERVATORY_BNB_L1_ENABLED = value;
  if (fillRpc) process.env.BNB_RPC_URL = "http://127.0.0.1:9";
  try {
    return fn();
  } finally {
    if (savedFlag === undefined) delete process.env.OBSERVATORY_BNB_L1_ENABLED;
    else process.env.OBSERVATORY_BNB_L1_ENABLED = savedFlag;
    if (fillRpc) {
      if (savedRpc === undefined) delete process.env.BNB_RPC_URL;
      else process.env.BNB_RPC_URL = savedRpc;
    }
  }
}

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

test("the table pins BNB USD1 as measured on 2026-10-19, and the read-side constants match", () => {
  assert.equal(bsc.id, 56);
  assert.equal(BNB_CAIP2, "eip155:56");
  assert.equal(BNB_CHAIN_ID, 56);
  assert.equal(BNB_CHAIN.caip2, BNB_CAIP2);
  assert.equal(BNB_CHAIN.chainId, BNB_CHAIN_ID);
  assert.equal(BNB_USD1, "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d");
  assert.equal(BNB_CHAIN.usdc, BNB_USD1);
  assert.equal(BNB_USD1_EIP712_NAME, "World Liberty Financial USD");
  assert.equal(BNB_CHAIN.eip712Name, BNB_USD1_EIP712_NAME);
  assert.equal(BNB_USD1_EIP712_VERSION, "1");
  assert.equal(BNB_CHAIN.eip712Version, BNB_USD1_EIP712_VERSION);
  assert.equal(BNB_CHAIN.v1Slug, null);
  assert.equal(BNB_CHAIN.flagEnv, "OBSERVATORY_BNB_L1_ENABLED");
  assert.equal(BNB_CHAIN.requiredEnv, "BNB_RPC_URL");
  assert.equal(BNB_CHAIN.label, "BNB Chain");
  assert.equal(EVM_PAY_CHAINS[3], BNB_CHAIN);
  assert.equal(BNB_CHAIN_ID_READ, BNB_CHAIN_ID);
  assert.equal(BNB_CAIP2_READ, BNB_CAIP2);
  assert.equal(BNB_USD1_ADDRESS, BNB_USD1);
  assert.equal(BNB_USD1_DECIMALS, 18);
  assert.equal(BNB_LEDGER_SCALE, 10n ** BigInt(BNB_USD1_DECIMALS - 6));
  assert.equal(BNB_PUBLIC_RPC_URL, "https://bsc-dataseed.bnbchain.org");
  assert.equal(evmChainFor("eip155:56")?.caip2, BNB_CAIP2);
  assert.equal(evmChainFor("eip155:97"), null, "BSC testnet is not pinned");
  assert.equal(evmChainFor("bnb"), null);
  assert.equal(evmChainFor("bsc"), null);
  assert.equal(hasCanonicalUsdcDomain({ name: "World Liberty Financial USD", version: "1" }, BNB_CHAIN), true);
  assert.equal(hasCanonicalUsdcDomain({ name: "USD Coin", version: "2" }, BNB_CHAIN), false);
  assert.equal(hasCanonicalUsdcDomain({ name: "World Liberty Financial USD", version: "2" }, BNB_CHAIN), false);
});

test("bnbRpcUrl uses BNB_RPC_URL and otherwise the public dataseed (no connection)", () => {
  const saved = process.env.BNB_RPC_URL;
  try {
    delete process.env.BNB_RPC_URL;
    assert.equal(bnbRpcUrl(), BNB_PUBLIC_RPC_URL);
    process.env.BNB_RPC_URL = "  ";
    assert.equal(bnbRpcUrl(), BNB_PUBLIC_RPC_URL);
    process.env.BNB_RPC_URL = "http://127.0.0.1:9";
    assert.equal(bnbRpcUrl(), "http://127.0.0.1:9");
  } finally {
    if (saved === undefined) delete process.env.BNB_RPC_URL;
    else process.env.BNB_RPC_URL = saved;
  }
});

test("OBSERVATORY_BNB_L1_ENABLED is off unless it is exactly \"true\"", () => {
  withFlag(undefined, () => {
    assert.equal(isBnbL1Enabled(), false);
    assert.equal(isEvmPayChainEnabled(BNB_CHAIN), false);
  });
  for (const value of ["", "TRUE", "1", "yes", "false"]) {
    withFlag(value, () => {
      assert.equal(isBnbL1Enabled(), false, value);
      assert.equal(isEvmPayChainEnabled(BNB_CHAIN), false, value);
    });
  }
  withFlag("true", () => {
    assert.equal(isBnbL1Enabled(), true);
    assert.equal(isEvmPayChainEnabled(BNB_CHAIN), true);
  });
});

test("flag on but BNB_RPC_URL empty or blank: a Base accept that falls off does not select or sign BNB", async () => {
  const fallen = [baseAccept({ asset: "0x0000000000000000000000000000000000000001" }), bnbAccept()];
  const opts = { declaredAmount: DIME_LEDGER.toString(), declaredPayTo: PAY_TO, declaredNetwork: BASE_CAIP2 };
  const account = privateKeyToAccount(generatePrivateKey());
  const authorization = {
    from: account.address,
    to: PAY_TO,
    value: DIME_TEXT,
    validAfter: "0",
    validBefore: "120",
    nonce: `0x${"cd".repeat(32)}` as `0x${string}`,
  };
  const savedFlag = process.env.OBSERVATORY_BNB_L1_ENABLED;
  const savedRpc = process.env.BNB_RPC_URL;
  process.env.OBSERVATORY_BNB_L1_ENABLED = "true";
  try {
    for (const rpc of [undefined, "   "] as const) {
      if (rpc === undefined) delete process.env.BNB_RPC_URL;
      else process.env.BNB_RPC_URL = rpc;
      assert.equal(isBnbL1Enabled(), true);
      assert.equal(isEvmPayChainEnabled(BNB_CHAIN), false);
      const chosen = selectAccept(fallen, opts);
      assert.equal(chosen.accept, null);
      assert.equal(chosen.reason, "no_eligible_accept");
      await assert.rejects(
        () => signX402Payment({ account, accept: bnbAccept(), authorization }),
        /BNB Chain lane is not enabled/,
      );
    }
  } finally {
    if (savedFlag === undefined) delete process.env.OBSERVATORY_BNB_L1_ENABLED;
    else process.env.OBSERVATORY_BNB_L1_ENABLED = savedFlag;
    if (savedRpc === undefined) delete process.env.BNB_RPC_URL;
    else process.env.BNB_RPC_URL = savedRpc;
  }
});

test("$0.10 is 100000 ledger units and 1e17 USD1 units, exactly", () => {
  assert.equal(bnbLedgerUnits(DIME), DIME_LEDGER);
  assert.equal(ledgerUnitsToBnbAssetUnits(DIME_LEDGER), DIME);
  assert.equal(DIME_LEDGER * BNB_LEDGER_SCALE, DIME);
});

test("flag off: a BNB accept is not selected, and a Base accept is unchanged", () => {
  withFlag(undefined, () => {
    const only = selectAccept([bnbAccept()], {
      declaredAmount: DIME_TEXT,
      declaredPayTo: PAY_TO,
      declaredNetwork: BNB_CAIP2,
    });
    assert.equal(only.accept, null);
    assert.equal(only.reason, "no_eligible_accept");
    assert.equal(only.detail, undefined);
    const mixed = selectAccept([bnbAccept(), baseAccept()], {
      declaredAmount: DIME_LEDGER.toString(),
      declaredPayTo: PAY_TO,
      declaredNetwork: BASE_CAIP2,
    });
    assert.equal(mixed.accept?.network, BASE_CAIP2);
    assert.equal("amountUnits" in mixed, false);
  });
});

test("flag on: $0.10 USD1 is selected and the ledger amount is 100000", () => {
  withFlag("true", () => {
    const chosen = selectAccept([bnbAccept()], {
      declaredAmount: DIME_TEXT,
      declaredPayTo: PAY_TO,
      declaredNetwork: BNB_CAIP2,
    });
    assert.equal(chosen.accept?.network, BNB_CAIP2);
    if (chosen.accept === null) throw new Error("expected a BNB accept");
    assert.equal(chosen.amountUnits, DIME_LEDGER);
    assert.equal(chosen.accept.amount, DIME_TEXT);
  });
});

test("declared price matches in 18-digit units: 1e17+1e12 is price_mismatch, 1e17+1 is unbuildable", () => {
  withFlag("true", () => {
    const opts = { declaredAmount: DIME_TEXT, declaredPayTo: PAY_TO, declaredNetwork: BNB_CAIP2 };
    const offByScale = selectAccept([bnbAccept({ amount: (DIME + BNB_LEDGER_SCALE).toString() })], opts);
    assert.equal(offByScale.accept, null);
    assert.equal(offByScale.reason, "price_mismatch");
    const offByOne = selectAccept([bnbAccept({ amount: (DIME + 1n).toString() })], opts);
    assert.equal(offByOne.accept, null);
    assert.equal(offByOne.reason, "no_eligible_accept");
    assert.equal(offByOne.detail, "unbuildable");
  });
});

test("an amount not divisible by 10^12 is unbuildable before it can be reserved", () => {
  withFlag("true", () => {
    assert.equal(bnbLedgerUnits(DIME + 1n), null);
    assert.equal(bnbLedgerUnits(0n), null);
    assert.equal(bnbLedgerUnits(-DIME), null);
    const r = selectAccept([bnbAccept({ amount: (DIME + 1n).toString() })], {
      declaredAmount: null,
      declaredPayTo: PAY_TO,
      declaredNetwork: BNB_CAIP2,
    });
    assert.equal(r.accept, null);
    assert.equal(r.reason, "no_eligible_accept");
    assert.equal(r.detail, "unbuildable");
  });
});

test("the per-purchase ceiling is the 6-digit cap scaled to 18 digits", () => {
  withFlag("true", () => {
    const atCap = MAX_PER_PURCHASE_UNITS * BNB_LEDGER_SCALE;
    const ok = selectAccept([bnbAccept({ amount: atCap.toString() })], {
      declaredAmount: atCap.toString(),
      declaredPayTo: PAY_TO,
      declaredNetwork: BNB_CAIP2,
    });
    assert.equal(ok.accept?.amount, atCap.toString());
    if (ok.accept === null) throw new Error("expected the cap accept");
    assert.equal(ok.amountUnits, MAX_PER_PURCHASE_UNITS);
    const over = (MAX_PER_PURCHASE_UNITS + 1n) * BNB_LEDGER_SCALE;
    const denied = selectAccept([bnbAccept({ amount: over.toString() })], {
      declaredAmount: over.toString(),
      declaredPayTo: PAY_TO,
      declaredNetwork: BNB_CAIP2,
    });
    assert.equal(denied.accept, null);
    assert.equal(denied.reason, "over_cap");
  });
});

test("only USD1 eip3009 is payable: other assets, permit2 and permit2-exact are refused", () => {
  withFlag("true", () => {
    const opts = { declaredAmount: DIME_TEXT, declaredPayTo: PAY_TO, declaredNetwork: BNB_CAIP2 };
    const otherAsset = "0x3333333333333333333333333333333333333333";
    for (const accept of [
      bnbAccept({ asset: otherAsset }),
      bnbAccept({ extra: { name: "World Liberty Financial USD", version: "1", assetTransferMethod: "permit2" } }),
      bnbAccept({ extra: { name: "World Liberty Financial USD", version: "1", assetTransferMethod: "permit2-exact" } }),
      bnbAccept({ scheme: "upto" }),
      bnbAccept({ network: "eip155:97" }),
      bnbAccept({ extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" } }),
    ]) {
      const r = selectAccept([accept], opts);
      assert.equal(r.accept, null, JSON.stringify(accept.extra ?? accept.asset));
      assert.equal(r.reason, "no_eligible_accept");
    }
  });
});

test("a Base permit2 wall plus USD1 at 1e17 is not price_mismatch against a 6-digit $0.10 declaration", () => {
  const wall = [
    baseAccept({ extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } }),
    bnbAccept(),
  ];
  const declared = {
    declaredAmount: DIME_LEDGER.toString(),
    declaredPayTo: PAY_TO,
    declaredNetwork: BASE_CAIP2,
  };
  const check = (prefer: boolean) => {
    const chosen = selectAccept(
      wall,
      prefer
        ? { ...declared, preferNetworks: [BNB_CAIP2], declaredPayTosByNetwork: { [BNB_CAIP2]: [PAY_TO] } }
        : declared,
    );
    // 宣言は Base の 6 桁。BNB の 18 桁とは比べられないので、払わず、売り手の所見（price_mismatch）にもしない。
    assert.equal(chosen.accept, null);
    assert.equal(chosen.reason, "no_eligible_accept");
  };
  withFlag(undefined, () => {
    check(false);
    check(true);
  });
  withFlag("true", () => {
    check(false);
    check(true);
  });
});

test("BNB primary: the relative cap is the 18-digit declaration in ledger units, and an unbuildable declaration does not exempt", () => {
  withFlag("true", () => {
    const listing = {
      declaredAmount: DIME_TEXT,
      declaredPayTo: PAY_TO,
      declaredNetwork: BNB_CAIP2,
      preferNetworks: [BASE_CAIP2],
    };
    const atListing = selectAccept([bnbAccept(), baseAccept({ amount: DIME_LEDGER.toString() })], listing);
    assert.equal(atListing.accept?.network, BASE_CAIP2, "a preferred Base accept at the 6-digit listing is payable");
    const overListing = selectAccept([bnbAccept(), baseAccept({ amount: (DIME_LEDGER + 1n).toString() })], listing);
    assert.equal(overListing.accept?.network, BNB_CAIP2, "one ledger unit above the listing is not paid on the preferred chain");
    const unbuildable = selectAccept([bnbAccept({ amount: (DIME + 1n).toString() }), baseAccept()], {
      ...listing,
      declaredAmount: (DIME + 1n).toString(),
    });
    assert.notEqual(unbuildable.accept?.network, BASE_CAIP2, "an unbuildable BNB declaration does not open the relative-cap exemption");
  });
});

test("lane preference buys the secondary USD1 accept at the Base listing's 6-digit price", () => {
  withFlag("true", () => {
    const lane = {
      declaredAmount: DIME_LEDGER.toString(),
      declaredPayTo: PAY_TO,
      declaredNetwork: BASE_CAIP2,
      preferNetworks: [BNB_CAIP2],
      declaredPayTosByNetwork: { [BNB_CAIP2]: [PAY_TO] },
    };
    const chosen = selectAccept([baseAccept(), bnbAccept()], lane);
    assert.equal(chosen.accept?.network, BNB_CAIP2);
    if (chosen.accept === null) throw new Error("expected the secondary USD1 accept");
    assert.equal(chosen.amountUnits, DIME_LEDGER);
    const dearer = selectAccept([baseAccept(), bnbAccept({ amount: (DIME + BNB_LEDGER_SCALE).toString() })], lane);
    assert.equal(dearer.accept?.network, BASE_CAIP2, "one ledger unit above the listing stays on Base");
    assert.equal("amountUnits" in dearer, false);
    const cheaper = selectAccept([baseAccept(), bnbAccept({ amount: (DIME - BNB_LEDGER_SCALE).toString() })], lane);
    assert.equal(cheaper.accept?.network, BNB_CAIP2);
    if (cheaper.accept === null) throw new Error("expected the cheaper USD1 accept");
    assert.equal(cheaper.amountUnits, DIME_LEDGER - 1n);
    const dust = selectAccept([baseAccept(), bnbAccept({ amount: (DIME + 1n).toString() })], lane);
    assert.equal(dust.accept?.network, BASE_CAIP2, "a non-divisible USD1 amount is not booked");
    const rogue = selectAccept([baseAccept(), bnbAccept({ payTo: OTHER })], lane);
    assert.equal(rogue.accept?.network, BASE_CAIP2);
    const noPref = selectAccept([baseAccept(), bnbAccept()], {
      declaredAmount: DIME_LEDGER.toString(),
      declaredPayTo: PAY_TO,
      declaredNetwork: BASE_CAIP2,
    });
    assert.equal(noPref.accept?.network, BASE_CAIP2);
  });
});

test("declaredPayTosFor reads a signable USD1 accept and ignores permit2 and other tokens", () => {
  const raw = [
    bnbAccept(),
    bnbAccept({ asset: "0x3333333333333333333333333333333333333333", payTo: OTHER }),
    bnbAccept({ extra: { assetTransferMethod: "permit2" }, payTo: OTHER }),
    baseAccept(),
  ];
  withFlag(undefined, () => {
    assert.deepEqual(declaredPayTosFor(BNB_CHAIN, raw), [PAY_TO]);
  });
});

test("signX402Payment signs the 18-digit USD1 amount under the pinned domain, and refuses the lane when the flag is off", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const accept = bnbAccept();
  const authorization = {
    from: account.address,
    to: PAY_TO,
    value: accept.amount,
    validAfter: "0",
    validBefore: "120",
    nonce: `0x${"ab".repeat(32)}` as `0x${string}`,
  };
  await withFlag(undefined, async () => {
    await assert.rejects(
      () => signX402Payment({ account, accept, authorization }),
      /BNB Chain lane is not enabled/,
    );
  });
  await withFlag("true", async () => {
    const { signature } = await signX402Payment({ account, accept, authorization });
    const ok = await verifyTypedData({
      address: account.address,
      domain: {
        name: "World Liberty Financial USD",
        version: "1",
        chainId: 56,
        verifyingContract: BNB_USD1 as `0x${string}`,
      },
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: PAY_TO as `0x${string}`,
        value: DIME,
        validAfter: 0n,
        validBefore: 120n,
        nonce: authorization.nonce,
      },
      signature: signature as `0x${string}`,
    });
    assert.equal(ok, true);
    assert.equal(authorization.value, DIME_TEXT);
    const wrongDomain = await verifyTypedData({
      address: account.address,
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: BASE_USDC as `0x${string}`,
      },
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: PAY_TO as `0x${string}`,
        value: DIME,
        validAfter: 0n,
        validBefore: 120n,
        nonce: authorization.nonce,
      },
      signature: signature as `0x${string}`,
    });
    assert.equal(wrongDomain, false);
  });
});

test("USD1 at $0.90 against a $0.10 declaration is never signed, whatever the declaration looks like", () => {
  const over = (10n ** 17n * 9n).toString(); // $0.90 in 18 digits
  const dimeDeclared = { declaredAmount: DIME_LEDGER.toString(), declaredPayTo: PAY_TO, declaredNetwork: BASE_CAIP2 };
  const cases: Array<[string, ChallengeAccept[], Parameters<typeof selectAccept>[1]]> = [
    ["Base permit2 plus USD1", [baseAccept({ extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } }), bnbAccept({ amount: over })], dimeDeclared],
    ["raw network spelling", [baseAccept(), bnbAccept({ amount: over })], { ...dimeDeclared, declaredNetwork: "base-mainnet" }],
    ["no declared payTo", [baseAccept(), bnbAccept({ amount: over })], { ...dimeDeclared, declaredPayTo: null }],
    ["USD1 only", [bnbAccept({ amount: over })], dimeDeclared],
  ];
  withFlag("true", () => {
    for (const [name, wall, opts] of cases) {
      for (const prefer of [false, true]) {
        const chosen = selectAccept(
          wall,
          prefer ? { ...opts, preferNetworks: [BNB_CAIP2], declaredPayTosByNetwork: { [BNB_CAIP2]: [PAY_TO] } } : opts,
        );
        const signsUsd1 = chosen.accept !== null && chosen.accept.network === BNB_CAIP2;
        assert.equal(signsUsd1, false, `${name} prefer=${prefer} must not sign USD1 $0.90`);
      }
    }
  });
});
