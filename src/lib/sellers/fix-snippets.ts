// 売り手がそのまま貼る x402 のミドルウェア断片。
// 関数名はインストール済みの export と、同じ世代（2.30.0）の型宣言で確認した。
//   @x402/core/server: HTTPFacilitatorClient, x402ResourceServer
//   @x402/evm/exact/server: ExactEvmScheme
//   @x402/stellar/exact/server: ExactStellarScheme
//   @x402/express と @x402/hono: paymentMiddleware, x402ResourceServer
//   @x402/next: withX402, x402ResourceServer
//   Python（coinbase/x402 の fastapi.py）: payment_middleware, x402ResourceServer,
//   HTTPFacilitatorClient, ExactEvmServerScheme
// 掲載の値だけを埋める。無い値、秘密、環境変数の値は <...> のままにする。
// 断片にセミコロンとダッシュを置かない（公開面の英文の決まり。カードの走査も同じ）。

export const SELLER_FIX_PLACEHOLDER = "<...>";

export const SELLER_FIX_STACKS = [
  { id: "express", title: "Express" },
  { id: "next", title: "Next.js (app router)" },
  { id: "hono", title: "Hono" },
  { id: "fastapi", title: "FastAPI" },
] as const;

export type SellerFixStackId = (typeof SELLER_FIX_STACKS)[number]["id"];

export type SellerFixListing = {
  payTo?: string | null;
  /** 原子単位の整数。 */
  amountAtomic?: string | null;
  /** CAIP-2。 */
  network?: string | null;
  path?: string | null;
  method?: string | null;
};

export type SellerFixSnippet = {
  id: SellerFixStackId;
  title: string;
  code: string;
};

const FACILITATOR_URL = "https://x402.org/facilitator";

type SchemeBits = {
  importTs: string | null;
  ctorTs: string;
  importPy: string | null;
  ctorPy: string;
};

function envValues(): Set<string> {
  const out = new Set<string>();
  for (const value of Object.values(process.env)) {
    if (typeof value === "string" && value.length > 0) out.add(value);
  }
  return out;
}

function looksSecret(value: string): boolean {
  if (value.length > 200) return true;
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return true;
  return /postgres(ql)?:|mysql:|mongodb(\+srv)?:|redis:|sk_live_|sk_test_|BEGIN [A-Z ]*PRIVATE KEY|api_key=|password=/i.test(value);
}

function blocked(value: string, env: Set<string>): boolean {
  return env.has(value) || looksSecret(value);
}

function acceptPayTo(raw: string | null | undefined, env: Set<string>): string {
  if (raw == null) return SELLER_FIX_PLACEHOLDER;
  const value = raw.trim();
  if (value.length === 0 || blocked(value, env)) return SELLER_FIX_PLACEHOLDER;
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return value;
  if (/^G[A-Z2-7]{55}$/.test(value)) return value;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return value;
  return SELLER_FIX_PLACEHOLDER;
}

function acceptAmount(raw: string | null | undefined, env: Set<string>): string {
  if (raw == null) return SELLER_FIX_PLACEHOLDER;
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value) || value.length > 30 || blocked(value, env)) return SELLER_FIX_PLACEHOLDER;
  return value;
}

function acceptNetwork(raw: string | null | undefined, env: Set<string>): string {
  if (raw == null) return SELLER_FIX_PLACEHOLDER;
  const value = raw.trim();
  if (blocked(value, env)) return SELLER_FIX_PLACEHOLDER;
  if (!/^[a-z0-9]{2,32}:[A-Za-z0-9._-]{1,64}$/.test(value)) return SELLER_FIX_PLACEHOLDER;
  return value;
}

function acceptPath(raw: string | null | undefined, env: Set<string>): string {
  if (raw == null) return SELLER_FIX_PLACEHOLDER;
  const value = raw.trim();
  if (blocked(value, env) || value.includes("--")) return SELLER_FIX_PLACEHOLDER;
  if (!/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(value)) return SELLER_FIX_PLACEHOLDER;
  return value;
}

