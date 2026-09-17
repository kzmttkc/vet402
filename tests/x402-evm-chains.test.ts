// ============================================================
// vet402 Observatory L1 — the EVM chain table behind the x402 payer (Arc lane, 2026-09-17).
//
// x402-payer used to be Base-only with one pinned EIP-712 domain. Arc (Circle's
// stablecoin L1, mainnet opened 2026-09-16) is the second EVM chain we can sign
// EIP-3009 on. The funnel philosophy is unchanged: **every accept is a refusal
// unless it matches a pinned row exactly** — network, USDC address and EIP-712
// domain are ours, never the seller's.
//
// Measured 2026-09-17 by RPC against https://rpc.mainnet.arc.io (not re-derived here):
//   chainId 5042 / USDC 0x3600000000000000000000000000000000000000 / decimals 6 /
//   EIP-712 name "USDC", version "2" (Base is "USD Coin" / "2" — different!) /
//   authorizationState(address,bytes32) present (EIP-3009).
//
// Fixtures below are the two accepts api.exa.ai publishes on eip155:5042 in the
// public catalog (raw_accepts, observed 2026-09-17): (a) the EIP-3009 one we can
// sign, (b) Circle Gateway's "GatewayWalletBatched" rail, which has a different
// signing domain and needs pre-deposited funds — refused. amount / maxTimeoutSeconds
// are illustrative; asset / payTo / extra are as observed.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import {
  ARC_CAIP2,
  ARC_CHAIN,
  ARC_USDC,
  BASE_CAIP2,
  BASE_CHAIN,
  BASE_USDC,
  BASE_USDC_EIP712_NAME,
  BASE_USDC_EIP712_VERSION,
  EVM_PAY_CHAINS,
  buildAuthorization,
  encodePaymentHeader,
  evmChainFor,
  hasCanonicalUsdcDomain,
  isArcL1Enabled,
  isEvmPayChainEnabled,
  selectAccept,
  signX402Payment,
} from "@/lib/observatory/x402-payer";

// Well-known throwaway test key (anvil #0) — never funded on mainnet by us.
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_PK);

const EXA_PAYTO = "0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC";

/** (a) api.exa.ai /search on Arc — EIP-3009 over Arc USDC. The one we can sign. */
const EXA_ARC_EIP3009 = {
  scheme: "exact",
  network: "eip155:5042",
  amount: "10000",
  asset: "0x3600000000000000000000000000000000000000",
  payTo: EXA_PAYTO,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", acceptId: "arc-usdc-circle" },
};

/** (b) api.exa.ai /search on Arc — Circle Gateway rail. Different domain; refused. */
const EXA_ARC_GATEWAY = {
  scheme: "exact",
  network: "eip155:5042",
  amount: "10000",
  asset: "0x3600000000000000000000000000000000000000",
  payTo: EXA_PAYTO,
  maxTimeoutSeconds: 300,
  extra: {
    name: "GatewayWalletBatched",
    version: "1",
    verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
    acceptId: "arc-usdc-gateway",
  },
};

/** The Base accept every existing test uses — must keep passing, unchanged in meaning. */
const BASE_ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "3000",
  asset: BASE_USDC,
  payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
  maxTimeoutSeconds: 300,
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

function withArcFlag<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.OBSERVATORY_ARC_L1_ENABLED;
  if (value === undefined) delete process.env.OBSERVATORY_ARC_L1_ENABLED;
  else process.env.OBSERVATORY_ARC_L1_ENABLED = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.OBSERVATORY_ARC_L1_ENABLED;
    else process.env.OBSERVATORY_ARC_L1_ENABLED = saved;
  }
}

// ---- the pinned table -------------------------------------------------------

