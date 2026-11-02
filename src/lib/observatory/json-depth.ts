// ============================================================
// 売り手の JSON の深さの上限（2026-11-02 資金経路の監査 M-1・L-1）。
//
// JSON.parse は深い入れ子を読めるが、そのあとの再帰（台帳へ書く前の掃除・証拠の組み立て・JSON.stringify）は
// スタックを使い切って RangeError で落ちる。16KB の 402 で深さ約 8,000 まで作れる。行が書かれないと窓にも冷却にも
// 入らないので、同じ売り手が毎回選ばれて購入バッチの持ち時間を使い切れた。
//
// 上限は本番の実測から余裕をみて決める: 保存済みの 402 の記録（1,343 行・2026-11-02）の最深は
// 封筒込みで 22 段。64 段は再帰にとって十分に浅い。
// ============================================================

export const MAX_SELLER_JSON_DEPTH = 64;

/**
 * JSON の文字列の入れ子が maxDepth 段を超えるか。パースせず 1 文字ずつ見る（再帰しない・文字列の中の括弧は数えない）。
 * JSON でない文字列にも答えを返す（読めるかどうかは JSON.parse が決める）。
 */
export function jsonTextDepthExceeds(text: string, maxDepth: number = MAX_SELLER_JSON_DEPTH): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) i++;
      else if (c === 0x22 /* " */) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x5b /* [ */ || c === 0x7b /* { */) {
      depth++;
      if (depth > maxDepth) return true;
    } else if (c === 0x5d /* ] */ || c === 0x7d /* } */) {
      depth--;
    }
  }
  return false;
}

/** JSON.parse と同じだが、深さの上限を超えた文字列は読めない JSON と同じく SyntaxError にする。 */
export function parseSellerJson(text: string): unknown {
  if (jsonTextDepthExceeds(text)) throw new SyntaxError("seller JSON nesting over the limit");
  return JSON.parse(text);
}
