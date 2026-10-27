// ============================================================
// 台帳 export（/api/v1/observatory/export.csv）の行を、出品（L0 export の endpoint）へ付ける。
//
// 判定（/decision）・/purchases・記録頁は購入の行を endpoint_id で引く（src/lib/decision/seller-facts.ts の
// `WHERE endpoint_id = …`）。台帳 export には endpoint_id の列が無いので、ここで resource_key と network から付け直す。
//
// 2026-10-28: 以前は `resource_key|network` の一致だけで付けていた。Base に載っている出品を Stellar・Celo・
// Solana・XRPL などの別のチェーンで買った行（その endpoint の行で、network だけが別）が落ち、判定は
// n_settled=2、台帳は 0 行、という赤が 10/25 から毎回 1 件出た（agent402.tools/api/skill/contact-verify、
// api.vextorium.com/v1/ping、agent402.tools/api/evm-rpc、pay.edge-agents.ai/…）。
//
// 付け方:
//   - その resource_key の endpoint が L0 export に 1 つだけ → その resource_key の行は network を問わず全部その出品の行。
//   - 2 つ以上 → network が 1 つの endpoint の network と一致する行はその endpoint の行。network が空の行
//     （402 の前に止まった no_eligible_accept 等）は今までどおりどこにも付けない（署名していないので数に効かない）。
//     network がどの endpoint とも一致しない行は、export だけでは付け先が決まらない → unplaced（比べずに skip の理由にする）。
//   - 売り手一覧が指す最新の購入（purchase_id）は、同じ resource_key なら必ず含める（今までどおり）。
// ============================================================

export type LedgerRow = Record<string, string>;

export type ListingLedger = {
  /** その出品の行（判定と同じ集合のつもりの行） */
  rows: LedgerRow[];
  /** 同じ resource_key に endpoint が複数あり、どれの行か export から決まらない行 */
  unplaced: LedgerRow[];
};

export type LedgerIndex = {
  rowsOf(listing: { observatoryId: string; resourceKey: string; network: string }, latestPurchaseId?: string): ListingLedger;
};

export function buildLedgerIndex(args: { l0: readonly LedgerRow[]; ledger: readonly LedgerRow[] }): LedgerIndex {
  const endpointsByKey = new Map<string, LedgerRow[]>();
  for (const r of args.l0) (endpointsByKey.get(r.resource_key) ?? endpointsByKey.set(r.resource_key, []).get(r.resource_key)!).push(r);
  const rowsByKey = new Map<string, LedgerRow[]>();
  const byPurchase = new Map<string, LedgerRow>();
  for (const r of args.ledger) {
    if (r.purchase_id) byPurchase.set(r.purchase_id, r);
    (rowsByKey.get(r.resource_key) ?? rowsByKey.set(r.resource_key, []).get(r.resource_key)!).push(r);
  }
  return {
    rowsOf(listing, latestPurchaseId) {
      const all = rowsByKey.get(listing.resourceKey) ?? [];
      const endpoints = endpointsByKey.get(listing.resourceKey) ?? [];
      let rows: LedgerRow[];
      const unplaced: LedgerRow[] = [];
      if (endpoints.length <= 1) rows = [...all];
      else {
        const nets = new Map<string, number>();
        for (const e of endpoints) nets.set(e.network, (nets.get(e.network) ?? 0) + 1);
        rows = [];
        for (const r of all) {
          if (r.network === "") continue;
          const n = nets.get(r.network) ?? 0;
          if (n === 0) unplaced.push(r);
          else if (r.network === listing.network) rows.push(r);
        }
      }
      const latest = latestPurchaseId ? byPurchase.get(latestPurchaseId) : undefined;
      if (latest && latest.resource_key === listing.resourceKey && !rows.includes(latest)) {
        rows.push(latest);
        const i = unplaced.indexOf(latest);
        if (i >= 0) unplaced.splice(i, 1);
      }
      return { rows, unplaced };
    },
  };
}
