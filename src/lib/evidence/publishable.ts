// ============================================================
// §10 証拠規則。公開してよい失敗は、次をすべて含むものに限る:
//   observed_at（UTC）・resource_id と canonical_url・probe_type（L0/L1/L2）・
//   生ログの要約（ステータス、ヘッダ名、エラー種別）・L1 以上なら tx_hash と chain・
//   再現手順（メソッド、方言、測定クライアント版）
// 欠けるならその観測は内部に留め、公開判定に使わない。述語は 1 箇所に置き、
// facts / decision / 公開ページの全てがこれを通す。
// ============================================================

export const L0_CLIENT = "vet402-observatory-l0/1.0";
export const L1_CLIENT = "vet402-observatory-l1/1.0";

export type FailureEvidence = {
  observed_at: string;
  resource_id: string;
  canonical_url: string;
  probe_type: "L0" | "L1" | "L2";
  raw_summary: { status: number | null; headers: string[]; error: string | null } | null;
  repro: { method: string; dialect: string | null; client: string } | null;
  tx_hash?: string | null;
  chain?: string | null;
};

export function isPublishableFailure(e: FailureEvidence): boolean {
  if (!e.observed_at || !e.resource_id || !e.canonical_url || !e.probe_type) return false;
  if (!e.raw_summary || !e.repro || !e.repro.method || !e.repro.client) return false;
  if (e.probe_type !== "L0" && (!e.tx_hash || !e.chain)) return false;
  return true;
}

/** L0 プローブ行から証拠オブジェクトを組む（rawResponseMeta の形は l0-probe.ts が持つ）。 */
export function l0FailureEvidence(input: {
  probedAt: string | null;
  resourceId: string | null;
  canonicalUrl: string | null;
  method: string;
  dialect: string | null;
  httpStatus: number | null;
  failReason: string | null;
  rawResponseMeta: Record<string, unknown> | null;
}): FailureEvidence | null {
  if (!input.probedAt || !input.resourceId || !input.canonicalUrl) return null;
  const meta = input.rawResponseMeta ?? {};
  const headers = ["contentType", "server"].filter((k) => meta[k] !== undefined && meta[k] !== null);
  return {
    observed_at: input.probedAt,
    resource_id: input.resourceId,
    canonical_url: input.canonicalUrl,
    probe_type: "L0",
    raw_summary: { status: input.httpStatus, headers, error: input.failReason },
    repro: { method: input.method, dialect: input.dialect, client: typeof meta.client === "string" ? meta.client : L0_CLIENT },
  };
}
