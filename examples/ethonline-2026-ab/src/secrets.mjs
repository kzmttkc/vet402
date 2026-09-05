/**
 * 秘密が出力に混ざらないことを、**規律ではなく計器**で担保する。
 *
 * WINDOW_PLAN §6「撮影で画面に出してはいけないもの」と同じ理由:
 * **一度出たキーは失効させるしかない。** 生ログは審査員に見せるものなので、
 * ここが最後の関門になる（[[fix-the-path-not-the-artifact]]）。
 */

/** 値が出たら止める環境変数。**名前ではなく、その値**を探す。 */
export const SECRET_ENV_NAMES = Object.freeze([
  "GRAPH_API_KEY",
  "VOUCH_API_KEY",
  "BAZANTIC_UPSTREAM_KEY",
  "OBSERVATORY_WALLET_PRIVATE_KEY",
  "VOUCH_PAYER_PRIVATE_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DATABASE_URL",
]);

/** 環境変数に入っていなくても、形で分かるもの。 */
const SHAPE_PATTERNS = Object.freeze([
  // EIP-3009 / EOA の秘密鍵（32バイト）。40桁のアドレスとは長さで区別する。
  { name: "private-key-like", re: /\b0x[0-9a-fA-F]{64}\b/g },
  { name: "sk-key-like", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "bearer-token-like", re: /\b(?:Bearer|bearer)\s+[A-Za-z0-9._-]{24,}/g },
]);

/** これ未満の長さの値は照合しない（"1" や "true" で全文が秘密になる誤検知を防ぐ）。 */
const MIN_SECRET_LENGTH = 12;

/**
 * @param {string} text
 * @param {Record<string,string|undefined>} env
 * @returns {{name: string, kind: "env"|"shape"}[]}
 */
export function findSecrets(text, env = process.env) {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = env?.[name];
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
    if (text.includes(value)) hits.push({ name, kind: "env" });
  }
  for (const { name, re } of SHAPE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) hits.push({ name, kind: "shape" });
  }
  return hits;
}

function walk(value, path, visit) {
  if (typeof value === "string") return visit(value, path);
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, visit);
  }
}

/**
 * 秘密が1つでもあれば投げる。**メッセージに値そのものを載せない**
 * （例外メッセージがログに残って、そこから漏れては意味が無い）。
 */
export function assertNoSecrets(payload, env = process.env) {
  const found = [];
  walk(payload, "", (text, path) => {
    for (const hit of findSecrets(text, env)) found.push(`${hit.name} (${hit.kind}) at ${path || "<root>"}`);
  });
  if (found.length > 0) {
    throw new Error(`refusing to write: secret material detected — ${[...new Set(found)].join("; ")}`);
  }
}
