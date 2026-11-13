import { redirect } from "next/navigation";
import { getDashboardSessionFromCookies } from "@/lib/dashboard/session";
import { SellerOpsClient } from "./seller-ops-client";

export const dynamic = "force-dynamic";

export default async function DashboardSellerOpsPage() {
  const session = await getDashboardSessionFromCookies();
  if (!session) redirect("/dashboard/login");
  return (
    <div className="space-y-6">
      <div>
        <h2 className="dash-title">Seller operations</h2>
        <p className="dash-lede">Revenue, delivery, trade disputes, and L0 reputation for one payTo wallet.</p>
      </div>
      <SellerOpsClient />
    </div>
  );
}