test("the table pins Base exactly as before and Arc as measured on-chain 2026-09-17", () => {
  assert.equal(EVM_PAY_CHAINS.length, 2, "exactly Base and Arc — nothing else can be signed on");
  assert.equal(BASE_CHAIN.caip2, BASE_CAIP2);
  assert.equal(BASE_CHAIN.chainId, 8453);
  assert.equal(BASE_CHAIN.usdc, BASE_USDC);
  assert.equal(BASE_CHAIN.eip712Name, BASE_USDC_EIP712_NAME);
  assert.equal(BASE_CHAIN.eip712Version, BASE_USDC_EIP712_VERSION);
  assert.equal(BASE_CHAIN.label, "Base");

  assert.equal(ARC_CAIP2, "eip155:5042");
  assert.equal(ARC_CHAIN.caip2, ARC_CAIP2);
  assert.equal(ARC_CHAIN.chainId, 5042);
  assert.equal(ARC_USDC, "0x3600000000000000000000000000000000000000");
  assert.equal(ARC_CHAIN.usdc, ARC_USDC);
  assert.equal(ARC_CHAIN.eip712Name, "USDC", "Arc USDC reports name() \"USDC\" — not Base's \"USD Coin\"");
  assert.equal(ARC_CHAIN.eip712Version, "2");
  assert.equal(ARC_CHAIN.label, "Arc");
});

