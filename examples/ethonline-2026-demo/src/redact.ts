/**
 * 秘密を画面から外す。**この CLI は撮影で映る**ので、ここが最優先の関門になる
 * （`docs/ethonline-2026/WINDOW_PLAN.md` §6「撮影で画面に出してはいけないもの」）。
 *
 * 伏せ方は2段。
 *   1. **環境変数に実在する値そのもの**を消す。いちばん確実で、誤爆もしない
 *   2. Gateway の URL は **パスに鍵が載る形**（`/api/<KEY>/subgraphs/…`）なので、
 *      鍵を環境から知らなくても経路の形で伏せる。ただし `x402` は鍵ではなく
 *      実在の公開経路なので伏せない（伏せると動く URL が壊れる）
 *
 * 一度出た鍵は失効させるしかない。だから「出さない」ではなく「出せない」側に寄せて、
 * 出力は必ず {@link ./emit.ts} の1本を通す。
 *
 * 2の「経路の形で伏せる」は SDK の `redactGraphKey` を使う（2026-09-06）。SDK 側が
 * `readSubgraphReceipts` のエラー経路で同じ伏せ方を必要とし、同じロジックを2箇所に
 * 置かないためにそちらへ寄せた。プレースホルダも SDK の定数を再公開する。
 */
import { redactGraphKey, GRAPH_KEY_PLACEHOLDER } from "../../../packages/sdk/dist/index.js";

/** URL のパスに載った鍵の置き換え先（SDK と同じ文字列）。 */
export { GRAPH_KEY_PLACEHOLDER };
/** 秘密として扱う最短の長さ。`2` のような短い値を消すと出力の方が壊れる。 */
export const MIN_SECRET_LENGTH = 12;

/** 環境から読む秘密。**値をここから外へ出さない**（用途は redact だけ）。 */
export const SECRET_ENV_NAMES = [
  "GRAPH_API_KEY",
  "VOUCH_API_KEY",
  "DEMO_PAYER_PRIVATE_KEY",
] as const;

/**
 * 伏せる対象の文字列を集める。秘密鍵は `0x` 付きでも外しても同じ値なので両方を対象にする
 * （どちらの綴りで出力へ紛れ込んでも消える）。
 */
export function collectSecrets(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < MIN_SECRET_LENGTH) continue;
    out.push(trimmed);
    if (/^0x/i.test(trimmed) && trimmed.length - 2 >= MIN_SECRET_LENGTH) out.push(trimmed.slice(2));
  }
  // 長いものから消す。短い方を先に消すと、長い秘密が部分的に残ることがある。
  return out.sort((a, b) => b.length - a.length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 伏せ関数を作る。**入力を1回だけ走査して返す**——呼び手が忘れても効くように、
 * 出力側（emit）でこの関数を必ず通す。
 */
export function makeRedactor(secrets: string[]): (text: string) => string {
  const patterns = secrets.map((s) => new RegExp(escapeRegExp(s), "gi"));
  return (text: string): string => {
    let out = String(text);
    for (const pattern of patterns) out = out.replace(pattern, "<REDACTED>");
    // Gateway の鍵付き経路（`x402` は除外）と `/api/<32桁hex>/` の形。SDK と同じ1本。
    out = redactGraphKey(out);
    return out;
  };
}
