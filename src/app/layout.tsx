import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import Script from "next/script";
import "./globals.css";
import { SiteChrome } from "@/components/site/SiteChrome";
import { SITE_URL } from "@/lib/site-url";

// 2026-07-22 CTO実装: 全社日次反応レポート(daily_reaction_report.py)向けに
// 合流Plausibleサイト(sharoushi-agent.com)へ計装(未計装だった6サイトの1つ)。
const PLAUSIBLE_DOMAIN = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;

/* 書体は self-host（Google Fonts / OFL・2026-08-13 承認ブランド）。
   craft-floor は「approved lettering に合う face を調達して self-host する。
   一番近い既存フォントで済ませるのは失敗であってフォールバックではない」と
   している。ここは承認ブランドが名指しした2書体そのものを配る。
   TTF から woff2 へ変換して src/fonts/ に置いてある（martian 45KB→17KB、
   fragment 109KB→40KB）。display:"swap" は本文が Fragment に切り替わるまで
   等幅フォールバックで読める状態を保つため。

   adjustFontFallback:false が要る（2026-08-13 監査是正 #4）。next/font/local は
   既定でこの値が "Arial" で、**Arial の字幅に合わせた size-adjust 付きの
   ローカル代替フェイスを自動生成し、それを fallback 配列より前に差し込む**。
   つまり書体が遮断された時に最初に出るのは下に書いた ui-monospace ではなく
   プロポーショナルの Arial で、ch 基準の段幅・tabular-nums の桁揃え・事実の表の
   列という RFC 骨格が全部崩れる。false にすると連鎖の先頭が ui-monospace になり、
   遮断時も等幅のまま「刷りが薄い RFC」に見える。 */
const martianMono = localFont({
  variable: "--font-martian",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  src: [
    { path: "../fonts/martian-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/martian-600.woff2", weight: "600", style: "normal" },
    { path: "../fonts/martian-700.woff2", weight: "700", style: "normal" },
  ],
});

const fragmentMono = localFont({
  variable: "--font-fragment",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  src: [{ path: "../fonts/fragment-400.woff2", weight: "400", style: "normal" }],
});

const SITE_TITLE = "vet402 — Independent Verification of the x402 Agent-Payment Economy";
const SITE_DESCRIPTION =
  "vet402 buys what x402 endpoints actually sell, verifies fulfillment against the seller's own declaration, and publishes the results with evidence.";

/* 方向性の契約。ソースで読める位置に置いてある。
   これを崩す変更（SaaS 標準のカード羅列・グラデ・影・kicker への退行）は、
   実装の好みの問題ではなく契約違反になる。

   2026-09-02 敵対的監査 P2: 以前は HTML コメントとして本番 HTML と RSC
   ペイロードに毎リクエスト配信していた（hidden の器に dangerouslySetInnerHTML）。
   内部の設計文書と output/ のファイルパスを公開面に載せる理由は無いので、
   TS のブロックコメントに移した。文面は変えていない。

  vet402 — DIRECTION CONTRACT (pinned 2026-08-13, approved by the owner)

  THESIS   This site is a publication of a measurement body, not a product
           landing page. It is typeset in the grammar of an IETF RFC.
  WORLD    Paper white / ground #eef0f3. Ink is one navy scale:
           #233456 / #3e537c / #55688c, with #8f9cb2 for rules only.
           Cyan is a single point per screen, and only ever on a fact.
           Martian Mono (display) + Fragment Mono (body). No gradients,
           no glass, no card grids, no eyebrows, no invented colors.
  TRUTH    No claim of a measurement that has not been made. Facts only:
           pass / fail / unverified / settled. Never fraud, never scam.
  SOURCE   output/0813/vet402_lp_design_brief.md
           output/0813/brand_vet402/vet402_rfc_plaintext.png
*/

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // 自己参照 canonical（2026-08-13 監査是正）。"./" は各ルートの実パスに対して
  // metadataBase 基準で解決されるため、ここ1箇所で全ページに自己参照 canonical が
  // 付く（独自に canonical を持つページはページ側が優先される）。
  alternates: {
    canonical: "./",
    types: {
      "application/rss+xml": `${SITE_URL}/blog/rss.xml`,
    },
  },
  title: {
    default: SITE_TITLE,
    template: "%s | vet402",
  },
  description: SITE_DESCRIPTION,
  applicationName: "vet402",
  // GSC所有権確認用のmetaタグ。GOOGLE_SITE_VERIFICATION(Vercel env)が未設定なら
  // Next.jsは何も出力しない(非破壊)。GSCプロパティ追加時のトークンをVercel環境変数
  // に入れて再デプロイすれば <meta name="google-site-verification"> が出力され確認が
  // 通る。metaタグはCSP(nonce)の影響を受けない。2026-07-23 IndexNow横展開に合わせて配線。
  verification: { google: process.env.GOOGLE_SITE_VERIFICATION || "P4SSxlBKJYSC0NYhh7xeStZ4MPg8_TnMm2HNQfZhl28" },
  // 2026-07-24 growth-hacker: OGP/Twitterカードが未設定でX/Slack等での共有時に
  // タイトル・説明文すら出ない状態だったため追加。
  // 2026-08-13: og:image は src/app/opengraph-image.png（承認済みブランドアセットの
  // RFC 第1ページ組版）を Next.js のファイル規約が自動で配線する。ここで images を
  // 書くとその自動配線を上書きしてしまうので書かない。
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    type: "website",
    siteName: "vet402",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: "@vet_402",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

