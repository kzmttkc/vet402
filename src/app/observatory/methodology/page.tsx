import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { safeJsonLd } from "@/lib/util/json-ld";
import TrackView from "@/components/site/TrackView";
import {
  MIN_CONSECUTIVE_FAILS_TO_PUBLISH,
} from "@/lib/observatory/l0-probe";
import { SETTLE_DROP_MIN_PREV_CALLS, SETTLE_DROP_RATIO } from "@/lib/observatory/catalog-diff";
import { SWEEP_WINDOW_DAYS } from "@/lib/observatory/l1-runner";
import { MAX_PER_PURCHASE_UNITS } from "@/lib/observatory/x402-payer";
import { DAILY_BUDGET_USD } from "@/lib/observatory/budget";

const MAX_PER_PURCHASE_USD = Number(MAX_PER_PURCHASE_UNITS) / 1_000_000;

/**
 * /observatory/methodology — the definitions page (design §5).
 *
 * Everything the observatory publishes points here. The page states what is
 * measured, what is NOT measurable without purchasing, and the two fairness
 * commitments: unverified ≠ failure, and no special treatment for our own
 * listings (a verifier that special-cases itself is flagging its own fraud).
 */

export const metadata: Metadata = pageMetadata({
  title: "Observatory methodology",
  description:
    "Definitions behind the x402 Observatory: L0 liveness probes, L1 real-money settle-through purchases, L2 structural conformance checks, and how delisting is detected.",
  path: "/observatory/methodology",
});

export const revalidate = 3600;

