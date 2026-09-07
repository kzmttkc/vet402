// ============================================================
// policy の数値は**有限**でなければ呼び出し側エラー（2026-09-07 第三者監査 A2）。
//
// 監査（HEAD 0ebec74・pay-or-refuse.ts :477, :530, :872）: `policy.maxPerTxUsd: NaN` は `NaN ?? 1` が
// NaN のまま上限になり、`amountUsd > NaN` も `units / 1e6 > NaN` も false——上限比較が**全部通る**。
// 本番サーバは `max_per_tx_usd=NaN` を 400 で止めるが、SDK 単体（偽サーバ・古いサーバ・オフライン）には
// 関門が無かった。`amountUsd` には「有限・非負」の検査があるのに、上限と床には無かった。
//
// 規則: `maxPerTxUsd` は `Number.isFinite(x) && x > 0`、床（`minL1Deliveries` / `minSubgraphReceipts`）は
// `Number.isFinite(x) && x >= 0` でなければ throw（通信の前・`amountUsd` と同じ厳しさ）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { payOrRefuse } from "../dist/index.js";

const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const account = { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => { throw new Error("must not sign"); } };
/** 通信は起きてはいけない（呼び出し側エラーは fetch の前に投げる）。 */
const noFetch = async (url) => { throw new Error(`must not fetch: ${url}`); };
const base = { payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account, fetch: noFetch };

for (const bad of [NaN, Infinity, -Infinity, 0, -1, "1", null]) {
  test(`N1 policy.maxPerTxUsd: ${String(bad)} → invalid_policy を throw（通信の前）`, async () => {
    await assert.rejects(
      () => payOrRefuse({ ...base, policy: { maxPerTxUsd: bad } }),
      (e) => /invalid_policy/.test(e.message) && /maxPerTxUsd/.test(e.message),
    );
  });
}

for (const floor of ["minL1Deliveries", "minSubgraphReceipts"]) {
  const source = floor === "minL1Deliveries" ? "vet402" : "subgraph";
  for (const bad of [NaN, Infinity, -1, "3", null]) {
    test(`N2 policy.evidence.${floor}: ${String(bad)}（source ${source}）→ invalid_evidence_policy を throw（通信の前）`, async () => {
      await assert.rejects(
        () => payOrRefuse({ ...base, policy: { evidence: { source, [floor]: bad, graphApiKey: "k".repeat(32) } } }),
        (e) => /invalid_evidence_policy/.test(e.message) && new RegExp(floor).test(e.message),
      );
    });
  }
}

test("N3 NaN の上限は「上限なし」ではない——402 が $1 でも NaN 上限で払わない（関門の実効）", async () => {
  // throw が関門なので、ここまで来られない。呼び出し側エラーが fetch の前であることを二重に固定する。
  let fetched = 0;
  await assert.rejects(() => payOrRefuse({ ...base, fetch: async () => { fetched++; throw new Error("x"); }, policy: { maxPerTxUsd: Number.NaN } }));
  assert.equal(fetched, 0);
});

test("N4 有限・正の上限と有限・非負の床は従来どおり受理する（ネガティブコントロール: 通信まで進む）", async () => {
  let fetched = 0;
  const r = await payOrRefuse({
    ...base,
    fetch: async () => { fetched++; return { ok: false, status: 503, json: async () => ({}), headers: new Map() }; },
    policy: { maxPerTxUsd: 0.5, evidence: { source: "vet402", minL1Deliveries: 0 } },
  });
  assert.equal(fetched, 1, "policy が通り /decision まで進んでいる");
  assert.equal(r.status, "refused");
});
