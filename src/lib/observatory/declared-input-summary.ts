// ============================================================
// 掲載の宣言の要約（2026-09-29）— x402_endpoints.declared_input の形と読み方。
//
// 書くのは catalog-source.ts（declared-input.ts の declaredInputSummary＝送る規則そのものを掲載に当てた結果）。
// 読むのは request-body.ts / request-query.ts の「vet402 が送っていなかった」判定（/sellers・retest）。
// このファイルは何も import しない: /sellers は支払いの依存（x402-payer）を持つ declared-input.ts を import できない
// （tests/sellers-no-payment-imports.test.ts）。
//
//   query  declared = 送る規則なら宣言のクエリを足す（2026-09-27 23:27 UTC より前の Base では実際には足していない）
//          empty    = 宣言が無い
//          refused  = 宣言は在るが、規則で使わない
//   body   declared = 送る規則なら宣言の本文を送る（2026-09-16 23:25 UTC より前は実際には `{}` を送っていた）
//          empty    = 宣言が無い（`{}` を送る）
// 値・本文そのものは残さない（売り手が公開の 402 で宣言している一次情報で、vet402 が再配布しない）。
// ============================================================

export type DeclaredInputSummary = {
  query: "declared" | "empty" | "refused";
  body: "declared" | "empty";
};

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** declared_input 列の値から読む（無い・形が違えば null＝判定に使わない）。 */
export function declaredInputOf(v: unknown): DeclaredInputSummary | null {
  const r = rec(v);
  if (!r) return null;
  const q = r.query;
  const b = r.body;
  if (q !== "declared" && q !== "empty" && q !== "refused") return null;
  if (b !== "declared" && b !== "empty") return null;
  return { query: q, body: b };
}

/** 送る規則なら宣言の本文を送る掲載か（declared_input.body が文字列 "declared"）。SQL は declaredInputBodySql。 */
export function declaredInputSendsBody(v: unknown): boolean {
  return rec(v)?.body === "declared";
}

/** 送る規則なら宣言のクエリを足す掲載か（declared_input.query が文字列 "declared"）。SQL は declaredInputQuerySql。 */
export function declaredInputSendsQuery(v: unknown): boolean {
  return rec(v)?.query === "declared";
}

const EXPR_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
function expr(fn: string, e: string): string {
  if (!EXPR_RE.test(e)) throw new Error(`${fn}: expected a column reference like alias.column, got ${JSON.stringify(e)}`);
  return e;
}

/** declaredInputSendsBody と同じ規則の SQL（引数は declared_input の列の式）。 */
export function declaredInputBodySql(inputExpr: string): string {
  const x = expr("declaredInputBodySql", inputExpr);
  return `(jsonb_typeof(${x} -> 'body') = 'string' AND ${x} ->> 'body' = 'declared')`;
}

/** declaredInputSendsQuery と同じ規則の SQL。 */
export function declaredInputQuerySql(inputExpr: string): string {
  const x = expr("declaredInputQuerySql", inputExpr);
  return `(jsonb_typeof(${x} -> 'query') = 'string' AND ${x} ->> 'query' = 'declared')`;
}
