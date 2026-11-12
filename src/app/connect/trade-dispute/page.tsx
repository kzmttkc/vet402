import type { Metadata } from "next";
import Link from "next/link";
import { TradeDisputePanel } from "@/components/connect/TradeDisputePanel";
import { P2_DISPUTE_PAGE_PATH, publicTradeDisputeJson } from "@/lib/observatory/trade-dispute";
import { p2PageMode } from "@/lib/observatory/p2-live";
import { mergeE6Record, hashDeliveredBody } from "@/lib/observatory/e6-record";
import { E6_DEMO_PURCHASE_ID, demoE6Record } from "@/lib/observatory/e6-store";
import { pageMetadata } from "@/lib/seo";
import styles from "../connect.module.css";

export const metadata: Metadata = pageMetadata({
  title: "Trade dispute (draft)",
  description:
    "Both sides of one x402 trade on one screen. vet402 records what each side signed and leaves the call to the evidence. Draft for public testnet.",
  path: P2_DISPUTE_PAGE_PATH,
});

const draftNote =
  p2PageMode() === "draft"
    ? "Draft. On public testnet this screen will show inconclusive or refund."
    : "Live on public testnet.";

export default function TradeDisputePage() {
  const example = publicTradeDisputeJson(demoE6Record(), { viewer: "anonymous" });
  const bodyHash = hashDeliveredBody("delivered-but-disputed");
  const deliveredExample = publicTradeDisputeJson(
    mergeE6Record(null, {
      purchaseId: "example-delivered-dispute",
      payer: {
        paymentTx: "0x1",
        receivedBodyHash: bodyHash,
        state: "claims_not_delivered",
        payerSignature: "0x" + "1".repeat(130),
      },
      seller: {
        paymentVerified: "0x1",
        deliveredBodyHash: bodyHash,
        deliverySignature: "0x" + "2".repeat(130),
      },
    }),
    { viewer: "anonymous" },
  );

  return (
    <main className={styles.page}>
      <article className={styles.article}>
        <p className={styles.lede}>{draftNote}</p>
        <h1>One trade, both sides</h1>
        <p>
          vet402 keeps E6 evidence per purchase id. I publish which stage disagreed. Response bodies and headers do not appear on this
          page.
        </p>
        <p>
          Example stage on record: <strong>{example.stage ?? "none"}</strong>. Both parties see the same view.
        </p>
        <p>
          When both hashes match and both sides signed, delivery stays confirmed. Example: stage{" "}
          <strong>{deliveredExample.stage ?? "none"}</strong>, delivery confirmed{" "}
          <strong>{deliveredExample.deliveryConfirmed ? "yes" : "no"}</strong>. I still publish no response body.
        </p>
        <TradeDisputePanel purchaseId={E6_DEMO_PURCHASE_ID} />
        <p className={styles.foot}>
          <Link href="/connect" className={styles.link}>
            Back to Connect
          </Link>
        </p>
      </article>
    </main>
  );
}
