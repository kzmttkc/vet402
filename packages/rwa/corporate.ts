// Corporate actions on Stock Tokens, as the tokens themselves record them (SPEC patch 022).
//
// A Stock Token does not change balances on a split or a reinvested dividend. It
// changes its uiMultiplier and emits UIMultiplierUpdated(before, after,
// effectiveAt). Shares shown to a person are raw × uiMultiplier / 1e18, so the
// same raw balance shows a different number of shares after the update.
//
// The public RPC cannot answer a historical eth_call, so past multipliers come
// only from these logs. They never change once written, so /rwa keeps them in
// two layers: a frozen walk of every canonical token from genesis
// (corporate-actions.json, rebuilt by scripts/snapshot-corporate-actions.ts) and
// a per-instance memo of the tail read since. A reconstruction then reads one
// log chunk per token in scope, not a genesis walk.
//
// Nothing here touches realized_usd. FIFO runs on raw quantities and USD, and
// the Chainlink price already carries the multiplier (CLAUDE.md, fixture A).
import { fetchBlockTimestamps, fetchMultiplierLogs } from "./chain";
import type { RwaEvent } from "./classify";
import { decodeMultiplierUpdate, type MultiplierUpdate } from "./events";
import type { RpcOptions } from "./rpc";
import snapshot from "./corporate-actions.json";

export type TimedMultiplierUpdate = MultiplierUpdate & { /** unix seconds of the block that carried the update */ time: number };

export type CorporateActionsSnapshot = {
  taken_at: string;
  chain_id: number;
  /** last block the walk covered, inclusive */
  to_block: number;
  /** lower-cased tokens walked from genesis to `to_block` */
  tokens_walked: string[];
  updates: { token: string; symbol: string; block: number; log_index: number; tx: string; time: number; multiplier_before: string; multiplier_after: string; effective_at: number }[];
};

export const SNAPSHOT = snapshot as CorporateActionsSnapshot;
const SNAPSHOT_WALKED = new Set(SNAPSHOT.tokens_walked);

/** One corporate action on one token, seen from one wallet. */
export type CorporateAction = {
  block: number;
  /** ISO time of the block that carried the update */
  time: string;
  /** ISO time from which the token applies the new multiplier, as it emitted it */
  effective_at: string;
  tx: string;
  /** uiMultiplier, 18 decimals, as integer strings */
  multiplier_before: string;
  multiplier_after: string;
  /** multiplier_after / multiplier_before, 18 decimal places, trailing zeros cut. A number, never a label */
  ratio: string;
  /** did the wallet hold the token right after the update transaction. Null when its history was not walked */
  held: boolean | null;
  /** raw balance the replayed events leave the wallet at that point. Null when the history was not walked */
  wallet_raw_at: string | null;
  /** wallet_raw_at × multiplier_before / 1e18, 8 decimals */
  wallet_shares_before: string | null;
  /** wallet_raw_at × multiplier_after / 1e18, 8 decimals */
  wallet_shares_after: string | null;
};

type Memo = Map<string, { through: number; updates: TimedMultiplierUpdate[] }>;
const memo: Memo = ((globalThis as unknown as { __rwaMultiplierMemo?: Memo }).__rwaMultiplierMemo ??= new Map());

/** Test seam. */
export function __resetMultiplierMemoForTest(): void {
  memo.clear();
}

function fromSnapshot(token: string): { through: number; updates: TimedMultiplierUpdate[] } | null {
  if (!SNAPSHOT_WALKED.has(token)) return null;
  return {
    through: SNAPSHOT.to_block,
    updates: SNAPSHOT.updates
      .filter((u) => u.token === token)
      .map((u) => ({
        token: u.token,
        block: u.block,
        log_index: u.log_index,
        tx: u.tx,
        time: u.time,
        multiplier_before: BigInt(u.multiplier_before),
        multiplier_after: BigInt(u.multiplier_after),
        effective_at: u.effective_at,
      })),
  };
}

/**
 * Every UIMultiplierUpdated of `tokens` from genesis up to and including `block`,
 * in chain order. Reads from the chain only what the snapshot and the memo do not
 * already cover: one tail range per token, batched across tokens.
 */
