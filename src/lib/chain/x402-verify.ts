import { isSkipChainReadsEnabled } from "@/lib/config/env";
import { matchSignatureForm, SIGNING_DOMAIN } from "@/lib/verify-message";
import { getPublicClient } from "./client";
import { BASE_USDC_ADDRESS } from "./config";

/**
 * vet402 2026-08-13 — proof of control for a settlement write-back.
 *
 * The write path used to accept `wallet` as a bare claim in the request body:
 * it confirmed the tx was real and originated from `wallet`, but not that the
 * POSTER controls `wallet`. So any API key could take a stranger's real Base
 * transfer (a known-scam wallet's, even) and post it as that stranger's
 * settlement history, moving a third party's score. This is the same
 * proof-of-control gate verified payees already use (payees/verify): a valid
 * EIP-191 signature by `wallet` over a canonical, tx-specific message. Binding
 * the tx hash into the signed text means one signature authorizes exactly one
 * settlement write-back and cannot be replayed onto a different tx.
 *
 * A write-back WITHOUT a valid signature is still recorded (the ledger keeps
 * the row) but marked ownership_verified=false, which excludes it from every
 * score aggregate. Ownership is proven, not assumed.
 */
export function x402AttestationMessage(wallet: string, txHash: string): string {
  return [
    `${SIGNING_DOMAIN} — x402 settlement attestation`,
    `domain: ${SIGNING_DOMAIN}`,
    `wallet: ${wallet.toLowerCase()}`,
    `tx: ${txHash.toLowerCase()}`,
    // 2026-09-05 (S-6/E-b): the old text said only "proves control". It did not
    // say what the signature CAUSES — that this settlement joins the public
    // score of that wallet. A signer who reads "proof of ownership" and later
    // finds a public ledger entry was told the truth but not the consequence.
    `Effect: this settlement will be counted toward the public score of the wallet above on ${SIGNING_DOMAIN}.`,
    "This signature moves no funds.",
  ].join("\n");
}

/** LEGACY (〜2026-09-05, delete after LEGACY_MESSAGE_ACCEPT_UNTIL). Frozen. */
export function legacyX402AttestationMessage(wallet: string, txHash: string): string {
  return [
    "Vouch x402 settlement attestation",
    `wallet: ${wallet.toLowerCase()}`,
    `tx: ${txHash.toLowerCase()}`,
    "This signature only proves control of the wallet above for this settlement.",
  ].join("\n");
}

/**
 * True only when `signature` is a valid EIP-191 signature by `wallet` over the
 * canonical attestation message for `txHash`. Any malformed input or recovery
 * failure is FALSE (fail-closed): an unprovable claim of ownership is treated
 * exactly like no claim at all. viem's verifyMessage also covers EIP-1271 /
 * EIP-6492 smart-account signatures where the chain supports them.
 */
export async function verifyX402Ownership(
  wallet: string,
  txHash: string,
  signature: string | null | undefined,
  now?: number,
): Promise<X402OwnershipResult> {
  const { matched } = await matchSignatureForm({
    address: wallet,
    signature,
    current: x402AttestationMessage(wallet, txHash),
    legacy: legacyX402AttestationMessage(wallet, txHash),
    now,
  });
  return {
    verified: matched === "current" || matched === "legacy",
    legacy: matched === "legacy",
    legacyExpired: matched === "legacy_expired",
  };
}

/**
 * `verified` decides ownership_verified. `legacy` / `legacyExpired` exist only
 * to MEASURE the migration off the pre-domain-binding message: a write-back
 * that had to fall back to the old text is still recorded as owned (until
 * LEGACY_MESSAGE_ACCEPT_UNTIL), but the route says so in its response and its
 * log, so "is anyone still signing the old form?" is answered by data rather
 * than by assumption.
 */
export interface X402OwnershipResult {
  verified: boolean;
  legacy: boolean;
  legacyExpired: boolean;
}

