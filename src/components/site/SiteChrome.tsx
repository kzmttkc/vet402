"use client";

/**
 * Wraps children with the standard marketing SiteHeader/SiteFooter, except on
 * /dashboard/*, which already renders its own app shell (DashboardShell) with
 * its own top nav — stacking the marketing header/footer there would double
 * up navigation chrome and break the dashboard layout.
 */

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { StatusBanner } from "@/components/site/StatusBanner";
import { buttonClass } from "@/components/ui/Button";

export function SiteChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isDashboard = pathname?.startsWith("/dashboard");

  // 2026-08-13 アクセシビリティ監査 [E3]: クライアント側のルート遷移のあと
  // document.activeElement が BODY に落ちていた。ブラウザの通常の読込なら
  // それが既定の挙動だが、SPA 遷移では「文書が変わったこと」も「どこから
  // 読み始めればいいか」も、キーボードとスクリーンリーダの利用者には何も
  // 伝わらない — 毎回ヘッダの先頭から Tab を打ち直すことになる。
  // 初回描画では動かさない（通常の読込のフォーカス位置を奪わない）。
  const mainRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // preventScroll: Next.js のスクロール復元と競合させない。
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  if (isDashboard) {
    return <>{children}</>;
  }

  return (
    <>
      {/* 2026-08-06 a11y (keyboard persona audit): there was no skip link
          anywhere on the site (zero in-page anchors, and <main> had no id), so
          every keyboard and screen-reader user tabbed through 9 header links
          before reaching the content — on every single page. Standard pattern:
          visually hidden until focused, first element in the tab order. The
          target needs tabIndex={-1} because a plain <div> is not focusable and
          some browsers would otherwise scroll without moving focus. */}
      <a
        href="#main-content"
        className={buttonClass({ className: "sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50" })}
      >
        Skip to main content
      </a>
      <StatusBanner />
      <SiteHeader />
      <div id="main-content" ref={mainRef} tabIndex={-1} className="min-w-0 flex-1">
        {children}
      </div>
      <SiteFooter />
    </>
  );
}
