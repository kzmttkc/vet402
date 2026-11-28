import { renderTrustScoreMarkdown } from "@/lib/markdown/public-pages";
import { markdownResponse } from "@/lib/markdown/response";

export const dynamic = "force-static";

export async function GET() {
  return markdownResponse(await renderTrustScoreMarkdown());
}