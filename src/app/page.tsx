import { headers } from "next/headers";
import Link from "next/link";
import TrackView from "@/components/site/TrackView";
import TrackedLink from "@/components/site/TrackedLink";
import { Mark402 } from "@/components/site/Mark402";
import { PricingSection } from "@/components/site/PricingSection";
import { TableScroll } from "@/components/site/TableScroll";
import { X402_DEFINITION } from "@/components/site/faq-data";
import { BILLING_PLANS, isStripeConfigured } from "@/lib/billing/plans";
import { buttonClass } from "@/components/ui/Button";
import { SITE_URL } from "@/lib/site-url";
import { organizationJsonLd, publisherOrg } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

/**
 * The front page is the memo.
 *
 * 2026-08-13 vet402 — direction contract pinned in src/app/layout.tsx and in
 * output/0813/vet402_lp_design_brief.md. The first viewport reproduces the
 * first page of an RFC: the split header block, the centred title, the
 * tagline, the double rule, the mark, the abstract, and two ways in. Everything
 * below is the body of the same document.
 *
 * Copy is the approved deck, verbatim except for typesetting breaks. Nothing on
 * this page claims a measurement that has not been made: §4 lists only what is
 * running today (including the live observatory), §5 is only work that has not
 * shipped.
 */

const HEAD_LEFT = [
  { label: "Network Working Group", value: null },
  { label: "Request for Verification", value: "402" },
  { label: "Category", value: "Independent Measurement" },
  { label: "Status", value: "Building in public", signal: true },
];

// 2026-08-13 UX監査R1 [D4]: 4ペルソナが独立に「ヘッダは trust scores を
// obsoletes と言っているのに §2.1 は今日返るのが trust score だと言っている」
// と矛盾を報告した。ヘッダ文言は承認済みコピーなので変えない。代わりに
// その行から §2.1 へ飛べるようにして、3秒で去る読者が矛盾を抱えたまま
// 離脱しないようにする（Obsoletes は RFC の書誌欄で「何を置き換える文書か」
// を宣言する欄で、置き換えの進行状況は §2.1 が持っている）。
const HEAD_RIGHT: { value: string; href?: string; title?: string }[] = [
  { value: "vet402" },
  { value: "x402 Economy" },
  { value: "August 2026" },
  {
    value: "Obsoletes: trust scores",
    href: "#methodology",
    title: "What replaces the trust score, and what is still returned today — see section 2.1",
  },
];

const CONTENTS = [
  { no: "1.", title: "The problem this memo addresses", href: "#gap", kind: "background" },
  { no: "2.", title: "Verification levels", href: "#methodology", kind: "method" },
  { no: "3.", title: "What a verdict must carry", href: "#evidence", kind: "policy" },
  { no: "4.", title: "Implemented and live", href: "#working", kind: "live" },
  { no: "5.", title: "Status of this work", href: "#status", kind: "building" },
  { no: "A.", title: "Access tiers", href: "#pricing", kind: "terms" },
  { no: "B.", title: "References", href: "#references", kind: "sources" },
];

const LEVELS = [
  {
    level: "L0",
    name: "Liveness",
    question: "Does the endpoint answer correctly?",
    how: "Probe, no purchase",
    output: "pass / fail / unverified",
  },
  {
    level: "L1",
    name: "Settle-through",
    question: "Does payment settle and a response arrive?",
    how: "Real purchase",
    output: "n of m settled, latency",
  },
  {
    level: "L2",
    name: "Conformance",
    question: "Does the response match the seller's own declaration?",
    how: "Purchase + machine diff",
    output: "conform / mismatch / undeclared",
  },
  {
    level: "L3",
    name: "Quality",
    question: "Is the content any good?",
    how: "Published rubric",
    output: "opinion — never mixed with L0–L2",
  },
];

