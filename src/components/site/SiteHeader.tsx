"use client";

/**
 * SiteHeader — the running head of the document.
 *
 * 2026-08-13 vet402: rebuilt in the RFC plaintext world. The bar sits on the
 * ground colour (not on paper) so the sheet below reads as a separate object,
 * and it closes with the single navy rule that opens every RFC page.
 *
 * The mobile toggle is the word [menu] / [close], not a hamburger. This world
 * has no icon system, and craft-floor is explicit that unicode glyphs standing
 * in for icons are a failure — in a plaintext document the honest control is
 * the bracketed word, which is also what a screen reader was going to say
 * anyway. The 44px hit area is unchanged.
 *
 * Vouch is Web3/stealth (pseudonymous), English-only, so no product name
 * localization or language switcher is needed here.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import { Wordmark } from "@/components/site/Wordmark";
import TrackedLink from "@/components/site/TrackedLink";

type NavItem = { label: string; href: string };

// 5項目まで。ヘッダの内寸は紙面と同じ幅に揃えてあり（下の max-w）、7項目では
// 収まらない。Accuracy / Leaderboard / Blog はフッタの索引に載っているので、上には
// 「読む・測る・試す・繋ぐ」の主導線だけを置く。観測所は公開の実測であり、
// スコア帳 Accuracy より先に辿り着ける必要がある。
const NAV_ITEMS: NavItem[] = [
  { label: "Method", href: "/#methodology" },
  { label: "Observatory", href: "/observatory" },
  { label: "Verify", href: "/payee" },
  { label: "Docs", href: "/docs/api" },
  { label: "FAQ", href: "/faq" },
];

// モバイルの抽斗にだけ出す二次動線。デスクトップではフッタの索引/奥付が担う。
// 2026-08-14: 非開発者ペルソナ（P2/P3/P6）が「誰が運営しているか」に辿り着け
// なかった。デスクトップはフッタ Operator 欄に Legal Notice があるが、モバイルの
// [menu] には運営者への導線が1本も無かったので About（=運営者情報の Legal
// Notice）を足す。新規ページは作らず既存の /legal/notice へ繋ぐだけ。
const NAV_SECONDARY: NavItem[] = [
  { label: "Accuracy", href: "/accuracy" },
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "Status", href: "/status" },
  { label: "Blog", href: "/blog" },
  { label: "About", href: "/legal/notice" },
];

export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // 2026-08-06 a11y (keyboard persona audit): the mobile panel could be opened
  // but Escape did nothing, so a keyboard user had to tab back through the
  // whole drawer to dismiss it. Deliberately NOT a focus trap: this is an
  // inline disclosure, not a modal (no role="dialog", no aria-modal, no inert,
  // body scroll untouched), and ARIA APG does not want a trap here — Escape
  // plus returning focus to the toggle is the whole contract.
  useEffect(() => {
    if (!mobileOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMobileOpen(false);
      toggleRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-brand-deep bg-ground">
      {/* 走り出しを紙面の本文列にぴたりと合わせる。外側が main と同じ余白、内側が
          .sheet と同じ余白で、max-width も同じ式（72ch + 紙の左右余白）。これで
          ワードマークの左端が Abstract の左端と 1px も違わずに揃う。
          検分1回目の実測ではナビが 1440px 全幅・紙が 763px で、どの端も一致して
          いなかった。罫線だけは全幅で引く（RFC の走り出し罫）。 */}
      <div className="px-4 sm:px-6 md:px-8">
        <div className="mx-auto flex h-14 w-full max-w-[var(--column)] items-center justify-between gap-6 px-[var(--sheet-pad)]">
          <Link href="/" className="shrink-0">
            <Wordmark className="text-[1.0625rem] leading-none" />
          </Link>

          <nav
            aria-label="Main navigation"
            className="hidden items-center gap-5 text-[0.8125rem] text-brand-lift md:flex"
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
                className="hover:text-brand-deep"
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
              className="text-[0.8125rem] text-brand-lift hover:text-brand-deep"
            >
              Dashboard
            </TrackedLink>
            <TrackedLink
              href="/signup"
              event="lp_cta_click"
              props={{ position: "header_signup" }}
              className={buttonClass()}
            >
              Get API key
            </TrackedLink>
          </div>

          <button
            ref={toggleRef}
            type="button"
            aria-expanded={mobileOpen}
            className="-mr-2 flex h-11 w-16 items-center justify-end text-[0.8125rem] text-brand-deep md:hidden"
            onClick={() => setMobileOpen((v) => !v)}
          >
            {mobileOpen ? "[close]" : "[menu]"}
          </button>
        </div>
      </div>

      {mobileOpen ? (
        // 2026-08-06 (landscape persona audit A-2): the open drawer made this
        // sticky header 422px tall. A sticky element taller than the viewport
        // does not move when you scroll, so on any phone in landscape (320-430px
        // tall) the bottom of the drawer — Dashboard and the primary "Get API
        // key" CTA — was permanently off-screen and physically untappable.
        // Capping the drawer at the space below the bar and letting it scroll
        // internally makes every item reachable at any viewport height.
        <nav
          aria-label="Mobile navigation"
          className="flex max-h-[calc(100dvh-3.5rem)] flex-col overflow-y-auto overscroll-contain border-t border-hair bg-paper px-5 py-3 md:hidden"
        >
          {[...NAV_ITEMS, ...NAV_SECONDARY].map((item) => (
            <TrackedLink
              key={item.href}
              href={item.href}
              event="nav_click"
              props={{ label: item.label }}
              className="border-b border-hair py-3 text-sm text-brand hover:text-brand-deep"
              onClick={() => setMobileOpen(false)}
            >
              {item.label}
            </TrackedLink>
          ))}
          <TrackedLink
            href="/dashboard/login"
            event="nav_click"
            props={{ label: "Dashboard" }}
            className="border-b border-hair py-3 text-sm text-brand hover:text-brand-deep"
            onClick={() => setMobileOpen(false)}
          >
            Dashboard
          </TrackedLink>
          <TrackedLink
            href="/signup"
            event="lp_cta_click"
            props={{ position: "drawer_signup" }}
            className={buttonClass({ className: "mt-4 w-full" })}
            onClick={() => setMobileOpen(false)}
          >
            Get API key
          </TrackedLink>
        </nav>
      ) : null}
    </header>
  );
}
