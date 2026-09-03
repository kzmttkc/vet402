// ============================================================
// docs/claims.yaml の `check.assert` を評価する最小の式エンジン。
//
// 依存を増やさない。文法は 1 行だけ:
//   <dotted.path> <op> <literal>
//   op      : >= <= == != > <
//   literal : 数値 / "文字列" / true / false / null
// これ以上を式に書きたくなったら、それは主張が複雑すぎる合図。
// ============================================================

export type EvalResult = { ok: boolean; actual: unknown; expected: string };

const EXPR = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*(>=|<=|==|!=|>|<)\s*(.+?)\s*$/;

function parseLiteral(raw: string): unknown {
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) return JSON.parse(raw);
  if (/^'[^']*'$/.test(raw)) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  throw new Error(`unsupported assertion literal: ${raw}`);
}

function readPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 式を評価する。パスが無ければ false（actual は undefined）。式が読めなければ throw。 */
export function evaluateAssertion(expr: string, data: unknown): EvalResult {
  const m = EXPR.exec(expr);
  if (!m) throw new Error(`unsupported assertion expression: ${expr}`);
  const [, path, op, rawLiteral] = m;
  const want = parseLiteral(rawLiteral);
  const actual = readPath(data, path);
  const expected = expr.trim();

  if (op === "==") return { ok: actual === want, actual, expected };
  if (op === "!=") return { ok: actual !== want, actual, expected };

  if (typeof actual !== "number" || typeof want !== "number") {
    return { ok: false, actual, expected };
  }
  const ok =
    op === ">=" ? actual >= want : op === "<=" ? actual <= want : op === ">" ? actual > want : actual < want;
  return { ok, actual, expected };
}
