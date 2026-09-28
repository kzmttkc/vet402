// ============================================================
// 売り手の単位＝ホスト名（/sellers・2026-09-28）。
//
// census（l1-runner の censusHostOf / censusHostSql）と同じ規則: resource_key（host+path に
// 正規化済み）の最初の `/` の前を取り、末尾の `:ポート` を落として小文字にする。
// api.verigrace.com:4449 と :4450 は同じ売り手。
//
// l1-runner を頁から import しない理由: 頁のバンドルに支払い経路（署名・鍵の読み込み）を
// 持ち込まないため。規則が 1 つであることは tests/sellers-fix-modes.test.ts が
// censusHostOf と突き合わせて固定する。
// ============================================================
import { sql, type SQL } from "drizzle-orm";

/** census の censusHostOf と同じ規則（小文字・末尾の `:ポート` を落とす）。 */
export function sellerHostOf(host: string): string {
  return host.toLowerCase().replace(/:[0-9]+$/, "");
}

/** resource_key（host+path）から売り手のホスト名を出す。 */
export function sellerHostOfResourceKey(resourceKey: string): string {
  return sellerHostOf(resourceKey.split("/")[0] ?? "");
}

/** 同じ規則の SQL 式（l1-runner の censusHostSql と同じ文）。 */
export const sellerHostSql = (resourceKey: SQL) =>
  sql`lower(regexp_replace(split_part(${resourceKey}, '/', 1), ':[0-9]+$', ''))`;

/**
 * URL の [host] として受け付ける形。DB に問い合わせる前に落とす（公開面は鍵なし）。
 * 小文字の英数字・`-`・`.` だけ、253 文字まで。ポートは受け付けない（売り手の単位に無い）。
 */
export function parseSellerHostParam(raw: string): string | null {
  let s: string;
  try {
    s = decodeURIComponent(raw);
  } catch {
    return null;
  }
  s = sellerHostOf(s.trim());
  if (s.length === 0 || s.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(s)) return null;
  if (s.includes("..")) return null;
  return s;
}

/** Base の出品（カタログの代表 network が Base）。census の対象と同じ（e.network）。表記の正典は request-query.ts。 */
export { BASE_NETWORKS } from "@/lib/observatory/request-query";
