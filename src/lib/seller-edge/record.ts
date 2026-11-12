// E5 の売り手端を E6 の同じ店へ載せる。決済は書かない。買い手の脚は空のまま。
import { mergeE6Record, type E6Record } from "@/lib/observatory/e6-record";
import { getE6Store, type E6Store } from "@/lib/observatory/e6-store";

export type SellerEdgeLeg = {
  paymentVerified: string;
  deliveredBodyHash: string;
  deliverySignature: string;
  vet402Middleware?: boolean;
};

export async function recordSellerEdgeOnE6(
  purchaseId: string,
  seller: SellerEdgeLeg,
  store?: E6Store | null,
): Promise<E6Record> {
  const target = store === undefined ? getE6Store() : store;
  if (!target) throw new Error("e6 store missing");
  const existing = await target.get(purchaseId);
  const next = mergeE6Record(existing, {
    purchaseId,
    seller: {
      paymentVerified: seller.paymentVerified,
      deliveredBodyHash: seller.deliveredBodyHash,
      deliverySignature: seller.deliverySignature,
      vet402Middleware: true,
    },
  });
  await target.put(next);
  return next;
}