/** keccak256("Transfer(address,address,uint256)") — standard ERC20 Transfer event. */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * How the payee address was resolved from the receipt:
 *  - "exact": a single Transfer leg with the payer as `from` — unambiguous.
 *  - "ambiguous": multiple payer-originated Transfer legs (e.g. a fee split);
 *    the largest-amount leg was chosen as the settlement body.
 *  - "fallback": no payer-originated leg matched; resolved via any Transfer
 *    log's `to` or `receipt.to` — lower confidence, may be a facilitator.
 * Log/observability only — never persisted alongside the payment row.
 */
export type PayeeConfidence = "exact" | "ambiguous" | "fallback";

/**
 * What the chain says the settlement leg actually moved.
 *
 * 2026-08-05. Before this, `amount` was whatever the caller POSTed: a
 * free-form string, stored unchecked next to a tx hash we HAD verified, on a
 * product whose entire proposition is "verified". The wallet-match condition
 * could also be satisfied by a Transfer of any ERC20 whatsoever, so a payment
 * row could be backed by a transfer of a worthless token the payer minted
 * themselves. The settlement leg's token and amount are read from the same log
 * the payee already comes from — no extra RPC call — and reported here.
 */
export interface X402SettlementFacts {
  /** ERC20 contract that moved on the settlement leg, lowercase. null when the
   *  payee could only be resolved from receipt.to (no Transfer log at all). */
  token: string | null;
  /** Transferred amount in the token's base units, as a decimal string. */
  onChainAmount: string | null;
  /** true only when the settlement leg is Base USDC — the only currency x402
   *  settles in. Anything else means the match came from an unrelated transfer. */
  isUsdc: boolean;
}

export type X402VerifyResult =
  | {
      ok: true;
      payee: string | null;
      payeeConfidence: PayeeConfidence;
      settlement: X402SettlementFacts;
      /** null when the caller declared no amount; otherwise whether the
       *  declared figure matches the chain exactly. */
      amountVerified: boolean | null;
      /** Set when a declared amount did not match the chain — the caller is
       *  told which figure we kept. */
      amountMismatch?: { declared: string; onChain: string | null };
      /** On-chain block time of the settlement tx (the receipt's block).
       *  The authoritative time axis for uniqueDays — see x402_payments
       *  .block_timestamp. null only when the block time could not be read. */
      blockTimestamp: Date | null;
    }
  | {
      ok: false;
      reason:
        | "unsupported_network"
        | "tx_not_found"
        | "tx_not_success"
        | "wallet_mismatch"
        | "rpc_unavailable";
    };

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export interface ReceiptLike {
  to: string | null;
  logs: readonly { address?: string; topics: readonly string[]; data?: string }[];
}

/**
 * Best-effort extraction of the receiving wallet (payee) from a verified
 * receipt. Reuses the same ERC20 Transfer logs the wallet-match check above
 * already parses, so this never issues extra RPC calls.
 *
 * Preference order:
 *  1. The `to` topic of the Transfer log whose `from` topic matches the payer
 *     wallet — the direct settlement leg (`payeeConfidence: "exact"`). When
 *     *multiple* payer-originated legs exist (e.g. a fee split where the
 *     payer funds both the merchant and a fee collector), the leg with the
 *     largest transfer amount is taken as the settlement body — fee legs are
 *     smaller than the body by construction — and the result is marked
 *     `"ambiguous"` so callers can log it.
 *  2. The `to` topic of any Transfer log in the receipt, if none matched (1)
 *     — covers the facilitator/meta-transaction path where the payer never
 *     appears as `from` on-chain (the relayer does), but a settlement
 *     transfer still happened (`"fallback"`).
 *  3. `receipt.to` (the transaction's direct recipient) as a last resort —
 *     covers plain native-token transfers with no ERC20 Transfer log at all.
 *     May be a contract address (e.g. a facilitator) rather than the final
 *     recipient (`"fallback"`).
 *
 * `payee` is null only when none of the above yields an address (e.g. a
 * contract-creation transaction with no logs).
 */
export function extractPayeeFromReceipt(
  receipt: ReceiptLike,
  walletLower: string,
): { payee: string | null; confidence: PayeeConfidence } {
  const { payee, confidence } = extractSettlement(receipt, walletLower);
  return { payee, confidence };
}

/**
 * The settlement leg: who received it, which token moved, and how much.
 * One pass over the receipt's Transfer logs — the payee resolution and the
 * amount check must never disagree about WHICH leg the settlement was.
 */
