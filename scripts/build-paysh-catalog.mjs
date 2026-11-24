#!/usr/bin/env node
/**
 * purchase_plan.csv + catalog_l0.csv → pay-skills-listings-data.ts, pay-skills-pinned-data.ts, paysh_excluded.csv
 * Reads only; writes under worktree + one external excluded CSV.
 */
import { createReadStream, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN = "/Users/takeshi/Takeshi_Automation/output/1124/solana_ai/work/p3/purchase_plan.csv";
const L0 = "/Users/takeshi/Takeshi_Automation/output/1124/solana_ai/work/p2/catalog_l0.csv";
const EXCLUDED_OUT = "/Users/takeshi/Takeshi_Automation/output/1124/moat/paysh_excluded.csv";
const OPENAPI_DIR = "/Users/takeshi/Takeshi_Automation/output/1124/solana_ai/raw/openapi";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Path segments that indicate mutating / outbound actions (not nouns like wallet, transfer). */
const KEYWORDS = [
  "book",
  "order",
  "send",
  "email",
  "mail",
  "sms",
  "post",
  "create",
  "signup",
  "register",
  "reserve",
  "withdraw",
  "swap",
  "execute",
  "trade",
  "pods",
];

function segmentMatchesKeyword(seg, kw) {
  if (seg === kw) return true;
  if (kw === "execute" && seg.startsWith("execute-")) return true;
  if (kw === "trade" || kw === "swap") return false;
  if (seg.startsWith(`${kw}-`)) return true;
  if (kw === "order" && (seg === "orders" || seg.startsWith("orders-"))) return true;
  if (
    (kw === "create" || kw === "signup" || kw === "register") &&
    seg.startsWith(kw) &&
    seg.length > kw.length
  ) {
    return true;
  }
  return false;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function readCsv(path) {
  const rows = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let headers = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (!headers) {
      headers = cols;
      continue;
    }
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function segments(provider, endpoint) {
  const s = [];
  for (const part of provider.split("/")) if (part) s.push(part.toLowerCase());
  for (const part of endpoint.split("/")) if (part) s.push(part.toLowerCase());
  return s;
}

function excludeReason(provider, endpoint) {
  const segs = segments(provider, endpoint);
  const ep = endpoint.toLowerCase();
  for (const kw of KEYWORDS) {
    for (const seg of segs) {
      if (segmentMatchesKeyword(seg, kw)) return `keyword:${kw}`;
    }
  }
  if (/(?:^|\/)pay(?:\/|$)/.test(ep)) return "keyword:pay";
  for (const seg of segs) {
    if (seg.startsWith("close-")) return "keyword:close-";
  }
  return null;
}

function usdToUnits(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = Math.round(n * 1_000_000);
  return u > 0 ? String(u) : null;
}

function pickL0Row(l0map, key) {
  const candidates = l0map.get(key);
  if (!candidates?.length) return null;
  const sol = candidates.find((r) => r.network === SOLANA_MAINNET && r.status === "pass");
  if (sol) return sol;
  const pass = candidates.find((r) => r.status === "pass" && r.network.startsWith("eip155:"));
  return pass ?? candidates.find((r) => r.status === "pass") ?? null;
}

function loadOpenapiBodies() {
  const bodies = new Map();
  if (!existsSync(OPENAPI_DIR)) return bodies;
  for (const f of readdirSync(OPENAPI_DIR)) {
    if (!f.endsWith(".json")) continue;
    const provider = f.replace(/^providers_/, "").replace(/_openapi\.json$/, "").replace(/_/g, "/");
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(OPENAPI_DIR, f), "utf8"));
    } catch {
      continue;
    }
    const paths = spec.paths ?? {};
    for (const [path, item] of Object.entries(paths)) {
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const op = item[method];
        if (!op) continue;
        const rb = op.requestBody;
        if (!rb) continue;
        const content = rb.content ?? {};
        const media = content["application/json"] ?? content["*/*"];
        if (!media) continue;
        let example = media.example ?? media.schema?.example;
        if (example === undefined && media.schema?.$ref) {
          const ref = media.schema.$ref.split("/").pop();
          example = spec.components?.schemas?.[ref]?.example;
        }
        if (example !== undefined) {
          const k = `${provider}\t${method.toUpperCase()}\t${path}`;
          try {
            bodies.set(k, JSON.stringify(example));
          } catch {
            /* skip */
          }
        }
      }
    }
  }
  return bodies;
}

function esc(s) {
  return JSON.stringify(s);
}

