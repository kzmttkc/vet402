/**
 * 採点。**WINDOW_PLAN §16「成功の定義」をそのまま実装する。ここを緩めない。**
 *
 *   成功 ＝ (1) 判定が我々の API の判定と一致する
 *        ∧ (2) 挙げた理由コードが、実際に返ってきた理由コードの**部分集合**である
 *
 * (2) が要。素の API 一覧しか無いエージェントの典型的な失敗は「それらしい理由を作る」ことで、
 * 正解にたまたま当たっても、根拠が嘘なら失敗とする。
 */

/** 判定語は2つだけ。ここを増やすと「どちらとも取れる答え」を勝ちにできてしまう。 */
export const VERDICTS = Object.freeze(["proceed", "refuse"]);

function normVerdict(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return VERDICTS.includes(s) ? s : null;
}

function normCodes(codes) {
  if (!Array.isArray(codes)) return [];
  return codes
    .filter((c) => typeof c === "string")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
}

/**
 * @param {{verdict: unknown, reasonCodes: unknown, unparseable?: boolean}} answer エージェントの答え
 * @param {{verdict: string, reasonCodes: string[]}} oracle 我々の API が実際に返した判定と理由コード
 */
export function grade(answer, oracle) {
  const got = normVerdict(answer?.verdict);
  const want = normVerdict(oracle?.verdict);
  const gotCodes = normCodes(answer?.reasonCodes);
  const wantCodes = new Set(normCodes(oracle?.reasonCodes));

  const fabricatedReasonCodes = gotCodes.filter((c) => !wantCodes.has(c));

  const verdictMatch = got !== null && want !== null && got === want;
  const reasonSubset = fabricatedReasonCodes.length === 0;

  return {
    verdictMatch,
    reasonSubset,
    // §16 の論理積。**ここに第3の条件を足さない。足すなら事前登録を先に直す。**
    success: verdictMatch && reasonSubset,
    fabricatedReasonCodes,
    // 非採点の可視化のみ。§16 は空集合を除外していないので success には効かせない。
    reasonCodesEmpty: gotCodes.length === 0,
    normalized: { verdict: got, reasonCodes: gotCodes },
  };
}
