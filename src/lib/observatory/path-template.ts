// ============================================================
// パステンプレート URL の検出（2026-09-02 監査 A1・オーナー決定）。
//
// カタログには `/v1/entreprise/:siren` のように**未置換のパスパラメータ**を
// 持つ resource が載る（本番実測 1,034 件）。我々はパラメータの実値を知らない
// ので正しいリクエストを作れず、叩けば 400/404 が返る——それは売り手の不履行
// ではなく我々の都合。L0 は外向き要求を出さずに unverified(path_template)、
// L1 は候補から外し、coverage 階層でも C1 の枠を使わない。
//
// 検出するのは**パスセグメント単位**: `:name` `{name}` `<name>` `[name]` `*`
// `%7Bname%7D`。セグメント途中の `:`（`/api/v1:beta`）、ポート番号、クエリ
// 文字列の値は対象外——正当な URL をテンプレート扱いして測定から外すのは、
// 測れるものを測らない誤りで、逆方向の嘘になる。
// ============================================================

import { sql, type SQL } from "drizzle-orm";

export const PATH_TEMPLATE_REASON = "path_template" as const;

/**
 * SQL 側の同じ判定（Postgres ARE・大文字小文字無視で使う）。L1 候補選定と coverage
 * 階層の WHERE 句が使う。クエリ文字列は `split_part(resource_url, '?', 1)` で落として
 * から当てる。JS 側 isPathTemplate との一致は tests/path-template.test.ts が固定する。
 * ここは生の文字列を見るので `{}` `<>` は生と符号化済みの両方を持つ。
 */
export const PATH_TEMPLATE_PG_REGEX =
  "/(:[A-Za-z_][A-Za-z0-9_-]*|\\{[^/]*\\}|%7B[^/]*%7D|<[^/]*>|%3C[^/]*%3E|\\[[^/]*\\]|\\*)(/|$)";

/** `x402_endpoints e` に対する「テンプレートではない」条件。 */
export function notPathTemplateSql(): SQL {
  return sql`split_part(e.resource_url, '?', 1) !~* ${PATH_TEMPLATE_PG_REGEX}`;
}

// WHATWG URL は `{}` `<>` をパス中で `%7B%7D` `%3C%3E` に符号化する（`[]` と `*` は
// そのまま）ので、生の形と符号化済みの形の両方を見る。
const TEMPLATE_SEGMENT =
  /^(?::[A-Za-z_][\w-]*|\{[^/]*\}|%7B[^/]*%7D|<[^/]*>|%3C[^/]*%3E|\[[^/]*\]|\*)$/i;

/** 純関数。resourceUrl のパスに未置換のテンプレートセグメントがあれば true。 */
export function isPathTemplate(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // WHATWG URL はパスを正規化しない（`%7B` はそのまま残る）ので raw で見る。
  return parsed.pathname
    .split("/")
    .some((segment) => segment !== "" && TEMPLATE_SEGMENT.test(segment));
}

/** 理由語彙（fail_reason に入る文字列）。テンプレートでなければ null。 */
export function pathTemplateReason(url: string): typeof PATH_TEMPLATE_REASON | null {
  return isPathTemplate(url) ? PATH_TEMPLATE_REASON : null;
}