async function main() {
  const plan = await readCsv(PLAN);
  const l0rows = await readCsv(L0);
  const l0map = new Map();
  for (const r of l0rows) {
    const key = `${r.provider_fqn}\t${r.method.toUpperCase()}\t${r.endpoint}\t${r.host}`;
    const arr = l0map.get(key) ?? [];
    arr.push(r);
    l0map.set(key, arr);
  }
  const openapiBodies = loadOpenapiBodies();

  const excluded = [];
  const listings = [];
  const pinned = [];

  const PIN = {
    reason: "presign-gate-2611",
    from: "2026-11-26T00:00:00.000Z",
    to: "2026-12-07T23:59:59.999Z",
    requestedBy: "solana-paysh special session (pay.sh catalog delivery report)",
    approvedAt: "2026-11-23T23:25:00.000Z",
    maxPurchases: 1,
  };

  for (const row of plan) {
    const { order, tranche, provider_fqn, host, endpoint, method, quoted_usd, cumulative_usd } = row;
    const reason = excludeReason(provider_fqn, endpoint);
    if (reason) {
      excluded.push({ ...row, reason });
      continue;
    }
    const l0 = pickL0Row(l0map, `${provider_fqn}\t${method.toUpperCase()}\t${endpoint}\t${host}`);
    if (!l0) {
      excluded.push({ ...row, reason: "no_l0_match" });
      continue;
    }
    const amount = usdToUnits(l0.quoted_usd || quoted_usd);
    if (!amount) {
      excluded.push({ ...row, reason: "zero_price" });
      continue;
    }
    const url = `https://${host}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    let exampleBody;
    if (method.toUpperCase() === "POST") {
      const ok =
        openapiBodies.get(`${provider_fqn}\tPOST\t${endpoint}`) ??
        openapiBodies.get(`${provider_fqn}\tPOST\t${endpoint.replace(/\/$/, "")}`);
      exampleBody = ok ?? "{}";
    }
    const network = l0.network.split(";")[0].trim() || l0.network;
    const listing = {
      url,
      method: method.toUpperCase(),
      network,
      payTo: l0.pay_to,
      asset: l0.asset.split(";")[0].trim() || USDC_MINT,
      amount,
      reason: `pay.sh catalog (solana-foundation/pay-skills) order ${order}`,
      addedOn: "2026-11-24",
      catalogOrder: Number(order),
      ...(exampleBody !== undefined ? { exampleBody } : {}),
    };
    listings.push(listing);
    pinned.push({
      url,
      method: method.toUpperCase(),
      ...PIN,
    });
  }

  listings.sort((a, b) => a.catalogOrder - b.catalogOrder);
  {
    const seenUrl = new Set();
    const drop = new Set();
    for (const l of listings) {
      if (seenUrl.has(l.url)) {
        drop.add(l.url + "\0" + l.method + "\0" + l.catalogOrder);
        excluded.push({
          order: String(l.catalogOrder),
          tranche: "",
          provider_fqn: "",
          host: new URL(l.url).host,
          endpoint: new URL(l.url).pathname,
          method: l.method,
          quoted_usd: "",
          cumulative_usd: "",
          reason: "duplicate_url",
        });
      } else seenUrl.add(l.url);
    }
    const filt = [];
    const seen2 = new Set();
    for (const l of listings) {
      if (seen2.has(l.url)) continue;
      seen2.add(l.url);
      filt.push(l);
    }
    listings.length = 0;
    listings.push(...filt);
  }
  pinned.length = 0;
  for (const l of listings) {
    pinned.push({
      url: l.url,
      method: l.method,
      ...PIN,
    });
  }

  const exHeader = "order,tranche,provider_fqn,host,endpoint,method,quoted_usd,cumulative_usd,reason\n";
  const exLines = excluded.map((r) =>
  [
    r.order,
    r.tranche,
    r.provider_fqn,
    r.host,
    JSON.stringify(r.endpoint).slice(1, -1),
    r.method,
    r.quoted_usd,
    r.cumulative_usd,
    r.reason,
  ].join(","),
);
  writeFileSync(EXCLUDED_OUT, exHeader + exLines.join("\n") + (exLines.length ? "\n" : ""));

  const listingsTs =
    `// AUTO-GENERATED by scripts/build-paysh-catalog.mjs — do not edit by hand.\n` +
    `import type { PaySkillsListing } from "./pay-skills-listings";\n\n` +
    `export const PAY_SKILLS_LISTINGS: readonly PaySkillsListing[] = [\n` +
    listings
      .map((l) => {
        const parts = [
          `  {`,
          `    url: ${esc(l.url)},`,
          `    method: ${esc(l.method)},`,
          `    network: ${esc(l.network)},`,
          `    payTo: ${esc(l.payTo)},`,
          `    asset: ${esc(l.asset)},`,
          `    amount: ${esc(l.amount)},`,
          l.exampleBody !== undefined ? `    exampleBody: ${esc(l.exampleBody)},` : null,
          `    reason: ${esc(l.reason)},`,
          `    addedOn: ${esc(l.addedOn)},`,
          `    catalogOrder: ${l.catalogOrder},`,
          `  },`,
        ]
          .filter(Boolean)
          .join("\n");
        return parts;
      })
      .join("\n") +
    `\n];\n`;

  const pinnedTs =
    `// AUTO-GENERATED by scripts/build-paysh-catalog.mjs — do not edit by hand.\n` +
    `import type { PinnedPurchase } from "./pinned-purchases";\n\n` +
    `export const PAYSH_PINNED_PURCHASES: readonly PinnedPurchase[] = [\n` +
    pinned
      .map(
        (p) =>
          `  { url: ${esc(p.url)}, method: ${esc(p.method)}, from: ${esc(p.from)}, to: ${esc(p.to)}, reason: ${esc(p.reason)}, requestedBy: ${esc(p.requestedBy)}, approvedAt: ${esc(p.approvedAt)}, maxPurchases: ${p.maxPurchases} },`,
      )
      .join("\n") +
    `\n];\n`;

  writeFileSync(join(ROOT, "src/lib/observatory/pay-skills-listings-data.ts"), listingsTs);
  writeFileSync(join(ROOT, "src/lib/observatory/pay-skills-pinned-data.ts"), pinnedTs);

  console.log(
    JSON.stringify({
      plan: plan.length,
      excluded: excluded.length,
      listings: listings.length,
      pinned: pinned.length,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});