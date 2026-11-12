"use client";

import { useEffect, useState } from "react";

type DisputeJson = {
  purchaseId: string;
  stage: string | null;
  deliveryConfirmed: boolean;
  payer: { present: boolean };
  seller: { present: boolean };
  p2Live: boolean;
  e4Outcome: string | null;
};

export function TradeDisputePanel({ purchaseId }: { purchaseId: string }) {
  const [data, setData] = useState<DisputeJson | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/v1/observatory/disputes?purchaseId=${encodeURIComponent(purchaseId)}`, {
          cache: "no-store",
        });
        if (!r.ok) {
          if (alive) setError("I could not load this trade record yet.");
          return;
        }
        const j = (await r.json()) as DisputeJson;
        if (alive) setData(j);
      } catch {
        if (alive) setError("I could not load this trade record yet.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [purchaseId]);

  if (error) return <p>{error}</p>;
  if (!data) return <p>Loading the trade record.</p>;

  return (
    <dl>
      <dt>Purchase id</dt>
      <dd>{data.purchaseId}</dd>
      <dt>Stage</dt>
      <dd>{data.stage ?? "none"}</dd>
      <dt>Delivery confirmed</dt>
      <dd>{data.deliveryConfirmed ? "yes" : "no"}</dd>
      <dt>Payer record</dt>
      <dd>{data.payer.present ? "present" : "empty"}</dd>
      <dt>Seller record</dt>
      <dd>{data.seller.present ? "present" : "empty"}</dd>
      {data.e4Outcome ? (
        <>
          <dt>E4 outcome</dt>
          <dd>{data.e4Outcome}</dd>
        </>
      ) : null}
    </dl>
  );
}
