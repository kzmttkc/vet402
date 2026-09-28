import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo";
import SubscriptionAction from "@/components/site/SubscriptionAction";

/**
 * /observatory/confirm — メール内リンクの着地頁（2026-09-28 監査）。
 * GET では何も書かない（DB に触れない）。変わるのはボタンの POST だけ。
 * トークンは # の後ろにあり、この頁のサーバ描画には届かない。
 */

export const metadata: Metadata = pageMetadata({
  title: "Confirm your email",
  description: "Confirm that you want one email each time an endpoint record's public verdict changes.",
  path: "/observatory/confirm",
  noindex: true,
});

export default function Page() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Endpoint record emails</span>
            <span>Double opt-in</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory" className="underline">
                Back to the register
              </Link>
            </span>
          </div>
        </div>
        <h1 className="doc-title mt-10">Confirm your email</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        <div className="mt-8">
          <SubscriptionAction mode="confirm" />
        </div>
      </article>
    </main>
  );
}
