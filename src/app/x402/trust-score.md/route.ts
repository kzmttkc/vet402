import { renderTrustScoreMarkdown } from "@/lib/markdown/public-pages";
import { markdownResponse } from "@/lib/markdown/response";

export const revalidate = 300;

export async function GET() {
  return markdownResponse(await renderTrustScoreMarkdown());
}