function acceptMethod(raw: string | null | undefined, env: Set<string>): string | null {
  if (raw == null) return null;
  const value = raw.trim().toUpperCase();
  if (blocked(raw.trim(), env) || blocked(value, env)) return null;
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(value)) return null;
  return value;
}

function schemeFor(network: string): SchemeBits {
  // 網が無い頁は Base の掲載なので、確認済みの EVM の scheme を出す。
  if (network === SELLER_FIX_PLACEHOLDER || network.startsWith("eip155:")) {
    return {
      importTs: `import { ExactEvmScheme } from "@x402/evm/exact/server"`,
      ctorTs: `new ExactEvmScheme()`,
      importPy: `from x402.mechanisms.evm.exact import ExactEvmServerScheme`,
      ctorPy: `ExactEvmServerScheme()`,
    };
  }
  if (network.startsWith("stellar:")) {
    return {
      importTs: `import { ExactStellarScheme } from "@x402/stellar/exact/server"`,
      ctorTs: `new ExactStellarScheme()`,
      importPy: null,
      ctorPy: SELLER_FIX_PLACEHOLDER,
    };
  }
  return { importTs: null, ctorTs: `new ${SELLER_FIX_PLACEHOLDER}()`, importPy: null, ctorPy: SELLER_FIX_PLACEHOLDER };
}

function q(value: string): string {
  return `"${value}"`;
}

function routeKey(method: string | null, path: string): string {
  if (path === SELLER_FIX_PLACEHOLDER && method === null) return SELLER_FIX_PLACEHOLDER;
  if (method && path !== SELLER_FIX_PLACEHOLDER) return `${method} ${path}`;
  if (method) return `${method} ${SELLER_FIX_PLACEHOLDER}`;
  return path;
}

function acceptsBlock(payTo: string, amount: string, network: string, indent: string): string[] {
  return [
    `${indent}scheme: "exact",`,
    `${indent}payTo: ${q(payTo)},`,
    `${indent}price: { amount: ${q(amount)}, asset: ${q(SELLER_FIX_PLACEHOLDER)} },`,
    `${indent}network: ${q(network)},`,
  ];
}

function expressLike(pkg: string, route: string, payTo: string, amount: string, network: string, scheme: SchemeBits): string {
  const lines = [`import { paymentMiddleware, x402ResourceServer } from ${q(pkg)}`];
  if (scheme.importTs) lines.push(scheme.importTs);
  lines.push(`import { HTTPFacilitatorClient } from "@x402/core/server"`);
  lines.push("");
  lines.push(`const facilitatorClient = new HTTPFacilitatorClient({ url: ${q(FACILITATOR_URL)} })`);
  lines.push(`const server = new x402ResourceServer(facilitatorClient).register(${q(network)}, ${scheme.ctorTs})`);
  lines.push("");
  lines.push("app.use(");
  lines.push("  paymentMiddleware(");
  lines.push("    {");
  lines.push(`      ${q(route)}: {`);
  lines.push("        accepts: {");
  lines.push(...acceptsBlock(payTo, amount, network, "          "));
  lines.push("        },");
  lines.push("      },");
  lines.push("    },");
  lines.push("    server,");
  lines.push("  ),");
  lines.push(")");
  return lines.join("\n");
}

function nextSnippet(route: string, method: string | null, payTo: string, amount: string, network: string, scheme: SchemeBits): string {
  const exportName = method ?? SELLER_FIX_PLACEHOLDER;
  const lines = [`import { withX402, x402ResourceServer } from "@x402/next"`];
  if (scheme.importTs) lines.push(scheme.importTs);
  lines.push(`import { HTTPFacilitatorClient } from "@x402/core/server"`);
  lines.push(`import { NextRequest, NextResponse } from "next/server"`);
  lines.push("");
  lines.push(`const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: ${q(FACILITATOR_URL)} })).register(${q(network)}, ${scheme.ctorTs})`);
  lines.push("");
  lines.push("const handler = async (request: NextRequest) => {");
  lines.push("  return NextResponse.json({ ok: true })");
  lines.push("}");
  lines.push("");
  lines.push(`export const ${exportName} = withX402(`);
  lines.push("  handler,");
  lines.push("  {");
  lines.push(`    ${q(route)}: {`);
  lines.push("      accepts: {");
  lines.push(...acceptsBlock(payTo, amount, network, "        "));
  lines.push("      },");
  lines.push("    },");
  lines.push("  },");
  lines.push("  server,");
  lines.push(")");
  return lines.join("\n");
}