test("evmChainFor resolves pinned networks (and the Base v1 slug) and nothing else", () => {
  assert.equal(evmChainFor("eip155:8453")?.chainId, 8453);
  assert.equal(evmChainFor("base")?.chainId, 8453, "v1 slug still normalizes to Base");
  assert.equal(evmChainFor("eip155:5042")?.chainId, 5042);
  assert.equal(evmChainFor("eip155:5042002"), null, "Arc testnet is not a purchase chain");
  assert.equal(evmChainFor("eip155:137"), null);
  assert.equal(evmChainFor("arc"), null, "no speculative v1 slug in the money path");
  assert.equal(evmChainFor("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), null);
  assert.equal(evmChainFor(undefined), null);
  assert.equal(evmChainFor(""), null);
});

test("Base is always enabled; Arc only when OBSERVATORY_ARC_L1_ENABLED is exactly \"true\"", () => {
  withArcFlag(undefined, () => {
    assert.equal(isEvmPayChainEnabled(BASE_CHAIN), true);
    assert.equal(isArcL1Enabled(), false);
    assert.equal(isEvmPayChainEnabled(ARC_CHAIN), false);
  });
  withArcFlag("1", () => assert.equal(isArcL1Enabled(), false, "only the exact string \"true\""));
  withArcFlag("TRUE", () => assert.equal(isArcL1Enabled(), false));
  withArcFlag("true", () => {
    assert.equal(isArcL1Enabled(), true);
    assert.equal(isEvmPayChainEnabled(ARC_CHAIN), true);
    assert.equal(isEvmPayChainEnabled(BASE_CHAIN), true, "Arc on does not change Base");
  });
});

// ---- domain check per chain --------------------------------------------------

test("hasCanonicalUsdcDomain is per chain: Arc's \"USDC\"/\"2\" is canonical on Arc and a contradiction on Base", () => {
  // Base — byte-identical to the pre-Arc behaviour (default chain argument).
  assert.equal(hasCanonicalUsdcDomain({ name: "USD Coin", version: "2" }), true);
  assert.equal(hasCanonicalUsdcDomain({ name: "USDC", version: "2" }), false);
  assert.equal(hasCanonicalUsdcDomain(undefined), true);
  // Arc
  assert.equal(hasCanonicalUsdcDomain({ name: "USDC", version: "2" }, ARC_CHAIN), true);
  assert.equal(hasCanonicalUsdcDomain(EXA_ARC_EIP3009.extra, ARC_CHAIN), true, "acceptId / assetTransferMethod are not domain fields");
  assert.equal(hasCanonicalUsdcDomain({ name: "USD Coin", version: "2" }, ARC_CHAIN), false, "Base's name is a contradiction on Arc");
  assert.equal(hasCanonicalUsdcDomain({}, ARC_CHAIN), true);
  assert.equal(hasCanonicalUsdcDomain(EXA_ARC_GATEWAY.extra, ARC_CHAIN), false, "GatewayWalletBatched is another domain");
});

test("a verifyingContract in extra that is not the pinned USDC is a contradiction (Gateway names 0x7777…)", () => {
  assert.equal(hasCanonicalUsdcDomain({ verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee" }, ARC_CHAIN), false);
  assert.equal(hasCanonicalUsdcDomain({ verifyingContract: ARC_USDC }, ARC_CHAIN), true);
  assert.equal(hasCanonicalUsdcDomain({ verifyingContract: ARC_USDC.toUpperCase().replace("0X", "0x") }, ARC_CHAIN), true, "address compare is case-insensitive");
  assert.equal(hasCanonicalUsdcDomain({ verifyingContract: BASE_USDC.toLowerCase() }, BASE_CHAIN), true);
  assert.equal(hasCanonicalUsdcDomain({ verifyingContract: 42 }, BASE_CHAIN), false, "present and not a string is a refusal");
});

// ---- selectAccept: the money gate, now with two chains ----------------------

test("flag off: the real exa.ai Arc EIP-3009 accept is no_eligible_accept — nothing on Arc is ever signed", () => {
  withArcFlag(undefined, () => {
    const chosen = selectAccept([EXA_ARC_EIP3009, EXA_ARC_GATEWAY], { declaredAmount: "10000", declaredPayTo: EXA_PAYTO.toLowerCase() });
    assert.equal(chosen.accept, null);
    assert.equal(chosen.reason, "no_eligible_accept");
  });
});

test("flag on: the exa.ai EIP-3009 accept is selected and the GatewayWalletBatched one is refused", () => {
  withArcFlag("true", () => {
    const chosen = selectAccept([EXA_ARC_GATEWAY, EXA_ARC_EIP3009], { declaredAmount: "10000", declaredPayTo: EXA_PAYTO.toLowerCase() });
    assert.ok(chosen.accept, "the eip3009 accept must be eligible");
    assert.equal(chosen.accept!.network, ARC_CAIP2);
    assert.equal(chosen.accept!.extra?.acceptId, "arc-usdc-circle");

    const gatewayOnly = selectAccept([EXA_ARC_GATEWAY], { declaredAmount: "10000", declaredPayTo: null });
    assert.equal(gatewayOnly.accept, null, "Gateway rail: different signing domain, pre-deposited funds — never signed");
    assert.equal(gatewayOnly.reason, "no_eligible_accept");
  });
});

test("flag on: Arc still requires the pinned USDC, scheme exact, eip3009-or-unspecified, and the catalog price", () => {
  withArcFlag("true", () => {
    const opts = { declaredAmount: "10000", declaredPayTo: null };
    assert.equal(selectAccept([{ ...EXA_ARC_EIP3009, asset: BASE_USDC }], opts).accept, null, "Base USDC address on Arc is not Arc USDC");
    assert.equal(selectAccept([{ ...EXA_ARC_EIP3009, scheme: "upto" }], opts).accept, null);
    assert.equal(
      selectAccept([{ ...EXA_ARC_EIP3009, extra: { ...EXA_ARC_EIP3009.extra, assetTransferMethod: "permit2" } }], opts).accept,
      null,
    );
    assert.equal(
      selectAccept([{ ...EXA_ARC_EIP3009, extra: { ...EXA_ARC_EIP3009.extra, name: "USD Coin" } }], opts).accept,
      null,
      "Base's domain name on an Arc accept contradicts the Arc pin",
    );
    const noExtra = selectAccept([{ ...EXA_ARC_EIP3009, extra: undefined }], opts);
    assert.ok(noExtra.accept, "no extra → pinned domain is used");
    const mismatch = selectAccept([{ ...EXA_ARC_EIP3009, amount: "20000" }], opts);
    assert.equal(mismatch.accept, null);
    assert.equal(mismatch.reason, "price_mismatch");
  });
});

test("Base accepts select exactly as before whether the Arc flag is on or off", () => {
  for (const flag of [undefined, "true"] as const) {
    withArcFlag(flag, () => {
      const chosen = selectAccept([BASE_ACCEPT], { declaredAmount: "3000", declaredPayTo: null });
      assert.ok(chosen.accept, `flag=${String(flag)}`);
      assert.equal(chosen.accept!.network, BASE_CAIP2);
      // An Arc accept in a Base seller's challenge never wins over the Base one.
      const mixed = selectAccept([EXA_ARC_EIP3009, BASE_ACCEPT], { declaredAmount: "3000", declaredPayTo: null });
      assert.equal(mixed.accept?.network, BASE_CAIP2);
      // Arc's domain on a Base accept is still a contradiction.
      assert.equal(selectAccept([{ ...BASE_ACCEPT, extra: { name: "USDC", version: "2" } }], { declaredAmount: "3000", declaredPayTo: null }).accept, null);
    });
  }
});

// ---- signing: the domain comes from the chain row, never the seller ----------

test("signX402Payment signs an Arc accept under the pinned Arc domain (USDC / 2 / 5042 / 0x3600…)", async () => {
  await withArcFlag("true", async () => {
    const authorization = buildAuthorization({
      from: account.address,
      to: EXA_PAYTO,
      value: "10000",
      nowSec: 1_758_000_000,
      maxTimeoutSeconds: 300,
    });
    const { signature } = await signX402Payment({ account, accept: EXA_ARC_EIP3009, authorization });
    const message = {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    };
    const underArc = await verifyTypedData({
      address: account.address,
      domain: { name: "USDC", version: "2", chainId: 5042, verifyingContract: ARC_USDC as `0x${string}` },
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature: signature as `0x${string}`,
    });
    assert.equal(underArc, true);
    const underBase = await verifyTypedData({
      address: account.address,
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC as `0x${string}` },
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature: signature as `0x${string}`,
    });
    assert.equal(underBase, false, "an Arc signature must not verify under the Base domain");
  });
});

test("signX402Payment refuses Arc while the flag is off, refuses the Gateway domain, and refuses unknown chains", async () => {
  const authorization = buildAuthorization({ from: account.address, to: EXA_PAYTO, value: "10000", nowSec: 1_758_000_000, maxTimeoutSeconds: 300 });
  await withArcFlag(undefined, async () => {
    await assert.rejects(() => signX402Payment({ account, accept: EXA_ARC_EIP3009, authorization }), /not enabled/);
  });
  await withArcFlag("true", async () => {
    await assert.rejects(() => signX402Payment({ account, accept: EXA_ARC_GATEWAY, authorization }), /canonical Arc USDC EIP-712 domain/);
    await assert.rejects(
      () => signX402Payment({ account, accept: { ...EXA_ARC_EIP3009, network: "eip155:137" }, authorization }),
      /not a pinned EVM purchase chain/,
    );
  });
  // Base: the existing refusal message is unchanged.
  await assert.rejects(
    () => signX402Payment({ account, accept: { ...BASE_ACCEPT, extra: { name: "USD Coin", version: "9" } }, authorization }),
    /canonical Base USDC EIP-712 domain/,
  );
});

test("encodePaymentHeader v2 carries the Arc accept verbatim; v1 keeps the CAIP-2 id (Arc has no v1 slug)", () => {
  const authorization = buildAuthorization({ from: account.address, to: EXA_PAYTO, value: "10000", nowSec: 1_758_000_000, maxTimeoutSeconds: 300 });
  const payload = { signature: "0xabc", authorization };
  const v2 = encodePaymentHeader({ x402Version: 2, accept: EXA_ARC_EIP3009, payload, resourceUrl: "https://api.exa.ai/search" });
  assert.equal(v2.headerName, "PAYMENT-SIGNATURE");
  const decoded2 = JSON.parse(Buffer.from(v2.headerValue, "base64").toString());
  assert.equal(decoded2.accepted.network, "eip155:5042");
  assert.equal(decoded2.accepted.asset, ARC_USDC);
  assert.equal(decoded2.accepted.extra.acceptId, "arc-usdc-circle");

  const v1 = encodePaymentHeader({ x402Version: 1, accept: EXA_ARC_EIP3009, payload, resourceUrl: "https://api.exa.ai/search" });
  const decoded1 = JSON.parse(Buffer.from(v1.headerValue, "base64").toString());
  assert.equal(decoded1.network, "eip155:5042");
  const v1Base = encodePaymentHeader({ x402Version: 1, accept: BASE_ACCEPT, payload, resourceUrl: "https://svc.example/api" });
  assert.equal(JSON.parse(Buffer.from(v1Base.headerValue, "base64").toString()).network, "base", "Base v1 slug unchanged");
});