// 2026-08-13 監査是正 #8: ブラウザが自分で塗る面（モバイルのアドレスバー・
// タブ帯）が既定の白のままで、その下に続く地色 #eef0f3 と段差になっていた。
// 値は globals.css の紙地トークン --color-ground / --background と同じ #eef0f3。
// sticky ヘッダも bg-ground なので、画面最上部から地続きになる。
// manifest.ts の theme_color(#233456) はこれとは別物で、インストール時のアプリ
// 識別色（タスク切替の帯）。走っている頁の地色とは役割が違う。
// themeColor は metadata ではなく viewport export に置く（Next.js 15 以降、
// metadata 側に書くとビルド警告が出て出力されない）。
export const viewport: Viewport = {
  themeColor: "#eef0f3",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reading the per-request nonce (set by src/proxy.ts) opts this layout
  // out of static rendering, which nonce-based CSP requires: Next.js
  // automatically applies this same nonce to its own inline hydration
  // script, and a statically-cached page would otherwise ship a stale
  // nonce that no longer matches the fresh one in the response header.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      className={`${martianMono.variable} ${fragmentMono.variable} h-full antialiased`}
    >
      <head>
        {PLAUSIBLE_DOMAIN ? (
          <>
            {/* 公式 queue stub。plausible.io/js/script.js は defer+afterInteractive
                で遅れて実行されるため、mount 直後に発火するイベント（TrackView の
                lp_view / payee_view / payee_scored / docs_view / signup_view など、
                RSC ページの useEffect 即時発火）が本体読み込み前に呼ばれると、
                これが無ければ window.plausible 未定義で no-op になり取りこぼす。
                stub が先に window.plausible を配って呼び出しを q に積み、本体が
                読み込まれたら q を消化する。parse 時に同期実行される素の inline
                script なので、どの component の mount より前に走る。nonce 必須
                （CSP: script-src 'self' 'nonce-…' 'strict-dynamic'。nonce 付き
                inline script は strict-dynamic 下でも実行される）。 */}
            <script
              nonce={nonce}
              dangerouslySetInnerHTML={{
                __html:
                  "window.plausible=window.plausible||function(){(window.plausible.q=window.plausible.q||[]).push(arguments)}",
              }}
            />
            <Script
              defer
              nonce={nonce}
              data-domain={PLAUSIBLE_DOMAIN}
              src="https://plausible.io/js/script.js"
              strategy="afterInteractive"
            />
          </>
        ) : null}
      </head>
      <body className="min-h-full flex flex-col bg-ground">
        {/* Outage strip is a client read of GET /api/health inside SiteChrome —
            it must not import scoring engines into this layout. */}
        <SiteChrome>
          {children}
        </SiteChrome>
      </body>
    </html>
  );
}
