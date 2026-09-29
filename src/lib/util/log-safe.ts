// ============================================================
// サーバログへ出す前に秘密を伏せる入口（2026-09-29 監査 第2巡の残り）。
//
// なぜ別モジュールか: `src/lib/util/log.ts` の logServerError は `error.message` を
// そのまま console へ出す。viem の HttpRequestError は本文に `URL: https://…/v2/<key>` を、
// postgres ドライバは接続文字列を含むので、素で渡すと Vercel のログに実鍵が並ぶ。
// log.ts は凍結中（Tokyo 提出の審査期間）で直せないため、伏せる層をここに置き、
// 凍結外の呼び手は全部こちらを通す。直呼びは eslint（no-restricted-imports）と
// tests/log-safe.test.ts の走査で止める。
//
// 伏せるもの:
//   - URL 全体（scheme を問わない）。RPC の鍵は path（alchemy `/v2/<key>`・infura `/v3/<key>`・
//     quicknode `/<token>/`）にも query（drpc `?dkey=`・`?apikey=`）にも userinfo
//     （`postgres://user:pw@`）にも入るので、部分的に残さず丸ごと `<url>` にする
//     （redact.ts の redactUrls と同じ方針）。
//   - URL の外に出た「鍵っぽい」もの: `apikey=…` 形式の代入、Bearer、既知の接頭辞
//     （Stripe `sk_live_`・Resend `re_`・GitHub `ghp_` 等）、JWT。
// 伏せないもの: 0x の tx hash やアドレス。秘密鍵と同じ形だが、診断に要る本体なので残す
// （秘密鍵を文字列でログへ渡す経路はそもそも無い）。
// ============================================================
import { logAndSwallow, logServerError } from "./log";
import { redactUrls } from "@/lib/observatory/redact";

// redactUrls は http(s)/ws(s)/postgres だけを見る。ログ側は redis・mysql・amqp 等も
// 来うるので scheme を問わず伏せる（台帳用の redact.ts は既存の長さ契約があるので触らない）。
const ANY_SCHEME_URL_RE = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'<>`]+/gi;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // 空白を含む秘密（mnemonic・seed phrase）は JSON の値の引用符の終わりまで伏せる。
  [/("(?:mnemonic|seed[_-]?phrase|seed)"\s*:\s*")[^"]*"/gi, "$1<redacted>\""],
  // `apikey=XYZ` / `api_key: "XYZ"` / `dkey=XYZ` / `access_token=XYZ` など（URL の外に出た query 片も含む）
  [
    /\b(api[_-]?key|apikey|dkey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|secret|password|passwd|private[_-]?key|mnemonic|seed[_-]?phrase|seed|token)(["']?\s*[=:]\s*["']?)(?!0x[0-9a-fA-F]{40}\b)[^\s"'&,;)}\]]+/gi,
    "$1$2<redacted>",
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/g, "$1 <redacted>"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "<redacted>"],
  [/\bwhsec_[A-Za-z0-9+/=]{8,}/g, "<redacted>"],
  [/\bre_[A-Za-z0-9_]{16,}/g, "<redacted>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<redacted>"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "<redacted>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted>"],
];

/** 文字列から URL と既知の秘密の形を伏せる。長さは切らない（ログは診断のためにある）。 */
export function redactSecretsForLog(text: string): string {
  // 先に引用符・山括弧で止まる側で伏せ、JSON 化したオブジェクトの残りを食わせない。
  // redactUrls（`\S+` で行末まで食う）は取りこぼしの保険として後に通す。
  let out = redactUrls(text.replace(ANY_SCHEME_URL_RE, "<url>"));
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function describe(error: unknown): string {
  // message が文字列でない Error もある（2026-09-29 レビュー指摘）: 必ず String に通す。
  if (error instanceof Error) return String(error.message);
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    // 素の logServerError は "[object Object]" しか出さず、中の URL は出ないが理由も消える。
    // ここでは中身を出す代わりに伏せる（循環参照・BigInt で落ちたら従来どおり String）。
    try {
      return JSON.stringify(error, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** logServerError の代わりに使う。文脈（tag）と理由の両方を伏せてから出す。 */
// 伏せる処理そのものが投げても、呼び手の制御（throw しない・握りつぶす）を変えない。
// 伏せられなかったときは本文を出さず、型名だけを残す（秘密を出すより情報が減る方を選ぶ）。
function safeMessage(error: unknown): string {
  try {
    return redactSecretsForLog(describe(error));
  } catch {
    return `<unloggable ${typeof error}>`;
  }
}

function safeContext(context: string): string {
  try {
    return redactSecretsForLog(String(context));
  } catch {
    return "<unloggable context>";
  }
}

export function logServerErrorSafe(context: string, error: unknown): void {
  try {
    logServerError(safeContext(context), new Error(safeMessage(error)));
  } catch {
    // ログで処理を落とさない。
  }
}

/** logAndSwallow の伏字版。`.catch(logAndSwallowSafe("ctx"))`。 */
export function logAndSwallowSafe(context: string): (error: unknown) => undefined {
  const swallow = logAndSwallow(safeContext(context));
  return (error) => {
    try {
      return swallow(new Error(safeMessage(error)));
    } catch {
      return undefined;
    }
  };
}

/**
 * 警告（console.warn）の伏字版（2026-09-29 監査 5 周目・中）。形は logServerError と同じ
 * `[vouch] <context>: <detail>`。凍結外の src は console.* を直に呼ばない（tests/log-safe.test.ts が走査する）。
 */
export function logServerWarnSafe(context: string, detail: unknown): void {
  try {
    console.warn(`[vouch] ${safeContext(context)}: ${safeMessage(detail)}`);
  } catch {
    // ログで処理を落とさない。
  }
}

/** 経過の記録（console.log）の伏字版。形は logServerWarnSafe と同じ。 */
export function logServerInfoSafe(context: string, detail: unknown): void {
  try {
    console.log(`[vouch] ${safeContext(context)}: ${safeMessage(detail)}`);
  } catch {
    // ログで処理を落とさない。
  }
}
