// ============================================================
// その行の tx を名指したのは誰か（2026-09-20・2026-09-19 公開面監査の宿題）。
//
//   seller_claim   売り手が有料応答の決済レシートで名指した tx。
//   vet402_index   売り手は名指していない。vet402 自身の決済索引（settlements）が、払い元・宛先・額・
//                  時刻の窓の一致から見つけて行に貼った tx（recover-late.ts の遅延回収）。
//
// どちらも `settled` になるには同じ照合器（settlement-verifier）を通る——nonce の束縛まで含めて。
// それでも区別して出す: 「売り手が返したレシートを再読した」と「売り手はレシートを返さず、vet402 が
// 自分の索引から決済を見つけた」は別の事実で、後者を前者と同じ顔で出すと、売り手がレシートを返す
// 割合を実際より良く見せる。自社に不利な方向の開示。
//
// 規則は照合器の `lateLinkOf`（settlement-verifier.ts）と同じ: 印は raw_response_meta.lateSettlement、
// 2026-09-19 以降の回収は貼った tx を lateSettlement.txHash に残すので、あればいまの tx_hash と一致する
// ことも要求する。照合器が遅延回収を取り消すと、行は回収前の tx_hash（無し、または売り手の原文）へ戻り、
// lateSettlement の印は rejectedTxHashes を持ったまま残る——その行を vet402_index と名乗らせない。
// 照合器は金に近い経路なので import せず、tests/export-request-body.test.ts が同じ表で両者の一致を固定する。
// ============================================================

export const SETTLEMENT_SOURCES = ["seller_claim", "vet402_index"] as const;
export type SettlementSource = (typeof SETTLEMENT_SOURCES)[number];

/** tx の無い行は null（名指された tx が無い）。 */
export function settlementSourceOf(row: { txHash: string | null | undefined; lateSettlement: unknown }): SettlementSource | null {
  if (typeof row.txHash !== "string" || row.txHash === "") return null;
  let late = row.lateSettlement;
  if (typeof late === "string") {
    try {
      late = JSON.parse(late);
    } catch {
      return "seller_claim";
    }
  }
  if (typeof late !== "object" || late === null || Array.isArray(late)) return "seller_claim";
  const linked = (late as Record<string, unknown>).txHash;
  if (typeof linked === "string" && linked.toLowerCase() !== row.txHash.toLowerCase()) return "seller_claim";
  return "vet402_index";
}

function assertAlias(fn: string, alias: string): string {
  if (alias !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`${fn}: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  }
  return alias === "" ? "" : `${alias}.`;
}

/** 「vet402 の索引が貼った tx をいま持っている」の SQL 述語。 */
function lateLinkedSql(p: string): string {
  const late = `${p}raw_response_meta->'lateSettlement'`;
  return (
    `${p}tx_hash IS NOT NULL AND ${p}tx_hash <> ''` +
    ` AND jsonb_typeof(${late}) = 'object'` +
    ` AND (jsonb_typeof(${late}->'txHash') IS DISTINCT FROM 'string' OR lower(${late}->>'txHash') = lower(${p}tx_hash))`
  );
}

/** `settlementSourceOf` と同じ規則の SQL 式（値の文字列、tx の無い行は NULL）。 */
export function settlementSourceSql(alias = ""): string {
  const p = assertAlias("settlementSourceSql", alias);
  return (
    `CASE WHEN ${p}tx_hash IS NULL OR ${p}tx_hash = '' THEN NULL` +
    ` WHEN ${lateLinkedSql(p)} THEN 'vet402_index'` +
    ` ELSE 'seller_claim' END`
  );
}

/** settled のうち、tx を vet402 の索引が貼った行（/api/v1/observatory/state の l1.settledLateLinked）。 */
export function settledLateLinkedPredicate(alias = ""): string {
  const p = assertAlias("settledLateLinkedPredicate", alias);
  return `${p}status = 'settled' AND ${lateLinkedSql(p)}`;
}