export default async function Home() {
  // 2026-07-25 CTO: ホームページのJSON-LDが0件だった非対称を解消(/faqのみ
  // FAQPage実装済みという状態だった)。数値はsrc/lib/billing/plans.ts(課金の
  // 単一情報源)から引用し、架空の価格を書かない。
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const organization = organizationJsonLd(
    "Independent verification of the x402 agent-payment economy. vet402 buys what x402 endpoints sell, verifies fulfillment against the seller's own declaration, and publishes the results with evidence.",
  );
  // 2026-08-14 SEO/AEO: WebSite ノードが欠けていた（Organization と
  // SoftwareApplication はあった）。検索の sitelinks／エンティティ束ねに効く
  // 基本ノードで、publisher で Organization に結ぶ。site 内検索は無いので
  // potentialAction(SearchAction) は書かない（存在しない導線を主張しない）。
  const webSiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "vet402",
    url: SITE_URL,
    description:
      "Independent verification of the x402 agent-payment economy.",
    publisher: publisherOrg(),
    inLanguage: "en",
    sameAs: organization.sameAs,
  };
  const softwareApplicationJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "vet402",
    url: SITE_URL,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    description:
      "Verification API for the x402 agent-payment economy. Prove control of a payee wallet, check a payee before paying it, and read the public accuracy ledger.",
    // An Offer is a machine-readable assertion that a plan is purchasable at
    // this price — read by search engines and by the buying agents this product
    // exists to serve. The paid entries are therefore tied to whether checkout
    // can actually complete, the same `isStripeConfigured()` that gates the
    // billing API and the paid CTA. On 2026-09-01 production advertised Pro and
    // Scale while its checkout handed customers a TEST-mode Stripe page; the
    // plan table below stays (it describes the tiers, which exist) but the
    // purchase claim does not outlive the ability to honour it.
    offers: [
      {
        "@type": "Offer",
        name: BILLING_PLANS.free.name,
        price: "0",
        priceCurrency: "USD",
        description: `${BILLING_PLANS.free.monthlyLimit.toLocaleString()} lookups / month`,
      },
      ...(isStripeConfigured()
        ? [
            {
              "@type": "Offer",
              name: BILLING_PLANS.pro.name,
              price: "49",
              priceCurrency: "USD",
              description: `${BILLING_PLANS.pro.monthlyLimit.toLocaleString()} lookups / month`,
            },
            {
              "@type": "Offer",
              name: BILLING_PLANS.scale.name,
              price: "199",
              priceCurrency: "USD",
              description: `${BILLING_PLANS.scale.monthlyLimit.toLocaleString()} lookups / month`,
            },
          ]
        : []),
    ],
  };

  return (
    // 2026-08-13 UX監査2巡目 [M8]: 1440×720 で2本の CTA の下端が 843px にあり、
    // fold の 123px 下だった。RFC 第1面の要素と順序（ヘッダ／表題／タグライン／
    // ダブルルール／マーク／Abstract／2本の入口）は一つも動かさず、行間と
    // マークの寸法だけを詰めて 712px に収めている。ここは md:pt-12 を外した分。
    // 2026-08-13 再監査: 同じ [M8] の欠陥がモバイルに残っていた。375×812 で
    // 2本の CTA の下端は 934px（fold の 122px 下）で、幅の広い端末だけを直して
    // いたことになる。ここから下の `sm:` 付きの値は 8/13 に承認された desktop の
    // 組版そのままで、640px 未満にだけ詰めた値を当てている（1440×720 の 706px は
    // 動かさない）。要素・順序・コピーは一つも変えていない。
    <main className="px-4 pt-4 pb-4 sm:px-6 sm:pt-8 md:px-8 md:pt-6">
      {/* 2026-08-06 growth: lp_view opens the funnel (Verilot parity). Without
          it, CTA click-through rate has no denominator — the automatic
          pageview can't carry utm_source as a queryable prop. */}
      <TrackView event="lp_view" withUtmSource />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(organization) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(webSiteJsonLd) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(softwareApplicationJsonLd) }}
      />

      {/* max-sm:py-5 — 紙の天地の余白だけ 32px → 20px。.sheet 自体（全ページ共通）
          は触らず、この1枚にだけ当てている。 */}
      <article className="sheet max-sm:py-5">
        {/* ================= RFC first page ================= */}
        {/* 640px 未満ではヘッダの2列が縦に積まれて8行になる（.doc-head の
            media query）。line-height 1.7 のままだと、この1ブロックだけで
            198px — モバイルの fold の約1/4 を、まだ何も言っていない書誌情報が
            占めていた。行間と2列間の空きだけを詰める（文字サイズも行数も同じ）。 */}
        <div className="doc-head max-sm:gap-2 max-sm:leading-[1.3]">
          <div className="doc-head-col">
            {HEAD_LEFT.map((row) => (
              <span key={row.label}>
                {row.label}
                {row.value ? ": " : ""}
                {row.value ? (
                  // シアンは1画面1箇所。この Status 値がその1点で、装飾ではなく
                  // 「いまどの段階にあるか」という事実に充てている。
                  // 色は #0e7490（白地 5.36:1）。ブランドシートの #0891b2 は
                  // 白地 3.68:1 で本文サイズの文字には AA が足りない。
                  <span className={row.signal ? "text-signal" : undefined}>{row.value}</span>
                ) : null}
              </span>
            ))}
          </div>
          <div className="doc-head-col">
            {HEAD_RIGHT.map((row) =>
              row.href ? (
                <span key={row.value}>
                  <Link href={row.href} className="doc-link" title={row.title}>
                    {row.value}
                  </Link>
                </span>
              ) : (
                <span key={row.value}>{row.value}</span>
              ),
            )}
          </div>
        </div>

        <h1 className="doc-title mt-3 sm:mt-6">
          vet402 — Independent Verification of the x402 Agent-Payment Economy
        </h1>
        <p className="mx-auto mt-2 max-w-[52ch] text-center text-brand-lift sm:mt-3">
          We buy. We settle. We publish the measurements.
        </p>
        {/* 2026-08-23 UX: タグラインは我々の**手順**を3語で言うが、初見の読者が
            5秒で欲しいのは「これは何をしてくれるのか」。Abstract（§下）は正確な
            代わりに専門語から入るので、その手前に平易な1文を置く。
            RFC のトーンを壊さないよう、新しい枠も装飾も足さず、タグラインと同じ
            中央寄せ・同じ弱いインクで続けるだけ。文は1つに留める。 */}
        <p className="mx-auto mt-2 max-w-[62ch] text-center text-brand-lift">
          Before an agent pays an x402 endpoint, vet402 checks whether that endpoint actually
          delivers — by buying it.
        </p>

        <div className="rule-double mx-auto mt-3 w-full max-w-[34ch] sm:mt-4" />

        {/* マークは 132 → 104px（モバイルと同寸）。[M8] の 123px のうち 28px を
            ここから出している。紙面の中央・ダブルルールの直下という位置は同じ。
            2026-08-13 再監査: 640px 未満では 72px。[M8] で desktop の寸法を
            詰めた時と同じ手で、モバイルにも同じ処置をしているだけ。位置・
            アニメーション・前後の要素は変わらない。 */}
        <div className="mt-3 flex justify-center sm:mt-5">
          <Mark402 animate className="h-auto w-[72px] sm:w-[104px]" />
        </div>

        <div className="mt-3 flex flex-col gap-1 sm:mt-5 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            {/* 引用符は straight。RFC の原典はプレーンテキストで、curly quote は
                存在しない。/faq と /legal も straight で統一されている。

                2026-08-13 [M8]: 5行 → 3行。落としたのは "Every verdict will carry
                a transaction hash, a timestamp and reproduction steps." の1文で、
                これは §3.1 が同じ内容をより強い形（「無ければ公開しない」）で
                述べている重複。Abstract が §3 を先取りするのをやめただけで、
                デッキの主張は1つも減っていない。 */}
            vet402 buys what x402 endpoints actually sell, verifies fulfillment against the
            seller&apos;s own declaration, and publishes the results with evidence.{" "}
            <strong>Nothing on this site is an estimate.</strong>
          </p>
        </div>

        {/* 2026-08-06 growth: lp_cta_click{position} tells us WHICH CTA converts
            (hero vs final vs pricing), which a plain /signup pageview can never
            attribute. */}
        <div className="mt-4 flex flex-wrap gap-3 sm:mt-5 sm:pl-[10ch]">
          {/* 2026-08-23 UX: 主従を入れ替えた。以前は "Read the methodology" が
              primary、"Verify a payee now" が secondary だったが、初見の読者が
              最初に取れる行動は後者（アカウント不要・その場で結果が出る）。
              方法論は「なぜ信じられるか」の裏取りで、先に読むものではない。
              並び順も primary を先頭へ。イベント名と position は変えていない
              （lp_cta_click の時系列比較を壊さないため）。 */}
          <TrackedLink
            href="/payee"
            event="lp_cta_click"
            props={{ position: "hero_verify" }}
            className={buttonClass({ size: "md", className: "w-full sm:w-auto" })}
          >
            Verify a payee now
          </TrackedLink>
          <TrackedLink
            href="#methodology"
            event="lp_cta_click"
            props={{ position: "hero_method" }}
            className={buttonClass({
              variant: "secondary",
              size: "md",
              // 縦に積まれる幅では、内容幅のままだと2本の右端が揃わず雑に見える。
              className: "w-full sm:w-auto",
            })}
          >
            Read the methodology
          </TrackedLink>
        </div>

        {/* 2026-08-14 UX: x402 の平易な定義をヒーロー直下へ昇格。この分野の外から
            来た読者（非開発者ペルソナ P2/P3/P6）は、定義が §1 の中ほど＝fold の
            下にあると最初の一画面で降りていた。定義そのものは /faq Q1 の承認済み
            文（faq-data.ts が正典）で、新しいコピーは足していない —— §1 にあった
            同じ枠を、二本の入口の直下へ動かしただけ。fold の CTA 行より後ろに
            置いているので、承認済みの第1面（表題／タグライン／マーク／Abstract／
            二本の入口）の並びと寸法はそのまま。 */}
        <div className="dashbox mt-8 max-w-[64ch]">
          <p className="doc-caption">{X402_DEFINITION.question}</p>
          <p className="mt-3 text-brand">{X402_DEFINITION.answer}</p>
          <p className="doc-note mt-3">
            <Link href="/faq" className="doc-link">
              More questions
            </Link>
            <span aria-hidden="true" className="mx-2 text-brand-lift">
              ·
            </span>
            <Link href="/observatory" className="doc-link">
              Live measurements
            </Link>
            <span aria-hidden="true" className="mx-2 text-brand-lift">
              ·
            </span>
            <Link href="/payee" className="doc-link">
              Score a wallet
            </Link>
          </p>
        </div>

        {/* ================= Table of contents ================= */}
        <nav aria-label="Table of contents" className="mt-14">
          <p className="doc-caption">Contents</p>
          <div className="mt-4 border-t border-hair pt-2">
            {CONTENTS.map((item) => (
              <Link key={item.href} href={item.href} className="toc-row">
                <span className="toc-no">{item.no}</span>
                <span className="toc-label">{item.title}</span>
                <span className="toc-lead" aria-hidden="true" />
                <span className="toc-page">{item.kind}</span>
              </Link>
            ))}
          </div>
        </nav>

        {/* ================= 1. The gap ================= */}
        <h2 id="gap" className="sec-head scroll-mt-24">
          <span className="sec-no">1.</span>
          <span>The problem this memo addresses</span>
        </h2>

        {/* 2026-08-13 UX監査R1 [C1][C2]: "x402" を定義しないまま12回使っていた穴は、
            定義枠をヒーロー直下（第1面の二本の入口の直後）へ昇格して塞いだ
            ——枠の本体はこの上、fold 付近に置いてある。§1 はそのまま本題（1.1〜）へ
            入る。 */}
        <div className="mt-6 space-y-5">
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">1.1</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              x402 settles payments finally and irreversibly. Proof of payment exists on-chain.{" "}
              <strong>Proof of delivery does not exist anywhere.</strong>
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">1.2</span>
            {/* 2026-08-13 UX監査R1 [A4]: 98.7% にチェーンの修飾が無く、3チェーン
                全体の数字として読めた。原典はチェーン別に 98.7%(ETH) /
                99.3%(Base) / 100.0%(BSC) で、ここは一番低い値を採っている
                （盛ってはいない）。どのチェーンの数字かを字面に出す。 */}
            <p className="min-w-0 max-w-[64ch] text-brand">
              Registries can be written for cents: 98.7% of ERC-8004 reputation feedback on
              Ethereum has no verifiable transaction behind it.{" "}
              <a href="#ref-arxiv" className="ref-mark">
                [ARXIV-2606]
              </a>
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">1.3</span>
            {/* 2026-08-13 UX監査R1 [A3]: ここは "roughly half of observed x402
                traffic is self-dealing" と書き、出典は URL も日付も無い
                「Artemis, x402 activity analysis, 2026」だった。原典（Visa と
                Artemis の共同レポート）を当たると、公表されている数字は
                self-dealing 単独ではなく **wash と test を合わせて除外した
                分** で、生の 178.3M トランザクションが調整後 109.6M になる
                = 38.5%。「およそ半分」でも「self-dealing」でもない。
                追跡できない引用を「Nothing on this site is an estimate」を
                掲げる頁に置くのは自己矛盾なので、原典が実際に公表している
                数字と語（adjusted / wash and test）に合わせ、URL・発行者・
                発行月・データ基準日を References に全部書く。 */}
            <p className="min-w-0 max-w-[64ch] text-brand">
              Directory metrics can be manufactured: 38.5% of x402 transactions fall away as wash
              or test activity before the totals mean anything.{" "}
              <a href="#ref-artemis" className="ref-mark">
                [VISA-ARTEMIS-2026]
              </a>
            </p>
          </div>
        </div>

        {/* ================= 2. Method ================= */}
        <h2 id="methodology" className="sec-head scroll-mt-24">
          <span className="sec-no">2.</span>
          <span>Verification levels</span>
        </h2>
        <p className="doc-p">
          Four levels, in order of what they cost us to run and what they prove. A result never
          moves up a level: an L0 probe cannot report settlement, and an L3 opinion is never
          folded into an L0&ndash;L2 fact.
        </p>

        {/* 表は md 以上。768px 未満では同じ配列を定義リストで積む（4列の散文表を
            横スクロールさせると、この表で一番重要な Output 列が最初から画面外に
            出る）。表示されない側は display:none なので支援技術にも二重に出ない。

            2026-08-13 アクセシビリティ監査（200%拡大）で、しきい値 640px は
            低すぎたことが実測で出た: .fact-table-fixed の下限は 39rem = 624px で、
            紙面の内寸がそれを割るのは 640px ではなく 786px。720px では
            50px、640px では 66px が隠れ、画面には `conform / mismat` と
            `opinion — never m` が出ていた。「正確に測る」を売る頁で、検証段の
            定義そのものが語の途中で切れていたことになる。

            しきい値は md(768px) では足りない（実測: 768px の紙面内寸は 606px で
            まだ 18px 隠れる）。内寸は viewport - 162px（ページ余白 64 + 紙の
            左右余白 96 + 罫 2）なので、624px を確保できるのは 786px から。
            30px の余裕を見て 800px を境にする。 */}
        <TableScroll
          label="vet402 verification levels"
          className="hidden min-[800px]:block"
        >
          <table className="fact-table fact-table-fixed">
            <caption className="sr-only">
              vet402 verification levels: what each level asks, how it is run, and what it outputs
            </caption>
            {/* 列幅は「その列に入る一番長い1語」から決める。表示書体が列ごとに
                違うので桁数だけでは決まらない（Level 列だけ Martian Mono の
                0.70em、他は Fragment Mono の 0.618em）。
                  Level    Conformance   11桁 × 0.70em × 13px = 100px (+20 pad)
                  Question declaration?  12桁 × 0.618em × 13px = 96px (+20 pad)
                  How      machine       7桁 = 56px (+20 pad)
                  Output   unverified   10桁 = 80px（最終列は右パディング0）
                24% は 1440px の紙面(665px)で 160px を Level 列に配り、
                `Settle-through`(127px) すら1語のまま置ける。
                .fact-table-fixed の min-width が下限を押さえている。 */}
            <colgroup>
              <col style={{ width: "24%" }} />
              <col style={{ width: "29%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "29%" }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col">Question</th>
                <th scope="col">How</th>
                <th scope="col">Output</th>
              </tr>
            </thead>
            <tbody>
              {LEVELS.map((row) => (
                <tr key={row.level}>
                  {/* 段名を nowrap で括るのは、ハイフンでの分割を止めるため。
                      列幅に入らない時、ブラウザは空白より先にハイフンで折る:
                      `L1 Settle-through`(155px) が 140px の内寸に入らないと
                      `L1 Settle-` / `through` になり、監査が拾った
                      `L2 Conformanc / e` と同じ形に見える。nowrap にすると
                      折れる場所が語間だけになり `L1` / `Settle-through` になる。
                      1行に収める案（LEVEL 列 27%）も試したが、その幅を保つには
                      表の下限が 648px になり、640–827px の画面で表が横スクロール
                      する。語間で折るほうが安い。 */}
                  <td>
                    <span className="whitespace-nowrap">{row.level}</span>{" "}
                    <span className="whitespace-nowrap">{row.name}</span>
                  </td>
                  <td>{row.question}</td>
                  <td>{row.how}</td>
                  <td className="text-brand-deep">{row.output}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>

        <dl className="mt-6 min-[800px]:hidden">
          {LEVELS.map((row) => (
            <div key={row.level} className="border-t border-hair py-4 first:border-t-brand-deep">
              <dt className="font-[family-name:var(--font-display)] font-semibold text-brand-deep">
                {row.level} {row.name}
              </dt>
              <dd className="mt-2 space-y-1 text-[0.8125rem] text-brand">
                <p>{row.question}</p>
                <p className="text-brand-lift">How: {row.how}</p>
                <p className="text-brand-deep">Output: {row.output}</p>
              </dd>
            </div>
          ))}
        </dl>

        {/* 2026-08-13 UX監査2巡目 [M5]: この §2 の L0–L3 と、API/SDK が今日返して
            いる trust score (0–100 / ALLOW-WARN-BLOCK) は別の物差しなのに、両方が
            同じサイトの上に無説明で並んでいた（/payee は "Level: L0" と
            "39 BLOCK" を同じ画面に出していた）。関係を書く場所はここ1箇所に決め、
            docs 側からはここへリンクする。実績の先取りをしないため、置き換えは
            すべて未来形で書く。 */}
        <div className="mt-8 flex gap-4">
          <span className="w-[4ch] shrink-0 text-brand-lift">2.1</span>
          <p className="min-w-0 max-w-[64ch] text-brand">
            The trust score this API returns today &mdash; 0&ndash;100, banded{" "}
            <span className="whitespace-nowrap">ALLOW / WARN / BLOCK</span> &mdash; predates these
            levels. It stays available to API and SDK callers during the transition. Observatory
            verdicts (L0&ndash;L2) replace it as they ship, and both will run side by side until
            then. A score is never reported as an L0&ndash;L2 result.{" "}
            <Link href="/docs/api#score-breakdown" className="doc-link">
              How the score is composed
            </Link>
            .
          </p>
        </div>

        {/* ================= 3. Evidence rules ================= */}
        <h2 id="evidence" className="sec-head scroll-mt-24">
          <span className="sec-no">3.</span>
          <span>What a verdict must carry</span>
        </h2>

        <div className="mt-6 space-y-5">
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">3.1</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              A failing verdict publishes with raw log, transaction hash, timestamp and reproduction
              steps &mdash; <strong>or it does not publish.</strong>
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">3.2</span>
            {/* 2026-08-13 UX監査R1 [D3]: 3ペルソナが独立に「ここは never "bad" と
                言うが、API は読めなかった入力に対して fail-closed の BLOCK を
                返す」と矛盾を指摘した。設計としては矛盾していない — 人に見せる
                面と、金を動かす直前の機械に返す答えは別物にしてある。その意図は
                docs（Payee score / Availability）と llms.txt には書いてあったが、
                この頁だけ半分しか言っていなかった。残りの半分を1行で足す。 */}
            <p className="min-w-0 max-w-[64ch] text-brand">
              Unverifiable is not a verdict. We say <strong>&quot;unverified&quot;</strong>, never
              &quot;bad&quot;. A caller about to move money gets the safe answer instead: a check
              that could not be completed returns a fail-closed{" "}
              <span className="whitespace-nowrap">BLOCK</span> to the API and the SDK, while the
              public page prints &ldquo;not verifiable right now&rdquo; and no number.{" "}
              <Link href="/docs/api#payee-score" className="doc-link">
                Why the two answers differ
              </Link>
              .
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">3.3</span>
            {/* 2026-08-13 UX監査R1 [C7][C8]: この2つの約束の実行先が UI のどこにも
                無かった。異議申立は ToS §8（全文の27%地点）だけ、訂正ログは
                2箇所で約束しながら該当ページが 404 だった。 */}
            <p className="min-w-0 max-w-[64ch] text-brand">
              Sellers can dispute any result and trigger a free re-verification.{" "}
              <Link href="/legal/terms#corrections" className="doc-link">
                How to dispute a result
              </Link>
              . Corrections are logged publicly &mdash;{" "}
              <Link href="/corrections" className="doc-link">
                the corrections log
              </Link>
              .
            </p>
          </div>
        </div>

        {/* ================= 4. Working today ================= */}
        <h2 id="working" className="sec-head scroll-mt-24">
          <span className="sec-no">4.</span>
          <span>Implemented and live</span>
        </h2>
        <p className="doc-p">
          Everything in this section is running right now and can be checked without asking us.
        </p>

        <div className="mt-6 divide-y divide-hair border-t border-brand-deep">
          <ItemRow
            state="live"
            title="The x402 Observatory"
            body={
              <>
                Every endpoint in the public discovery catalog, probed daily: is it still listed,
                and does its payment wall answer a valid 402. No purchase is attached to the
                public table.
              </>
            }
            action={{
              label: "Open the observatory",
              href: "/observatory",
              event: "lp_cta_click",
              position: "s4_observatory",
            }}
          />
          <ItemRow
            state="live"
            title="Verified Payee"
            body={
              <>
                Prove control of a wallet by signature, get a public verification page and an SVG
                badge.
              </>
            }
            action={{ label: "Verify a payee", href: "/payee", event: "lp_cta_click", position: "s4_payee" }}
          />
          {/* 2026-08-13 UX監査R1 [C4]: 3つのパッケージは npm に公開済み
              （いずれも 0.1.0）なのに、サイト全体で "npm" の文字が0件で、
              「middleware package」と書きながらインストール名がどこにも
              無かった。しかも npm には無関係の別ベンダーの `vouch-sdk` /
              `@getvouch/sdk` が実在するので、スコープ付きの正確な名前を
              名指しする必要がある。 */}
          <ItemRow
            state="live"
            title="Drop-in middleware, REST API and MCP tool"
            body={
              <>
                An x402 middleware package, a REST API, and an MCP tool that answers the question a
                spending agent should ask before it pays.
                <span className="mt-3 block text-[0.8125rem] text-brand-lift">
                  On npm:{" "}
                  <code className="break-all text-brand-deep">npm i @vet402/sdk</code>,{" "}
                  <code className="break-all text-brand-deep">@vet402/middleware</code>,{" "}
                  <code className="break-all text-brand-deep">@vet402/mcp-server</code>. The{" "}
                  <code className="text-brand-deep">@vouchscore</code> scope is the only one that
                  is ours &mdash; unscoped <code>vouch-sdk</code> and{" "}
                  <code>@getvouch/sdk</code> on npm are unrelated packages by other publishers.
                </span>
              </>
            }
            action={{ label: "API reference", href: "/docs/api", event: "docs_click", position: "s4_docs" }}
          />
          <ItemRow
            state="live"
            title="Public accuracy ledger"
            body={
              <>
                Every past verdict and its outcome, misfire rate included &mdash; published whether
                or not the numbers flatter us.
              </>
            }
            action={{ label: "Measured accuracy", href: "/accuracy", event: "docs_click", position: "s4_accuracy" }}
          />
          {/* 2026-08-26 L2 UX監査 #4: 実購買・オンチェーン領収・改ざん検知の
              最強の証拠ページ(/impact)へ、サイト内のどこからもリンクが無かった
              （LP内リンク0件・独立確認済み）。他行のコピーと同じ文体（RFC調・
              事実文・新規数字を作らない）で1行足す。 */}
          <ItemRow
            state="live"
            title="Impact ledger"
            body={
              <>
                Real purchases made and published with evidence &mdash; settled and failed alike
                &mdash; plus catalog coverage and a hash-anchored ledger (daily prev-hash chain;
                on-chain anchoring ships behind a flag, OFF by default), synthesized from the
                sections above into one page for grant reviewers and integrators.
              </>
            }
            action={{ label: "View impact", href: "/impact", event: "docs_click", position: "s4_impact" }}
          />
        </div>

        {/* ================= 5. The observatory ================= */}
        <h2 id="status" className="sec-head scroll-mt-24">
          <span className="sec-no">5.</span>
          <span>Status of this work</span>
        </h2>
        <p className="doc-p">
          Live work is in section 4. This section is only what has not shipped, and this page will
          not describe it as though it had.
        </p>

        <div className="mt-6 divide-y divide-hair border-t border-brand-deep">
          <ItemRow
            state="building"
            title="Writing to the empty registry"
            body={
              <>
                Verification records will be written to the ERC-8004 Validation Registry &mdash; the
                one registry that is still empty.
              </>
            }
          />
        </div>

        <div className="dashbox mt-8 max-w-[64ch]">
          <p className="doc-caption">Follow the build</p>
          <p className="mt-3 text-brand">
            <TrackedLink
              href="https://x.com/vet_402"
              event="follow_click"
              props={{ channel: "x" }}
              className="doc-link"
            >
              X @vet_402
            </TrackedLink>
            <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
            <TrackedLink
              href="https://github.com/kzmttkc/vet402"
              event="follow_click"
              props={{ channel: "github" }}
              className="doc-link"
            >
              GitHub
            </TrackedLink>
          </p>
        </div>

        {/* ================= Appendix A. Access tiers ================= */}
        <PricingSection />

        {/* ================= Appendix B. References ================= */}
        <h2 id="references" className="sec-head scroll-mt-24">
          <span className="sec-no">B.</span>
          <span>References</span>
        </h2>
        <dl className="mt-6 space-y-5 text-[0.8125rem]">
          <div id="ref-arxiv" className="flex flex-col gap-1 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-brand-deep sm:w-[16ch]">[ARXIV-2606]</dt>
            <dd className="min-w-0 max-w-[58ch] text-brand">
              98.7% of ERC-8004 reputation feedback on Ethereum has no verifiable transaction
              behind it. The paper reports this per chain; §1.2 quotes the Ethereum figure, which
              is the lowest of the three it measures.{" "}
              <a
                href="https://arxiv.org/abs/2606.26028"
                target="_blank"
                rel="noopener noreferrer"
                className="doc-link"
              >
                arXiv:2606.26028
              </a>
            </dd>
          </div>
          <div id="ref-artemis" className="flex flex-col gap-1 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-brand-deep sm:w-[16ch]">[VISA-ARTEMIS-2026]</dt>
            <dd className="min-w-0 max-w-[58ch] text-brand">
              Raw x402 activity of $135.7M across 178.3M transactions falls to $15.0M across 109.6M
              once wash and test transactions are excluded &mdash; 38.5% of transactions, 88.9% of
              volume. Visa and Artemis,{" "}
              <a
                href="https://www.visa.com/en-us/thought-leadership/innovation/agentic-payments-from-the-ground-up"
                target="_blank"
                rel="noopener noreferrer"
                className="doc-link"
              >
                Agentic Payments from the Ground Up
              </a>
              , July 2026; Artemis Analytics on-chain data as of April 21, 2026. The split between
              self-dealing and wash trading inside that excluded share is not published, so this
              page does not state one.
            </dd>
          </div>
        </dl>
      </article>
    </main>
  );
}

/**
 * ItemRow — one entry in §4 / §5. The state marker is the whole point of the
 * row: `live` means it runs today, `building` means it does not. Keeping the
 * two states in one visual grammar is what stops §5 from reading as a claim.
 */
function ItemRow({
  state,
  title,
  body,
  action,
}: {
  state: "live" | "building";
  title: string;
  body: React.ReactNode;
  action?: { label: string; href: string; event: string; position: string };
}) {
  return (
    <div className="flex flex-col gap-2 py-5 sm:flex-row sm:gap-6">
      <div className="shrink-0 sm:w-[14ch] sm:pt-0.5">
        <span className={state === "live" ? "marker marker-live" : "marker marker-plan"}>
          {state === "live" ? "implemented" : "building"}
        </span>
      </div>
      <div className="min-w-0 max-w-[58ch]">
        <p className="font-[family-name:var(--font-display)] font-semibold text-brand-deep">
          {title}
        </p>
        <p className="mt-2 text-brand">{body}</p>
        {action ? (
          <p className="mt-3">
            <TrackedLink
              href={action.href}
              event={action.event}
              props={{ position: action.position }}
              className="doc-link"
            >
              {action.label}
            </TrackedLink>
          </p>
        ) : null}
      </div>
    </div>
  );
}
