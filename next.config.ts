import type { NextConfig } from "next";

// Content-Security-Policy is no longer set here: it now needs a fresh
// per-request nonce for script-src (replacing 'unsafe-inline'), so it's
// generated and applied in src/proxy.ts instead. The dashboard's one
// dynamic inline style (progress bar width) still relies on
// style-src 'unsafe-inline', which src/proxy.ts also sets.
const securityHeaders = [
  // 2026-08-13 監査 L-1: これまでは Vercel 既定の max-age のみ（includeSubDomains/
  // preload なし）に依存していた。自前で明示し、サブドメインへの平文格下げ攻撃も
  // 塞ぐ。preload は hstspreload.org への登録自体は別途手続きだが、登録要件である
  // このトークンを先に配っておく。
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // 2026-08-06: Vouch was the only one of the three products without this
  // header (Verilot has carried it since 2026-07-22). None of these APIs are
  // used anywhere in the app, so denying them outright costs nothing and
  // removes them from any injected/embedded content's reach.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  // Docker セルフホスト（Dockerfile）のときだけ standalone 出力。Vercel 本番の
  // ビルド挙動を一切変えないため、無条件では設定しない（Phase 0.2）。
  ...(process.env.DOCKER_BUILD ? { output: "standalone" as const } : {}),
  // 2026-08-05 R&D audit: the three products' headers were compared and Vouch
  // was the only one still advertising its framework. Zero functional value,
  // and a product that sells itself as a trust layer should not volunteer
  // fingerprinting hints it does not have to.
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      // 2026-09-04 監査 D・P2: /llms.txt は public/ の静的ファイルで Vercel 既定の
      // `max-age=0, must-revalidate`、/llms-full.txt は route handler で `max-age=3600`
      // （本番実測）。同じ読者向けの同じ種類の文書なので鮮度の約束を揃える。
      // 値は src/app/llms-full.txt/route.ts と同じ（tests/llms-cache-headers.test.ts が固定）。
      {
        source: "/llms.txt",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600" }],
      },
    ];
  },
  async rewrites() {
    return [
      // llmstxt.org lives at /llms.txt. Some agents still probe
      // /.well-known/llms.txt or /ai.txt; alias them rather than 404.
      { source: "/.well-known/llms.txt", destination: "/llms.txt" },
      { source: "/ai.txt", destination: "/llms.txt" },
    ];
  },
  // 2026-08-06 (JS-disabled / navigation audit): the header's "Pricing" item
  // points at the in-page anchor /#pricing, but developers type URLs directly
  // and inbound links get written as /pricing — which returned a hard 404. The
  // pricing table itself is server-rendered on the homepage, so a redirect is
  // the whole fix. Kept temporary (307) rather than 308 so that promoting
  // pricing to a real page later isn't fighting a permanently cached redirect.
  async redirects() {
    return [
      {
        source: "/pricing",
        destination: "/#pricing",
        permanent: false,
      },
      // 2026-08-23 UX監査: ヘッダーの Method は /#methodology、Verify は /payee を
      // 指しており（内部リンク32本を本番実測して404は0件）、ナビ自体は死んで
      // いない。だが /method・/verify・/methodology はいずれも読者が推測して
      // 打つ形で、実測すると 404 だった。/pricing と同じ話——アンカーやネストした
      // 正典URLは、直打ちと外部からの被リンクでは素の短いパスとして書かれる。
      //
      // /pricing と同じく 307（permanent:false）。将来 Method を独立ページへ
      // 昇格させる可能性があり、恒久リダイレクトのキャッシュと戦いたくない。
      { source: "/method", destination: "/#methodology", permanent: false },
      // 正典は /observatory/methodology。短い方を打った読者を正典へ送る。
      { source: "/methodology", destination: "/observatory/methodology", permanent: false },
      { source: "/verify", destination: "/payee", permanent: false },
      // 2026-09-02 敵対的監査: /docs が 404 だった。正典は /docs/api で、これが
      // 別ページに昇格する予定は無いので 308（permanent）。/agent も 404 だが、
      // 旧 URL として何を指していたかが不明なので行き先を推測して足さない。
      { source: "/docs", destination: "/docs/api", permanent: true },
      // 2026-08-19: note.com's link auto-embed (and its explicit "埋め込み"
      // insert command) silently fails to build a card for any URL with a
      // query string — verified by hand in the Sen note.com editor and
      // already fixed the same way on Verilot (verilot.app/s/sen-note-a|b,
      // 2026-08-16). Same bug, same fix here: a query-string-free short path
      // that redirects to the real UTM-tagged destination, so note's embed
      // fetcher can follow it and read the landed page's OGP tags while
      // Plausible still sees the full utm_source/medium/campaign/content.
      {
        source: "/s/sen-note-a",
        destination:
          "/?utm_source=sen_note&utm_medium=cta&utm_campaign=vouch&utm_content=sen_note_a",
        permanent: false,
      },
      {
        source: "/s/sen-note-b",
        destination:
          "/?utm_source=sen_note&utm_medium=cta&utm_campaign=vouch&utm_content=sen_note_b",
        permanent: false,
      },
      // 2026-08-13 UX監査R1 [B2]: 旧 Vercel ドメイン
      // agent-trust-tawny.vercel.app が本番とバイト同一の複製を配信し続けて
      // いた（実測: HTTP 200、同じ HTML）。GitHub リポの homepage も当時そこを
      // 指していた。同じ文書が2つの正典を持つと、被リンクと索引が割れるだけ
      // でなく、「どちらが本物か」を読者が判定できない — 検証を売る製品が
      // 自分の身元で それをやっているのは、llms.txt が第三者ドメインを
      // 否認しているのと辻褄が合わない。
      //
      // ホスト一致の恒久リダイレクト。パスは保存する（旧ドメインの深いリンクが
      // トップに落ちない）。308 = permanent:true で、メソッドと本文を保つ
      // （301 は POST を GET に変える）。
      {
        source: "/:path*",
        has: [{ type: "host", value: "agent-trust-tawny.vercel.app" }],
        destination: "https://vet402.com/:path*",
        permanent: true,
      },
      // 2026-08-19: www.vet402.com served a full byte-identical copy at HTTP 200
      // (canonical correctly pointed at the apex, so index consolidation held,
      // but a verification product should not answer on two hosts). Same
      // host-match 308 as above: fold www onto the apex, preserving the path.
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.vet402.com" }],
        destination: "https://vet402.com/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
