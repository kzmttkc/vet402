// payer-reconcile 専用の network 正規化。stellar:pubnet は isMainnet が意図的に false（L0 表を動かさない）なのでここで扱う。
import { toCaip2, isMainnet } from "@/lib/observatory/chains";
import { STELLAR_PUBNET_CAIP2 } from "@/lib/observatory/stellar402-payer";

const STELLAR_PUBNET_ALIASES = new Set(["stellar", "stellar:pubnet"]);

/** 購入行の network を payer-reconcile の CAIP 表記へ。対象外なら null。 */
export function payerReconcilePurchaseNetwork(network: string): string | null {
  const trimmed = network.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  if (key.startsWith("stellar:test") || key === "stellar:testnet") return null;
  if (STELLAR_PUBNET_ALIASES.has(key)) return STELLAR_PUBNET_CAIP2;
  const caip = toCaip2(trimmed) ?? trimmed;
  if (caip === STELLAR_PUBNET_CAIP2) return STELLAR_PUBNET_CAIP2;
  if (!isMainnet(trimmed) && !isMainnet(caip)) return null;
  return caip;
}