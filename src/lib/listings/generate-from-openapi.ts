import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PAY_TO,
  PRICE_ATOMIC,
  USDC,
  X402_NETWORK,
  bazaarInfo,
  bazaarSchema,
  paymentRequired,
  paymentRequirements,
} from "@/lib/x402/base-usdc";
import { stableStringify } from "./stable-json";
import { listingsConfig } from "./load-openapi";
import type { OpenApiRoot } from "./types";
import type { GeneratedListingFiles, ListingDestination } from "./types";

function productionServer(spec: OpenApiRoot): string {
  const prod = spec.servers?.find((s) => /vet402\.com/i.test(s.url));
  return prod?.url?.replace(/\/$/, "") ?? "https://vet402.com";
}

function operationById(spec: OpenApiRoot, operationId: string) {
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (method === "parameters") continue;
      const operation = op as { operationId?: string };
      if (operation.operationId === operationId) {
        return { path, method: method.toUpperCase(), operation: op as Record<string, unknown> };
      }
    }
  }
  throw new Error(`operationId not found in openapi: ${operationId}`);
}

function paySkillsOpenApiSubset(spec: OpenApiRoot, operationId: string): Record<string, unknown> {
  const hit = operationById(spec, operationId);
  return {
    openapi: spec.openapi,
    info: {
      title: spec.info.title,
      version: spec.info.version,
    },
    servers: [{ url: productionServer(spec) }],
    paths: {
      [hit.path]: {
        [hit.method.toLowerCase()]: hit.operation,
      },
    },
  };
}

function payShPayMd(spec: OpenApiRoot): string {
  const cfg = listingsConfig(spec);
  const p = cfg.paySh;
  const frontmatter = {
    name: p.name,
    title: p.title,
    description: p.description,
    use_case: p.use_case,
    category: p.category,
    service_url: p.service_url,
    openapi: { path: "openapi.json" },
  };
  const lines = ["---", ...Object.entries(frontmatter).flatMap(formatYamlEntry), "---", ""];
  lines.push(
    "Paid x402 lane for vet402 RWA facts. Settlement is USDC on Base via the Coinbase CDP facilitator.",
    "The 402 includes `extensions.bazaar` for CDP Bazaar discovery.",
    "Full API reference for every public route lives at https://vet402.com/openapi.json.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function formatYamlEntry([key, value]: [string, unknown]): string[] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return [key + ":", ...Object.entries(obj).map(([k, v]) => `  ${k}: ${yamlScalar(v)}`)];
  }
  return [`${key}: ${yamlScalar(value)}`];
}

function yamlScalar(value: unknown): string {
  if (typeof value === "string") {
    if (value.includes("\n") || value.includes(":") || value.includes("'")) {
      return `>-\n    ${value.replace(/\n/g, "\n    ")}`;
    }
    return `'${value.replace(/'/g, "''")}'`;
  }
  return String(value);
}

function mcpServerJson(spec: OpenApiRoot, root: string): Record<string, unknown> {
  const cfg = listingsConfig(spec).mcp;
  const pkg = JSON.parse(readFileSync(join(root, "packages", "mcp-server", "package.json"), "utf8")) as {
    version: string;
  };
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: cfg.registryName,
    title: cfg.title,
    description: cfg.description,
    repository: { url: cfg.repository.url, source: "github", directory: cfg.repository.directory },
    version: pkg.version,
    websiteUrl: cfg.websiteUrl,
    icons: [cfg.icon],
    remotes: [cfg.remote],
  };
}

function bazaarDeclaration(spec: OpenApiRoot): Record<string, unknown> {
  const cfg = listingsConfig(spec);
  const base = productionServer(spec);
  const declarations = cfg.bazaar.map((row) => {
    const op = operationById(spec, row.operationId);
    const sampleAddress = "0xE9B08727131E34010b34006c660D4c1B436EC25f";
    const resourceUrl = `${base}${row.pathTemplate.replace("{address}", sampleAddress)}`;
    const terms = paymentRequired(resourceUrl);
    return {
      operationId: row.operationId,
      path: row.pathTemplate,
      method: op.method,
      resourceUrl,
      accepts: [paymentRequirements()],
      payTo: PAY_TO,
      amount: PRICE_ATOMIC,
      asset: USDC,
      network: X402_NETWORK,
      extensions: {
        bazaar: {
          info: bazaarInfo(),
          schema: bazaarSchema(),
        },
      },
      paymentRequired402: terms,
    };
  });
  return { generatedFrom: "openapi.info.x-vet402-listings", declarations };
}

function x402EcosystemMetadata(spec: OpenApiRoot): Record<string, unknown> {
  const e = listingsConfig(spec).x402Ecosystem;
  return {
    name: e.name,
    description: e.description,
    logoUrl: e.logoUrl,
    websiteUrl: e.websiteUrl,
    category: e.category,
  };
}

export function generateListingFiles(spec: OpenApiRoot, root: string = process.cwd()): GeneratedListingFiles {
  const payCfg = listingsConfig(spec).paySh;
  const payOpenApi = paySkillsOpenApiSubset(spec, payCfg.operationId);
  return {
    openapi: stableStringify(spec, 2) + "\n",
    "pay-sh-paymd": payShPayMd(spec),
    "pay-sh-openapi": stableStringify(payOpenApi, 2) + "\n",
    "mcp-server": stableStringify(mcpServerJson(spec, root), 2) + "\n",
    bazaar: stableStringify(bazaarDeclaration(spec), 2) + "\n",
    "x402-ecosystem": stableStringify(x402EcosystemMetadata(spec), 2) + "\n",
  };
}

export const LISTING_OUTPUT_PATHS: Record<ListingDestination, string> = {
  openapi: "data/listings/openapi.json",
  "pay-sh-paymd": "data/listings/pay-sh/PAY.md",
  "pay-sh-openapi": "data/listings/pay-sh/openapi.json",
  "mcp-server": "data/listings/mcp/server.json",
  bazaar: "data/listings/bazaar/declarations.json",
  "x402-ecosystem": "data/listings/x402-ecosystem/metadata.json",
};

export const LISTING_DESTINATION_LABELS: Record<ListingDestination, string> = {
  openapi: "openapi.json",
  "pay-sh-paymd": "pay.sh PAY.md",
  "pay-sh-openapi": "pay.sh openapi.json",
  "mcp-server": "MCP server.json",
  bazaar: "bazaar",
  "x402-ecosystem": "x402.org metadata.json",
};