export const INDEXNOW_KEY = "ec4e403cca67243a3da131d92f6412c9";

/**
 * @param {string} xml
 * @returns {{ loc: string; lastmod: string | null }[]}
 */
export function parseSitemap(xml) {
  const out = [];
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const chunk = block[1];
    const locM = chunk.match(/<loc>\s*([^<]+?)\s*<\/loc>/i);
    if (!locM) continue;
    const lastmodM = chunk.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i);
    out.push({
      loc: locM[1].trim(),
      lastmod: lastmodM ? lastmodM[1].trim() : null,
    });
  }
  return out;
}

/**
 * @param {{ loc: string; lastmod: string | null }[]} entries
 * @param {{ all?: boolean; sinceDays?: number; now?: Date; host: string }} opts
 * @returns {string[]}
 */
export function selectUrls(entries, opts) {
  const { all = false, sinceDays = 3, now = new Date(), host } = opts;
  const home = `https://${host}/`;
  const cutoff = now.getTime() - sinceDays * 86_400_000;
  const seen = new Set();
  const urls = [];

  for (const { loc, lastmod } of entries) {
    let u;
    try {
      u = new URL(loc);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.host !== host) continue;
    if (all) {
      if (!seen.has(loc)) {
        seen.add(loc);
        urls.push(loc);
      }
      continue;
    }
    let include = false;
    if (lastmod) {
      const t = Date.parse(lastmod);
      if (Number.isFinite(t) && t >= cutoff) include = true;
    }
    if (include && !seen.has(loc)) {
      seen.add(loc);
      urls.push(loc);
    }
  }

  if (!all) {
    if (!seen.has(home)) {
      seen.add(home);
      urls.unshift(home);
    }
  }

  return urls.slice(0, 10_000);
}

/**
 * @param {string} host
 * @param {string[]} urls
 */
export function buildPayload(host, urls) {
  return {
    host,
    key: INDEXNOW_KEY,
    keyLocation: `https://${host}/${INDEXNOW_KEY}.txt`,
    urlList: urls,
  };
}
