// ============================================================
// L1 の POST 本文を、売り手自身の宣言から取る（Issue #29・2026-09-17）。
//
// それまで L1 は POST に常に `{}` を送っていた。方法論 §2 は「カタログの掲載は
// エンドポイントが期待する JSON 本文を教えてくれない」と書いていたが、Bazaar の
// discovery 拡張を載せた掲載はそれを宣言している: `extensions.bazaar.info.input.body`。
// 同じ宣言は L1 が最初に取りに行く無払いの 402 応答（PAYMENT-REQUIRED ヘッダの
// base64 JSON、または本文の JSON）にも載っているので、スキーマを変えずに読める。
// 2026-09-16 実測: Bazaar 16,062 件中 6,683 件（41.6%）が input.body を宣言。
//
// 規則（ここが正典）:
//   - 読むのは parseChallenge が支払い条件を取ったのと**同じ文書**だけ
//     （ヘッダが accepts を持てばヘッダ、無ければ本文）。別の文書の宣言を混ぜない。
//   - body が JSON の object か array で、JSON 文字列にして 16KB（バイト）以下なら
//     それを送る。**中身は書き換えない**（補完・既定値の注入をしない）。
//   - それ以外（宣言なし・null・スカラー・16KB 超・壊れた JSON）は従来どおり `{}`。
//
// 無払いの要求の本文は `{}` のまま（l1-runner のコメント参照）: 宣言はこの 402 応答を
// 読んで初めて手に入るので、その前に送れる本文は無い。
// ============================================================
import { parseChallenge } from "./x402-payer";

/** 宣言本文の上限（UTF-8 バイト）。readBodyCapped の応答上限と同じ桁。 */
export const DECLARED_BODY_MAX_BYTES = 16 * 1024;

export type RequestBodySource = "declared" | "empty";

export type DeclaredRequestBody = { body: string; source: RequestBodySource };

const EMPTY: DeclaredRequestBody = { body: "{}", source: "empty" };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** parseChallenge が採用する文書（ヘッダ優先・次に本文）を、同じ関数で決める。 */
function challengeDocument(input: { bodyText: string; headers: Headers }): unknown {
  const headerB64 = input.headers.get("PAYMENT-REQUIRED");
  if (headerB64) {
    const headerOnly = parseChallenge({ bodyText: "", headers: input.headers });
    if (headerOnly) {
      try {
        return JSON.parse(Buffer.from(headerB64, "base64").toString("utf8"));
      } catch {
        return undefined;
      }
    }
  }
  if (input.bodyText && parseChallenge({ bodyText: input.bodyText, headers: new Headers() })) {
    return parseJson(input.bodyText);
  }
  return undefined;
}

export function declaredRequestBody(input: { bodyText: string; headers: Headers }): DeclaredRequestBody {
  const doc = asRecord(challengeDocument(input));
  const bazaar = asRecord(asRecord(doc?.extensions)?.bazaar);
  const declared = asRecord(asRecord(bazaar?.info)?.input)?.body;
  if (typeof declared !== "object" || declared === null) return EMPTY;
  let body: string;
  try {
    body = JSON.stringify(declared);
  } catch {
    return EMPTY;
  }
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > DECLARED_BODY_MAX_BYTES) return EMPTY;
  return { body, source: "declared" };
}
