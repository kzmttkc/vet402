// ローカルの next start に対して、sitemap.xml の全 URL が 200 であることと、
// 出した JSON-LD が壊れておらず schema.org の必須項目を持つことを確かめる。
// BASE_URL の既定は http://127.0.0.1:3456。
const base = (process.env.BASE_URL ?? "http://127.0.0.1:3456").replace(/\/$/, "");

const REQUIRED = {
  Organization: ["name", "url"],
  WebSite: ["name", "url"],
  SoftwareApplication: ["name"],
  FAQPage: ["mainEntity"],
  BreadcrumbList: ["itemListElement"],
  WebAPI: ["name", "url"],
  Dataset: ["name", "description", "license", "distribution"],
  Article: ["headline"],
  BlogPosting: ["headline"],
  TechArticle: ["headline"],
  WebPage: ["name", "url"],
  ItemList: ["itemListElement"],
  HowTo: ["name", "step"],
};

const EXPECT = {
  "/": ["Organization", "WebSite", "SoftwareApplication"],
  "/faq": ["FAQPage", "BreadcrumbList"],
  "/docs/api": ["WebAPI", "BreadcrumbList", "TechArticle"],
  "/observatory/state": ["Dataset", "BreadcrumbList"],
  "/impact": ["Dataset", "BreadcrumbList"],
  "/blog/what-is-x402": ["BlogPosting", "BreadcrumbList"],
  "/x402/stablecoin-payments": ["Article", "BreadcrumbList"],
  "/x402/check-a-seller": ["Article", "BreadcrumbList"],
  "/x402/chains": ["Article", "BreadcrumbList"],
  "/x402/chains/base": ["Article", "BreadcrumbList"],
};

function locs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

function typesOf(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) typesOf(item, out);
    return;
  }
  const raw = node["@type"];
  const types = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const type of types) {
    out.push(type);
    const need = REQUIRED[type];
    if (!need) continue;
    for (const key of need) {
      if (node[key] == null || node[key] === "") {
        throw new Error(`${type} に ${key} が無い`);
      }
    }
    if (type === "Dataset") {
      const dist = Array.isArray(node.distribution) ? node.distribution : [node.distribution];
      if (dist.length === 0) throw new Error("Dataset の distribution が空");
      for (const row of dist) {
        if (!row?.contentUrl) throw new Error("Dataset distribution に contentUrl が無い");
      }
      const license = String(node.license ?? "");
      if (!license.startsWith("https://creativecommons.org/licenses/by/4.0")) {
        throw new Error(`Dataset の license が CC BY 4.0 ではない: ${license}`);
      }
    }
  }
  const context = node["@context"];
  if (types.length > 0) {
    const ctx = typeof context === "string" ? context : context?.["@vocab"] ?? "";
    if (!String(ctx).includes("schema.org")) throw new Error(`@context が schema.org ではない: ${ctx}`);
  }
}

async function get(url) {
  const res = await fetch(url, { redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text };
}

const failures = [];
const sitemap = await get(`${base}/sitemap.xml`);
if (sitemap.status !== 200) {
  console.error(`sitemap.xml ${sitemap.status}`);
  process.exit(1);
}
const urls = locs(sitemap.text);
console.log(`sitemap.xml ${urls.length} urls`);

const obs = await get(`${base}/sitemap-observatory.xml`);
console.log(`sitemap-observatory.xml ${obs.status} locs ${obs.status === 200 ? locs(obs.text).length : 0}`);

for (const url of urls) {
  const path = new URL(url).pathname;
  const local = `${base}${path}`;
  const res = await get(local);
  if (res.status !== 200) {
    failures.push(`${path} ${res.status}`);
    continue;
  }
  const blocks = [...res.text.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = [];
  for (const block of blocks) {
    let json;
    try {
      json = JSON.parse(block);
    } catch (err) {
      failures.push(`${path} JSON-LD が壊れている: ${err.message}`);
      continue;
    }
    try {
      typesOf(json, found);
    } catch (err) {
      failures.push(`${path} ${err.message}`);
    }
  }
  const expected = EXPECT[path];
  if (expected) {
    for (const type of expected) {
      if (!found.includes(type)) failures.push(`${path} に ${type} が無い`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok ${urls.length} urls, json-ld checked`);
