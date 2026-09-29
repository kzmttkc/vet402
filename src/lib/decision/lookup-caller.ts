// ============================================================
// /decision の問い合わせを数えるときの「呼び手」の単位（2026-09-29 監査 5 周目・高）。
//
// 問い合わせ数は L1 の最優先枠（coverage.ts の C2「問い合わせ多」）への昇格に使う。以前は呼び出しごとに
// 1 を足していたので、鍵なしの 10 回/分/IP の枠で同じ出品を 5 回叩けば昇格できた。呼び手 × endpoint × UTC 日で
// 1 回に数える（decide.ts recordDecisionLookup が decision_lookup_callers で重複を除く）。
//
// 呼び手: 鍵ありは API キーの id、鍵なしはクライアント IP。IPv6 は /64 で丸める（1 回線に /64 が配られるのが
// 普通で、下位 64 bit は利用者が自由に回せる）。保存するのは HMAC だけで、材料に日付を入れるので日をまたいで
// 同じ呼び手を結び付けられない。鍵は API_KEY_PEPPER（本番必須）から HKDF で用途ごとに導出する。
//
// 2026-09-29 監査 6 周目（中）: 呼び手 × 日の重複除去でも、1 つの IP から 5 日で 5 回になり、別サイトの
// `<img src=".../decision">` で閲覧者の IP を呼び手にできた（鍵なしの呼び手は数を作れる）。だから:
//  - **数えるのは鍵ありの呼び手だけ**（鍵なしは材料 null＝数えない）。鍵の呼び手の HMAC は日をまたいで同じ値
//    （初版は先頭 `k1:`・下の独立レビューで持ち主の `k2:` へ）にして、C2 の昇格（coverage.ts）が「別々の鍵 3 以上 かつ 別々の日 2 以上」を数えられるようにする。
//    鍵 id はもともとこちらが発行した識別子で、IP のような利用者の属性ではない。IP の材料は今も日ごとに違う値。
//  - ブラウザが別サイトから送った問い合わせ（`Sec-Fetch-Site: cross-site`）と、vet402.com の売り手頁（/sellers）が
//    自動で呼んだ問い合わせ（Referer）は数えない。
//
// 2026-09-29 独立レビュー（中）: 鍵 id で数えると 1 人で満たせた（1 人が MAX_KEYS_PER_OWNER=10 本まで鍵を持てる
// ——3 本発行して 2 日問い合わせれば C2）。**数える単位は鍵の持ち主**（api_keys.user_id・無ければ鍵 id そのもの、
// api-keys.ts ApiKeyRecord.ownerId）。材料は `owner:<持ち主>`、HMAC の先頭は `k2:`。鍵 id で数えた `k1:` の行は
// 数えない（coverage.ts は `k2:` だけを見る）——同じ持ち主の鍵を別々に数えた行を 7 日の窓に残さないため。
// ============================================================
import { createHash, createHmac, hkdfSync } from "node:crypto";

/** IPv6 を /64 に丸める。IPv4・読めない値はそのまま（小文字・前後空白なし）。 */
export function ipCounterKey(ip: string): string {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!v.includes(":")) return v;
  // IPv4 射影（::ffff:1.2.3.4）は IPv4 として数える。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return mapped[1];
  const [head, tail = ""] = v.split("::");
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === "" ? [] : tail.split(":");
  if (!v.includes("::") && headParts.length !== 8) return v;
  const zeros = Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill("0");
  const full = v.includes("::") ? [...headParts, ...zeros, ...tailParts] : headParts;
  if (full.length !== 8 || full.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return v;
  return `${full.slice(0, 4).map((p) => p.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** vet402 自身の公開面の origin（売り手頁の自動の呼び出しを見分ける）。 */
const OWN_ORIGINS = new Set(["https://vet402.com", "https://www.vet402.com"]);

/**
 * 問い合わせを数えない要求か（2026-09-29 監査 6 周目）: ブラウザが別サイトから送った（`Sec-Fetch-Site: cross-site`）、
 * または vet402.com の売り手頁（`/sellers` とその下）から送った。ヘッダが無ければ数える側（API の呼び手は送らない）。
 */
export function isUncountedLookupRequest(headers: Pick<Headers, "get"> | null | undefined): boolean {
  if (!headers) return false;
  if ((headers.get("sec-fetch-site") ?? "").trim().toLowerCase() === "cross-site") return true;
  const referer = headers.get("referer");
  if (referer) {
    try {
      const u = new URL(referer);
      if (OWN_ORIGINS.has(u.origin) && (u.pathname === "/sellers" || u.pathname.startsWith("/sellers/"))) return true;
    } catch {
      // 読めない Referer は判断材料にしない。
    }
  }
  return false;
}

/**
 * 呼び手の材料。鍵ありは**鍵の持ち主**（ownerId）。**鍵なしは null**（数えない・2026-09-29 監査 6 周目）——鍵なしの
 * IP は 1 人で日をまたいで数を作れ、別サイトの閲覧者の IP も借りられる。数えない要求（isUncountedLookupRequest）も null。
 * 鍵があっても持ち主が分からなければ null（数えない側に倒す——鍵 id で数えると 1 人で 10 本分になる）。
 * `ip` は互換のために受け取るが、材料には使わない。
 */
export function lookupCallerMaterial(input: {
  apiKeyId?: string | null;
  ownerId?: string | null;
  ip?: string | null;
  headers?: Pick<Headers, "get"> | null;
}): string | null {
  if (!input.apiKeyId || !input.ownerId) return null;
  if (isUncountedLookupRequest(input.headers)) return null;
  return `owner:${input.ownerId}`;
}

/**
 * 鍵ありの呼び手の caller_hash の先頭（coverage.ts はこの行だけを C2 の昇格に数える）。`k1:` は鍵 id で数えた
 * 行（監査 6 周目の初版）で、もう数えない。
 */
export const KEYED_CALLER_HASH_PREFIX = "k2:";

function hmacKey(): Buffer | null {
  const material = process.env.API_KEY_PEPPER?.trim();
  if (!material) return null;
  return Buffer.from(hkdfSync("sha256", material, "", "vet402/decision-lookup-callers/v1", 32));
}

/**
 * decision_lookup_callers.caller_hash。IP の材料は UTC 日を含める（日をまたいで結び付けない）。持ち主の材料は日を
 * 含めず `k2:` を前に付ける（別々の持ち主の数を 7 日の窓で数えるため・2026-09-29 監査 6 周目と独立レビュー）。
 */
export function lookupCallerHash(material: string, day: string): string {
  if (material.startsWith("owner:")) return `${KEYED_CALLER_HASH_PREFIX}${hashText(`owner|${material}`)}`;
  return hashText(`${day}|${material}`);
}

function hashText(text: string): string {
  const key = hmacKey();
  // 鍵が無いのはローカルとテストだけ（本番は production-env が API_KEY_PEPPER を必須にする）。
  if (!key) return createHash("sha256").update(`vet402/decision-lookup-callers/v1|${text}`).digest("hex");
  return createHmac("sha256", key).update(text).digest("hex");
}
