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

/** 呼び手の材料。鍵ありは鍵 id、鍵なしは IP（/64）。 */
export function lookupCallerMaterial(input: { apiKeyId?: string | null; ip?: string | null }): string {
  if (input.apiKeyId) return `key:${input.apiKeyId}`;
  return `ip:${ipCounterKey(input.ip ?? "unknown")}`;
}

function hmacKey(): Buffer | null {
  const material = process.env.API_KEY_PEPPER?.trim();
  if (!material) return null;
  return Buffer.from(hkdfSync("sha256", material, "", "vet402/decision-lookup-callers/v1", 32));
}

/** decision_lookup_callers.caller_hash。材料に UTC 日を含める（日をまたいで結び付けない）。 */
export function lookupCallerHash(material: string, day: string): string {
  const key = hmacKey();
  const text = `${day}|${material}`;
  // 鍵が無いのはローカルとテストだけ（本番は production-env が API_KEY_PEPPER を必須にする）。
  if (!key) return createHash("sha256").update(`vet402/decision-lookup-callers/v1|${text}`).digest("hex");
  return createHmac("sha256", key).update(text).digest("hex");
}
