// /connect: the entry that picks a side. Every snippet is copied from a package
// README or the code it names (tests/connect-page.test.ts checks each package
// name and each vet402.com path against this repo). A stack with no real call
// today is left out, not invented.
//   curl / No-code: src/app/api/v1/resolve/route.ts, src/app/api/v1/resources/[resourceId]/decision/route.ts
//   TypeScript: packages/vet402/README.md (check, vet402/buyer payOrRefuse), vet402 0.1.0 on npm
//   Python: plain HTTP (httpx) on the two routes. vet402-sdk is not on PyPI.
//   MCP: src/lib/docs/mcp-page-text.ts (Cursor), src/app/docs/mcp/page.tsx (Claude Code, Claude Desktop, Claude.ai)
//   Express / Next.js / Hono: packages/middleware/README.md
// Public English: no we / our / us, no semicolons, no dashes.
import { MCP_DOCS_CONNECT_CURSOR } from "@/lib/docs/mcp-page-text";

export const CONNECT_LEAD = "Put vet402 between AI agents. Both sides trade safely.";

export const CONNECT_SIGNUP_HREF = "/signup";

export type ConnectStack = {
  stack: string;
  /** Short line above the code: where it goes or what it installs. */
  intro: string;
  code: string;
  /** Packages the code installs or imports, by their name in this repo. */
  packages: string[];
};

export type ConnectChoice = {
  id: "buy" | "sell" | "both";
  label: string;
  summary: string;
  steps: [string, string, string];
  stacks: ConnectStack[];
  /** Tabs this choice points to instead of repeating their snippets. */
  switchTo?: ConnectChoice["id"][];
  note?: string;
};

const SAMPLE_URL = "https://api.example.com/v1/quote";

const BUY: ConnectStack[] = [
  {
    stack: "curl",
    intro:
      "Look up the URL, then read the decision for its resource_id. Needs jq. Works without a key at 10 requests a minute. When RESOURCE_ID is null, vet402 has no record of the URL.",
    code: [
      `RESOURCE_ID=$(curl -s --get --data-urlencode "q=${SAMPLE_URL}" https://vet402.com/api/v1/resolve | jq -r .resource.resource_id)`,
      `curl -s "https://vet402.com/api/v1/resources/$RESOURCE_ID/decision?role=payer"`,
    ].join("\n"),
    packages: [],
  },
  {
    stack: "TypeScript",
    intro: "npm install vet402 (and viem for an EVM signer). check reads what vet402 saw when it paid the URL. payOrRefuse pays after the checks pass.",
    code: [
      `import { check } from "vet402";`,
      `import { payOrRefuse } from "vet402/buyer";`,
      ``,
      `const payee = "0x..."; // the payTo in the seller's 402`,
      `const account = yourSigner; // a signer, see the payOrRefuse section of the @vet402/sdk README`,
      `const r = await check("${SAMPLE_URL}");`,
      `if (r.recommendation === "ALLOW") {`,
      `  const paid = await payOrRefuse({ payee, resource: "${SAMPLE_URL}", amountUsd: 0.01, fetch, account, network: "base-sepolia" });`,
      `}`,
    ].join("\n"),
    packages: ["vet402"],
  },
  {
    stack: "Python",
    intro: "pip install httpx. No key needed at 10 requests a minute.",
    code: [
      `import httpx`,
      `url = "${SAMPLE_URL}"`,
      `found = httpx.get("https://vet402.com/api/v1/resolve", params={"q": url}).json()`,
      `resource = found.get("resource") or {}`,
      `resource_id = resource.get("resource_id")`,
      `if resource_id:`,
      `    d = httpx.get(f"https://vet402.com/api/v1/resources/{resource_id}/decision", params={"role": "payer"}).json()`,
      `    print(d["recommendation"], d["reason_codes"])`,
    ].join("\n"),
    packages: [],
  },
  {
    stack: "MCP",
    intro:
      "Cursor: put this line in .cursor/mcp.json. Claude Code: claude mcp add --transport http vet402 https://vet402.com/mcp. Claude Desktop and Claude.ai add a custom connector in Settings, Connectors with the URL https://vet402.com/mcp. No key.",
    code: MCP_DOCS_CONNECT_CURSOR,
    packages: [],
  },
  {
    stack: "No-code",
    intro: "n8n: two HTTP Request nodes with method GET. The second takes resource.resource_id from the first. Stop when resource is missing.",
    code: [
      `GET https://vet402.com/api/v1/resolve?q={{encodeURIComponent($json.url)}}`,
      `GET https://vet402.com/api/v1/resources/{{$json.resource.resource_id}}/decision?role=payer`,
    ].join("\n"),
    packages: [],
  },
];