export function extractSettlement(
  receipt: ReceiptLike,
  walletLower: string,
): { payee: string | null; confidence: PayeeConfidence } & X402SettlementFacts {
  const transferLogs = receipt.logs.filter(
    (log) => log.topics[0]?.toLowerCase() === TRANSFER_TOPIC,
  );

  const facts = (
    log: { address?: string; data?: string } | undefined,
  ): X402SettlementFacts => {
    const token = log?.address?.toLowerCase() ?? null;
    return {
      token,
      onChainAmount: log ? transferAmount(log.data).toString() : null,
      isUsdc: token === BASE_USDC_ADDRESS.toLowerCase(),
    };
  };

  const directLegs = transferLogs.filter((log) => {
    const fromTopic = log.topics[1];
    if (!fromTopic || !log.topics[2]) return false;
    return topicToAddress(fromTopic) === walletLower;
  });

  if (directLegs.length === 1) {
    return {
      payee: topicToAddress(directLegs[0].topics[2]!),
      confidence: "exact",
      ...facts(directLegs[0]),
    };
  }
  if (directLegs.length > 1) {
    // Prefer the largest USDC leg: a fee split pays the collector in the same
    // token, and picking the biggest leg of the WRONG token would report a
    // settlement amount denominated in something x402 does not settle in.
    const usdcLegs = directLegs.filter(
      (log) => log.address?.toLowerCase() === BASE_USDC_ADDRESS.toLowerCase(),
    );
    const pool = usdcLegs.length > 0 ? usdcLegs : directLegs;
    const largest = pool.reduce((best, log) =>
      transferAmount(log.data) > transferAmount(best.data) ? log : best,
    );
    return {
      payee: topicToAddress(largest.topics[2]!),
      confidence: "ambiguous",
      ...facts(largest),
    };
  }

  const anyLeg = transferLogs.find((log) => Boolean(log.topics[2]));
  if (anyLeg?.topics[2]) {
    return {
      payee: topicToAddress(anyLeg.topics[2]),
      confidence: "fallback",
      ...facts(anyLeg),
    };
  }

  return {
    payee: receipt.to?.toLowerCase() ?? null,
    confidence: "fallback",
    ...facts(undefined),
  };
}

/**
 * ERC20 Transfer amount lives in the log's non-indexed `data` field. Treat
 * anything unparseable (missing, "0x", non-hex) as 0 rather than throwing —
 * this is a tiebreak, not a validation gate.
 */
function transferAmount(data: string | undefined): bigint {
  if (!data || data === "0x") return 0n;
  try {
    return BigInt(data);
  } catch {
    return 0n;
  }
}

/**
 * Confirms an x402 settlement attestation corresponds to a real, successful
 * Base transaction attributable to the claimed wallet before it is written
 * to the DB and weighted into the trust score.
 *
 * Matches on either:
 *  - `receipt.from` (direct submission by the payer wallet), or
 *  - the `from` topic of an ERC20 `Transfer` log in the receipt (facilitator
 *    / meta-transaction submission pattern used by x402 relayers, where the
 *    wallet signs an authorization but a relayer broadcasts the tx).
 *
 * Fail-closed: any RPC error, missing receipt, non-success status, or lack
 * of a wallet match is treated as unverifiable and MUST be rejected by the
 * caller. Never record an attestation we could not independently confirm.
 */