export async function readMultiplierUpdates(tokens: string[], block: number, opts?: RpcOptions): Promise<TimedMultiplierUpdate[]> {
  const known = new Map<string, { through: number; updates: TimedMultiplierUpdate[] }>();
  for (const raw of new Set(tokens.map((t) => t.toLowerCase()))) known.set(raw, memo.get(raw) ?? fromSnapshot(raw) ?? { through: -1, updates: [] });

  const behind = [...known].filter(([, k]) => k.through < block).map(([token, k]) => ({ token, from: k.through + 1 }));
  if (behind.length > 0) {
    const fresh = (await fetchMultiplierLogs(behind, block, opts)).map(decodeMultiplierUpdate).filter((u): u is MultiplierUpdate => u !== null);
    const times = fresh.length > 0 ? await fetchBlockTimestamps(fresh.map((u) => u.block), opts) : new Map<number, number>();
    for (const { token } of behind) {
      const k = known.get(token)!;
      const seen = new Set(k.updates.map((u) => `${u.tx}:${u.log_index}`));
      const added = fresh.filter((u) => u.token === token && !seen.has(`${u.tx}:${u.log_index}`)).map((u) => ({ ...u, time: times.get(u.block)! }));
      const next = { through: block, updates: [...k.updates, ...added].sort((a, b) => a.block - b.block || a.log_index - b.log_index) };
      known.set(token, next);
      memo.set(token, next);
    }
  }
  return [...known.values()]
    .flatMap((k) => k.updates.filter((u) => u.block <= block))
    .sort((a, b) => a.block - b.block || a.log_index - b.log_index);
}

/** `n / 1e18` as a decimal string with trailing zeros cut ("1.000775159164630595", "2", "0.5"). */
export function decimal18(n: bigint): string {
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** `raw * multiplier / 1e18` with 8 decimals (the same rounding as TokenFacts.shares_ui). */
function shares(raw: bigint, multiplier: bigint): string {
  const scaled = (raw * multiplier) / 10n ** 10n;
  const whole = scaled / 10n ** 26n;
  const frac = (scaled % 10n ** 26n) / 10n ** 18n;
  return `${whole}.${frac.toString().padStart(8, "0")}`;
}

/**
 * The corporate actions of one token, each with what the wallet held at that
 * point. The holding is the replay of the wallet's own classified events up to
 * the update's position in the chain (block, then log index), so it is exactly
 * what the FIFO engine sees. An update while the wallet held nothing stays in the
 * list with held:false: the list is the token's history, not a filtered view.
 */
export function corporateActionsFor(updates: TimedMultiplierUpdate[], tokenEvents: Pick<RwaEvent, "block_number" | "log_index" | "raw_delta">[], historyWalked: boolean): CorporateAction[] {
  const events = [...tokenEvents].sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);
  return [...updates]
    .sort((a, b) => a.block - b.block || a.log_index - b.log_index)
    .map((u) => {
      let raw: bigint | null = null;
      if (historyWalked) {
        raw = 0n;
        for (const e of events) {
          if (e.block_number > u.block || (e.block_number === u.block && e.log_index > u.log_index)) break;
          raw += e.raw_delta;
        }
      }
      return {
        block: u.block,
        time: new Date(u.time * 1000).toISOString(),
        effective_at: new Date(u.effective_at * 1000).toISOString(),
        tx: u.tx,
        multiplier_before: u.multiplier_before.toString(),
        multiplier_after: u.multiplier_after.toString(),
        ratio: u.multiplier_before === 0n ? "0" : decimal18((u.multiplier_after * 10n ** 18n) / u.multiplier_before),
        held: raw === null ? null : raw > 0n,
        wallet_raw_at: raw === null ? null : raw.toString(),
        wallet_shares_before: raw === null ? null : shares(raw, u.multiplier_before),
        wallet_shares_after: raw === null ? null : shares(raw, u.multiplier_after),
      };
    });
}

/**
 * The multiplier the token should report now if no update was missed: 1e18
 * before any update, else the last update's `after` once it is in effect. Null
 * while the last update is still scheduled (the token's behaviour before
 * effectiveAt is not something /rwa has measured).
 */
export function expectedMultiplier(updates: TimedMultiplierUpdate[], asOf: number): bigint | null {
  if (updates.length === 0) return 10n ** 18n;
  const last = updates.reduce((a, b) => (b.block > a.block || (b.block === a.block && b.log_index > a.log_index) ? b : a));
  return last.effective_at <= asOf ? last.multiplier_after : null;
}
