import { desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { payerReconcileRuns } from "@/lib/db/schema";
import type { PayerReconcileResult } from "./payer-reconcile";

export async function insertPayerReconcileRun(result: PayerReconcileResult): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("insertPayerReconcileRun: DATABASE_URL is not configured");
  await db.insert(payerReconcileRuns).values({
    ranAt: new Date(result.at),
    ok: result.ok,
    totalUnrecorded: result.totalUnrecorded,
    totalPending: 0,
    windowFrom: new Date(result.windowFrom),
    windowTo: new Date(result.windowTo),
    chainsJson: result.chains,
  });
}

export async function listPayerReconcileRuns(limit = 30): Promise<
  {
    id: number;
    ranAt: string;
    ok: boolean;
    totalUnrecorded: number;
    totalPending: number;
    windowFrom: string;
    windowTo: string;
    chains: PayerReconcileResult["chains"];
  }[]
> {
  const db = getDb();
  if (!db) throw new Error("listPayerReconcileRuns: DATABASE_URL is not configured");
  const rows = await db
    .select()
    .from(payerReconcileRuns)
    .orderBy(desc(payerReconcileRuns.ranAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    ranAt: r.ranAt.toISOString(),
    ok: r.ok,
    totalUnrecorded: r.totalUnrecorded,
    totalPending: r.totalPending,
    windowFrom: r.windowFrom.toISOString(),
    windowTo: r.windowTo.toISOString(),
    chains: r.chainsJson as PayerReconcileResult["chains"],
  }));
}