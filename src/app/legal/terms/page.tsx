import type { Metadata } from "next";
import { headers } from "next/headers";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

/**
 * Terms of Service.
 *
 * 2026-08-06 (L4 legal review). Sections 0-5 were the whole document and left
 * three gaps that mattered more for vet402 (then named Vouch) than for a
 * normal B2B API:
 *
 *  1. No governing law, no venue, no dispute process at all.
 *  2. Liability was one sentence ("not liable for losses arising from
 *     reliance on trust scores") with no cap and no damage types named, and
 *     there was no indemnity.
 *  3. Nothing addressed non-customers. This is the structural one. Section 2
 *     puts the allow/warn/block decision on the customer, but section 2 only
 *     binds the customer. The people most likely to be hurt by a wrong score
 *     — a payee wrongly BLOCKed out of a payment, or someone defrauded after
 *     a wrong ALLOW — have no contract with us, so no contractual disclaimer
 *     reaches them. /faq advertises both directions of use, so this is not
 *     hypothetical. Sections 6-8 below address it directly: scores are stated
 *     as opinion rather than as fact about a person, third-party beneficiary
 *     status is disclaimed, no duty of care is assumed toward non-customers,
 *     and — the part that actually reduces the risk rather than just
 *     disclaiming it — a free, key-less correction route is published for
 *     anyone who thinks a score about them is wrong.
 *
 * Voice follows Verilot's ToS (same operator): plain English that explains
 * why a clause exists rather than reciting boilerplate. Existing section
 * numbers 0-5 are unchanged so anything citing them still resolves; the new
 * material is appended as 6-12.
 */

// 2026-08-13 [m2] の続き: /legal/notice にだけ固有 title を付け、同じ legal/
// 配下の terms と privacy を取り残していた。この2枚は既定の SITE_TITLE を
// 名乗るので、タブ・検索結果・ブックマークのどこでも他ページと区別が付かない。
// template が " | vet402" を付けるので、ここではサフィックスを書かない。
export const metadata: Metadata = pageMetadata({
  title: "Terms of Service",
  description:
    "Terms of service for the vet402 verification API, including how scores may be used and the free correction route for anyone who believes a score about them is wrong.",
  path: "/legal/terms",
});

