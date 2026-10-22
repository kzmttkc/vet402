import Link from "next/link";
import type { Metadata } from "next";

// 2026-08-13: カスタム404。フレームワーク既定の白紙ページは RFC 紙面の
// 世界観から完全に外れるため、faq/page.tsx と同じ紙面文法（sheet /
// doc-head / doc-title / rule-double / doc-link）で組む。ヘッダ・フッタは
// layout.tsx の SiteChrome が自動で付く。文言は事実語のみ。
export const metadata: Metadata = {
  title: "404 Not Found",
};

export default function NotFound() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Status report</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">404 Not Found</h1>
        <p className="mx-auto mt-3 max-w-[56ch] text-center text-brand-lift">
          The requested path does not exist on this server.
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <p className="mt-8 text-center text-[0.84375rem]">
          <Link href="/" className="doc-link">
            Home
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">
            ·
          </span>
          <Link href="/payee" className="doc-link">
            Verify a payee
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">
            ·
          </span>
          <Link href="/docs/api" className="doc-link">
            Docs
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">
            ·
          </span>
          <Link href="/observatory" className="doc-link">
            Observatory
          </Link>
        </p>
      </article>
    </main>
  );
}
