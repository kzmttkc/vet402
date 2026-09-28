// ============================================================
// L1 の支払い付き要求の本文とクエリを、売り手の 402 の宣言から取る（Issue #29・2026-09-17／2026-09-20）。
//
// 規則の本体（正典のコメントを含む）は declared-input-rules.ts。ここは 402 の応答から「parseChallenge が
// 支払い条件を取ったのと同じ文書」を選び、規則に渡すだけ（2026-09-29 に分けた）。
// ============================================================
import { parseChallenge } from "./x402-payer";
import { declaredRequestBodyFromDoc, declaredRequestUrlFromDoc, type DeclaredRequestBody, type DeclaredRequestUrl } from "./declared-input-rules";

export * from "./declared-input-rules";

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
  return declaredRequestBodyFromDoc(challengeDocument(input));
}

export function declaredRequestUrl(input: { resourceUrl: string; bodyText: string; headers: Headers }): DeclaredRequestUrl {
  return declaredRequestUrlFromDoc({ resourceUrl: input.resourceUrl, document: challengeDocument(input) });
}
