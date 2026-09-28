import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo";

/**
 * /operations — AI運営企業の透明性ページ（C11/15）。
 * 「信じてくれ」ではなく「検算してくれ」を運営体制にも適用する。
 * 書いてよいのは検証可能な事実だけ——このページの各主張には
 * 確かめる手段を必ず併記する。
 */

export const metadata: Metadata = pageMetadata({
  title: "Operations — an AI-operated verifier, verifiably",
  description:
    "vet402 is operated day-to-day by an AI under human approval gates for money and external actions. This page states how, with the means to verify each claim.",
  path: "/operations",
});

export default function OperationsPage() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Operating model, stated verifiably</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory" className="underline">
                Observatory
              </Link>
              {" · "}
              <Link href="/observatory/methodology" className="underline">
                Methodology
              </Link>
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Operations</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            vet402 is operated day-to-day by an AI, directed by a human owner who holds the
            approval gates that matter: money leaving a wallet, anything sent or published
            outside, and new financial commitments. We state this openly because a verifier&apos;s
            own operations should survive the same scrutiny it applies to others — every claim
            below names the way to check it.
          </p>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>What runs without a human</span>
        </h2>
        <p className="doc-p">
          Daily catalog sync, L0 probes, budget-capped L1 purchases, metrics rollup, and the
          ledger hash chain run on schedule with no human in the loop.{" "}
          <strong>Verify:</strong> the cadence is visible in the data itself —{" "}
          <code>/api/v1/observatory/history</code> shows daily rows;{" "}
          <code>/api/v1/observatory/anchors</code> chains each day&apos;s ledger; the code that
          does it is open source (MIT), commit history included.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>What requires the human owner</span>
        </h2>
        <p className="doc-p">
          Funding any wallet, enabling any flag that spends (Solana purchases, on-chain registry
          writes, ledger anchoring), publishing to package registries, outbound email or posts,
          and any paid engagement. <strong>Verify:</strong> the flags ship OFF in the open-source
          defaults (<code>.env.example</code>); spend-bearing paths carry hard budget reservations
          you can read in <code>src/lib/observatory/l1-runner.ts</code>.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>Why this is stated at all</span>
        </h2>
        <p className="doc-p">
          Continuity: an operator you can replace is an operator you can trust long-term. The
          entire operation — runbooks, schedules, budget gates, publication rules — exists as
          code and documents in the repository, not in anyone&apos;s head.{" "}
          <Link href="/docs/api" className="underline">
            API reference
          </Link>
          {" · "}
          <a className="underline" href="https://github.com/kzmttkc/vet402">
            source
          </a>
          .
        </p>
      </article>
    </main>
  );
}
