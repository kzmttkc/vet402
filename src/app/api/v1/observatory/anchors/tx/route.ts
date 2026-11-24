import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAddress, type Address } from "viem";
import {
  ANCHOR_BASE_CHAIN_ID,
  createAnchorBaseRpc,
  registerLedgerAnchorTx,
} from "@/lib/observatory/anchor-base";
import { getDb } from "@/lib/db/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

/**
 * POST /api/v1/observatory/anchors/tx — register a Base mainnet self-tx that etches a sealed day root.
 * Bearer ANCHOR_POST_SECRET. Broadcast is done off-Vercel (scripts/anchor-base.mjs); this route only verifies and stores.
 */

export const dynamic = "force-dynamic";

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(request: NextRequest): string {
  const h = request.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

const DEFAULT_RPC = "https://mainnet.base.org";

export async function POST(request: NextRequest) {
  const secret = (process.env.ANCHOR_POST_SECRET ?? "").trim();
  if (secret === "") {
    return NextResponse.json({ error: "anchor_post_unconfigured" }, { status: 503 });
  }
  const given = bearer(request);
  if (given === "" || !sameSecret(given, secret)) {
    return NextResponse.json({ error: "anchor_post_unauthorized" }, { status: 403 });
  }
  const signerRaw = (process.env.ANCHOR_BASE_SIGNER ?? "").trim();
  if (!isAddress(signerRaw)) {
    return NextResponse.json({ error: "anchor_post_unconfigured" }, { status: 503 });
  }
  const signer = signerRaw as Address;
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503 });
  }
  let body: { day?: unknown; txHash?: unknown; chainId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const day = typeof body.day === "string" ? body.day.trim() : "";
  const txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";
  const chainId = typeof body.chainId === "number" ? body.chainId : Number(body.chainId);
  if (day === "" || txHash === "" || !Number.isFinite(chainId)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (chainId !== ANCHOR_BASE_CHAIN_ID) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const rpcUrl = (process.env.ANCHOR_BASE_RPC_URL ?? DEFAULT_RPC).trim() || DEFAULT_RPC;
  try {
    const result = await registerLedgerAnchorTx(
      db,
      { day, txHash, chainId },
      createAnchorBaseRpc(rpcUrl),
      signer,
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(
      { ok: true, day: result.day, txHash: result.txHash, chainId: ANCHOR_BASE_CHAIN_ID },
      { status: 200 },
    );
  } catch (error) {
    logServerErrorSafe("observatory_anchor_tx_post", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503 });
  }
}

const __disallowed = exportDisallowedMethodHandlers(["POST"]);
export const { GET, PUT, PATCH, DELETE, OPTIONS } = __disallowed;