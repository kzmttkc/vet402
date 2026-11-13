"use server";

import { getDashboardSessionFromCookies } from "@/lib/dashboard/session";
import { loadSellerCard } from "@/lib/dashboard/ops-data";
import type { SellerDashboardProof } from "@/lib/dashboard/seller-access";
import type { SellerCardResult } from "@/lib/dashboard/ops-card";

export async function loadSellerCardAction(proof: SellerDashboardProof): Promise<SellerCardResult> {
  const session = await getDashboardSessionFromCookies();
  if (!session) {
    return { ok: false, reason: "session_required" };
  }
  return loadSellerCard(proof);
}
