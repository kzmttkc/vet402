// ============================================================
// P3 売り手運用画面の本人確認（3.4 と同じ payTo 署名。DNS TXT は未実装）。
// ============================================================
import { verifyMessage, type Hex } from "viem";
import { isValidIssuedAt, SIGNING_DOMAIN } from "@/lib/verify-message";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/;
const ISSUED_WINDOW_MS = 10 * 60_000;

export type SellerDashboardProof =
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

export type SellerDashboardVerification =
  | { ok: true; method: "payto_signature" }
  | { ok: false; reason: "unverified" | "dns_txt_not_implemented" | "invalid_signature" | "wallet_mismatch" };

export function sellerDashboardAccessMessage(input: { wallet: string; issued: string }): string {
  const wallet = input.wallet.toLowerCase();
  return [
    `${SIGNING_DOMAIN} seller dashboard view`,
    `domain: ${SIGNING_DOMAIN}`,
    `wallet: ${wallet}`,
    `issued: ${input.issued}`,
    "This signature does not move funds. It only proves I control this payTo wallet for the seller dashboard.",
  ].join("\n");
}

export async function verifySellerDashboardAccess(proof: SellerDashboardProof): Promise<SellerDashboardVerification> {
  if (proof.kind === "host_dns_txt") {
    return { ok: false, reason: "dns_txt_not_implemented" };
  }
  const wallet = proof.wallet.toLowerCase();
  if (!ADDRESS_RE.test(wallet)) {
    return { ok: false, reason: "wallet_mismatch" };
  }
  if (!SIGNATURE_RE.test(proof.signature) || !isValidIssuedAt(proof.issued)) {
    return { ok: false, reason: "invalid_signature" };
  }
  if (Math.abs(Date.now() - Date.parse(proof.issued)) > ISSUED_WINDOW_MS) {
    return { ok: false, reason: "invalid_signature" };
  }
  try {
    const ok = await verifyMessage({
      address: wallet as Hex,
      message: sellerDashboardAccessMessage({ wallet, issued: proof.issued }),
      signature: proof.signature as Hex,
    });
    return ok ? { ok: true, method: "payto_signature" } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
}
