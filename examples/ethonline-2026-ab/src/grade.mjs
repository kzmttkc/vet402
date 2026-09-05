/**
 * 採点。**WINDOW_PLAN §16「成功の定義」をそのまま実装する。ここを緩めない。**
 *
 *   成功 ＝ (1) 判定が我々の API の判定と一致する
 *        ∧ (2) 挙げた理由コードが、実際に返ってきた理由コードの**部分集合**であり、
 *              **正解が「拒否」のときは空でない**
 *
 * (2) が要。素の API 一覧しか無いエージェントの典型的な失敗は「それらしい理由を作る」ことで、
 * 正解にたまたま当たっても、根拠が嘘なら失敗とする。
 *
 * **2026-09-05 10:55 の事前登録修正**（実データを1件も見る前・理由は WINDOW_PLAN §16「事前登録の修正」）:
 * 元の (2) は「部分集合」だけだった。**空集合は字義どおり部分集合**なので、
 * 「拒否したが理由を1つも挙げない」答えが success になっていた。
 * **これは我々がいちばん見たい失敗（理由の捏造／理由の不在）を取り逃がす。**
 * 正解が「進む」のときは理由コードを要求しない（従来どおり）。
 * 修正前の数え方は `successUnderOriginalRule` として**非採点で並記**し、
 * どちらの数も生ログから再計算できるようにする。
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
  const reasonCodesEmpty = gotCodes.length === 0;
  // 修正後の (2): 正解が「拒否」のときは空でないことを要求する。
  // 正解が「進む」のときは理由コードを要求しない。
  const reasonNonEmptyWhenRequired = want === "refuse" ? !reasonCodesEmpty : true;

  return {
    verdictMatch,
    reasonSubset,
    reasonNonEmptyWhenRequired,
    // §16 の論理積（2026-09-05 修正後）。**ここに第4の条件を足さない。足すなら事前登録を先に直す。**
    success: verdictMatch && reasonSubset && reasonNonEmptyWhenRequired,
    // **非採点**。修正前の規則で数えるとどうなるかを並記する（両方を生ログから再計算できるように）。
    successUnderOriginalRule: verdictMatch && reasonSubset,
    fabricatedReasonCodes,
    reasonCodesEmpty,
    normalized: { verdict: got, reasonCodes: gotCodes },
  };
}
