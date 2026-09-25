// ============================================================
// ensureReverted（W05）: 「次に来た人が来たときに戻す」。
//
// serverless では時間で戻せない（after() の setTimeout は本番で発火しなかった実測・
// Vercel cron に分単位が無い）。だから守る不変条件を来訪で守る。呼ぶのは3か所:
// mutate の先頭・state（変えてから 90 秒以上）・reset。
//
//   1. DB の行とチェーンの今の値を読む。どちらも 10000 なら clean（tx を打たない）
//   2. チェーンが 10000 で DB だけ 10001 → DB を合わせるだけ（tx を打たない）
//   3. 戻す権利を1文で取る（reverting_until と generation）。取れなければ already_reverting
//   4. setText(NODE, KEY, VALUES.off) を W_op で署名。受領まで待つ
//   5. generation が進んでいなければ 10000 と記録。進んでいたら間に誰かが押した → 上書きしない
//
// 署名は job_leases のリース（LEASE_NAME）の内側だけで行う。mutate は自分でリースを取ってから
// revertLocked を呼ぶ（二重に取らない）。
// ============================================================
import { AMOUNT, KEY, NODE, P_D, VALUES } from "./constants";
import type { ButtonDeps, Hex } from "./types";

export type RevertResult =
  | { status: "clean"; synced?: true }
  | { status: "already_reverting" }
  | { status: "resolver_moved"; resolver: string }
  | { status: "reverted"; tx: Hex }
  | { status: "superseded"; tx: Hex }
  | { status: "pending"; tx: Hex }
  | { status: "tx_reverted"; tx: Hex }
  | { status: "tx_failed" }
  | { status: "busy" };

const lc = (s: string | null | undefined) => String(s ?? "").toLowerCase();

/** x402-offer の生値から amount を取り出す（読めなければ null）。 */
export function amountOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { amount?: unknown };
    return typeof j.amount === "string" ? j.amount : null;
  } catch {
    return null;
  }
}

/** リースを持っている前提で戻す。 */
export async function revertLocked(deps: ButtonDeps): Promise<RevertResult> {
  const row = await deps.store.readRow();

  let chain: string | null = null;
  try {
    const r = await deps.readOffer();
    // seller-d.eth のリゾルバが P_d から外れていたら、P_d へ書いても何も戻らない。打たない。
    if (r.resolver && lc(r.resolver) !== lc(P_D)) return { status: "resolver_moved", resolver: r.resolver };
    chain = r.value;
  } catch {
    chain = null; // 読めないときは DB の記録だけで決める（戻す向きの tx は安全側）
  }

  const dbDirty = row.currentValue !== AMOUNT.off;
  const chainDirty = chain !== null && chain !== VALUES.off;
  if (!dbDirty && !chainDirty) return { status: "clean" };
  if (dbDirty && chain === VALUES.off) {
    await deps.store.markClean(row.generation);
    return { status: "clean", synced: true };
  }

  const generation = await deps.store.claimRevert();
  if (generation === null) return { status: "already_reverting" };

  let tx: Hex;
  try {
    tx = await deps.writeContract({ address: P_D, functionName: "setText", args: [NODE, KEY, VALUES.off] });
  } catch {
    await deps.store.releaseClaim(generation);
    return { status: "tx_failed" };
  }

  const receipt = await deps.waitForReceipt(tx);
  if (receipt === "reverted") {
    await deps.store.releaseClaim(generation);
    return { status: "tx_reverted", tx };
  }
  await deps.store.appendLog(amountOf(chain) ?? row.currentValue, AMOUNT.off, tx);
  // timeout: tx はまだ載りうるので権利は手放さない（REVERT_CLAIM_SECONDS で切れる）。
  if (receipt === "timeout") return { status: "pending", tx };

  const written = await deps.store.finishRevert(generation, tx);
  return written ? { status: "reverted", tx } : { status: "superseded", tx };
}

/** リースを取ってから戻す（state・reset から）。 */
export async function ensureReverted(deps: ButtonDeps): Promise<RevertResult> {
  const leased = await deps.withLease(() => revertLocked(deps));
  return leased.acquired ? leased.value : { status: "busy" };
}
