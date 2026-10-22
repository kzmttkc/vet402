"use client";

/**
 * SiteHeader — the running head of the document.
 *
 * 2026-08-13 vet402: rebuilt in the RFC plaintext world. The bar sits on the
 * ground colour (not on paper) so the sheet below reads as a separate object,
 * and it closes with the single navy rule that opens every RFC page.
 *
 * The mobile control is a <details> disclosure. The summary reads Menu, and
 * Close while it is open. The links are in the first HTML, so the list opens
 * before any script runs. JavaScript only sets aria-current for the page
 * the reader is on. The 44px hit area is unchanged.
 *
 * Vouch is Web3/stealth (pseudonymous), English-only, so no product name
 * localization or language switcher is needed here.
 */

import { usePathname } from "next/navigation";
import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import { Wordmark } from "@/components/site/Wordmark";
import TrackedLink from "@/components/site/TrackedLink";

// wideOnly: 1024px 以上だけヘッダに出す（それ未満の md 幅では入り切らない。抽斗には常に出る）。
type NavItem = { label: string; href: string; wideOnly?: boolean };

// 5項目まで。ヘッダの内寸は紙面と同じ幅に揃えてあり（下の max-w）、7項目では
// 収まらない。Accuracy / Leaderboard / Blog はフッタの索引に載っているので、上には
// 「読む・測る・試す・繋ぐ」の主導線だけを置く。観測所は公開の実測であり、
// スコア帳 Accuracy より先に辿り着ける必要がある。
// 2026-09-28 監査: 売り手が自分の購入結果を探す入口 /sellers がナビに無く、トップの本文からしか
// 辿れなかった。観測所の隣に置く。6 項目は 768px 幅で右端の「Get API key」が 46px はみ出した
// （実測 scrollWidth 813）ので、Method（トップの節へのアンカー）は 1024px 以上だけに出し、
// md 幅の間隔を 1 段詰める。
const NAV_ITEMS: NavItem[] = [
  { label: "Method", href: "/#methodology", wideOnly: true },
  { label: "Observatory", href: "/observatory" },
  { label: "Sellers", href: "/sellers" },
  { label: "Verify", href: "/payee" },
  { label: "Docs", href: "/docs/api" },
  { label: "FAQ", href: "/faq" },
];

// モバイルの抽斗にだけ出す二次動線。デスクトップではフッタの索引/奥付が担う。
// 2026-08-14: 非開発者ペルソナ（P2/P3/P6）が「誰が運営しているか」に辿り着け
// なかった。デスクトップはフッタ Operator 欄に Legal Notice があるが、モバイルの
// Menu には運営者への導線が1本も無かったので About（=運営者情報の Legal
// Notice）を足す。新規ページは作らず既存の /legal/notice へ繋ぐだけ。
const NAV_SECONDARY: NavItem[] = [
  { label: "Accuracy", href: "/accuracy" },
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "Status", href: "/status" },
  { label: "Blog", href: "/blog" },
  { label: "About", href: "/legal/notice" },
];

// 節アンカー（/#methodology）は頁そのものではないので現在地にしない。
function currentNav(pathname: string, href: string): "page" | undefined {
  if (href.includes("#")) return undefined;
  if (pathname === href || (href !== "/" && pathname.startsWith(`${href}/`))) return "page";
  return undefined;
}

