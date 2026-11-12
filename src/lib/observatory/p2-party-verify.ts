// ============================================================
// P2 の本人確認（3.4-P2-6）。送金先の鍵の署名、またはホストの DNS TXT。
// DNS TXT は未実装。未実装の経路を合格にしない。
// ============================================================
import { verifyMessage, type Hex } from "viem";
import { isValidIssuedAt, SIGNING_DOMAIN } from "@/lib/verify-message";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/;

export type P2PartyProof =
  | {
      kind: "payto_signature";
      wallet: string;
      signature: string;
      issued: string;
    }
  | {
      kind: "host_dns_txt";
      host: string;
      txt: string;
    };

export type P2PartyVerification =
  | { ok: true; method: "payto_signature" }
  | { ok: false; reason: "unverified" | "dns_txt_not_implemented" | "invalid_signature" | "wallet_mismatch" };

export function p2PartyAccessMessage(input: { purchaseId: string; party: "payer" | "seller"; issued: string }): string {
  return [
    `${SIGNING_DOMAIN} trade dispute view`,
    `domain: ${SIGNING_DOMAIN}`,
    `purchase_id: ${input.purchaseId}`,
    `party: ${input.party}`,
    `issued: ${input.issued}`,
    "This signature does not move funds. It only proves I am allowed to see my own E6 proof on this purchase.",
  ].join("\n");
}

export async function verifyP2PartyAccess(
  party: "payer" | "seller",
  purchaseId: string,
  proof: P2PartyProof,
  expected: { payerWallet: string; sellerPayTo: string },
): Promise<P2PartyVerification> {
  if (proof.kind === "host_dns_txt") {
    return { ok: false, reason: "dns_txt_not_implemented" };
  }
  const want = party === "payer" ? expected.payerWallet.toLowerCase() : expected.sellerPayTo.toLowerCase();
  const wallet = proof.wallet.toLowerCase();
  if (!ADDRESS_RE.test(wallet) || wallet !== want) {
    return { ok: false, reason: "wallet_mismatch" };
  }
  if (!SIGNATURE_RE.test(proof.signature) || !isValidIssuedAt(proof.issued)) {
    return { ok: false, reason: "invalid_signature" };
  }
  try {
    const ok = await verifyMessage({
      address: wallet as Hex,
      message: p2PartyAccessMessage({ purchaseId, party, issued: proof.issued }),
      signature: proof.signature as Hex,
    });
    return ok ? { ok: true, method: "payto_signature" } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
}
