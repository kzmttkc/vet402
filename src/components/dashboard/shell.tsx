"use client";

import Link from "next/link";
import { Wordmark } from "@/components/site/Wordmark";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { dashboardLogout } from "@/lib/dashboard/client";
import { dashboardErrorMessage } from "@/lib/dashboard/errors";
import { buttonClass } from "@/components/ui/Button";

const nav = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/lookup", label: "Lookup" },
  { href: "/dashboard/settlements", label: "Settlements" },
  { href: "/dashboard/lists", label: "Lists" },
  { href: "/dashboard/keys", label: "API keys" },
  { href: "/dashboard/billing", label: "Billing" },
  { href: "/dashboard/integrations", label: "Integrations" },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/dashboard/login";
  const [ready, setReady] = useState(isLogin);
  const [serviceError, setServiceError] = useState<string | null>(null);

  // 2026-08-15 (B3 a11y): SiteChrome の同じ対処をここにも。7個のサイドバー
  // タブをクライアント側 <Link> で行き来しても、フォーカスは前のリンクに
  // 残ったまま——キーボード/スクリーンリーダ利用者には遷移が起きたことも
  // どこから読めばいいかも伝わらない。初回描画では動かさない。
  const mainRef = useRef<HTMLElement>(null);
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    if (isLogin) return;

    let cancelled = false;

    fetch("/api/dashboard/overview", { credentials: "include" })
      .then(async (response) => {
        if (cancelled) return;

        if (response.status === 401 || response.status === 403) {
          router.replace("/dashboard/login");
          return;
        }

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setServiceError(data.error ?? "service_unavailable");
          setReady(true);
          return;
        }

        setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setServiceError("connection_failed");
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isLogin, router]);

  async function logout() {
    await dashboardLogout();
    router.push("/dashboard/login");
  }

  // 2026-08-14 完全性の穴（本番精査）: /dashboard 系は自前シェルで SiteChrome を
  // 迂回するため、他の全ページに出るフッタ（Legal Notice / Privacy / Terms /
  // Contact）がここだけ欠けていた。特にログイン画面は法務/連絡先への導線が皆無
  // だった。
  // 2026-09-02 デザイン監査 P1: そのとき流用した SiteFooter は RFC の奥付で、zinc の
  // 画面に紙の世界が混ざっていた（DESIGN.md「混ぜない」）。同じ 4 リンクを zinc の
  // 1 行フッタで出す。
  if (isLogin) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-50">
        <div className="flex-1">{children}</div>
        <DashboardFooter />
      </div>
    );
  }

  if (!ready) {
    return <DashboardLoading />;
  }

  if (serviceError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
        <div className="dash-card max-w-md text-center">
          <p className="text-sm text-red-700">{dashboardErrorMessage(serviceError)}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={buttonClass({ className: "mt-4" })}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900">
      {/* Skip link — the dashboard has its own chrome (SiteChrome is bypassed
          here), so it needs its own. Eight sidebar links otherwise sit between
          the top of the tab order and the page content on every view. */}
      <a
        href="#dashboard-main"
        className={buttonClass({ className: "sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50" })}
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-baseline gap-3">
            <Wordmark className="text-[1.0625rem] leading-none" />
            <h1 className="font-[family-name:var(--font-display)] text-[0.8125rem] font-semibold text-zinc-500">
              Dashboard
            </h1>
          </div>
          <button
            type="button"
            onClick={logout}
            className="rounded-[2px] px-2 py-1.5 text-[0.8125rem] text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-1 gap-8 px-6 py-8 lg:grid-cols-[200px_minmax(0,1fr)]">
        <details className="dash-card-flush lg:hidden">
          <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800">
            Menu
          </summary>
          <nav className="space-y-0.5 border-t border-zinc-200 p-2">{navLinks(pathname)}</nav>
        </details>
        <nav className="hidden self-start lg:sticky lg:top-[4.5rem] lg:block lg:border-r lg:border-zinc-200 lg:pr-6">
          <div className="space-y-0.5">{navLinks(pathname)}</div>
        </nav>
        <main id="dashboard-main" ref={mainRef} tabIndex={-1} className="min-w-0">
          {children}
        </main>
      </div>
      <DashboardFooter />
    </div>
  );
}

const footerLinks = [
  { label: "Terms", href: "/legal/terms" },
  { label: "Privacy", href: "/legal/privacy" },
  { label: "Legal notice", href: "/legal/notice" },
  { label: "Contact", href: "/legal/notice#contact" },
];

/** zinc の 1 行フッタ。リンク先は SiteFooter の法務 4 本と同じ（正典は /legal）。 */
function DashboardFooter() {
  return (
    <footer className="border-t border-zinc-200 bg-white">
      <nav
        aria-label="Legal"
        className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 px-6 py-4 text-[0.75rem] text-zinc-500"
      >
        {footerLinks.map((item, i) => (
          <span key={item.href} className="inline-flex items-center">
            {i > 0 && (
              <span aria-hidden="true" className="px-2">
                ·
              </span>
            )}
            <Link href={item.href} className="hover:text-zinc-900 hover:underline">
              {item.label}
            </Link>
          </span>
        ))}
      </nav>
    </footer>
  );
}

function navLinks(pathname: string) {
  return nav.map((item) => {
    const active = pathname === item.href;
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`block rounded-[2px] px-3 py-2 text-[0.8125rem] ${
          active
            ? "bg-brand-deep font-medium text-white"
            : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
        }`}
      >
        {item.label}
      </Link>
    );
  });
}

function DashboardLoading() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 8_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 px-6">
      <div className="flex w-full max-w-xs flex-col gap-2">
        <div className="dash-skel w-2/3" />
        <div className="dash-skel w-full" />
        <div className="dash-skel w-5/6" />
      </div>
      <p className="text-sm text-zinc-600">
        {slow ? "Still loading. If this persists, refresh or sign in again." : "Loading dashboard…"}
      </p>
      {slow ? (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={buttonClass()}
        >
          Retry
        </button>
      ) : null}
      <noscript>
        <p className="max-w-sm rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-center text-amber-900">
          The dashboard needs JavaScript and will not finish loading without it. The same data is
          available from the API — see the{" "}
          <a className="underline" href="/docs/api">
            API reference
          </a>
          .
        </p>
      </noscript>
    </div>
  );
}
