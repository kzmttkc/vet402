// ============================================================
// 公開頁の利用件数（2026-11-09）— 第三者計装契約終了後の first-party 集計。
//
// ブラウザは /api/v1/site-events へ {e,p,r} だけを送る。保存するのは (UTC 日, event, path, source, count) だけ。
// IP・User-Agent 文字列・生 URL・クエリ・cookie・識別子は保存しない。ヘッダは bot を除くか・同サイトかを見るためだけに読む。
// 応答を遅らせない: 書き込みは応答の後（runAfterResponse）。失敗はログへ出して捨てる。
// ============================================================
import { sql } from "drizzle-orm";
import { GUIDE_CHAINS } from "@/components/site/x402-guides";
import { getAllPosts } from "@/lib/blog";
import { OWN_ORIGINS } from "@/lib/decision/lookup-caller";
import { getDb } from "@/lib/db/client";
import { SITE_URL } from "@/lib/site-url";
import { runAfterResponse } from "@/lib/util/after-response";
import { logAndSwallowSafe } from "@/lib/util/log-safe";

/** track() と TrackView / TrackedLink が送るイベント名の正典。未知の名前は書かない。 */
export const SITE_EVENTS = [
  "page_view",
  "snippet_copy",
  "outbound_github",
  "outbound_npm",
  "outbound_x",
  "outbound_other",
  "contact_click",
  "lp_cta_click",
  "nav_click",
  "docs_click",
  "signup_started",
  "signup_completed",
  "api_key_created",
  "record_subscribe",
  "dispute_start",
  "pricing_cta_click",
  "signup_view",
  "signup_failed",
  "fix_first_open",
  "seller_page_view",
  "payee_lookup_view",
  "payee_view",
  "payee_scored",
  "lp_view",
  "observatory_view",
  "methodology_view",
  "faq_view",
  "docs_mcp_view",
  "docs_view",
  "openapi_click",
  "openapi_click_github",
  "lookup_view",
  "login_completed",
  "integrations_view",
  "billing_view",
  "connect_view",
  "passport_view",
  "follow_click",
  "entry_before_pay",
  "entry_while_pay",
  "entry_after_pay",
] as const;

export type SiteEventName = (typeof SITE_EVENTS)[number];

const SITE_EVENT_SET: ReadonlySet<string> = new Set(SITE_EVENTS);

const GUIDE_CHAIN_SLUGS = new Set(GUIDE_CHAINS.map((c) => c.slug));

/** src/app/sitemap.ts の静的頁と、計測で exact に持つ追加パス。 */
const STATIC_SITE_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/memo",
  "/docs/api",
  "/docs/mcp",
  "/connect",
  "/accuracy",
  "/leaderboard",
  "/status",
  "/observatory",
  "/observatory/state",
  "/observatory/methodology",
  "/payee",
  "/corrections",
  "/operator-log",
  "/rwa",
  "/faq",
  "/x402/stablecoin-payments",
  "/x402/check-a-seller",
  "/x402/chains",
  "/impact",
  "/decisions",
  "/operations",
  "/playground",
  "/ethonline",
  "/blog",
  "/signup",
  "/legal/terms",
  "/legal/privacy",
  "/legal/notice",
  "/about",
  "/dashboard",
  "/sellers",
  "/observatory/e",
]);

const BOT_UA_RE = /bot|crawl|spider|slurp|preview|headless|lighthouse/i;
const PATH_MAX = 64;

