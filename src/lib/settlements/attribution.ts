// ============================================================
// §7.2 帰属規則（純関数）。
//   confirmed: 402 封筒の payTo と tx の受取が一致、時刻が観測窓内、amount が封筒と一致
//   probable:  payTo 一致、amount または時刻が緩い一致
//   unmatched: 受取は見えるが Resource に落ちない
// ============================================================
import type { Attribution } from "./types";
import { toCaip2 } from "@/lib/observatory/chains";

/** 観測窓。L1 の提出→確定窓（120 秒）と最大バックフィル（15 分）に合わせる。 */
export const ATTRIBUTION_WINDOW_MS = 15 * 60_000;

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function attribute(
  tx: { payee: string | null; amount: string | null; asset: string | null; chain: string; blockTime: Date | null },
  envelope: {
    payTo: string | null;
    amount: string | null;
    asset: string | null;
    network: string | null;
    observedAt: Date | null;
  },
): Attribution {
  if (!same(tx.payee, envelope.payTo)) return "unmatched";
  const envChain = toCaip2(envelope.network);
  if (envChain && toCaip2(tx.chain) !== envChain) return "unmatched";
  const amountOk = same(tx.amount, envelope.amount) && (!envelope.asset || same(tx.asset, envelope.asset));
  const timeOk =
    !!tx.blockTime &&
    !!envelope.observedAt &&
    Math.abs(tx.blockTime.getTime() - envelope.observedAt.getTime()) <= ATTRIBUTION_WINDOW_MS;
  return amountOk && timeOk ? "confirmed" : "probable";
}
