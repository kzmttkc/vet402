import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo";
import LiveClient from "./live-client";

/**
 * /live — 台帳のライブフィード（C10）。演出ゼロ: 流れるのは実際に
 * 書かれた行だけで、静かな時間は静かに見える（それが日次測定の事実）。
 */

export const metadata: Metadata = pageMetadata({
  title: "Live — the ledger as it happens",
  description:
    "New L0 probes and real L1 purchases, streamed as they are written. No simulation — quiet periods look quiet.",
  path: "/live",
});

export default function LivePage() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Live: rows as they land</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory" className="underline">
                Observatory
              </Link>
              {" · "}
              <Link href="/observatory/state" className="underline">
                State of x402
              </Link>
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-8">Live</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            Every row below is a fact the moment it is written: an L0 probe answering whether a
            payment wall responded correctly, or an L1 <strong>real purchase</strong> with its
            settlement outcome. Nothing here is simulated, smoothed, or replayed — when the daily
            runs are idle, the feed is idle. Definitions:{" "}
            <Link href="/observatory/methodology" className="underline">
              methodology
            </Link>
            .
          </p>
        </div>

        <LiveClient />
      </article>
    </main>
  );
}
