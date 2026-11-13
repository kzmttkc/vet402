// ============================================================
// P3 運用ダイジェストの webhook 配送（定期実行は別工程）。
// ============================================================
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { buyerCardWebhookPayload, type BuyerCard } from "@/lib/dashboard/ops-card";

export async function dispatchOpsDigest(apiKeyId: string, buyerCard: BuyerCard): Promise<void> {
  const payload = buyerCardWebhookPayload(buyerCard);
  await dispatchWebhookEvent(apiKeyId, "ops.digest", payload);
}
