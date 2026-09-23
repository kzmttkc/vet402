// The USD value of the other side of a swap (SPEC §2, "quote を USD にするとき").
//
// USDG is taken as 1 USD with 6 decimals; the depeg question is out of scope for
// v0 and stated as such. WETH needs the chain's ETH/USD feed, which the official
// list does not publish for 4663 yet — SPEC §2 says that lot is `cost_known=false`
// rather than priced by a guess, so this returns null and the FIFO engine keeps
// the lot unknown. Nothing here invents a price.
import { USDG, WETH } from "./config";
import { TOPICS, topicToAddress } from "./events";
import type { RwaLog } from "./classify";

/** USDG (6 decimals) → integer cents, floored. */
export function usdgToCents(amount: bigint): bigint {
  return (amount * 100n) / 10n ** 6n;
}

export type QuoteSide = { token: "USDG" | "WETH"; raw: bigint; usd_cents: bigint | null };

/**
 * The quote legs of one transaction that moved to or from `address`, summed per
 * token. A v4 swap routinely pays out in two Transfers (measured 2026-09-24 on
 * the demo address), so the legs are summed rather than the first one taken.
 * The sign convention matches the canonical side: a sale returns what came in.
 */
export function quoteForSwap(logs: RwaLog[], address: string, canonicalReceived: boolean): QuoteSide | null {
  const me = address.toLowerCase();
  const totals = new Map<string, bigint>();
  for (const log of logs) {
    if (log.topics[0] !== TOPICS.transfer || log.topics.length < 3) continue;
    const token = log.address.toLowerCase();
    if (token !== USDG && token !== WETH) continue;
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    // Buying the canonical token pays the quote out; selling it takes the quote in.
    const wanted = canonicalReceived ? from === me : to === me;
    if (!wanted) continue;
    if (from === to) continue;
    totals.set(token, (totals.get(token) ?? 0n) + BigInt(log.data === "0x" ? "0x0" : log.data));
  }
  if (totals.size !== 1) return null; // no quote leg, or a multi-token route v0 does not price
  const [token, raw] = [...totals][0];
  if (token === USDG) return { token: "USDG", raw, usd_cents: usdgToCents(raw) };
  return { token: "WETH", raw, usd_cents: null }; // SPEC §2: no published ETH/USD feed on 4663 yet
}
