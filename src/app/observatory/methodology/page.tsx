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
import {
  PRIORITY_SELLER_HOSTS,
  PRIORITY_SWEEP_WINDOW_DAYS,
  SWEEP_WINDOW_DAYS,
} from "@/lib/observatory/l1-runner";
import {
  getObservatoryStatsCached,
  getUnverifiedBreakdownCached,
} from "@/lib/observatory/cached-reads";
import {
  OBSERVATORY_VOCABULARY,
  VOCABULARY_GROUP_LABELS,
  vocabularyJsonLd,
} from "@/lib/observatory/vocabulary";
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
  // 2026-09-04 外部監査 E・P1-8: §2 は「unverified の主因は method の未申告」と
  // 言い続けていたが、実測ではそれが 1 件で unverified は 12,305 件だった。
  // 順位を散文で書くとまた腐るので、実測を出す。
  const unverified = await getUnverifiedBreakdownCached().catch(() => null);
  // 2026-09-05 セキュリティ監査 S-4 / S-17: settled を 1 段で出していたので、nonce 束縛の
  // 前後で証拠の強さが違うことが読者に見えなかった。旧行は降格しない（持っていない証拠で
  // 無実の売り手を refuted にしない・2026-09-04 の決定）。強度のラベルと件数を足すだけで、
  // 件数そのものは 1 行も動かさない。散文に件数を焼くと腐るので、公開 API と同じ reader から
  // 生きた内訳を出す（頁は cached 読み）。
  // §6 の本文に "/files/*" があり、claims 抽出器はそこを行コメントの開始と読む。ここに
  // JSX ブロックコメントを置くとその偽コメントの終端になって走査範囲が動くので、置かない。
  const l1Tiers = await getObservatoryStatsCached()
    .then((st) => st.l1)
    .catch(() => null);
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
    dateModified: "2026-09-04",
    author: { "@type": "Organization", name: "vet402", url: SITE_URL },
    publisher: { "@type": "Organization", name: "vet402", url: SITE_URL },
    inLanguage: "en",
  };

  const vocabulary = vocabularyJsonLd(SITE_URL);

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
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(vocabulary) }}
        />

        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Methodology: L0, L1, L2</span>
            <span>Version 3 · 2026-09-04</span>
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
            failure. A 0–100 score is a different API and is never an L0–L2 result. Every word this
            page publishes measurements in is defined once, in one line each, in{" "}
            <a href="#vocabulary" className="underline">
              section 10
            </a>
            .
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
          recorded. <strong>unverified</strong> — we do not have grounds to publish either of
          the other two yet. That covers an entry that does not declare enough to measure (no
          declared method: probing with a guessed method reports false deaths), an entry the
          rolling probe schedule has not reached, an entry whose failing probe has not met the
          publication gate in section 3, and an entry we could not reach for a reason of our own
          (rate limiting, a TLS failure on our side).{" "}
          <em>unverified is not a failure and is never counted as one.</em>
        </p>
        {unverified && unverified.total > 0 && (
          <>
            <p className="doc-p">
              What that bucket is actually made of, over the endpoints on record at the time this
              page was rendered:
            </p>
            <ul className="doc-p list-disc space-y-1 pl-5">
              <li>
                {unverified.notYetProbed.toLocaleString()} not yet probed: the rolling schedule has
                not reached them
              </li>
              <li>
                {unverified.singleFailGateNotMet.toLocaleString()} with a failing probe that has not
                met the publication gate in section 3
              </li>
              <li>
                {unverified.otherNotReached.toLocaleString()} we could not reach for a reason of our
                own (rate limiting, TLS)
              </li>
              <li>
                {unverified.pathTemplate.toLocaleString()} whose listed URL still contains an
                unfilled path parameter (<code>path_template</code>, below)
              </li>
              <li>{unverified.methodUndeclared.toLocaleString()} that declare no HTTP method</li>
            </ul>
            <p className="doc-p">
              Those five sum to {unverified.total.toLocaleString()}, which is the same figure{" "}
              <code>publishedUnverified</code> reports at{" "}
              <code>/api/v1/observatory/state</code>. Until 2026-09-04 this section said the usual
              cause was the undeclared method; the counts above contradict that, so the counts are
              printed instead of a sentence that can go stale between readings.
            </p>
          </>
        )}
        <p className="doc-p">
          <strong>path_template</strong> — the listed URL still contains an unfilled path
          parameter (<code>/v1/entreprise/:siren</code>, <code>/items/{"{id}"}</code>,{" "}
          <code>/files/*</code>); we do not know the real value, so no request is sent, the
          probe is recorded as <code>unverified</code> with this reason, and the endpoint is
          never purchased from — a 4xx from a request we could not have formed correctly is our
          limitation, not the seller&apos;s failure.
        </p>
        <p className="doc-p">
          <strong>
            That principle is about the request, not about the URL, so it applies to the body and
            the authentication header too.
          </strong>{" "}
          A listing declares a URL, a price and a payee. It does not tell us what JSON body the
          endpoint expects, and it does not hand us an API key. We send <code>{"{}"}</code> on a{" "}
          <code>POST</code> and we carry no credential of the seller&apos;s. So when a paid request
          comes back <code>400</code> (the request is malformed), <code>401</code> or{" "}
          <code>403</code> (not authenticated), <code>404</code> or <code>422</code>, the most
          likely explanation is the same one we already accept for a template URL:{" "}
          <strong>we could not form the request correctly.</strong> Since 2026-09-05 those rows are
          labelled <code>inconclusive</code> and are out of the denominator for{" "}
          <code>delivered</code>. They are not deleted, not hidden and not corrected away — the
          status and the HTTP code stay on the endpoint&apos;s page, and the count is published as{" "}
          <code>l1.inconclusive</code>. A <code>5xx</code> is not treated this way: a server fault
          is not something our request shape explains. Before that date every 4xx was published as
          settled-and-not-delivered, which reads as &ldquo;this named company took the money and
          did not deliver&rdquo; — see{" "}
          <Link href="/corrections" className="underline">
            /corrections
          </Link>
          .
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
          An L1 purchase is a real transaction: one purchase per endpoint, at most once per{" "}
          {SWEEP_WINDOW_DAYS}-day window for the catalog at large — see the priority list below for
          the {PRIORITY_SELLER_HOSTS.length} hosts bought from more often — targeting endpoints
          whose most recent L0 verdict is <code>pass</code>, prioritised by real observed demand
          (30-day payer and call counts reported by the catalog). We request unpaid first to read the <code>402</code> challenge,
          then select a payment option and refuse to proceed unless every one of these holds:
          scheme <code>exact</code>, a network we purchase on (Base, or Solana mainnet when the
          Solana payer is enabled), the canonical USDC asset for that network, and a price that
          matches what the catalog declared when we chose the target. Any deviation — a
          different asset, a different chain, a higher price — is recorded as a refusal, never
          paid. A hard per-purchase ceiling (${MAX_PER_PURCHASE_USD.toFixed(2)}) and a daily
          budget (${DAILY_BUDGET_USD}) are checked against a database ledger, not memory, before
          every signature, so a restart or a concurrent run cannot double-spend. Once we sign, the
          spend is recorded whether or not the seller delivers — a signed EIP-3009 authorization
          is live money the moment it exists.
        </p>
        <p className="doc-p">
          <strong>We buy under our own name.</strong> Every request in this pipeline &mdash; the
          unpaid L0 probe, the unpaid read of the <code>402</code> challenge, and the paid request
          itself &mdash; carries a <code>User-Agent</code> that says who we are and links back to
          this page: <code>vet402-observatory-l0/1.0</code>, <code>vet402-observatory-l0-recheck/1.0</code>{" "}
          and <code>vet402-observatory-l1/1.0</code>, each with{" "}
          <code>(+https://vet402.com/observatory/methodology)</code>. There is no rotation, no
          disguise and no attempt to look like an ordinary buyer. A seller who wants to treat vet402
          differently can, and can do so from the first byte of the request.{" "}
          <strong>That is the harder test, not the easier one.</strong> A seller who knows exactly
          who is watching and still takes the payment without delivering has been measured under
          the best conditions it will ever get; the record below is what happened anyway. Until
          2026-09-05 this page said purchases were made &ldquo;covertly&rdquo; &mdash; that was
          never true of the implementation, and it is corrected on{" "}
          <Link href="/corrections" className="underline">
            /corrections
          </Link>
          .
        </p>
        <p className="doc-p">
          <strong>The priority list, and why it exists.</strong> Four hosts are not on the{" "}
          {SWEEP_WINDOW_DAYS}-day window. They may be re-purchased once every{" "}
          {PRIORITY_SWEEP_WINDOW_DAYS === 1 ? "day" : `${PRIORITY_SWEEP_WINDOW_DAYS} days`}, and
          they are pinned to the head of candidate selection:{" "}
          {PRIORITY_SELLER_HOSTS.map((host, i) => (
            <span key={host}>
              {i > 0 ? ", " : ""}
              <code>{host}</code>
            </span>
          ))}
          . The reason is that a settle-through record is worth more as a series than as a single
          row, and these four carry the bulk of the organic call volume the public catalog reports,
          so a daily point on them says more about the x402 economy than a one-shot row on the long
          tail. Two things this does <em>not</em> change: the measurement is the identical pipeline
          with the identical gates, and the result publishes exactly as anyone else&apos;s does,
          pass and fail alike. What differs is how often we buy, and that is stated here rather
          than left for a reader to infer from the timestamps. Until 2026-09-04 this section said
          &ldquo;at most once per {SWEEP_WINDOW_DAYS}-day window&rdquo; with no exception named,
          which was false for these four.
        </p>
        <p className="doc-p">
          <strong>settled</strong> — <em>vet402 re-read the transaction on-chain</em> and found
          the exact USDC transfer it paid for: from our payer, to the catalog-declared payee, for
          the declared amount, in the canonical USDC contract. On Base that means an ERC-20{" "}
          <code>Transfer</code> log matching all four of those with at least 32 confirmations; on
          Solana it means the transaction is <code>finalized</code>, succeeded, and the
          USDC token-balance deltas in it show the payee&apos;s wallet receiving at least the
          declared amount while our payer&apos;s wallet loses it — read from balances rather than
          from instructions, and only after the RPC&apos;s own genesis hash confirms we are reading
          the cluster the purchase declared. <strong>settle_claimed</strong> — the seller returned a settlement
          receipt with a well-formed transaction id, and we have not re-read it on-chain yet.{" "}
          <strong>settle_claim_refuted</strong> — we re-read it and that transfer is not there.{" "}
          <strong>settle_claimed_unverifiable</strong> — the id returned is not even well-formed
          for that chain. <strong>delivered_no_receipt</strong> — the seller returned{" "}
          <code>200</code> but the response carried no settlement receipt.{" "}
          <strong>settle_failed</strong> — no successful paid response came back at all.{" "}
          <strong>inconclusive</strong> — the payment settled and the paid request answered{" "}
          <code>4xx</code>, so the delivery judgement is held rather than counted against the
          seller (§2, the same principle as <code>path_template</code>); the row still publishes,
          it is simply out of the denominator for <code>delivered</code>. Every attempt, including
          refusals before any money moved, is visible on the endpoint&apos;s page with its
          evidence.
        </p>
        <p className="doc-p">
          <strong>l1_not_attempted</strong> — we have not signed a paid attempt against that
          resource, so what it sells is unverified rather than refuted. Since 2026-09-05 the
          runner can be stopped mid-batch by a runtime spending halt, and while that halt is
          on, nothing new is signed. So a decision document carries{" "}
          <code>spending_halted</code> beside its facts, and{" "}
          <code>facts.l1.last_attempt_at</code> says when we last looked — a halted week and a
          quiet week are otherwise the same picture. When the gap is ours to explain,{" "}
          <code>not_attempted_reason</code> names it: <code>spending_halted</code>, or{" "}
          <code>no_eligible_accept</code> when the wall offered nothing machine-payable. We do
          not write our own halt into the seller&apos;s record. The other ways an attempt
          ends before the signature — over cap, price mismatch, payee mismatch — leave the
          field null here and stay where they already are, one row per attempt in the
          public decision ledger.
        </p>
        <p className="doc-p">
          <strong>settled comes at two evidence strengths, and both counts are published.</strong>{" "}
          Since 2026-09-04 12:00 UTC each purchase carries a one-time value we generate
          ourselves — the EIP-3009 authorization nonce on Base, our own memo on Solana — and
          the re-read binds the transaction to that value. We publish those rows as{" "}
          <strong>nonce-bound</strong>: the transaction is the one that paid for this purchase.
          Rows that settled before that timestamp were matched on amount, payee, asset and
          chain, with nothing tying the transaction to the purchase it was offered for. We
          publish those as <strong>amount + payee</strong>. The gap is not hypothetical: a
          seller holding several catalog entries at the same price and the same payee could
          have answered with a transfer it had received earlier and passed that check.{" "}
          {l1Tiers && l1Tiers.settled > 0 ? (
            <>
              At the current reading, {l1Tiers.settledAmountPayeeOnly.toLocaleString()} of{" "}
              {l1Tiers.settled.toLocaleString()} settled rows are amount + payee and{" "}
              {l1Tiers.settledNonceBound.toLocaleString()} are nonce-bound.{" "}
            </>
          ) : null}
          The split is live at <code>/api/v1/observatory/state</code> as{" "}
          <code>l1.settledNonceBound</code> and <code>l1.settledAmountPayeeOnly</code>, which sum
          to <code>l1.settled</code>, and per chain in <code>l1.byChain</code>.
        </p>
        <p className="doc-p">
          <strong>Why the older rows keep the label.</strong> Demoting them would assert
          something we cannot show — that those transfers were not the ones bought — and we
          hold no evidence for that assertion. Refuting a seller on evidence we do not have is
          a worse error than the one we are disclosing here, so the count of{" "}
          <code>settled</code> is unchanged and the strength is stated beside it. One check
          does work retroactively: the settlement block time against the moment we attempted
          the purchase. A transaction the seller had received earlier would sit far outside
          that band. On 2026-09-05 the 1,589 settled rows with a block time
          on record ran from 1 second before the attempt to 62 seconds after it, and none sat
          outside a -5/+15 minute window. That window is reported as{" "}
          <code>l1.settledTimeWindowOk</code>, with{" "}
          <code>l1.settledTimeWindowUnknown</code> for the rows whose block time we do not
          hold — those are neither inside nor outside it, and we do not count them as either.
        </p>
        <p className="doc-p">
          <strong>settled is not delivered.</strong> <code>settled</code> is a statement about the
          money: we confirmed the transfer on-chain. <code>delivered</code> is a statement about
          the goods: the attempt is <code>settled</code> <em>and</em> the paid request answered{" "}
          <code>2xx</code>. A seller can take the payment and answer <code>400</code>, and that row
          is settled and not delivered. Both counts are published side by side on the endpoint
          page, on the register, in the badge, and at <code>/api/v1/observatory/state</code>
          (<code>l1.settled</code> and <code>l1.delivered</code>), so the difference between them
          is money that moved without the response arriving. Until 2026-09-04 only{" "}
          <code>settled</code> was published, which let an endpoint whose every paid request
          answered <code>400</code> read as a full settle-through record.
        </p>
        <p className="doc-p">
          <strong>What changed on 2026-08-23, and what is still open.</strong> Until that date,{" "}
          <code>settled</code> meant only that the seller had asserted success in its own{" "}
          <code>PAYMENT-RESPONSE</code> header — we published that assertion without ever
          re-reading the chain. It is now a measurement we make: the definition of{" "}
          <code>settled</code> is &ldquo;vet402 confirmed it on-chain&rdquo;. The gap named here
          until 2026-09-04 — L1 purchases ran on both Base and Solana, but Solana settlements were
          never re-read, so a Solana purchase reached <code>settle_claimed</code> and stayed there
          — is closed: <strong>Solana settlements are now re-read on-chain</strong> by a
          Solana-specific verifier, and a Solana purchase is promoted to <code>settled</code> only
          on the same evidence Base requires. What remains open is narrower and still worth naming:
          the re-read exists for Base and Solana only, so a purchase on any other chain would stay
          at <code>settle_claimed</code> rather than be promoted on evidence we do not have. When
          our own RPC cannot answer, or reports a different cluster than the purchase declared, the
          row stays unverified rather than being called refuted — an instrument we could not read
          is not a finding about the seller.
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
        <p className="doc-p">
          <strong>One vocabulary, and its older summary form.</strong> The four words above are the
          canonical set: they are what the ledger column <code>l2_schema</code> stores and what
          every API returns. Short summaries of the levels have historically used a three-word form
          (<code>conform / mismatch / undeclared</code>), and a reader comparing the two surfaces
          could not tell whether they described the same measurement. They do:{" "}
          <code>conform</code> is <code>match</code>, <code>mismatch</code> is{" "}
          <code>mismatch</code>, and <code>undeclared</code> is <code>no_declaration</code>. The
          summary form has no word for <code>not_checked</code>, because a level summary is not
          reporting rows that were never checked. Where the two disagree, the four-word set wins.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">8.</span>
          <span>Fairness commitments</span>
        </h2>
        <p className="doc-p">
          vet402&apos;s own endpoints, when listed in the catalog, run through exactly the same
          measurement pipeline as everyone else&apos;s, and vet402&apos;s own rows are excluded
          from the aggregate rates — a verifier that grades itself is not a neutral party in its
          own numbers. What is <em>not</em> uniform is purchase frequency: the four hosts in the
          priority list in section 6 are bought from more often than the rest of the catalog. The
          pipeline, the gates and the publication rules are identical for them; only the cadence
          differs, and the list is named there rather than left implicit. No operator gets a
          different measurement, a suppressed result, or a softer word for the same finding, and
          that is what partners are told they cannot buy. These pages publish facts with reason
          codes and timestamps; they do not publish composite scores, rankings, or evaluative
          language about any operator.
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

        {/* 2026-09-05 ETHOnline / WINDOW_PLAN §2 #3: evidence 行の source を
            散文でも展開する（語彙の定義だけが独り歩きしないように）。 */}
        <p className="doc-p">
          <strong>Where a piece of evidence came from.</strong> Each row in an{" "}
          <code>evidence[]</code> array names its own source, because a decision document can
          carry observations from two different ledgers.{" "}
          <code>evidence.source=vet402</code> is our own record: a probe we ran, a purchase we
          paid for, a schema check on what came back. <code>evidence.source=subgraph</code> is
          The Graph&rsquo;s x402 subgraph, read by the caller with their own Graph Gateway API
          key rather than proxied through us; that row carries the <code>subgraphId</code>, the{" "}
          <code>block.number</code> and <code>deployment</code> it was read at, and the{" "}
          <code>queriedAt</code> timestamp, so a reader can tell live index data apart from a
          static snapshot. A caller can ask for <code>evidence.source=both</code> and be refused
          if either source cannot be read &mdash; but no single row wears that label, because the
          two sources count different things and adding them would produce a number that means
          nothing. Our engine and the subgraph can disagree about the same wallet; the rows stay
          apart so a reader sees the disagreement instead of an average of it.
        </p>

        {/* 2026-09-05 AEO: 語彙の正典は src/lib/observatory/vocabulary.ts。
            この節と DefinedTermSet JSON-LD は同じ配列から出る。上の §1–§7 は
            同じ語を散文で展開したもので、矛盾したらどちらかではなく両方直す。 */}
        <h2 className="sec-head" id="vocabulary">
          <span className="sec-no">10.</span>
          <span>Definitions, one line each</span>
        </h2>
        <p className="doc-p">
          The sections above define these words in context. This index states each of them once, in
          a single sentence, so a reader — or a machine reading this page — can take one definition
          without reconstructing it from a paragraph. The same list is published as structured data
          on this page and in <code>/llms-full.txt</code>.
        </p>
        {(Object.keys(VOCABULARY_GROUP_LABELS) as (keyof typeof VOCABULARY_GROUP_LABELS)[]).map(
          (group) => (
            <div key={group} className="mt-6">
              <p className="text-brand-deep">{VOCABULARY_GROUP_LABELS[group]}</p>
              <dl className="mt-2 max-w-[70ch]">
                {OBSERVATORY_VOCABULARY.filter((t) => t.group === group).map((t) => (
                  <div key={t.term} className="mt-3">
                    <dt id={`term-${t.term}`} className="text-brand-deep">
                      <code>{t.term}</code>
                    </dt>
                    <dd className="doc-p mt-1">{t.definition}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ),
        )}
      </article>
    </main>
  );
}
