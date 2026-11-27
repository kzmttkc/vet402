import { renderErc8004Markdown } from "@/lib/markdown/public-pages";
import { markdownResponse } from "@/lib/markdown/response";

export const revalidate = 600;

export async function GET() {
  return markdownResponse(await renderErc8004Markdown(), 600);
}