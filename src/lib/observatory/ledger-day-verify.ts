// ============================================================
// 台帳の日次 root を、鍵なしで検算する（anchors.ts の anchorDay と同じ連結規則）。
//
// 2026-11-10 公平審査（3.8 の 6c-1）: 3 つの値を別々に受け取り、どれか 1 つでも
// 無い・違う、なら不合格にする。
//   1. その日の公開ファイルのバイト列（/api/v1/observatory/anchors/day?day=）
//   2. その日の公開ヘッド（/api/v1/observatory/anchors の行。root と prevRoot）
//   3. 鎖がその日の値として持つ root（次に封印した日の prevRoot）
// 1 から計算した root が 2 と一致し、2 が 3 と一致して初めて ok。3 を省いた呼び出しは
// ok にならない（片方の根だけを見せて合格にしない）。
// ============================================================
import { createHash } from "node:crypto";

/** sha256((prevRoot ?? "genesis") + "\n" + payload)。anchorDay と同じ式。 */
export function dayRootHash(prevRoot: string | null, payload: string | Uint8Array): string {
  return createHash("sha256")
    .update(prevRoot ?? "genesis")
    .update("\n")
    .update(payload)
    .digest("hex");
}

export type PublishedDayHead = { day: string; rootHash: string; prevRoot: string | null };

export type DayTripleInput = {
  day: string;
  /** 公開ファイルのバイト列。読めなかったら null。 */
  payloadBytes: string | Uint8Array | null;
  /** 公開ヘッドのその日の行。無ければ null。 */
  publishedHead: PublishedDayHead | null;
  /** 鎖がその日の値として持つ root。次の日が未封印なら null。 */
  chainRoot: string | null;
};

export const DAY_TRIPLE_FAILURES = [
  "no_payload",
  "no_published_head",
  "head_day_mismatch",
  "no_chain_root",
  "payload_does_not_match_head",
  "head_does_not_match_chain",
] as const;
export type DayTripleFailure = (typeof DAY_TRIPLE_FAILURES)[number];

export type DayTripleResult = {
  day: string;
  ok: boolean;
  /** ok が false のときの理由。最初に当たったもの。 */
  code: DayTripleFailure | null;
  recomputedRoot: string | null;
  publishedRoot: string | null;
  chainRoot: string | null;
};

export function verifyPublishedDayTriple(input: DayTripleInput): DayTripleResult {
  const publishedRoot = input.publishedHead?.rootHash ?? null;
  const chainRoot = input.chainRoot ?? null;
  const fail = (code: DayTripleFailure, recomputedRoot: string | null): DayTripleResult => ({
    day: input.day,
    ok: false,
    code,
    recomputedRoot,
    publishedRoot,
    chainRoot,
  });
  if (input.payloadBytes === null || input.payloadBytes === undefined) return fail("no_payload", null);
  if (!input.publishedHead) return fail("no_published_head", null);
  if (input.publishedHead.day !== input.day) return fail("head_day_mismatch", null);
  const recomputedRoot = dayRootHash(input.publishedHead.prevRoot, input.payloadBytes);
  if (recomputedRoot !== input.publishedHead.rootHash) return fail("payload_does_not_match_head", recomputedRoot);
  if (chainRoot === null || chainRoot === "") return fail("no_chain_root", recomputedRoot);
  if (chainRoot !== input.publishedHead.rootHash) return fail("head_does_not_match_chain", recomputedRoot);
  return { day: input.day, ok: true, code: null, recomputedRoot, publishedRoot, chainRoot };
}
