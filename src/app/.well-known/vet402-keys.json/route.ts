import { NextResponse } from "next/server";
import { getResponseSigningJwks } from "@/lib/signing/response-signature";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getResponseSigningJwks(), {
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}

const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);