/** Shared response headers for public page Markdown mirrors. */
export function markdownResponse(body: string, revalidateSeconds = 3600): Response {
  return new Response(body.trimEnd() + "\n", {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": `public, max-age=${revalidateSeconds}`,
    },
  });
}