import { redirect } from "next/navigation";
import { getDashboardSessionFromCookies } from "@/lib/dashboard/session";
import { loadBuyerCard } from "@/lib/dashboard/ops-data";
import { BuyerOpsView } from "./buyer-ops-view";

export const dynamic = "force-dynamic";

export default async function DashboardBuyerOpsPage() {
  const session = await getDashboardSessionFromCookies();
  if (!session) redirect("/dashboard/login");
  const card = await loadBuyerCard(session.apiKeyId);
  return <BuyerOpsView card={card} />;
}
