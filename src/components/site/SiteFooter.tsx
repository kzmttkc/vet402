/**
 * SiteFooter — the page foot of the document.
 *
 * 2026-08-13 vet402: the three-part RFC page foot
 * (`vet402 · Building in public · [Page 1]`) closes every page, under the
 * double rule that opens a memo's back matter. The index below it is set as an
 * RFC index, not as a marketing sitemap.
 *
 * Vouch is a stealth/pseudonymous Web3 product (mode B minimal disclosure,
 * see legal_requirements.md #4). Mode B withholds the operator's *personal*
 * identifiers (legal name, address, phone) — those stay disclosure-on-request.
 * It does not withhold the trade name: per brand.md (2026-07-31 Takeshi ruling,
 * which postdates legal_requirements.md), every product carries KIZUNA Creation
 * as the maker. Vouch has no locale switching — it is English throughout — so
 * it follows Banto's English-locale page, which renders the credit in ASCII
 * parens. Contact remains email-only. B2B API billing, when enabled, lives on
 * the dashboard; consumer mail-order billing is not live. /legal/notice
 * explains the disclosure scope.
 */

import Link from "next/link";
import { Wordmark } from "@/components/site/Wordmark";

// 2026-09-02 Takeshi「フッターのバランスが悪い。本当に必要なものだけ残し、配置と内容を最適化」。
// それまでは Index 11 / Operator 6 / Cite 2 の 3 列で、左だけが長い索引だった。
// 3 列を「測定の記録 / 使う / 会社」に組み直して 5 / 4 / 4 に揃え、法務と機械向けは
// 1 行の小さな列に落とす（読者の次の一手ではないが、無いと約束を破る）。
// 落としたもの: Leaderboard と Measured accuracy（ヘッダの副ナビと LP §4 から到達できる。
// /accuracy は 2026-09-02 時点で 3 表とも 0 件で、奥付から誘導する先ではない）。
// 足したもの: Impact ledger と Decisions（監査で inbound が LP の 1 本だけと判明。
// 審査員が見る実購買の証拠ページが索引に無いのは、索引の役目を果たしていない）。
const COLUMNS: { caption: string; label: string; links: { label: string; href: string }[] }[] = [
  {
    caption: "Measurements",
    label: "Measurement records",
    links: [
      { label: "Observatory", href: "/observatory" },
      { label: "State of x402", href: "/observatory/state" },
      { label: "Impact ledger", href: "/impact" },
      { label: "Decisions", href: "/decisions" },
      // 2026-08-13 UX監査R1 [C8]: 「Corrections are logged publicly」の約束の帳簿。
      { label: "Corrections", href: "/corrections" },
    ],
  },
  {
    caption: "Use",
    label: "Use vet402",
    links: [
      { label: "API reference", href: "/docs/api" },
      { label: "Get an API key", href: "/signup" },
      { label: "Dashboard", href: "/dashboard" },
      { label: "Verify a payee", href: "/payee" },
    ],
  },
  {
    caption: "About",
    label: "About vet402",
    links: [
      { label: "FAQ", href: "/faq" },
      { label: "Blog", href: "/blog" },
      { label: "Status", href: "/status" },
      // 2026-08-14: 公開の運営者介入ログ（credible-neutrality の担保）。
      { label: "Operator log", href: "/operator-log" },
    ],
  },
];

// 法務と機械向け。約束として要るが、初見の読者の次の一手ではないので 1 行に落とす。
const SMALL_PRINT_LINKS = [
  { label: "Terms", href: "/legal/terms" },
  { label: "Privacy", href: "/legal/privacy" },
  { label: "Legal notice", href: "/legal/notice" },
  { label: "Contact", href: "/legal/notice#contact" },
  { label: "RSS", href: "/blog/rss.xml" },
  { label: "llms.txt", href: "/llms.txt" },
];

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    // ヘッダと同じ式で紙面の本文列に揃える（外は main と同じ余白、内は .sheet と
    // 同じ余白）。奥付が本文と同じ走り出しに乗る。
    <footer className="mt-16 bg-ground px-4 pb-12 sm:px-6 md:px-8">
      <div className="mx-auto w-full max-w-[var(--column)] px-[var(--sheet-pad)] pt-1">
        <div className="rule-double" />

        {/* RFC page foot — three parts, left / centre / right. */}
        <div className="flex items-baseline justify-between gap-3 pt-3 text-[0.8125rem] text-brand-lift">
          <Wordmark className="text-[0.8125rem]" />
          <span className="hidden sm:inline">Building in public</span>
          <span>[Page 1]</span>
        </div>

        {/* 3 列 5/4/4。640px 未満は 1 列に積む（2 列だと 3 列目が孤立して段が崩れる）。 */}
        <div className="mt-10 grid gap-8 sm:grid-cols-3">
          {COLUMNS.map((col) => (
            <nav key={col.caption} aria-label={col.label}>
              <p className="doc-caption">{col.caption}</p>
              <ul className="mt-4 space-y-2 text-sm">
                {col.links.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} className="text-brand hover:text-brand-deep">
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <nav aria-label="Legal and machine-readable" className="mt-10 border-t border-hair pt-5">
          <ul className="flex flex-wrap gap-x-2 gap-y-1 text-[0.8125rem] text-brand-lift">
            {SMALL_PRINT_LINKS.map((item, i) => (
              <li key={item.href} className="flex items-center gap-x-2">
                {i > 0 && <span aria-hidden="true">·</span>}
                <Link href={item.href} className="hover:text-brand-deep">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* 免責は 1 文。奥付の責任主体（KIZUNA Creation）だけ本文色で読み取りやすく。 */}
        <p className="mt-5 max-w-[72ch] text-[0.8125rem] leading-relaxed text-brand-lift">
          © {year} vet402 (<span className="text-brand">KIZUNA Creation</span>). Results are
          measurements offered for B2B API use — not a guarantee, credit assessment, or legal
          certification.
        </p>
      </div>
    </footer>
  );
}
