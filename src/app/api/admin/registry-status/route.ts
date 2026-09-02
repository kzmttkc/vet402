import { NextRequest, NextResponse } from "next/server";
import { secureCompare } from "@/lib/util/secure-compare";

/**
 * GET /api/admin/registry-status — ERC-8004 Validation Registry の運用者ウォレットの
 * 「住所と残高」だけを返す（ADMIN_SECRET Bearer）。
 *
 * 2026-09-02: Registry 書き込みを ON にする前に、鍵の住所とガス残高を知る必要があるが、
 * `REGISTRY_OPERATOR_PRIVATE_KEY` は Vercel の sensitive env で `vercel env pull` でも読めない。
 * 鍵は絶対に返さない。住所は公開情報、残高はチェーンの公開状態。
 */
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token.length > 0 && secureCompare(token, secret);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = process.env.REGISTRY_OPERATOR_PRIVATE_KEY?.trim();
  const enabled = process.env.REGISTRY_WRITES_ENABLED === "true";
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    return NextResponse.json({ enabled, key: raw ? "malformed" : "unset" });
  }
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { createPublicClient, http, formatEther } = await import("viem");
    const { base } = await import("viem/chains");
    const account = privateKeyToAccount(raw as `0x${string}`);
    const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
    const [balance, gasPrice] = await Promise.all([client.getBalance({ address: account.address }), client.getGasPrice()]);
    return NextResponse.json({
      enabled,
      key: "set",
      operator: account.address,
      chain: "eip155:8453",
      balance_eth: formatEther(balance),
      gas_price_gwei: Number(gasPrice) / 1e9,
    });
  } catch (error) {
    return NextResponse.json({ enabled, key: "set", error: error instanceof Error ? error.name : "unknown" }, { status: 503 });
  }
}
