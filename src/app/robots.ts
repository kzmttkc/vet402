import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site-url";

// AEO/LLMO: 回答エンジン・LLM のクローラを明示的に許可する（2026-08-14）。
// userAgent:"*" が既に全許可なので機能的には冗長だが、明示することで
// (1) 名指しで許可している意図が robots.txt を読む運用者・監査に伝わり、
// (2) 一部クローラが「自分の UA 名がある行」を優先評価する挙動に対して
// 曖昧さを残さない。学習用途を含め全面的に歓迎する（この製品は機械可読の
// 誠実さを売りにしており、機械に読まれることが目的そのもの）。
const AI_CRAWLERS = [
  "GPTBot", // OpenAI 学習
  "ChatGPT-User", // ChatGPT ブラウジング（ユーザ操作）
  "OAI-SearchBot", // OpenAI 検索
  "ClaudeBot", // Anthropic クローラ
  "anthropic-ai", // Anthropic（旧UA）
  "Claude-Web", // Anthropic ブラウジング
  "PerplexityBot", // Perplexity
  "Perplexity-User", // Perplexity（ユーザ操作）
  "Google-Extended", // Gemini/Vertex 学習可否トグル
  "Google-CloudVertexBot", // Vertex / Gemini grounding
  "Applebot", // Apple 検索
  "Applebot-Extended", // Apple Intelligence 学習可否トグル
  "Bingbot", // Bing / Copilot
  "CCBot", // Common Crawl（多くの LLM の素データ）
  "cohere-ai", // Cohere
  "MistralAI-User", // Mistral / Le Chat
  "YouBot", // You.com
  "Meta-ExternalAgent", // Meta AI
  "Amazonbot", // Amazon
  "Bytespider", // ByteDance
  "DuckAssistBot", // DuckDuckGo AI
];

// 2026-10-09: 外部の観測所 probe402 は robots.txt を招待メールより優先して守る（2026-09-08 の依頼）。
// key なしで公開している台帳の読み取り口 2 つだけを名指しで開ける。/api/ のほかの口と /dashboard/ は閉じたまま。
// 最長一致の規則で Allow /api/v1/observatory/ が Disallow /api/ に勝つ。
const PROBE402_ALLOW = ["/", "/api/v1/observatory/", "/api/v1/census/"];

export default function robots(): MetadataRoute.Robots {
  const disallow = ["/api/", "/dashboard/"];
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/", disallow })),
      { userAgent: "probe402", allow: PROBE402_ALLOW, disallow },
    ],
    // 2026-09-05 SEO: sitemap は 2 本。静的な公開頁（/sitemap.xml）と、
    // 測定済み endpoint 頁（/sitemap-observatory.xml — カタログに現在も掲載され、
    // 公開判定が pass で、直近 7 日に実測がある分だけ）。sitemap index を
    // 名乗らず robots に 2 行書くのは、実装も検証も単純で対応が広いから。
    // 2026-09-28: 3 本目。売り手の個別頁（/sitemap-sellers.xml — /sellers の一覧と同じ
    // データ源の全ホスト、lastmod は各売り手の最新の購入）。
    // 2026-09-29 敵対的監査: 売り手頁の「どちら側の失敗か」に誤りが見つかったため、直すまで
    // 売り手の sitemap を外す（/sitemap-sellers.xml 自体は残す。戻すときはここに足すだけ）。
    sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/sitemap-observatory.xml`],
    host: SITE_URL,
  };
}
