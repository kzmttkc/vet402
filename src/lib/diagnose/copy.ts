// 診断の公開英文。主語は vet402。we / our / us、セミコロン、ダッシュは置かない。
// 既存の識別子（CAIP-2、batch-settlement、auth-capture、feePayer）だけハイフンを許す。

export const CHECK_IDS = [
  "returns_402",
  "x402_shape",
  "header_body",
  "resource_url",
  "amount_atomic",
  "network_caip2",
  "asset_usdc",
  "payto",
  "testnet_only",
  "solana_fee_payer",
  "scheme",
  "account_readiness",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export const VERDICTS = ["ALLOW", "WARN", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type CheckStatus = "pass" | "warn" | "fail" | "info";

const FIX: Record<CheckId, Partial<Record<CheckStatus, string>>> = {
  returns_402: {
    pass: "vet402 received HTTP 402.",
    fail: "vet402 did not receive HTTP 402. Return 402 with an x402 challenge before asking for payment.",
  },
  x402_shape: {
    pass: "vet402 read an x402 v1 or v2 challenge.",
    fail: "vet402 could not read an x402 v1 or v2 challenge. Return x402Version 1 or 2 and at least one accept.",
  },
  header_body: {
    pass: "vet402 found the header and the body agree, or only one of them was sent.",
    fail: "vet402 found the header and the body disagree. Send the same scheme, amount, asset, network, payTo, and resource in both.",
  },
  resource_url: {
    pass: "vet402 found the resource URL matches the URL you asked about.",
    warn: "vet402 found no resource URL. Add the resource so the client can see what it would pay for.",
    fail: "vet402 found the resource URL points somewhere else. Set resource to the URL the client called.",
  },
  amount_atomic: {
    pass: "vet402 read the amount as a positive whole number of atomic units.",
    fail: "vet402 found an amount that is not a positive whole number of atomic units. Send the amount as an integer string.",
  },
  network_caip2: {
    pass: "vet402 read a CAIP-2 network id it knows.",
    warn: "vet402 read a legacy network name. Prefer the CAIP-2 id for that chain.",
    fail: "vet402 could not map this network to a known CAIP-2 id. Use a CAIP-2 network id.",
  },
  asset_usdc: {
    pass: "vet402 found the pinned USDC for that network.",
    warn: "vet402 does not recognize this asset as the pinned USDC for that network. Use the pinned USDC if you want vet402 to treat the accept as payable.",
    fail: "vet402 found USDC that belongs to a different network. Use the USDC for the network you named.",
  },
  payto: {
    pass: "vet402 found a payTo address that is well formed and not a burn address.",
    fail: "vet402 found a payTo address that is missing, malformed, or a burn or zero address. Set payTo to the seller account.",
  },
  testnet_only: {
    pass: "vet402 found a mainnet option.",
    warn: "vet402 found a testnet option next to a mainnet option. Prefer the mainnet accept.",
    fail: "vet402 found only testnet options. Offer a mainnet accept if you want mainnet clients to pay.",
  },
  solana_fee_payer: {
    pass: "vet402 found a Solana feePayer and it differs from payTo.",
    fail: "vet402 needs a Solana feePayer that is present and different from payTo.",
  },
  scheme: {
    pass: "vet402 read a scheme it can pay.",
    info: "vet402 can read this scheme but does not treat it as payable. Use exact, upto, batch-settlement, or auth-capture.",
    fail: "vet402 found an accept with no scheme. Set scheme to exact, upto, batch-settlement, or auth-capture.",
  },
  account_readiness: {
    pass: "vet402 read the recipient account on a public RPC and found it ready to receive.",
    fail: "vet402 found the recipient account inactive or missing a trust line. Activate the account and open the trust line before asking for payment.",
  },
};

export const SKIP_NOT_402 = "vet402 skipped this check because the response was not HTTP 402.";
export const SKIP_UNREADABLE = "vet402 skipped this check because the 402 was not a readable x402 challenge.";
export const SKIP_SOLANA = "vet402 found no Solana accept to check.";
export const SKIP_READINESS = "vet402 found no XRPL or Stellar mainnet account to check.";
export const SKIP_READINESS_UNREAD = "vet402 could not read the recipient account from a public RPC.";
export const SKIP_CATALOG = "vet402 could not read the catalog, so this response does not say whether the URL is listed.";

export function fixFor(id: CheckId, status: CheckStatus): string {
  const text = FIX[id][status];
  if (!text) throw new Error(`missing fix ${id} ${status}`);
  return text;
}

/** 新しい公開英文の検査。空配列ならその文はこの決まりを通っている。 */
export function publicEnglishFaults(text: string): string[] {
  const faults: string[] = [];
  if (/\b(we|our|us)\b/i.test(text)) faults.push("person");
  if (text.includes(";")) faults.push("semicolon");
  if (text.includes("\u2014") || text.includes("\u2013")) faults.push("dash");
  return faults;
}
