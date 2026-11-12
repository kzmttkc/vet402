// ============================================================
// P2 を Live の完了と名乗れる条件（3.4-P2-7）。9a-2 が public testnet で緑になるまで draft。
// ============================================================
import { e4FormComparisonTable } from "@/lib/e4/form1";

/** 9a-2: 届かなかった例が確定せず買い手へ戻る、が public Base Sepolia で緑か。 */
export function isE4Form1PublicTestnetGreen(): boolean {
  const row = e4FormComparisonTable().find((r) => r.form === 1);
  if (!row) return false;
  return !row.testnetResult.includes("Not yet run on the public Base Sepolia network");
}

export function isP2LiveComplete(): boolean {
  return isE4Form1PublicTestnetGreen();
}

export function p2PageMode(): "live" | "draft" {
  return isP2LiveComplete() ? "live" : "draft";
}
