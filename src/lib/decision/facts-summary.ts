// ============================================================
// §14 P2（2026-09-02）: passport の facts 要約。bound wallet が payTo の Endpoint に
// ついて L0–L2 の事実だけを要約する（スコアではない・§8.3）。
// DB 読みは呼び手が渡す loader に閉じ込め、組み立ては純関数にする（監査 P1-10）。
// ============================================================
import type { EndpointRef } from "@/lib/resolve/lookup";
import type { SellerFactsLoaded } from "./seller-facts";

export type FactsSummary = {
  endpoints: {
    endpoint_id: string;
    observatory_id: string;
    canonical_url: string;
    l0: string;
    l1: { n_delivered: number; n_attempts: number };
    l2: string;
  }[];
  total_endpoints: number;
};

export const FACTS_SUMMARY_HEAD = 3;

/** 先頭 head 件だけ facts を引く。読めなかった endpoint は落とす（null を混ぜない）。 */
export async function buildFactsSummary(
  eps: readonly EndpointRef[],
  loadFacts: (observatoryId: string) => Promise<SellerFactsLoaded | null>,
  head: number = FACTS_SUMMARY_HEAD,
): Promise<FactsSummary> {
  const rows = await Promise.all(
    eps.slice(0, head).map(async (e) => {
      const loaded = await loadFacts(e.observatory_id);
      if (!loaded) return null;
      return {
        endpoint_id: e.endpoint_id,
        observatory_id: e.observatory_id,
        canonical_url: e.canonical_url,
        l0: loaded.facts.l0.status,
        l1: { n_delivered: loaded.facts.l1.n_delivered, n_attempts: loaded.facts.l1.n_attempts },
        l2: loaded.facts.l2.status,
      };
    }),
  );
  return { endpoints: rows.filter((x): x is NonNullable<typeof x> => x !== null), total_endpoints: eps.length };
}
