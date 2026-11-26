// ============================================================
// 払い手照合（payer-reconcile）で「購入ではない」と外す宛先の一覧。
// 台帳の payer（払い手）・運営者の受取番地・OBSERVATORY_TEST_WALLETS。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { parsePartyId } from "@/lib/ids/canonical";
import { ARC_CAIP2 } from "@/lib/chain/arc";
import { ARC_GATEWAY_WALLET } from "@/lib/observatory/arc-gateway";
import { toCaip2 } from "@/lib/observatory/chains";
import { payerReconcilePurchaseNetwork } from "@/lib/settlements/payer-reconcile-network";
import { operatorPayToDenylist, isOperatorPayTo } from "@/lib/observatory/operator";
import { rowsOf } from "./upsert";

export type OwnWalletContext = {
  /** CAIP-2 キー → その網で「自分の財布」とみなす address（EVM は小文字）。 */
  byNetwork: ReadonlyMap<string, ReadonlySet<string>>;
};

function ownWalletNetworkCaip(network: string): string {
  return payerReconcilePurchaseNetwork(network) ?? toCaip2(network) ?? network;
}

function normalizeAddress(network: string, address: string): string {
  const caip = ownWalletNetworkCaip(network);
  if (caip.startsWith("eip155:") || caip.startsWith("xrpl:")) return address.toLowerCase();
  return address;
}

export async function loadOwnWalletContext(): Promise<OwnWalletContext> {
  const db = getDb();
  if (!db) throw new Error("loadOwnWalletContext: DATABASE_URL is not configured");

  const byNetwork = new Map<string, Set<string>>();
  const add = (network: string, address: string) => {
    const caip = ownWalletNetworkCaip(network);
    let set = byNetwork.get(caip);
    if (!set) {
      set = new Set();
      byNetwork.set(caip, set);
    }
    set.add(normalizeAddress(network, address));
  };

  const payers = rowsOf<{ network: string; payer: string }>(
    await db.execute(sql`
      SELECT DISTINCT network, payer FROM x402_l1_purchases
      WHERE payer IS NOT NULL AND network IS NOT NULL
    `),
  );
  for (const p of payers) add(p.network, p.payer);

  for (const op of operatorPayToDenylist()) {
    for (const [caip] of byNetwork) {
      if (caip.startsWith("eip155:")) add(caip, op);
    }
  }

  for (const raw of (process.env.OBSERVATORY_TEST_WALLETS ?? "").split(",")) {
    const v = raw.trim();
    const parsed = v ? parsePartyId(v) : null;
    if (parsed) add(parsed.chain, parsed.address);
  }

  const frozen = new Map<string, ReadonlySet<string>>();
  for (const [k, v] of byNetwork) frozen.set(k, v);

  return { byNetwork: frozen };
}

/** 購入候補から外す理由。null なら突き合わせ対象。 */
export function exclusionReasonForPayerTransfer(
  input: { network: string; payer: string; to: string; from: string },
  ctx: OwnWalletContext,
): string | null {
  const caip = ownWalletNetworkCaip(input.network);
  if (input.from.toLowerCase() === input.to.toLowerCase()) return "self_transfer";
  if (isOperatorPayTo(input.to)) return "own_wallet";
  const own = ctx.byNetwork.get(caip);
  const toNorm = normalizeAddress(input.network, input.to);
  if (own?.has(toNorm)) return "own_wallet";
  if (
    caip === ARC_CAIP2 &&
    toNorm === ARC_GATEWAY_WALLET.toLowerCase()
  ) {
    return "gateway_deposit";
  }
  return null;
}