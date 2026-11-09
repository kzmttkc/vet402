import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { fragmentMono, martianMono } from "./fonts";
import { SiteChrome } from "@/components/site/SiteChrome";
import PageViewBeacon from "@/components/site/PageViewBeacon";
import { SITE_URL } from "@/lib/site-url";

// 2026-11-09: オーナーが承認した共有画像に合わせ、既定の title / og:title / twitter:title は
// LP の H1（src/app/page.tsx）。template は既定には付かない。em ダッシュは使わない。
const SITE_TITLE = "Safe payments between AI agents and the APIs they buy from.";
const SITE_DESCRIPTION =
  "vet402 pays x402 APIs itself and publishes which paid requests came back with a non-empty 2xx, so you can check a seller before your agent pays it.";

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
  // og:image は src/app/opengraph-image.png（2026-11-09 承認の白黒の共有画像）を
  // Next.js のファイル規約が自動で配線する。ここで images を書くと
  // その自動配線を上書きしてしまうので書かない。
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
    site: "@vet402_com",
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
  await headers();

  return (
    <html
      lang="en"
      className={`${martianMono.variable} ${fragmentMono.variable} h-full antialiased`}
    >
      <head />
      <body className="min-h-full flex flex-col bg-ground">
        <PageViewBeacon />
        {/* Outage strip is a client read of GET /api/health inside SiteChrome —
            it must not import scoring engines into this layout. */}
        <SiteChrome>
          {children}
        </SiteChrome>
      </body>
    </html>
  );
}