export default async function TermsPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Terms of Service", path: "/legal/terms" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet space-y-6 text-sm text-brand">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Instrument: terms of service</span>
            <span>
              {/* この頁のシアン1点。改訂日という事実。 */}
              Revision: <span className="text-signal">August 15, 2026</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>August 2026</span>
          </div>
        </div>
        <h1 className="doc-title mt-10">Terms of Service</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        <p className="doc-note text-center">Last updated: August 15, 2026</p>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">0.</span>
            <span>Business use only</span>
          </h2>
          <p>
            vet402 (formerly Vouch) is offered for business-to-business (B2B) use by agent and service operators
            integrating trust scores into their own products. It is not marketed or sold to
            consumers for personal use. See our{" "}
            <a className="doc-link" href="/legal/notice">
              Legal Notice
            </a>{" "}
            for operator and contact information.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">1.</span>
            <span>Service</span>
          </h2>
          <p>
            vet402 provides agent trust scores and recommendations for informational purposes only.
            Scores do not constitute a guarantee, credit assessment, investment advice, or legal
            certification.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">2.</span>
            <span>Your responsibility</span>
          </h2>
          <p>
            You are solely responsible for decisions to allow, warn, or block agents or wallets
            based on vet402 output. Final access control remains with you.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">3.</span>
            <span>API keys</span>
          </h2>
          <p>
            Keep API keys confidential. You are responsible for usage under your account, including
            quota consumption across all keys you create.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">4.</span>
            <span>Acceptable use</span>
          </h2>
          <p>
            Do not abuse the API, attempt to circumvent rate limits, or use the service for unlawful
            activity. We may suspend accounts that violate these terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">5.</span>
            <span>Disclaimer</span>
          </h2>
          <p>
            The service is provided &quot;as is&quot; and &quot;as available,&quot; without
            warranties of any kind, express or implied, including accuracy, completeness,
            merchantability, or fitness for a particular purpose. Scores are computed from public
            on-chain data and third-party sources we do not control, which can be incomplete,
            delayed, throttled, or wrong. Nothing we publish about how well the scores have
            performed in the past — including the figures on{" "}
            <a className="doc-link" href="/accuracy">
              /accuracy
            </a>{" "}
            — is a promise about how they will perform on your traffic. What we will and will not
            pay for if something goes wrong is in section 9.
          </p>
        </section>

        {/* --- 6-8: the non-customer sections. See the file header for why. --- */}

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">6.</span>
            <span>What a score is — and what it is not</span>
          </h2>
          <p>
            A vet402 score is our <strong>opinion</strong>, expressed as a number and a
            recommendation, about the risk profile of a blockchain address or an ERC-8004 agent
            identifier, based on data that is already public on-chain. It is not a statement of fact
            about any person or business, and it is not an accusation. A low score does not say
            that anyone is a fraudster, a criminal, insolvent, or untrustworthy as a person; it says
            that the public record attached to that address, read through our published
            methodology, looks risky to us on the day we read it.
          </p>
          {/* 2026-08-14 (B-2 暫定実装): 意見と事実の区別を運用方針として明文化。
              意見は検証可能な事実的根拠（オンチェーン記録＋公開手法）に立脚し、
              評価語(fraud/scam等)を人への事実断定として発しない。confirmed_fraud
              等のラベルは outcome-writer.ts の実態（顧客報告/自動検出の分類）に
              即して記述——裁定的認定と誤読されないように。 */}
          <p>
            The opinion is not free-floating: every verdict rests on <strong>verifiable factual
            grounds</strong> — the on-chain record we read, which anyone can re-read, and the
            methodology we publish at{" "}
            <a className="doc-link" href="/accuracy">
              /accuracy
            </a>
            . Our policy is to state the underlying facts as facts, the assessment as an
            assessment, and never to assert an evaluative label — &quot;fraud,&quot;
            &quot;scam,&quot; or anything like them — as a statement of fact about a person. Where
            a category label such as <code className="text-brand-deep">confirmed_fraud</code>{" "}
            appears in our data or API, it is the name of an outcome category — how the customer
            who ran the transaction reported it, or what an automated on-chain pattern check
            recorded — kept to measure our own accuracy. It is not a finding by us that anyone
            committed fraud, and it must not be quoted as one. Every published verdict carries the
            same free, key-less challenge route (section 8), and corrections are published openly
            on{" "}
            <a className="doc-link" href="/corrections">
              /corrections
            </a>
            .
          </p>
          <p>
            A score is also not identity verification, KYC/AML screening, a sanctions check, a
            credit assessment, a background check, or any kind of certification or accreditation.
            Addresses are pseudonymous: the same address may be controlled by different parties over
            time, one party may control many addresses, and we generally do not know who is behind
            any of them.
          </p>
          <p>
            Our methodology uses public lists — including the US Treasury OFAC list of sanctioned
            digital-currency addresses — as one benchmark of known-bad addresses to measure our
            scoring against. Using that list as a benchmark is not us making a sanctions
            determination: we do not decide who is on it, we do not screen for sanctions compliance,
            and a low score or a BLOCK is not a statement that an address is sanctioned or that
            transacting with it is unlawful. If you have a sanctions- or AML-compliance obligation,
            meet it with a service built and licensed for that purpose; vet402 is not one.
          </p>
          <p>
            ALLOW, WARN, and BLOCK are <strong>recommendations to the customer who asked</strong>,
            not instructions and not decisions. vet402 never accepts, refuses, delays, or reverses
            anyone&apos;s payment — we have no custody, no signing authority, and no place in the
            transaction. If a payment of yours was refused, or accepted and then went wrong, the
            decision was made by the business you were transacting with, applying its own policy.
            Section 2 puts that responsibility on our customers in so many words, and we are
            repeating it here so that it is legible to someone who is not our customer and never
            agreed to these terms.
          </p>
          <p>
            Our methodology, and our own measured error rates including the false positives that
            make us look bad, are published at{" "}
            <a className="doc-link" href="/accuracy">
              /accuracy
            </a>
            . We publish them because a score that presents itself as infallible is the more
            dangerous product.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">7.</span>
            <span>No third-party beneficiaries, and no duty to non-customers</span>
          </h2>
          <p>
            These terms are an agreement between us and the customer who holds the API key. Nobody
            else acquires rights under them. In particular, a person or business that is
            <em> scored</em> by vet402, or that is on the other side of a transaction where our
            customer used vet402, is not a party to this agreement and is not an intended third-party
            beneficiary of it. Our customers cannot promise, on our behalf, that a score is accurate,
            current, or fit for anything.
          </p>
          <p>
            To the fullest extent permitted by applicable law, we do not accept and do not assume a
            duty of care toward people who are not our customers. We do not investigate the parties
            behind the addresses we score, we do not adjudicate disputes between a payer and a
            payee, and we do not undertake to protect any particular party from loss. If you are not
            our customer and a score affected you, our undertaking to you is the correction route in
            section 8 — a real one, free and open to anyone — and not an assurance of any outcome.
          </p>
          <p>
            Nothing in this section is an attempt to escape liability for our own fraud,
            intentional misconduct, or gross negligence, or for anything that applicable law does
            not allow to be excluded. Those remain exactly where the law puts them.
          </p>
        </section>

        {/* 2026-08-13 UX監査R1 [C7]: 異議申立の入口は UI のどこにも無く、唯一の
            記述がこの §8（全文の27%地点）だった。LP §3.3 / /payee/:address /
            /faq / /accuracy / /corrections から名指しで飛べるように id を付ける。
            id は節番号ではなく "corrections" — 節が繰り上がってもリンクが
            死なないため。 */}
        <section id="corrections" className="scroll-mt-24 space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">8.</span>
            <span>If you think a score about you is wrong</span>
          </h2>
          <p>
            You do not need an account, an API key, a payment, or a lawyer to challenge a score. Two
            routes, both free:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Prove control of the address.</strong> Sign our canonical message with the
              wallet in question and{" "}
              <code className="text-brand-deep">POST /api/v1/payees/verify</code>. A valid
              signature is the proof — no key required, no charge. That registers you as a verified
              payee, publishes a profile at{" "}
              <code className="text-brand-deep">/payee/&lt;address&gt;</code>, and feeds
              back into how the address is scored.{" "}
              <a className="doc-link" href="/docs/api">
                The API reference
              </a>{" "}
              shows the exact request, and a GET on the same path returns the message to sign before
              you attempt anything.
            </li>
            <li>
              <strong>Or just email us.</strong> Write to{" "}
              <a className="doc-link" href={SUPPORT_MAILTO}>
                {SUPPORT_EMAIL}
              </a>{" "}
              with the address and what you think is wrong. One person reads that inbox. We will
              acknowledge within 5 business days (Japan time). We cannot promise to change a score —
              it is our opinion, and sometimes we will disagree with you — but we will look, we will
              tell you what we concluded, and if we got a fact wrong we will fix it and re-score.
            </li>
          </ul>
          {/* 2026-09-02: endpoint 記録（L0–L2）への異議の経路。上の 2 経路は score 用。 */}
          <p>
            <strong>Endpoint records are separate from scores</strong> and have their own route:
            every record page under{" "}
            <code className="text-brand-deep">/observatory/e/</code> ends with a{" "}
            <em>Dispute this record</em> form. Send your email address and what you believe is wrong
            (20–2,000 characters); you receive a receipt number, and one person reads it and tells
            you what we concluded. Records are never deleted on dispute. If the measurement was
            wrong, the correction is published with the same weight as the record; if it was right,
            the record stands and we say so. If you control the endpoint&apos;s receiving address,
            you can also sign the dispute (
            <code className="text-brand-deep">POST /api/v1/observatory/disputes</code>), which
            triggers a re-measurement through the normal publication gate.
          </p>
          <p>
            If you intend to bring a claim about a score, please use one of those routes first and
            give us 30 days. This is not a waiver of any right and it does not stop any clock that
            the law is running; it is a request, because most of these are fixable in an afternoon
            and neither of us wants the alternative.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">9.</span>
            <span>Limitation of liability</span>
          </h2>
          <p>
            To the fullest extent permitted by applicable law, we are not liable for indirect,
            incidental, special, consequential, exemplary, or punitive damages, or for lost profits,
            lost revenue, lost or corrupted data, lost business, business interruption, loss of
            goodwill or reputation, or the cost of substitute services — whether the claim is
            framed in contract, in tort (including negligence), or otherwise, and whether or not we
            were told such damages were possible. This includes losses from a payment you accepted
            after an ALLOW, a payment or counterparty you turned away after a WARN or BLOCK, and
            funds sent to a wallet that scored well and misbehaved anyway.
          </p>
          <p>
            Our total liability for all claims relating to vet402, taken together, will not exceed
            the greater of (a) the amount you paid us for the service in the twelve months before
            the claim and (b) US$100 (or its equivalent in Japanese yen). On the Free plan (a) is
            zero, so the US$100 floor is what applies. On Pro that ceiling is at most US$588, and on
            Scale at most US$2,388.
          </p>
          <p>
            We would rather state that plainly than bury it. vet402 is run by one person and priced
            between US$0 and US$199 a month; it cannot carry exposure larger than the revenue an
            account actually produced, and pretending otherwise would be a promise we could not
            keep. Size your reliance accordingly: if a single wrong verdict would cost you more than
            the cap, vet402 should be one input into your decision and not the decision. If you need
            cover beyond this, talk to us <em>before</em> you build it into a payment path — the
            answer may be no, but you will have it in writing and in advance.
          </p>
          <p>
            Nothing in these terms limits or excludes liability that cannot be limited or excluded
            under the law that applies to you — including liability for fraud or fraudulent
            misrepresentation, for our own intentional misconduct or gross negligence, or for death
            or personal injury. vet402 is offered for business use only (section 0), so this section
            is written for a business counterparty rather than a consumer; if mandatory
            consumer-protection rules nonetheless apply to you, they apply whether or not this
            document says so, and this section takes effect only as far as those rules allow.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">10.</span>
            <span>Your responsibility to us</span>
          </h2>
          <p>
            If a third party brings a claim against us because of how you used vet402 — because you
            used it unlawfully or in breach of these terms, because you presented a score as
            something it is not (a certification, a fraud determination, a KYC or sanctions result,
            a statement of fact about a person), because you republished or resold score output in a
            way these terms do not permit, or because of a decision you made to allow, warn, or
            block someone — you agree to cover the direct costs we reasonably incur from that claim,
            including reasonable legal fees. This does not apply to anything caused by our own act
            or omission, and it is limited to what applicable law allows. We will tell you promptly
            about any such claim, will not settle it without asking you first, and will let you take
            over the defense if you want it.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">11.</span>
            <span>Governing law, venue, and language</span>
          </h2>
          <p>
            These terms, and any dispute arising out of them or out of your use of vet402 — including
            non-contractual disputes — are governed by the laws of Japan, without regard to
            conflict-of-law rules. That is because the operator is an individual proprietor
            established in Japan; the product being about on-chain payments between parties anywhere
            in the world does not change where its operator sits.
          </p>
          <p>
            For any dispute that reaches a court, the Japanese district court with jurisdiction over
            the operator&apos;s principal place of business will be the exclusive court of first
            instance. vet402 is a B2B service (section 0), so this is written as a
            business-to-business venue clause and there is no consumer carve-out; if you are
            somehow using vet402 in a capacity where mandatory local rules give you a forum in your
            own country, those rules apply on their own terms regardless of this clause. If you need
            to know the specific court by name before you can approve vet402 internally, ask us by
            email and we will tell you in writing.
          </p>
          <p>
            Before starting formal proceedings, please email us and give us 30 days to sort it out.
            One person reads that inbox and answers. These terms contain no mandatory arbitration
            clause and no class-action waiver — we are not asking you to sign away a forum.
          </p>
          <p>These terms are written in English, and the English text governs.</p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">12.</span>
            <span>Changes, and the rest</span>
          </h2>
          <p>
            We may update these terms as the product changes. Material changes will be reflected on
            this page with an updated date before they take effect; continuing to use vet402 after
            that means the updated terms apply. If any part of these terms turns out to be
            unenforceable, the rest stays in force and that part is read as narrowly as needed to
            make it valid. If we do not enforce something immediately, we have not given it up.
            Sections 5 through 11, and sections 13 through 15, survive after you stop using the
            service. Together with the{" "}
            <a className="doc-link" href="/legal/privacy">
              Privacy Policy
            </a>
            , these terms are the whole agreement between you and us about vet402. You may not
            transfer your rights under them; we may transfer ours if the project moves to a company
            or is acquired, and we will say so on this page if that happens.
          </p>
          <p>
            Questions about these terms? Email{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </section>

        {/* --- 13-15: verification results (added 2026-08-13 with the vet402
            rename). A verification result is a record of a measurement, not an
            opinion like a score, so it gets its own sections: what a result is
            (13), decisions it must not be used for (14), and the badge license
            (15). Section numbers 0-12 above are unchanged. --- */}

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">13.</span>
            <span>Verification results — what they are, and what they are not</span>
          </h2>
          <p>
            Alongside trust scores, vet402 publishes verification results for x402 endpoints. A
            verification result is different in kind from a score, so it gets its own section. A
            score is our opinion (section 6). A verification result is a record of a measurement:
            at the moment shown on the result, we paid the endpoint&apos;s published price with
            real funds, following our published methodology, and we recorded what happened. We
            publish the record, the transaction hash, and the timestamp, and we describe what we
            observed in plain factual terms.
          </p>
          <p>
            A verification result is a snapshot, and only a snapshot. It states what that endpoint
            did at the recorded time, measured the recorded way. It is not a statement about what
            the endpoint is doing now, will do tomorrow, or did for anyone else. It is not a
            representation or warranty of the operator&apos;s reliability, solvency, honesty, or
            future performance, and it is not an endorsement of, or a recommendation to transact
            with, anyone. A &quot;pass&quot; means the endpoint delivered what it charged for when
            we tested it — nothing more. A &quot;fail&quot; means it did not deliver when we
            tested it — and a temporary outage can produce the same record as a permanent one,
            which is why we re-test before confirming any fail and show an &quot;as of&quot;
            timestamp on everything.
          </p>
          <p>
            &quot;Unverified&quot; is not a negative assessment. Most endpoints start unverified,
            and an endpoint can be unverified simply because we have not tested it yet, because it
            opted out of test purchases, or because a result could not be determined. We do not
            treat &quot;unknown&quot; as &quot;bad,&quot; and neither should you.
          </p>
          <p>
            Results age. We re-test on a published cadence and update results automatically, but
            between measurements the world can change faster than we do. Always read a result
            together with its timestamp, and treat the live result page — not any copy,
            screenshot, or badge — as the only current statement.
          </p>
          <p>
            If you operate an endpoint and believe a result about it is wrong, the challenge route
            in section 8 applies to verification results exactly as it applies to scores: it is
            free, needs no account, and one person reads that inbox. We will re-test within a
            stated period, publish corrections openly, and record them in a corrections log.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">14.</span>
            <span>Decisions you may not base on results</span>
          </h2>
          <p>
            Scores and verification results are informational. They exist to help a business
            decide how much friction to apply before accepting a payment or calling an endpoint.
            They are not built, tested, or represented as suitable for anything else, and some
            uses are expressly off the table:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Investment decisions.</strong> Nothing we publish is investment advice, a
              research report, a solicitation, or a recommendation to buy, sell, or hold any
              token, security, or other asset, and nothing we publish says anything about the
              value or prospects of any project or business. Do not use scores or verification
              results to make, justify, or market an investment decision.
            </li>
            <li>
              <strong>
                Credit, insurance, employment, housing, and similar decisions about people.
              </strong>{" "}
              Scores and results describe addresses and endpoints, not people (section 6), and
              they must not be used as a factor in deciding whether a person gets a loan, a
              policy, a job, a home, or any similar benefit. They are not a consumer report and we
              are not a consumer reporting agency.
            </li>
            <li>
              <strong>Clipped or altered republication.</strong> If you quote a result, you must
              keep its &quot;as of&quot; timestamp and a link to the live result page, and you
              must not alter, truncate, or reframe it in a way that changes what it says —
              including presenting a past &quot;pass&quot; as current, or presenting a
              &quot;fail&quot; without the timestamp and re-test context the result page carries.
            </li>
          </ul>
          <p>
            Using the service for any of these is a breach of section 4 (acceptable use), and
            section 10 (your responsibility to us) applies to claims that arise from it. We wrote
            this section because a snapshot that is accurate on the day it is taken becomes a
            false statement when someone strips the date off and waves it around; we do not want
            our measurements doing that to anyone.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">
            <span className="sec-no">15.</span>
            <span>Badges</span>
          </h2>
          <p>
            We may offer verification badges — small images or SVG embeds that show an
            endpoint&apos;s current verification status. If we do, this section is the license for
            them.
          </p>
          <p>
            <strong>What we grant.</strong> If an endpoint you operate has a current verification
            result, we grant you a limited, non-exclusive, non-transferable, non-sublicensable,
            revocable permission to display the badge for that endpoint on your own site and
            materials. The badge is ours; this is permission to display it, not a transfer of any
            right in it, and it does not license our name or logo for any other use.
          </p>
          <p>
            <strong>Display conditions.</strong> A badge must be embedded so that it reflects the
            current result — use the live embed we serve rather than a saved copy, because a
            screenshot of Tuesday&apos;s badge is a statement about Tuesday that starts lying the
            moment things change, and if you freeze it, the lie is yours: keeping a stale badge on
            display is the displayer&apos;s responsibility, not ours. The badge must link back to
            its live result page on vet402, must be reproduced without modification — no edits to
            its wording, marks, colors, or proportions, and no cropping the timestamp — and must
            not be displayed in a way that suggests we endorse your business, audited anything
            beyond the tested endpoint, or guarantee future performance. &quot;Verified by
            vet402&quot; means exactly what section 13 says a result means, and a badge may not be
            used to imply more.
          </p>
          <p>
            <strong>Revocation.</strong> We may withdraw permission for a badge at any time — in
            particular when the underlying result changes, goes stale, or is corrected, or when a
            badge is being displayed in breach of this section. The live embed updates or goes
            blank on its own. If you have displayed the badge any other way and we ask you to
            remove it, you will do so within 5 business days. Continuing to display a badge after
            the permission behind it has ended is use of our mark without a license, and section
            10 applies to claims that arise from a badge displayed in breach of this section.
          </p>
        </section>

        <section className="space-y-2">
          <h2 id="paid-subscriptions" className="sec-head">
            <span className="sec-no">16.</span>
            <span>Paid subscriptions</span>
          </h2>
          <p>
            Paid plans raise the monthly lookup quota on the score API. They are business-to-business
            subscriptions billed after an API key exists, from the dashboard, in US dollars via
            Stripe. Public pages — the observatory and the payee lookup — stay free and do not
            require a key.
          </p>
          <p>
            <strong>What you buy.</strong> A month of the stated lookup quota for that plan, shared
            across every key on the account. Unused lookups do not roll over. Changing plan in the
            middle of a period is handled by Stripe; the next invoice may include a prorated
            difference. The current plan names and prices are the ones shown on Billing at the
            moment you pay, not a price quoted elsewhere.
          </p>
          <p>
            <strong>Cancel.</strong> Cancel from the Stripe customer portal linked on Billing
            (&quot;Manage subscription&quot;). Access to the paid quota continues until the end of
            the current period, then the account returns to Free. We do not refund unused lookups
            or unused time on a cancelled period.
          </p>
          <p>
            <strong>Failed payment.</strong> If a renewal charge fails, Stripe retries. Until that
            finishes, Billing will say so and the current plan stays. If retries fail, the
            subscription ends and the account returns to Free. Card, invoices, and tax details are
            managed in the portal, not by email from us — the service sends no email.
          </p>
        </section>
      </article>
    </main>
  );
}
