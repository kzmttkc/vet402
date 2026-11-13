// ============================================================
// P2 を Live の完了と名乗れる条件（3.4-P2-7）。E4 形1の public testnet が緑でも 3.4 の画面受け入れが要る。
// ============================================================
import { E4_FORM1_PUBLIC_TESTNET_RUN } from "@/lib/e4/form1";

const TX_HASH_64 = /^0x[0-9a-fA-F]{64}$/;

function voidAndReclaimHashesReady(): boolean {
  const { txs } = E4_FORM1_PUBLIC_TESTNET_RUN;
  const voidHashes = [txs.voidHttp500.void, txs.voidEmpty200.void, txs.voidAccepted202.void];
  const reclaimHash = txs.reclaim.reclaim;
  return [...voidHashes, reclaimHash].every((h) => TX_HASH_64.test(h));
}

/** 9a-2: 届かなかった例が確定せず買い手へ戻る、が public Base Sepolia で緑か。 */
export function isE4Form1PublicTestnetGreen(): boolean {
  if (E4_FORM1_PUBLIC_TESTNET_RUN.allPass !== true) return false;
  return voidAndReclaimHashesReady();
}

/** P2 の担当が 3.4 の画面受け入れ条件を満たしたときに true へ変える。 */
export const P2_SCREEN_ACCEPTANCE_COMPLETE = false;

export function isP2LiveComplete(): boolean {
  return isE4Form1PublicTestnetGreen() && P2_SCREEN_ACCEPTANCE_COMPLETE;
}

export function p2PageMode(): "live" | "draft" {
  return isP2LiveComplete() ? "live" : "draft";
}
