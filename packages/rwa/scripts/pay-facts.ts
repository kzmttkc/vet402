// Pay once for the paid facts lane (SPEC patch 017) and print the receipt.
//
//   npx tsx packages/rwa/scripts/pay-facts.ts --dry-run [address]
//       Signs with a throwaway key that holds nothing. No money can move; the
//       point is to see the route's 402 and what the facilitator says about the
//       signature (expect an allowance or balance refusal, not a format error).
//
//   PAYER_PRIVATE_KEY=0x… npx tsx packages/rwa/scripts/pay-facts.ts [--approve] [address]
//       Pays 0.01 USDG from that key's wallet on Robinhood Chain (4663).
//       --approve first sends approve(Permit2, 1 USDG) when the allowance is
//       short; that transaction needs a little ETH on 4663 for gas.
//
// The key is read from the environment only and never printed. Before signing,
// the script refuses any terms that are not exactly: eip155:4663, USDG,
// ≤ 0.01, paid to the vet402 anchor wallet.
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { RWA_CHAIN_ID, RWA_RPC_URL } from "../config";
import { PAY_TO, PERMIT2, PRICE_ATOMIC, USDG, X402_NETWORK, X402_PERMIT2_PROXY, b64json } from "../x402";

const DEMO = "0xE9B08727131E34010b34006c660D4c1B436EC25f";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const approve = args.includes("--approve");
const target = args.find((a) => a.startsWith("0x")) ?? DEMO;
const base = process.env.RWA_PAID_BASE ?? "https://vet402.com";
const url = `${base}/api/v1/rwa/paid/facts/${target}`;

const chain = { id: RWA_CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RWA_RPC_URL] } } } as const;
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

async function main() {
  const key = dryRun ? generatePrivateKey() : (process.env.PAYER_PRIVATE_KEY as Hex | undefined);
  if (!key) throw new Error("set PAYER_PRIVATE_KEY, or pass --dry-run");
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain, transport: http(RWA_RPC_URL) });
  console.log(JSON.stringify({ mode: dryRun ? "dry-run (throwaway key, holds nothing)" : "pay", payer: account.address, url }));

  // 1. the terms
  const first = await fetch(url);
  const reqHeader = first.headers.get("PAYMENT-REQUIRED");
  if (first.status !== 402 || !reqHeader) throw new Error(`expected 402 with PAYMENT-REQUIRED, got ${first.status}`);
  const required = JSON.parse(Buffer.from(reqHeader, "base64").toString("utf8"));
  const accept = required.accepts?.[0];
  const same = (a: string, b: string) => a?.toLowerCase() === b.toLowerCase();
  if (
    !accept || accept.scheme !== "exact" || accept.network !== X402_NETWORK || !same(accept.asset, USDG) || !same(accept.payTo, PAY_TO) ||
    accept.extra?.assetTransferMethod !== "permit2" || !/^\d+$/.test(String(accept.amount)) || BigInt(accept.amount) <= 0n || BigInt(accept.amount) > BigInt(PRICE_ATOMIC)
  ) {
    throw new Error(`refusing terms that are not ours: ${JSON.stringify(accept)}`);
  }
  console.log(JSON.stringify({ terms: { network: accept.network, asset: accept.asset, amount: accept.amount, payTo: accept.payTo } }));

  // 2. the contracts the signature names must exist on 4663; then balance and Permit2 allowance
  for (const [name, addr] of [["Permit2", PERMIT2], ["x402ExactPermit2Proxy", X402_PERMIT2_PROXY]] as const) {
    const code = await pub.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`${name} has no code on 4663; nothing signed`);
  }
  const [bal, allow] = await Promise.all([
    pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    pub.readContract({ address: USDG, abi: erc20, functionName: "allowance", args: [account.address, PERMIT2] }),
  ]);
  console.log(JSON.stringify({ usdg_balance_atomic: bal.toString(), permit2_allowance_atomic: allow.toString() }));
  if (!dryRun) {
    if (bal < BigInt(accept.amount)) throw new Error("USDG balance is below the price; nothing sent");
    if (allow < BigInt(accept.amount)) {
      if (!approve) throw new Error("Permit2 allowance is short; rerun with --approve (needs a little ETH on 4663)");
      const wallet = createWalletClient({ account, chain, transport: http(RWA_RPC_URL) });
      const hash = await wallet.writeContract({ address: USDG, abi: erc20, functionName: "approve", args: [PERMIT2, 1_000_000n] });
      await pub.waitForTransactionReceipt({ hash });
      console.log(JSON.stringify({ approve_tx: hash, approved_atomic: "1000000" }));
    }
  }

  // 3. sign the Permit2 witness transfer (spender = x402ExactPermit2Proxy, witness.to = payTo)
  const now = Math.floor(Date.now() / 1000);
  const nonce = BigInt("0x" + randomBytes(32).toString("hex"));
  const deadline = BigInt(now + Number(accept.maxTimeoutSeconds ?? 120));
  const validAfter = BigInt(now - 60);
  const signature = await account.signTypedData({
    domain: { name: "Permit2", chainId: RWA_CHAIN_ID, verifyingContract: PERMIT2 },
    types: {
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "Witness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      Witness: [
        { name: "to", type: "address" },
        { name: "validAfter", type: "uint256" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: USDG, amount: BigInt(accept.amount) },
      spender: X402_PERMIT2_PROXY,
      nonce,
      deadline,
      witness: { to: getAddress(accept.payTo), validAfter },
    },
  });
  const paymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted: accept,
    payload: {
      signature,
      permit2Authorization: {
        permitted: { token: USDG, amount: String(accept.amount) },
        from: account.address,
        spender: X402_PERMIT2_PROXY,
        nonce: nonce.toString(),
        deadline: deadline.toString(),
        witness: { to: getAddress(accept.payTo), validAfter: validAfter.toString() },
      },
    },
  };

  // 4. pay and read
  const t0 = Date.now();
  const paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": b64json(paymentPayload) } });
  const respHeader = paid.headers.get("PAYMENT-RESPONSE");
  const settlement = respHeader ? JSON.parse(Buffer.from(respHeader, "base64").toString("utf8")) : null;
  const body = await paid.json().catch(() => null);
  console.log(JSON.stringify({ status: paid.status, ms: Date.now() - t0, payment_status: paid.headers.get("X-Payment-Status"), settlement, error: body?.error ?? null, r1_status: body?.r1_status ?? null, as_of_block: body?.as_of_block ?? null }));
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e).slice(0, 400));
  process.exit(1);
});