export async function verifyX402PaymentOnChain(
  txHash: `0x${string}`,
  wallet: string,
  network: string,
  /** What the caller says was paid, in the token's base units. Optional: the
   *  attestation endpoint has always accepted an amount-less write-back. */
  declaredAmount?: string | null,
): Promise<X402VerifyResult> {
  if (network.toLowerCase() !== "base") {
    // Only Base is wired up to an RPC client today; we cannot verify other
    // networks, so refuse rather than accept unverified attestations.
    return { ok: false, reason: "unsupported_network" };
  }

  if (isSkipChainReadsEnabled()) {
    // Test/seed mode reads no chain, so it can confirm nothing. Say so
    // explicitly rather than defaulting amountVerified to true.
    return {
      ok: true,
      payee: null,
      payeeConfidence: "fallback",
      settlement: { token: null, onChainAmount: null, isUsdc: false },
      amountVerified: declaredAmount ? false : null,
      blockTimestamp: null,
    };
  }

  const walletLower = wallet.toLowerCase();
  const client = getPublicClient();

  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    // Covers "receipt not found" (tx doesn't exist / not yet mined) as well
    // as RPC/network failures. Fail-closed either way.
    return { ok: false, reason: "tx_not_found" };
  }

  if (!receipt || receipt.status !== "success") {
    return { ok: false, reason: "tx_not_success" };
  }

  // Block time of the settlement, read once here (the receipt carries the
  // block number but not its timestamp). A read failure degrades to null — the
  // ledger falls back to created_at for the time axis — rather than failing the
  // whole write-back, which is already fully verified on every other axis.
  let blockTimestamp: Date | null = null;
  try {
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    blockTimestamp = new Date(Number(block.timestamp) * 1000);
  } catch {
    blockTimestamp = null;
  }

  if (receipt.from?.toLowerCase() === walletLower) {
    return okWithPayee(receipt, walletLower, txHash, declaredAmount, blockTimestamp);
  }

  const logMatches = receipt.logs.some((log) => {
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 !== TRANSFER_TOPIC) return false;
    const fromTopic = log.topics[1];
    if (!fromTopic) return false;
    return topicToAddress(fromTopic) === walletLower;
  });

  if (logMatches) {
    return okWithPayee(receipt, walletLower, txHash, declaredAmount, blockTimestamp);
  }

  return { ok: false, reason: "wallet_mismatch" };
}

function okWithPayee(
  receipt: ReceiptLike,
  walletLower: string,
  txHash: string,
  declaredAmount: string | null | undefined,
  blockTimestamp: Date | null,
): X402VerifyResult {
  const { payee, confidence, ...settlement } = extractSettlement(receipt, walletLower);
  if (confidence === "ambiguous") {
    console.warn(
      `[vouch] x402_payee_ambiguous: tx ${txHash} has multiple payer-originated ` +
        `Transfer legs; picked largest-amount leg ${payee ?? "unknown"} as payee`,
    );
  }

  const { amountVerified, amountMismatch } = checkDeclaredAmount(
    declaredAmount,
    settlement,
    txHash,
  );

  return {
    ok: true,
    payee,
    payeeConfidence: confidence,
    settlement,
    amountVerified,
    amountMismatch,
    blockTimestamp,
  };
}

/**
 * A declared amount is confirmed only when all three hold: the caller sent
 * one, the settlement leg is Base USDC (the only currency x402 settles in),
 * and the two figures are equal as integers. Anything else is recorded as
 * unverified — with the on-chain figure kept as the authoritative one — rather
 * than silently trusted.
 *
 * Deliberately NOT a rejection: refusing the write-back would lose a real,
 * chain-verified settlement because its metadata was wrong, and the amount
 * does not feed the trust score (only paymentCount and uniqueDays do). What it
 * must never do is call an unchecked number verified.
 */
export function checkDeclaredAmount(
  declaredAmount: string | null | undefined,
  settlement: X402SettlementFacts,
  txHash?: string,
): { amountVerified: boolean | null; amountMismatch?: { declared: string; onChain: string | null } } {
  if (declaredAmount === undefined || declaredAmount === null || declaredAmount === "") {
    return { amountVerified: null };
  }

  let declared: bigint | null = null;
  try {
    declared = BigInt(declaredAmount);
  } catch {
    declared = null;
  }

  const matches =
    settlement.isUsdc &&
    declared !== null &&
    settlement.onChainAmount !== null &&
    declared === BigInt(settlement.onChainAmount);

  if (matches) return { amountVerified: true };

  if (txHash) {
    console.warn(
      `[vouch] x402_amount_unverified: tx ${txHash} declared ${declaredAmount} but the ` +
        `settlement leg moved ${settlement.onChainAmount ?? "nothing readable"} of ` +
        `${settlement.token ?? "no token"}${settlement.isUsdc ? "" : " (not Base USDC)"}`,
    );
  }
  return {
    amountVerified: false,
    amountMismatch: { declared: declaredAmount, onChain: settlement.onChainAmount },
  };
}