function pythonAccepts(payTo: string, amount: string, network: string, indent: string): string[] {
  return [
    `${indent}"scheme": "exact",`,
    `${indent}"payTo": ${q(payTo)},`,
    `${indent}"price": {"amount": ${q(amount)}, "asset": ${q(SELLER_FIX_PLACEHOLDER)}},`,
    `${indent}"network": ${q(network)},`,
  ];
}

function fastapiSnippet(route: string, payTo: string, amount: string, network: string, scheme: SchemeBits): string {
  const lines = [
    "from fastapi import FastAPI",
    "from x402 import x402ResourceServer",
    "from x402.http import HTTPFacilitatorClient",
    "from x402.http.middleware.fastapi import payment_middleware",
  ];
  if (scheme.importPy) lines.push(scheme.importPy);
  lines.push("");
  lines.push("app = FastAPI()");
  lines.push("facilitator = HTTPFacilitatorClient()");
  lines.push("server = x402ResourceServer(facilitator)");
  lines.push(`server.register(${q(network)}, ${scheme.ctorPy})`);
  lines.push("");
  lines.push("routes = {");
  lines.push(`    ${q(route)}: {`);
  lines.push(`        "accepts": {`);
  lines.push(...pythonAccepts(payTo, amount, network, "            "));
  lines.push("        },");
  lines.push("    },");
  lines.push("}");
  lines.push("");
  lines.push(`@app.middleware("http")`);
  lines.push("async def x402_middleware(request, call_next):");
  lines.push("    return await payment_middleware(routes, server)(request, call_next)");
  return lines.join("\n");
}

/** 掲載の resource URL から経路だけを取る。クエリと userinfo は捨てる。 */
export function sellerFixListingFrom(source: {
  resourceUrl?: string | null;
  priceAmount?: string | null;
  method?: string | null;
  declaredPayTo?: string | null;
  declaredAmount?: string | null;
  network?: string | null;
}): SellerFixListing {
  return {
    payTo: source.declaredPayTo ?? null,
    amountAtomic: firstText(source.priceAmount, source.declaredAmount),
    network: source.network ?? null,
    path: pathOfListing(source.resourceUrl),
    method: source.method ?? null,
  };
}

function firstText(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function pathOfListing(resourceUrl: string | null | undefined): string | null {
  if (typeof resourceUrl !== "string") return null;
  const trimmed = resourceUrl.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.pathname.length > 0 ? url.pathname : null;
  } catch {
    const bare = trimmed.split("?")[0]?.split("#")[0] ?? "";
    return bare.startsWith("/") ? bare : null;
  }
}

export function sellerFixSnippets(listing: SellerFixListing = {}): SellerFixSnippet[] {
  const env = envValues();
  const payTo = acceptPayTo(listing.payTo, env);
  const amount = acceptAmount(listing.amountAtomic, env);
  const network = acceptNetwork(listing.network, env);
  const path = acceptPath(listing.path, env);
  const method = acceptMethod(listing.method, env);
  const route = routeKey(method, path);
  const scheme = schemeFor(network);
  const nextRoute = path;
  return [
    { id: "express", title: "Express", code: expressLike("@x402/express", route, payTo, amount, network, scheme) },
    { id: "next", title: "Next.js (app router)", code: nextSnippet(nextRoute, method, payTo, amount, network, scheme) },
    { id: "hono", title: "Hono", code: expressLike("@x402/hono", route, payTo, amount, network, scheme) },
    { id: "fastapi", title: "FastAPI", code: fastapiSnippet(route, payTo, amount, network, scheme) },
  ];
}
