import { desc } from "drizzle-orm";
import { getDb } from "./client";
import { isMissingSchemaError } from "./pg-errors";
import { operatorOverrides } from "./schema";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * vet402 2026-08-14 — operator override transparency log (append-only, PUBLIC).
 * See schema.operatorOverrides. Turns a GLOBAL operator blacklist act — the
 * "silent single censorship point" the EF/Vitalik review flagged — into an
 * auditable public record. Only global (operator-wide) acts are recorded here;
 * a customer's own list is their private management right, not censorship.
 */

export type OperatorOverrideAction = "blacklist_added" | "blacklist_removed";

export type OperatorOverrideEntry = {
  wallet: string;
  action: OperatorOverrideAction;
  reason: string;
  createdAt: string;
};

/**
 * Append one operator act to the public log. Never throws on a missing table
 * (deploy-ordering): failing to WRITE the transparency record must not take the
 * list-write path down, but it is logged loudly so the gap is visible — an
 * unrecorded override is a fail-loud ops event, not a silent one.
 */
export async function recordOperatorOverride(input: {
  wallet: string;
  action: OperatorOverrideAction;
  reason: string;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.insert(operatorOverrides).values({
      wallet: input.wallet.toLowerCase(),
      action: input.action,
      reason: input.reason,
    });
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    logServerErrorSafe(
      "operator_override_log_missing",
      new Error("operator_overrides not migrated yet; global override NOT publicly logged"),
    );
  }
}

/**
 * The public log, newest first. Degrades to an empty list when the table is not
 * migrated yet — an empty log is the honest state ("no operator overrides on
 * record"), never an error the public page has to handle.
 */
export async function listOperatorOverrides(limit = 200): Promise<OperatorOverrideEntry[]> {
  const db = getDb();
  if (!db) return [];
  const safeLimit = Math.min(1000, Math.max(1, limit));
  try {
    const rows = await db
      .select()
      .from(operatorOverrides)
      .orderBy(desc(operatorOverrides.createdAt))
      .limit(safeLimit);
    return rows.map((r) => ({
      wallet: r.wallet,
      action: r.action as OperatorOverrideAction,
      reason: r.reason,
      createdAt: (r.createdAt ?? new Date(0)).toISOString(),
    }));
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    logServerErrorSafe(
      "operator_override_list_missing",
      new Error("operator_overrides not migrated yet; public log reads as empty"),
    );
    return [];
  }
}