export default async function ObservatoryMethodologyPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Observatory", path: "/observatory" },
    { name: "Methodology", path: "/observatory/methodology" },
  ]);
  const article = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: "Observatory methodology",
    description:
      "Definitions behind the x402 Observatory: L0 liveness probes, L1 real-money settle-through purchases, L2 structural conformance checks, and how delisting is detected.",
    url: `${SITE_URL}/observatory/methodology`,
    dateModified: "2026-08-15",
    author: { "@type": "Organization", name: "vet402", url: SITE_URL },
    publisher: { "@type": "Organization", name: "vet402", url: SITE_URL },
    inLanguage: "en",
  };

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <TrackView event="methodology_view" />
      <article className="sheet">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }}
        />

        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Methodology: L0, L1, L2</span>
            <span>Version 2 · 2026-08-15</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory" className="underline">
                Back to the register
              </Link>
            </span>
            <span>Facts only · no composite scores</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">What these measurements mean</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">In 60 seconds</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            L0 asks whether the payment wall answers. L1 asks whether a real purchase settles. L2
            asks whether the response matches the seller&apos;s declaration. Unverified is not a
            failure. A 0–100 score is a different API and is never an L0–L2 result.
          </p>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">0.</span>
          <span>Where the catalog comes from</span>
        </h2>
        <p className="doc-p">
          Every endpoint on this page was discovered through the <strong>CDP x402 Bazaar</strong>{" "}
          (and equivalent public discovery surfaces). That catalog is the measured population, not
          the whole x402 economy: x402 traffic that is never listed there — x402 on XRPL, for
          example — is outside what we probe or purchase, and appears as <code>0</code> in{" "}
          <code>byChain</code>. A zero there is a coverage limit of this observatory, not a finding
          about that chain. The catalog is an input; the measurements are the record.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>What L0 measures</span>
        </h2>
        <p className="doc-p">
          An L0 probe sends one request to a catalog-listed endpoint using{" "}
          <strong>the HTTP method the catalog entry itself declares</strong>, with no payment
          attached. Under the x402 protocol a compliant server answers{" "}
          <code>HTTP 402 Payment Required</code> with an <code>accepts</code> array before
          executing anything, so the probe is free, side-effect free, and observable. We record:
          whether 402 came back, whether <code>accepts</code> parses, whether the advertised
          price, asset, network and receiving address agree with what the catalog declares, and
          the latency — each with a timestamp and a response digest kept as evidence.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>The verdict vocabulary</span>
        </h2>
        <p className="doc-p">
          <strong>pass</strong> — the probe received 402 and the challenge was consistent with the
          catalog declaration. <strong>fail</strong> — the probe contradicted that: no 402 (any
          other status), DNS/TLS/timeout failure, an unparseable challenge, or a challenge whose
          price or receiving address contradicts the catalog; the specific reason code is always
          recorded. <strong>unverified</strong> — the entry does not declare enough to measure
          (most commonly no declared method — probing with a guessed method reports false
          deaths), or the evidence threshold below is not met.{" "}
          <em>unverified is not a failure and is never counted as one.</em>
        </p>

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>Publication gate</span>
        </h2>
        <p className="doc-p">
          A single failing probe is never published as <code>fail</code>: transient network
          conditions — including ours — are indistinguishable from a dead endpoint in one sample.
          The register shows <code>fail</code> only after{" "}
          <strong>{MIN_CONSECUTIVE_FAILS_TO_PUBLISH} consecutive failing probes</strong>; until
          then the published state is <code>unverified</code>. Every underlying probe, including
          single fails, remains visible in the endpoint&apos;s history with its evidence.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>Delisting detection</span>
        </h2>
        <p className="doc-p">
          The public discovery catalog is fetched in full daily. An endpoint present on an earlier
          day and absent from a <strong>complete</strong> fetch is recorded as{" "}
          <code>delisted</code>, with the before/after values kept on the event. On any day our
          own fetch is incomplete (fetched count below the catalog&apos;s reported total), no
          delisting judgements are made — a gap in our data must never read as a disappearance in
          yours. Reappearance is recorded as <code>relisted</code>. A fall in the
          catalog-reported 30-day call count of {Math.round(SETTLE_DROP_RATIO * 100)}% or more,
          from a base of at least {SETTLE_DROP_MIN_PREV_CALLS} calls, is recorded as{" "}
          <code>settle_drop</code> — a factual observation of the catalog&apos;s own telemetry,
          not a judgement.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">5.</span>
          <span>What L0 cannot measure</span>
        </h2>
        <p className="doc-p">
          Without purchasing, we cannot observe whether the endpoint actually delivers what it
          sells, the quality of what it returns, or settlement behaviour after payment. An
          endpoint with <code>L0: pass</code> has a standing payment wall — nothing more is
          claimed. L1 and L2 below cover settlement and conformance; L3, opinion on the quality of
          what is delivered, is not built and nothing on this site presents one.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">6.</span>
          <span>What L1 measures</span>
        </h2>
        <p className="doc-p">
          An L1 purchase is a real transaction: one covert purchase per endpoint, at most once per{" "}
          {SWEEP_WINDOW_DAYS}-day window, targeting endpoints whose most recent L0 verdict is{" "}
          <code>pass</code>, prioritised by real observed demand (30-day payer and call counts
          reported by the catalog). We request unpaid first to read the <code>402</code> challenge,
          then select a payment option and refuse to proceed unless every one of these holds:
          scheme <code>exact</code>, network Base, asset canonical Base USDC, and a price that
          matches what the catalog declared when we chose the target. Any deviation — a
          different asset, a different chain, a higher price — is recorded as a refusal, never
          paid. A hard per-purchase ceiling (${MAX_PER_PURCHASE_USD.toFixed(2)}) and a daily
          budget (${DAILY_BUDGET_USD}) are checked against a database ledger, not memory, before
          every signature, so a restart or a concurrent run cannot double-spend. Once we sign, the
          spend is recorded whether or not the seller delivers — a signed EIP-3009 authorization
          is live money the moment it exists.
        </p>
        <p className="doc-p">
          <strong>settled</strong> — <em>vet402 re-read the transaction on-chain</em> and found
          the exact USDC transfer it paid for: from our payer, to the catalog-declared payee, for
          the declared amount, in the canonical USDC contract, on Base, with at least 32
          confirmations. <strong>settle_claimed</strong> — the seller returned a settlement
          receipt with a well-formed transaction id, and we have not re-read it on-chain yet.{" "}
          <strong>settle_claim_refuted</strong> — we re-read it and that transfer is not there.{" "}
          <strong>settle_claimed_unverifiable</strong> — the id returned is not even well-formed
          for that chain. <strong>delivered_no_receipt</strong> — the seller returned{" "}
          <code>200</code> but the response carried no settlement receipt.{" "}
          <strong>settle_failed</strong> — no successful paid response came back at all. Every
          attempt, including refusals before any money moved, is visible on the endpoint&apos;s
          page with its evidence.
        </p>
        <p className="doc-p">
          <strong>What changed on 2026-08-23, and what is still open.</strong> Until that date,{" "}
          <code>settled</code> meant only that the seller had asserted success in its own{" "}
          <code>PAYMENT-RESPONSE</code> header — we published that assertion without ever
          re-reading the chain. It is now a measurement we make: the definition of{" "}
          <code>settled</code> is &ldquo;vet402 confirmed it on-chain&rdquo;. Still open, stated
          plainly: <strong>Solana settlements are not yet re-read</strong> — that chain needs a
          different verifier, so those rows stay <code>settle_claimed</code> rather than being
          called settled on evidence we do not have. We would rather name the gap than let you
          assume a check we are not doing.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">7.</span>
          <span>What L2 measures</span>
        </h2>
        <p className="doc-p">
          L2 runs only when the paid request in the same purchase returned <code>200</code>. It is
          a minimal structural check, not a full JSON-Schema validation: the response must parse
          as JSON and carry the top-level keys the catalog&apos;s own declared output schema marks
          as required. <strong>no_declaration</strong> — the catalog entry does not declare an
          output schema; never counted as a failure. <strong>match</strong> — the response parses
          and every declared required key is present. <strong>mismatch</strong> — the body does
          not parse as JSON, a required key is missing, or the content type is not JSON despite a
          declaration. <strong>not_checked</strong> — the paid request did not return{" "}
          <code>200</code>, so there was nothing to check. L2 does not verify that the values are
          correct or that the content is any good — that judgement is L3, and L3 is not built.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">8.</span>
          <span>Fairness commitments</span>
        </h2>
        <p className="doc-p">
          vet402&apos;s own endpoints, when listed in the catalog, are measured by exactly the
          same pipeline with no special casing — a verifier that special-cases itself is flagging
          its own fraud. These pages publish facts with reason codes and timestamps; they do not
          publish composite scores, rankings, or evaluative language about any operator.
          Corrections follow the site-wide{" "}
          <Link href="/corrections" className="underline">
            corrections policy
          </Link>
          .
        </p>

        <h2 className="sec-head">
          <span className="sec-no">9.</span>
          <span>Reuse and citation</span>
        </h2>
        <p className="doc-p">
          The measurements on these pages — the aggregate JSON at{" "}
          <code>/api/v1/observatory/state</code>, the daily series at{" "}
          <code>/api/v1/observatory/history</code>, and the purchase ledger at{" "}
          <code>/api/v1/observatory/export.csv</code> — are published under{" "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            className="underline"
            rel="license noopener noreferrer"
            target="_blank"
          >
            CC BY 4.0
          </a>
          . Redistribute them, chart them, put them in a paper or a grant memo, commercially or
          not; the one condition is that the source is named. The code is MIT, in the repository.
          No permission is needed and none is granted selectively: an operator whose numbers these
          are may reuse them on exactly the same terms as anyone measuring us.
        </p>
        <p className="doc-p">
          Every number here moves, so a measurement without its retrieval date is not a
          measurement. Cite it as:{" "}
          <code>
            KIZUNA Creation. vet402 observatory. Dataset, retrieved YYYY-MM-DD.
            https://vet402.com/api/v1/observatory/state
          </code>{" "}
          The JSON carries <code>license</code>, <code>licenseUrl</code>, <code>retrievedAt</code>{" "}
          and <code>cite</code> in the response body, and the CSV — which has nowhere to put a
          comment — carries <code>x-vet402-license</code>, <code>x-vet402-retrieved-at</code>,{" "}
          <code>x-vet402-rows</code>, <code>x-vet402-window-days</code> and a <code>Link</code>{" "}
          header pointing at the licence and at this page. A file that ends up on someone
          else&apos;s disk still knows where it came from.
        </p>
        <p className="doc-p">
          The ledger is append-only and ordered by <code>attempted_at</code>, so a row that was
          published does not change afterwards; a re-download with a wider{" "}
          <code>?days=</code> window returns the same earlier rows plus older ones. Rows are
          capped at 50,000 per request and the cap is declared in{" "}
          <code>x-vet402-truncated</code> rather than passed off as the whole ledger. If we get a
          number wrong we correct it in public under the{" "}
          <Link href="/corrections" className="underline">
            corrections policy
          </Link>{" "}
          — the licence is not conditioned on the number being flattering to us.
        </p>
      </article>
    </main>
  );
}
