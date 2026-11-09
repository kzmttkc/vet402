#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPayload, INDEXNOW_KEY, parseSitemap, selectUrls } from "./indexnow-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function usage() {
  console.error(`Usage: node scripts/indexnow-submit.mjs [options]
  --all              submit every on-host URL from the sitemap
  --since-days N     include URLs whose lastmod is within N days (default 3)
  --urls a,b,c       explicit URL list (skips sitemap fetch)
  --dry-run          print payload, do not POST
  --host HOST        default vet402.com`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    all: false,
    sinceDays: 3,
    urls: null,
    dryRun: false,
    host: "vet402.com",
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--since-days") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) usage();
      opts.sinceDays = n;
    } else if (arg === "--urls") {
      opts.urls = String(argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--host") {
      opts.host = String(argv[++i] ?? "").trim();
      if (!opts.host) usage();
    } else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return opts;
}

async function assertKeyFile(host) {
  const keyPath = path.join(ROOT, "public", `${INDEXNOW_KEY}.txt`);
  if (!fs.existsSync(keyPath)) {
    console.error(`Missing key file: public/${INDEXNOW_KEY}.txt`);
    process.exit(1);
  }
  const local = fs.readFileSync(keyPath, "utf8").trim();
  if (local !== INDEXNOW_KEY) {
    console.error("Local key file content does not match INDEXNOW_KEY");
    process.exit(1);
  }

  const keyLocation = `https://${host}/${INDEXNOW_KEY}.txt`;
  const res = await fetch(keyLocation);
  const body = (await res.text()).trim();
  if (res.status !== 200 || body !== INDEXNOW_KEY) {
    console.error(
      `Live key check failed: GET ${keyLocation} returned HTTP ${res.status}, body trimmed: ${JSON.stringify(body)}`,
    );
    process.exit(1);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  await assertKeyFile(opts.host);

  let urls;
  if (opts.urls && opts.urls.length > 0) {
    urls = [...new Set(opts.urls)].slice(0, 10_000);
  } else {
    const sitemapUrl = `https://${opts.host}/sitemap.xml`;
    const res = await fetch(sitemapUrl);
    if (!res.ok) {
      console.error(`Failed to fetch sitemap: HTTP ${res.status} from ${sitemapUrl}`);
      process.exit(1);
    }
    const xml = await res.text();
    const entries = parseSitemap(xml);
    urls = selectUrls(entries, {
      all: opts.all,
      sinceDays: opts.sinceDays,
      now: new Date(),
      host: opts.host,
    });
  }

  if (urls.length === 0) {
    console.log("No URLs selected. Nothing to submit.");
    process.exit(0);
  }

  console.log(`URL count: ${urls.length}`);
  for (const u of urls) console.log(u);

  const payload = buildPayload(opts.host, urls);
  if (opts.dryRun) {
    console.log("Dry run. Skipping POST.");
    process.exit(0);
  }

  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (res.status === 200 || res.status === 202) {
    console.log(`IndexNow HTTP ${res.status}`);
    process.exit(0);
  }
  console.error(`IndexNow HTTP ${res.status}`);
  if (text) console.error(text);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
