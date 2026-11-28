export type Vet402ListingsConfig = {
  version: number;
  paySh: {
    operator: string;
    name: string;
    title: string;
    description: string;
    use_case: string;
    category: string;
    service_url: string;
    operationId: string;
  };
  mcp: {
    registryName: string;
    /** MCP レジストリに出す版（ホストした remote の版で、npm の @vet402/mcp-server の版ではない）。 */
    serverVersion: string;
    title: string;
    description: string;
    repository: { url: string; directory: string };
    websiteUrl: string;
    remote: { type: string; url: string };
    icon: { src: string; mimeType: string; sizes: string[] };
  };
  bazaar: Array<{ operationId: string; pathTemplate: string }>;
  x402Ecosystem: {
    slug: string;
    name: string;
    category: string;
    description: string;
    logoUrl: string;
    websiteUrl: string;
  };
};

export type OpenApiRoot = {
  openapi: string;
  info: {
    title: string;
    version: string;
    "x-vet402-listings"?: Vet402ListingsConfig;
    [key: string]: unknown;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ListingDestination =
  | "openapi"
  | "pay-sh-paymd"
  | "pay-sh-openapi"
  | "mcp-server"
  | "bazaar"
  | "x402-ecosystem";

export type GeneratedListingFiles = Record<ListingDestination, string>;