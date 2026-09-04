import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo";
import PartnersClient from "./partners-client";

/**
 * /partners — デザインパートナー・プログラム（C11/11）。
 * 条件は対称で公開: 無償で深く検証する代わりに、結果は良くても悪くても
 * 通常の公開ゲートで公開される（有利な扱いは存在しない——それが売り）。
 */

export const metadata: Metadata = pageMetadata({
  title: "Design partners",
  description:
    "Build with the verification layer early: agent builders get integration help, endpoint operators get priority verification — and every result publishes through the same gate as everyone else's.",
  path: "/partners",
});

export default function PartnersPage() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Design partner program</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/playground" className="underline">
                Playground
              </Link>
              {" · "}
              <Link href="/observatory" className="underline">
                Observatory
              </Link>
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Design Partners</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            We are looking for a handful of teams to build against the verification layer while
            it is early. <strong>Agent builders</strong> get direct integration help
            (SDK/MCP/LangChain/ElizaOS/solana-agent-kit, TypeScript and Python) and input on the
            API surface. <strong>Endpoint operators</strong> get priority verification via the{" "}
            <Link href="/observatory" className="underline">
              public request queue
            </Link>{" "}
            and a live receipt badge. Everything is free at this stage.
          </p>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>The one condition</span>
        </h2>
        <p className="doc-p">
          Results publish through the same gate as everyone else&apos;s — pass and fail alike,
          receipts included. There is no partner-only treatment of the record, because a
          verifier that sells favorable treatment is not a verifier. What partners shape is the
          <em> product</em> (APIs, integrations, definitions), never the <em>measurements</em>.
          Being measured more often is not favorable treatment and is not for sale either: four
          hosts are bought from on a shorter cadence because of the call volume the public catalog
          reports for them, that list is named in{" "}
          <Link href="/observatory/methodology" className="underline">
            the methodology
          </Link>
          , and the criterion is the catalog&apos;s own reported
          call volume rather than any relationship with us.
        </p>

        <PartnersClient />
      </article>
    </main>
  );
}
