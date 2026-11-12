// 鍵なしの支払い証明。本文の解読とチェーン読みは lib/payment-proof に置く。
import type { NextRequest } from "next/server";
import { handlePaymentProof } from "@/lib/payment-proof/handle";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(request: NextRequest): Promise<Response> {
  return handlePaymentProof(request);
}
