/**
 * 生応答 → { verdict, reasonCodes }。
 *
 * **散文から推測しない。** 「refuse という語が本文にある」を判定として拾うと、
 * 実際には答えていないものを当たりにできてしまう。読めなければ `unparseable` で
 * 1試行として記録する（厳守2「失敗した試行を捨てる経路を作らない」）。
 */
import { VERDICTS } from "./grade.mjs";

/** 応答の中から、最後に現れる well-formed な JSON オブジェクトを取る。 */
function extractJsonObject(text) {
  for (let start = text.lastIndexOf("{"); start !== -1; start = text.lastIndexOf("{", start - 1)) {
    for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
      const slice = text.slice(start, end + 1);
      try {
        const parsed = JSON.parse(slice);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        /* 次の候補へ */
      }
    }
  }
  return null;
}

export function parseAgentAnswer(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { verdict: null, reasonCodes: [], explanation: null, unparseable: true };
  }
  const obj = extractJsonObject(text);
  if (obj === null || !("verdict" in obj)) {
    return { verdict: null, reasonCodes: [], explanation: null, unparseable: true };
  }
  const raw = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : null;
  return {
    verdict: raw !== null && VERDICTS.includes(raw) ? raw : null,
    reasonCodes: Array.isArray(obj.reason_codes) ? obj.reason_codes.filter((c) => typeof c === "string") : [],
    explanation: typeof obj.explanation === "string" ? obj.explanation : null,
    unparseable: false,
  };
}