const SELL: ConnectStack[] = [
  {
    stack: "Express",
    intro: "npm install @vet402/middleware. Mount it after x402 verification so req.payer is set.",
    code: [
      `import { createExpressGate } from "@vet402/middleware/express";`,
      ``,
      `app.use("/api/paid", createExpressGate({`,
      `  apiUrl: process.env.VOUCH_API_URL!,   // https://vet402.com/api/v1`,
      `  apiKey: process.env.VOUCH_API_KEY!,`,
      `  getAddress: (req) => req.payer,`,
      `}));`,
    ].join("\n"),
    packages: ["@vet402/middleware"],
  },
  {
    stack: "Hono",
    intro: "npm install @vet402/middleware",
    code: [
      `import { createHonoGate } from "@vet402/middleware/hono";`,
      ``,
      `app.use("/api/paid/*", createHonoGate({`,
      `  apiUrl: process.env.VOUCH_API_URL!,`,
      `  apiKey: process.env.VOUCH_API_KEY!,`,
      `  getAddress: (c) => c.get("payer"),`,
      `}));`,
    ].join("\n"),
    packages: ["@vet402/middleware"],
  },
  {
    stack: "Next.js",
    intro: "npm install @vet402/middleware. App Router route handler.",
    code: [
      `import { withVouchGate } from "@vet402/middleware/next";`,
      ``,
      `export const POST = withVouchGate(`,
      `  {`,
      `    apiUrl: process.env.VOUCH_API_URL!,`,
      `    apiKey: process.env.VOUCH_API_KEY!,`,
      `    getAddress: (req) => new URL(req.url).searchParams.get("payer") ?? undefined,`,
      `  },`,
      `  async (req, trust) => Response.json({ ok: true, trust }),`,
      `);`,
    ].join("\n"),
    packages: ["@vet402/middleware"],
  },
];

export const CONNECT_CHOICES: ConnectChoice[] = [
  {
    id: "buy",
    label: "I buy",
    summary: "Your agent pays x402 sellers. Read what vet402 saw when it paid the same URL before your agent signs.",
    steps: [
      "A free API key. Reads of a decision also work without one at 10 requests a minute.",
      "Pick your stack below.",
      "Copy the snippet into your agent.",
    ],
    stacks: BUY,
  },
  {
    id: "sell",
    label: "I sell",
    summary: "Your API takes x402 payments. Check the paying wallet before the payment settles.",
    steps: ["A free API key. The seller gate needs one.", "Pick your stack below.", "Copy the snippet into your server."],
    stacks: SELL,
  },
  {
    id: "both",
    label: "Both",
    summary: "Use the I buy snippet on the way out and the I sell snippet on the way in.",
    steps: [
      "A free API key. One key works for both sides.",
      "Pick a stack under I buy and under I sell.",
      "Copy the snippet into each side.",
    ],
    stacks: [],
    switchTo: ["buy", "sell"],
    note:
      "The two sides read different things today. The buyer lines read vet402's record for the seller's URL, built from probes and from purchases vet402 made. The seller gate reads a score for the paying wallet. The record page for the URL lists the transaction hash of each settled purchase, and /api/v1/resolve?q=<tx hash> finds a recent settlement and the URL it paid for.",
  },
];