export function SiteHeader() {
  const pathname = usePathname() ?? "";

  return (
    <header className="site-header sticky top-0 z-40 border-b border-brand-deep bg-ground">
      <div className="px-4 sm:px-6 md:px-8">
        {/* 走り出しを紙面の本文列にぴたりと合わせる。外側が main と同じ余白、内側が
            .sheet と同じ余白で、max-width も同じ式（72ch + 紙の左右余白）。これで
            ワードマークの左端が Abstract の左端と 1px も違わずに揃う。
            検分1回目の実測ではナビが 1440px 全幅・紙が 763px で、どの端も一致して
            いなかった。罫線だけは全幅で引く（RFC の走り出し罫）。 */}
        <div className="mx-auto flex h-14 w-full max-w-[var(--column)] items-center justify-between gap-6 px-[var(--sheet-pad)]">
          <Link href="/" className="inline-flex h-11 shrink-0 items-center">
            <Wordmark className="text-[1.0625rem] leading-none" />
          </Link>

          <nav
            aria-label="Main navigation"
            className="hidden items-center gap-4 text-[0.84375rem] text-brand-lift md:flex lg:gap-6"
          >
            {/* 2026-09-02 敵対的監査 F8: header の主 CTA と nav に計測がなく、LP 側の
                lp_cta_click{position} だけでは「どの入口が効いたか」の分母が欠けていた。
                nav は nav_click{label}、署名は lp_cta_click{header_signup|drawer_signup}。 */}
            {NAV_ITEMS.map((item) => (
              <TrackedLink
                key={item.href}
                href={item.href}
                event="nav_click"
                props={{ label: item.label }}
                ariaCurrent={currentNav(pathname, item.href)}
                className={item.wideOnly ? "hidden h-11 items-center hover:text-brand-deep lg:inline-flex" : "inline-flex h-11 items-center hover:text-brand-deep"}
              >
                {item.label}
              </TrackedLink>
            ))}
          </nav>

          <div className="hidden shrink-0 items-center gap-4 md:flex">
            <TrackedLink
              href="/dashboard/login"
              event="nav_click"
              props={{ label: "Dashboard" }}
              ariaCurrent={currentNav(pathname, "/dashboard/login")}
              className="inline-flex h-11 items-center text-[0.84375rem] text-brand-lift hover:text-brand-deep"
            >
              Dashboard
            </TrackedLink>
            <TrackedLink
              href="/signup"
              event="lp_cta_click"
              props={{ position: "header_signup" }}
              ariaCurrent={currentNav(pathname, "/signup")}
              className={buttonClass()}
            >
              Get API key
            </TrackedLink>
          </div>

          {/* 要約は以前のボタンと同じ枠（右端、44px）。一覧は details の中にあり、
              開くまで出ない。hidden にはしないので、スクリプト無しでも開く。
              開いた一覧はバーの下へ全幅で重なる。高さは残り画面で内部スクロール
              （2026-08-06 landscape: sticky が画面より高くなると下の項目に届かない）。 */}
          <details key={pathname} className="site-menu md:hidden">
            <summary className="-mr-2 flex h-11 w-16 cursor-pointer list-none items-center justify-end text-[0.84375rem] text-brand-deep">
              <span className="site-menu-open">Menu</span>
              <span className="site-menu-close">Close</span>
            </summary>
            <nav
              aria-label="Mobile navigation"
              // 一覧のリンクを押したら閉じる。pathname が変わらない遷移（/#methodology、今いる頁）でも
              // 一覧が本文に重なったまま残らないように（2026-10-21 点検 中）。スクリプト無しは全頁読み込みで閉じる。
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a")) e.currentTarget.closest("details")?.removeAttribute("open");
              }}
              className="absolute left-0 right-0 top-full z-40 max-h-[calc(100dvh-3.5rem)] overflow-y-auto overscroll-contain border-t border-hair bg-paper px-5 py-3"
            >
            {[...NAV_ITEMS, ...NAV_SECONDARY].map((item) => (
              <TrackedLink
                key={item.href}
                href={item.href}
                event="nav_click"
                props={{ label: item.label }}
                ariaCurrent={currentNav(pathname, item.href)}
                className="min-h-11 border-b border-hair py-3 text-[0.84375rem] text-brand hover:text-brand-deep"
              >
                {item.label}
              </TrackedLink>
            ))}
            <TrackedLink
              href="/dashboard/login"
              event="nav_click"
              props={{ label: "Dashboard" }}
              ariaCurrent={currentNav(pathname, "/dashboard/login")}
              className="min-h-11 border-b border-hair py-3 text-[0.84375rem] text-brand hover:text-brand-deep"
            >
              Dashboard
            </TrackedLink>
            <TrackedLink
              href="/signup"
              event="lp_cta_click"
              props={{ position: "drawer_signup" }}
              ariaCurrent={currentNav(pathname, "/signup")}
              className={buttonClass({ className: "mt-4 w-full" })}
            >
              Get API key
            </TrackedLink>
          </nav>
        </details>
        </div>
      </div>
    </header>
  );
}
