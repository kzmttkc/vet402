// ============================================================
// §7.3 逆引きの入口: q が URL / domain / address / tx / payee_id のどれかを判別する。
// 判別は文字列の形だけで行う（DB を見ない・純関数）。
// ============================================================
export type QueryKind = "url" | "domain" | "address" | "tx" | "payee_id" | "unknown";

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;
const PARTY_ID = /^(eip155:\d+|solana:[1-9A-HJ-NP-Za-km-z]{32,44}):(.+)$/;

export function classifyQuery(raw: string): { kind: QueryKind; value: string } {
  const q = raw.trim();
  if (q.length === 0 || q.length > 2048) return { kind: "unknown", value: q };
  if (/^https?:\/\//i.test(q)) return { kind: "url", value: q };
  if (PARTY_ID.test(q)) return { kind: "payee_id", value: q };
  if (EVM_TX.test(q)) return { kind: "tx", value: q.toLowerCase() };
  if (EVM_ADDR.test(q)) return { kind: "address", value: q.toLowerCase() };
  if (B58.test(q) && q.length >= 80 && q.length <= 90) return { kind: "tx", value: q };
  if (B58.test(q) && q.length >= 32 && q.length <= 44) return { kind: "address", value: q };
  if (DOMAIN.test(q)) return { kind: "domain", value: q.toLowerCase() };
  return { kind: "unknown", value: q };
}
