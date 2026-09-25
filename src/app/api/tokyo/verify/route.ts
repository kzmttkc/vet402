// GET /api/tokyo/verify?name=<ENS name> — 読み取りだけ。ENSIP-29 草案の7段（checkEnsOffer の trace）を JSON で返す。
// 署名器も鍵も無い。/tokyo のページと同じ ../_lib/verify.ts を使う。
import { verifyName } from "../_lib/verify";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name") ?? "";
  const r = await verifyName(name);
  const status = "error" in r ? (r.error === "invalid_name" ? 400 : 503) : 200;
  return Response.json(r, { status, headers: { "Cache-Control": "no-store" } });
}
