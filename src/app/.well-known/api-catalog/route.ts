// ============================================================
// /.well-known/api-catalog (RFC 9727, 2026-11-27 SEO/AEO/LLMO).
// Static linkset: public API, OpenAPI, human docs, MCP and key read routes.
// ============================================================
import { SITE_URL } from "@/lib/site-url";

export const dynamic = "force-static";

export function GET() {
  const body = {
    linkset: [
      {
        anchor: `${SITE_URL}/api/v1`,
        "service-desc": [
          { href: `${SITE_URL}/openapi.json`, type: "application/json" },
          { href: `${SITE_URL}/openapi.yaml`, type: "application/yaml" },
        ],
        "service-doc": [{ href: `${SITE_URL}/docs/api`, type: "text/html" }],
        status: [{ href: `${SITE_URL}/api/v1/health`, type: "application/json" }],
      },
      {
        anchor: `${SITE_URL}/api/v1/check`,
        "service-desc": [
          { href: `${SITE_URL}/openapi.json`, type: "application/json" },
        ],
        "service-doc": [
          { href: `${SITE_URL}/docs/api`, type: "text/html" },
          { href: `${SITE_URL}/x402/check-a-seller.md`, type: "text/markdown" },
        ],
      },
      {
        anchor: `${SITE_URL}/api/v1/observatory/state`,
        "service-desc": [
          { href: `${SITE_URL}/openapi.json`, type: "application/json" },
        ],
        "service-doc": [
          { href: `${SITE_URL}/observatory/state`, type: "text/html" },
          { href: `${SITE_URL}/x402/statistics.md`, type: "text/markdown" },
        ],
      },
      {
        anchor: `${SITE_URL}/mcp`,
        "service-doc": [{ href: `${SITE_URL}/docs/mcp`, type: "text/html" }],
      },
    ],
  };
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    headers: {
      "Content-Type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
      "Cache-Control": "public, max-age=86400",
    },
  });
}