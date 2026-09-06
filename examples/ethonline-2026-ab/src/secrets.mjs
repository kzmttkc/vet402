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
  "DEMO_PAYER_PRIVATE_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DATABASE_URL",
]);

/** 環境変数に入っていなくても、形で分かるもの。 */
const SHAPE_PATTERNS = Object.freeze([
  { name: "sk-key-like", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "bearer-token-like", re: /\b(?:Bearer|bearer)\s+[A-Za-z0-9._-]{24,}/g },
]);

/**
 * **32バイトの 16 進値**。EOA の秘密鍵も、決済の txHash も、まったく同じ形をしている。
 * **形だけでは区別できない**——これは推論の限界であって、正規表現の書き方の問題ではない。
 *
 * 2026-09-06 まで、ここは `/\b0x[0-9a-fA-F]{64}\b/` で**無条件に秘密**としていた。
 * その結果、`SKILL.md` に載っている**公開済みの決済 txHash**（basescan で誰でも読める）が
 * `private-key-like` と判定され、生ログを1バイトも書けなくなった。
 *
 * では文脈（`txHash:` の直後・`basescan.org/tx/` の中）で許すか——**それはやらない。**
 * 文脈は書き手が自由に付けられるので、`txHash: 0x<本物の秘密鍵>` が素通りする。
 * **「秘密でないこと」を証明できるのは形でも文脈でもなく、その値そのもの**なので、
 * **人が公開済みだと確かめて、出所つきでここに載せた値だけ**を許す。
 * ここに無い 64桁hex は、今までどおり全部止める（既定は「秘密」のまま。緩んでいない）。
 */
export const PUBLIC_HEX_ALLOWLIST = Object.freeze([
  Object.freeze({
    value: "0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad",
    why: "The Graph の x402 エンドポイントへ実際に $0.01 を払った決済の txHash（WINDOW_PLAN §10.5・SKILL.md）。Base の公開台帳に載っており、秘密ではない。",
    provenance: "https://basescan.org/tx/0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad",
  }),
]);

const ALLOWED_HEX = new Set(PUBLIC_HEX_ALLOWLIST.map((e) => e.value.toLowerCase()));
const HEX32_RE = /\b0x[0-9a-fA-F]{64}\b/g;

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
  // 32バイト hex は**許可リストに載っていなければ秘密**。既定は「止める」側のまま。
  HEX32_RE.lastIndex = 0;
  for (const m of text.matchAll(HEX32_RE)) {
    if (!ALLOWED_HEX.has(m[0].toLowerCase())) {
      hits.push({ name: "private-key-like", kind: "shape" });
      break;
    }
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