function stripPath(raw: string): string {
  let p = raw.trim();
  if (!p) return "/";
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

const KNOWN_BLOG_SLUGS = () => new Set(getAllPosts().map((post) => post.slug));

const REAL_DOC_PATHS = new Set(["/docs/api", "/docs/mcp"]);

/**
 * 保存用の頁グループ。生の pathname を有限集合へ寄せる（最大 64 文字）。
 */
export function pathGroup(pathname: string): string {
  const p = stripPath(pathname);
  if (STATIC_SITE_PATHS.has(p)) return p.slice(0, PATH_MAX);

  const chain = /^\/x402\/chains\/([^/]+)$/.exec(p);
  if (chain) {
    return GUIDE_CHAIN_SLUGS.has(chain[1])
      ? `/x402/chains/${chain[1]}`.slice(0, PATH_MAX)
      : "/x402/chains/[chain]";
  }

  const blog = /^\/blog\/([^/]+)$/.exec(p);
  if (blog) {
    return KNOWN_BLOG_SLUGS().has(blog[1]) ? `/blog/${blog[1]}`.slice(0, PATH_MAX) : "/blog/[other]";
  }

  if (/^\/observatory\/e\/[^/]+$/.test(p)) return "/observatory/e/[id]";
  if (/^\/sellers\/[^/]+$/.test(p)) return "/sellers/[host]";
  if (/^\/payee\/[^/]+$/.test(p)) return "/payee/[address]";
  if (p === "/dashboard" || p.startsWith("/dashboard/")) return "/dashboard";

  const doc = /^\/docs\/([^/]+)$/.exec(p);
  if (doc) {
    const full = `/docs/${doc[1]}`;
    return REAL_DOC_PATHS.has(full) ? full : "/docs/[other]";
  }

  return "other";
}

function hostSuffix(hostname: string, suffix: string): boolean {
  const h = hostname.toLowerCase();
  const s = suffix.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

/**
 * 参照元ホスト名から保存用ラベルを選ぶ（ホスト文字列そのものは保存しない）。
 */
export function sourceLabel(referrerHost: string | null | undefined): string {
  const h = (referrerHost ?? "").trim().toLowerCase();
  // PageViewBeacon は参照元が空のとき "direct" を送る（ホスト名ではない）。other に落とさない（2026-11-09 本番の実測で発見）。
  if (!h || h === "direct") return "direct";
  // 2026-11-09 確認役の直し: クライアントは頁内の移動とイベントに r="internal" を送る。ホスト名ではないので
  // ここで受けないと other に落ち、来訪（S1）が頁内の移動の数だけ水増しされる。
  if (h === "internal" || h === "vet402.com" || h === "www.vet402.com") return "internal";
  if (hostSuffix(h, "gemini.google.com")) return "gemini";
  if (hostSuffix(h, "google.com") || hostSuffix(h, "google.co.uk") || /\.google\./.test(h)) return "google";
  if (hostSuffix(h, "bing.com")) return "bing";
  if (hostSuffix(h, "duckduckgo.com")) return "duckduckgo";
  if (hostSuffix(h, "search.yahoo.com") || hostSuffix(h, "yahoo.com") || /\.yahoo\./.test(h)) return "yahoo";
  if (h === "chatgpt.com" || h === "chat.openai.com") return "chatgpt";
  if (hostSuffix(h, "perplexity.ai")) return "perplexity";
  if (hostSuffix(h, "claude.ai")) return "claude";
  if (hostSuffix(h, "copilot.microsoft.com")) return "copilot";
  if (h === "t.co" || h === "x.com" || h === "twitter.com" || hostSuffix(h, "twitter.com")) return "x";
  if (hostSuffix(h, "github.com")) return "github";
  if (hostSuffix(h, "linkedin.com") || h === "lnkd.in") return "linkedin";
  if (hostSuffix(h, "reddit.com")) return "reddit";
  if (hostSuffix(h, "news.ycombinator.com")) return "hn";
  if (hostSuffix(h, "dev.to")) return "devto";
  if (hostSuffix(h, "npmjs.com")) return "npm";
  return "other";
}

function siteOrigins(): ReadonlySet<string> {
  const origins = new Set(OWN_ORIGINS);
  try {
    origins.add(new URL(SITE_URL).origin);
  } catch {
    /* SITE_URL is fixed in production */
  }
  return origins;
}

const SITE_ORIGINS = siteOrigins();

/**
 * 数える要求か。bot・クロスサイトの偽装 POST を除く。User-Agent と Origin / Sec-Fetch-Site だけを見る。
 */
export function shouldCount(headers: Pick<Headers, "get">): boolean {
  const ua = (headers.get("user-agent") ?? "").trim();
  if (!ua || BOT_UA_RE.test(ua)) return false;
  if ((headers.get("sec-fetch-site") ?? "").trim().toLowerCase() === "same-origin") return true;
  const origin = (headers.get("origin") ?? "").trim();
  if (origin && SITE_ORIGINS.has(origin)) return true;
  return false;
}

function upsertSiteEvent(event: string, path: string, source: string, now: Date): Promise<void> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (error) {
    logAndSwallowSafe("site_events.record")(error);
    return Promise.resolve();
  }
  if (!db) return Promise.resolve();
  const day = now.toISOString().slice(0, 10);
  let pending: PromiseLike<unknown>;
  try {
    pending = db.execute(
      sql`INSERT INTO site_events_daily (day, event, path, source, count)
          VALUES (${day}::date, ${event}, ${path}, ${source}, 1)
          ON CONFLICT (day, event, path, source) DO UPDATE SET count = site_events_daily.count + 1`,
    );
  } catch (error) {
    logAndSwallowSafe("site_events.record")(error);
    return Promise.resolve();
  }
  return Promise.resolve(pending)
    .then(() => undefined)
    .catch(logAndSwallowSafe("site_events.record"));
}

/** 1 件を加算する。未知の event は何もしない。 */
export function recordSiteEvent(payload: { event: string; path: string; source: string }): void {
  try {
    if (!SITE_EVENT_SET.has(payload.event)) return;
    const path = payload.path.slice(0, PATH_MAX);
    const source = payload.source.slice(0, 64);
    const now = new Date();
    runAfterResponse(() => upsertSiteEvent(payload.event, path, source, now));
  } catch (error) {
    logAndSwallowSafe("site_events.schedule")(error);
  }
}
