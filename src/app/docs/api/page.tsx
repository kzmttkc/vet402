import type { Metadata } from "next";
import ApiDocsRest from "@/components/docs/ApiDocsRestLazy";
import Link from "next/link";
import { API_ENDPOINT_TOC } from "@/lib/docs/api-endpoints-toc";
import { headers } from "next/headers";
import TrackView from "@/components/site/TrackView";
import TrackedLink from "@/components/site/TrackedLink";
import CodeBlock from "@/components/docs/CodeBlock";
import { TryItPanel } from "@/components/docs/TryItPanel";
import DocsToc, { type TocItem } from "@/components/docs/DocsToc";
import { WideColumn } from "@/components/site/WideColumn";
import { SITE_URL } from "@/lib/site-url";
import { KEYLESS_READ_STOP, keylessRatesSentence, keylessResolvePerMinute } from "@/lib/api/keyless-limits";
import { pageMetadata, breadcrumbJsonLd, webApiJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { buildMonth } from "@/lib/build-month";
import { API_DOCS_ANSWER } from "@/lib/docs/api-page-text";
import { inviteRequired } from "@/lib/dashboard/signup-core";

// 2026-08-13 UX監査2巡目 [m2]: このページには metadata が無く、layout の
// default（LP と同じ長い表題）をそのまま名乗っていた。template "%s | vet402"
// が効くので、ここは接尾辞なしの固有名だけを書く。
// 2026-08-14: openGraph/twitter/canonical を pageMetadata で個別化。
const API_BLURB = `Decision API for x402 agent payments. ${keylessRatesSentence()}`;

export const metadata: Metadata = pageMetadata({
  title: "Decision API for x402 agent payments",
  description: API_BLURB,
  path: "/docs/api",
});

// 2026-08-12 FIX-6: 各エンドポイントを目次から直接指せるようにする。
// 2026-08-11: sticky 簡易目次の項目。リンク先の id は各 <section> と
// 各エンドポイントカードに付けてある。
const TOC: TocItem[] = [
  { href: "#quickstart", label: "Quickstart" },
  { href: "#packages", label: "Packages" },
  { href: "#verdicts", label: "Decision verdicts & reason codes" },
  { href: "#score-bands", label: "Score bands" },
  { href: "#rate-limits", label: "Rate limits" },
  {
    href: "#endpoints",
    label: "Endpoints",
    children: API_ENDPOINT_TOC.map((ep) => ({
      href: `#${ep.id}`,
      label: `${ep.method} ${ep.path.split("?")[0]}`,
    })),
  },
  {
    href: "#score-breakdown",
    label: "Score breakdown",
    children: [{ href: "#payee-score", label: "Payee score" }],
  },
  { href: "#webhooks", label: "Webhooks" },
  { href: "#availability", label: "Availability" },
  { href: "#error-codes", label: "Error codes" },
];


export default async function ApiDocsPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "API reference", path: "/docs/api" },
  ]);
  const article = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: "API reference",
    description: API_BLURB,
    url: `${SITE_URL}/docs/api`,
    author: { "@type": "Organization", name: "vet402", url: SITE_URL },
    publisher: { "@type": "Organization", name: "vet402", url: SITE_URL },
    inLanguage: "en",
  };
  const webApi = webApiJsonLd({
    name: "vet402 Decision API",
    description: API_BLURB,
  });

  return (
    // 2026-08-06 (320px persona audit A-5): `p-8` had no breakpoint, so a 320px
    // screen lost 64px to the page gutter alone — stacked with the card's px-4
    // and the <pre>'s p-3, the readable code column was 198px (62% of the
    // screen) and the longest response example needed 4.5 screen-widths of
    // horizontal scrubbing. The LP already uses the px-5/md:px-8 pattern; docs
    // was the outlier.
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      {/* 2026-08-06 growth: docs_view marks a visitor doing developer-grade
          evaluation — for an API product this is the aha-stage event in
          growth_ledger.py (the true value moment, a scored API call, happens
          server-side; page events are counted first-party on vet402.com). */}
      <TrackView event="docs_view" />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(webApi) }}
      />

      {/* 2026-08-11 UI監査5: このページはモバイル375pxで約21,000px の一枚岩で、
          「Webhooksの署名検証」を探す読者はスクロールし続ける以外の手段が無かった
          （見出しジャンプはスクリーンリーダー利用者にしか無い）。JSを足さずに
          済ませたいのでネイティブのアンカーだけで組む。header が sticky top-0 /
          h-14 なので、この帯は top-14、飛び先は scroll-mt-32（帯2本ぶん）。 */}
      <DocsToc items={TOC} />

      <WideColumn />
      <article className="sheet sheet-wide mt-6 space-y-10">
        <div>
          <div className="doc-head doc-head-compact">
            <div className="doc-head-col">
              <span>Independent Measurement</span>
              <span>Interface: REST v1</span>
              <span>
                {/* この頁のシアン1点。認証の形という事実。2026-09-29.3（監査 6 周目）: 判定と resolve は鍵不要。 */}
                Auth: <span className="text-signal">none for decision &amp; resolve</span>
              </span>
            </div>
            <div className="doc-head-col">
              <span>vet402</span>
              <span>x402 Economy</span>
              <span>{buildMonth()}</span>
            </div>
          </div>

          <h1 className="doc-title mt-8">API reference</h1>
          <p className="mx-auto mt-3 max-w-[62ch] text-center text-brand">
            Decision API for x402 agent payments.{" "}
            <Link href="/x402/check-a-seller" className="doc-link">
              Check an x402 seller before paying
            </Link>
            .
          </p>
          <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        </div>

        <div className="space-y-3">
        {/* 2026-10-31 AEO: 冒頭が目次と認証の文で、「vet402 とは何か」「払う前にどう確かめるか」に答える文が無かった。 */}
        <p className="text-brand">{API_DOCS_ANSWER}</p>
        {/* 2026-09-28 監査: Base URL が break-all で「https://vet」「402.com」と語の途中で
            折れていた。URL は 1 つの要素のまま折り返さない（375px 幅でも 1 行に収まる長さ）。 */}
        {/* 2026-09-29.3（監査 6 周目）: 冒頭が「Bearer API key」で、鍵なしで答える判定と resolve が鍵必須に読めた。 */}
        <p className="text-brand">
          {keylessRatesSentence()} The score, webhook and attest endpoints take an API key in{" "}
          <code className="text-brand-deep">Authorization: Bearer</code>. Base URL:{" "}
          <code className="whitespace-nowrap text-brand-deep">{`${SITE_URL}/api/v1`}</code>
        </p>
        <p className="text-[0.84375rem] text-brand-lift">
          Full machine-readable schema:{" "}
          {/* 2026-08-06 growth: openapi_click — pulling the machine-readable
              schema signals codegen/tooling-level integration intent, deeper
              than reading the human docs. */}
          <TrackedLink
            href="/openapi.yaml"
            event="openapi_click"
            className="underline"
          >
            <code className="text-brand-deep">/openapi.yaml</code>
          </TrackedLink>
          ,{" "}
          <TrackedLink href="/openapi.json" event="openapi_click" className="underline">
            <code className="text-brand-deep">/openapi.json</code>
          </TrackedLink>{" "}
          (also on{" "}
          <TrackedLink
            href="https://github.com/vet402/vet402/blob/main/docs/openapi.yaml"
            event="openapi_click_github"
            className="underline"
          >
            GitHub
          </TrackedLink>
          ).
        </p>
      </div>

      {/* 2026-08-13 UX監査2巡目 [M2]: このページは「Authenticate with Bearer …」
          から始まっていたので、評価しに来た開発者が最初に踏む段が「アカウントを
          作る」だった。鍵無しで叩ける公開パスは実在するのに、それが 13 本の
          エンドポイント表の中ほどに埋まっていて入口として使えていない。
          先頭に、コピーして即動く curl を3本置く。
          下の2本は 2026-08-13 に本番 (vet402.com) で実行して応答を確認済み。 */}
      <section id="quickstart" className="scroll-mt-32 space-y-3">
        <h2 className="sec-head">Quickstart</h2>
        <p className="text-[0.84375rem] text-brand">
          For a buyer agent, start with one of these two. Both read vet402 records, need no account, no key, and no
          signature. Paste them as they are.
        </p>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            1 &mdash; Check an x402 seller before paying (no key)
          </p>
          <CodeBlock
            label="curl: what vet402 recorded when it paid this URL"
            code={`curl "${SITE_URL}/api/v1/check?url=${encodeURIComponent("https://api.exa.ai/search")}&method=POST"`}
          />
          <TryItPanel
            path={`/api/v1/check?url=${encodeURIComponent("https://api.exa.ai/search")}&method=POST`}
            label="GET /api/v1/check?url=…"
          />
          <p className="mt-1 text-[0.84375rem] text-brand-lift">
            Same document as MCP <code className="text-brand-deep">check_x402_seller</code>:{" "}
            <code>recommendation</code>, <code>evidence_age</code>, <code>delivery</code>, the five latest purchases, and{" "}
            <code>verified_terms</code>. Optional <code>method=</code> narrows GET or POST like{" "}
            <code>/api/v1/resolve</code>. {keylessResolvePerMinute()} requests per minute per IP, shared with{" "}
            <code>/api/v1/resolve</code>. {KEYLESS_READ_STOP} This listing is POST on{" "}
            <code className="text-brand-deep">https://api.exa.ai/search</code>.
          </p>
        </div>
      </section>

      <ApiDocsRest inviteRequired={inviteRequired()} />

      </article>
    </main>
  );
}
