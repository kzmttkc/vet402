import type { Metadata } from "next";
import { headers } from "next/headers";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

// 2026-08-13 [m2] の続き: /legal/notice にだけ固有 title を付け、同じ legal/
// 配下の terms と privacy を取り残していた。template が " | vet402" を付けるので、
// ここではサフィックスを書かない。
export const metadata: Metadata = pageMetadata({
  title: "Privacy Policy",
  description:
    "What vet402 collects, what it does not, and how long it is kept — for API customers and for the wallets that appear in public verification results.",
  path: "/legal/privacy",
});

export default async function PrivacyPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Privacy Policy", path: "/legal/privacy" },
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
            <span>Instrument: privacy policy</span>
            <span>
              {/* この頁のシアン1点。改訂日という事実。 */}
              Revision: <span className="text-signal">August 14, 2026</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>August 2026</span>
          </div>
        </div>
        <h1 className="doc-title mt-10">Privacy Policy</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        <p className="doc-note text-center">Last updated: August 14, 2026</p>

        <section className="space-y-2">
          <h2 className="sec-head">Contact / operator information</h2>
          <p>
            vet402 is operated by an individual proprietor. See our{" "}
            <a className="doc-link" href="/legal/notice">
              Legal Notice
            </a>{" "}
            for how operator disclosure works. Privacy questions or deletion requests:{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Data we collect</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Account email address</li>
            <li>API usage logs (agent IDs, wallet addresses queried, scores returned)</li>
            <li>Customer whitelist/blacklist entries you configure</li>
            <li>Billing metadata via Stripe (we do not store card numbers)</li>
            <li>
              Request metadata for security and rate-limiting — including the IP address a request
              is made from — kept only as long as needed to run those controls
            </li>
            <li>
              The public blockchain addresses and ERC-8004 agent identifiers we score, together
              with the on-chain activity we read about them and the scores we derive (see{" "}
              <a className="doc-link" href="#scored-third-parties">
                people we score who are not our customers
              </a>{" "}
              below)
            </li>
            <li>
              If you ask us to correct a score, whatever you send us to make that case — which may
              include an email address and a wallet signature you provide voluntarily
            </li>
            {/* 2026-09-04 外部監査 E・P1-12: 3 つの保存先が未開示だった。列は実測。 */}
            <li>
              <strong>Record notifications you asked for</strong> (<code>record_subscriptions</code>):
              the email address you entered, which endpoint record it follows, what kind of
              notification it is, the free-text reason you gave if you gave one, the last verdict we
              notified you about, and a one-way hash of the IP address the request came from (used
              to rate-limit sign-ups, never stored in the clear)
            </li>
            <li>
              <strong>Waitlist entries</strong> (<code>waitlist_entries</code>): the email address
              you entered, which offering you registered interest in, and the free-text note you
              added if you added one
            </li>
            <li>
              <strong>Disputes</strong> (<code>disputes</code>): the endpoint the dispute is about,
              the subject and reason you wrote, and the wallet address plus the signed message and
              signature that prove control of it. This table holds no email address; if you write to
              support instead, that correspondence lives in the support inbox
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Wallet addresses</h2>
          <p>
            Wallet addresses are public blockchain identifiers. We treat them as pseudonymous data
            and do not intentionally collect direct personal identifiers beyond your email.
          </p>
        </section>

        {/* 2026-08-14 (legal compliance audit): the policy listed data-subject
            rights but never stated a lawful basis for any processing, which is
            a required disclosure under GDPR Art. 6 / UK GDPR and the first gap
            a reviewer flags. The bases below describe how the operator intends
            to rely on the law; the legitimate-interest basis for scoring third
            parties in particular is a position, not a settled ruling, and is
            called out for legal review in the audit report rather than asserted
            here as certain. */}
        <section className="space-y-2">
          <h2 className="sec-head">Legal basis (GDPR / UK GDPR)</h2>
          <p>
            Where the EU or UK GDPR applies, we rely on the following lawful bases. If you are in a
            jurisdiction with a different framework (for example Japan&apos;s APPI or a US state law),
            equivalent bases apply under that law.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Performance of a contract</strong> (Art. 6(1)(b)) — creating and running your
              account, authenticating API keys, metering usage, and answering support.
            </li>
            <li>
              <strong>Legitimate interests</strong> (Art. 6(1)(f)) — scoring public blockchain
              addresses and agent identifiers so that operators can assess payment risk, together
              with securing the service and preventing abuse. The interest is providing an
              independent fraud-risk signal for on-chain payments; the data is already public
              on-chain; and anyone scored has a free route to object and to have factual errors
              corrected (see below). You can ask us for our balancing assessment.
            </li>
            <li>
              <strong>Legal obligation</strong> (Art. 6(1)(c)) — keeping billing and tax records for
              the period the law requires.
            </li>
            <li>
              <strong>Consent</strong> (Art. 6(1)(a)) — we do not currently rely on consent for any
              processing (our analytics is cookieless and needs none). If that ever changes we will
              ask for it separately and you will be able to withdraw it.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Retention</h2>
          <p>
            Query logs are retained per your plan (90 days Free, 1 year Pro+). You may request
            deletion of your account by contacting support.
          </p>
          {/* 2026-09-04 外部監査 E・P1-12: 上の 3 つに保持期間も削除経路も書かれていなかった。
              自動失効の仕組みは無いので、無い仕組みを在ると書かずに、人が消すと書く。 */}
          <p>
            Record notifications, waitlist entries and disputes are kept until you ask us to remove
            them, because each of them exists to be acted on later: a notification has to outlive
            the change it is watching for, and a dispute is part of the record of a correction. None
            of the three expires automatically — no scheduler deletes them — so the route is a
            person. Mail{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>{" "}
            and say which one you mean; we remove it by hand within 7 days and confirm to the same
            address. Replying to a notification email reaches the same inbox and counts as the same
            request. Where a dispute has already produced a published correction, we remove your
            contact details and keep the fact that a correction was issued, which is the entry other
            people rely on — the grounds for that are in{" "}
            <a className="doc-link" href="#scored-third-parties">
              people we score who are not our customers
            </a>{" "}
            below.
          </p>
        </section>

        {/* 2026-08-14 (legal compliance audit): the previous version named the
            categories ("hosting, database, RPC, Stripe") but not the actual
            subprocessors, which is the first thing a GDPR/procurement reviewer
            asks for. The list below is measured from the codebase (package.json
            dependencies and the env vars each integration reads), not assumed.
            2026-09-04 外部監査 E・P1-12: この注釈は「メール配信の委託先は無い
            （サービスはメールを送らない）」と書いていたが偽だった——
            record-subscriptions の通知と異議への返信は Resend で送っている。
            Solana の決済読み直しも公開 RPC を叩いている。両方を下に足した。 */}
        <section className="space-y-2">
          <h2 className="sec-head">Subprocessors and third parties</h2>
          <p>
            We use the providers below to run the service. Each processes only the data its function
            needs, under its own data-processing terms. We do not sell personal data, and we do not
            share it with anyone for their own marketing.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Vercel</strong> (US) — application hosting and edge delivery; sees request
              metadata including IP addresses.
            </li>
            <li>
              <strong>Neon</strong> (US) — the PostgreSQL database that stores accounts, API keys,
              usage logs, and scores.
            </li>
            <li>
              <strong>Stripe</strong> (US) — billing and payment processing for paid plans; holds
              card data directly, which we never see or store.
            </li>
            <li>
              <strong>Alchemy</strong> (US) — Base blockchain RPC and indexing; receives the public
              wallet addresses we read on-chain data for.
            </li>
            <li>
              <strong>Blockscout</strong> — block-explorer API used to read public on-chain data;
              receives the public wallet addresses we query.
            </li>
            <li>
              <strong>Solana Labs public mainnet RPC</strong> (<code>api.mainnet-beta.solana.com</code>)
              — used to re-read Solana settlements on-chain; receives transaction signatures and
              wallet addresses, all of which are already public on that chain.
            </li>
            <li>
              <strong>Resend</strong> (US) — email delivery for the record-change notifications you
              asked for and for replies about a dispute; receives the recipient email address and
              the body of that message. It is not used for marketing, and there is no newsletter.
            </li>
            <li>
              <strong>Plausible Analytics</strong> (EU) — aggregate traffic statistics. Plausible is
              cookieless, sets no persistent identifier, and does not collect personal data or track
              visitors across sites.
            </li>
          </ul>
          <p>
            This list can change as the service evolves; the current list lives on this page, and we
            will update it here before a new subprocessor starts handling personal data. If you need
            it confirmed in writing for a procurement review, ask us by email.
          </p>
        </section>

        {/* 2026-08-14 (legal compliance audit): cookies were undisclosed. The
            only cookie the site sets is the dashboard login session — verified
            in src/lib/dashboard/session.ts: httpOnly, secure, sameSite=strict.
            It is strictly necessary for authentication, so under the ePrivacy
            Directive it needs no consent banner; analytics is cookieless. This
            section states that plainly rather than leaving it implied. */}
        <section className="space-y-2">
          <h2 className="sec-head">Cookies</h2>
          <p>
            We use one cookie, and only after you log in to the dashboard: a strictly-necessary
            session cookie that keeps you signed in. It is set{" "}
            <code className="text-brand-deep">httpOnly</code>,{" "}
            <code className="text-brand-deep">secure</code>, and{" "}
            <code className="text-brand-deep">sameSite=strict</code>, and it is used for nothing but
            authentication. Because it is strictly necessary, it needs no consent. We set no
            advertising or cross-site tracking cookies, and our analytics (Plausible) is cookieless,
            so there is no consent banner to click through.
          </p>
        </section>

        {/* 2026-08-06 (L4 legal review): the policy named deletion as the only
            right and said nothing about where data physically sits. Both are
            baseline expectations under GDPR/APPI-style regimes, and the storage
            question is the first one a procurement reviewer asks. The hosting
            region is deliberately not asserted here — the operator has not
            measured which region the Vercel/Neon projects are pinned to, and a
            privacy policy is the wrong place to guess. Naming the providers and
            offering the exact region on request is accurate today; replace this
            with the measured region once it is confirmed. */}
        <section className="space-y-2">
          <h2 className="sec-head">Where your data is stored</h2>
          <p>
            vet402 is hosted on Vercel, with its database on Neon — both are US-headquartered
            providers — and the operator administers the service from Japan. Your data is therefore
            stored and accessed outside your own country in most cases, and personal data
            originating in the EEA or UK may be transferred to and processed in third countries. We
            rely on our providers&apos; standard data-processing terms, including standard
            contractual clauses where they apply, for those transfers. If you need the specific
            hosting region confirmed in writing before approving vet402 internally, ask us by email
            and we will tell you.
          </p>
        </section>

        {/* 2026-08-14 (legal compliance audit): the highest-risk area for this
            product. We score third parties who never signed up and publish the
            result; negative verdicts carry defamation exposure, and the
            corrections log collides with the erasure right (GDPR Art. 17) and
            the objection right (Art. 21) if treated as absolute. Same-day B-1
            interim decision (CEO/owner-approved): the log's old "none
            withdrawn" absolutism was replaced with individual balancing +
            Art. 18 restriction/annotation (see the paragraph comment below).
            The lawyer-review flag on the underlying balance STANDS — nothing
            here may be presented as a settled legal conclusion. */}
        <section id="scored-third-parties" className="scroll-mt-24 space-y-2">
          <h2 className="sec-head">People we score who are not our customers</h2>
          <p>
            vet402 scores blockchain addresses and agent identifiers that belong to third parties —
            people and businesses who never opened an account with us. If one of those addresses can
            be traced to you, the data-protection law where you live may treat our score as personal
            data about you, and you have rights over it even though you are not our customer.
          </p>
          <p>
            The data involved is the public on-chain address, the public transaction activity we
            read about it, and the score we derive from that activity. We do not attach names,
            contact details, or off-chain identity to an address unless the person behind it gives
            them to us — for example by using the correction route.
          </p>
          {/* 2026-08-14 (B-1 暫定実装・CEO判断/オーナー承認): 旧文は「append-only が
              正当な利益で消去要求を上回りうる」という立場表明で止まっていた。
              Art.17 単体で「絶対に消さない」は拒否根拠にならないため、運用を
              明文化する: 個別衡量→(優越根拠あり) Art.18 制限＋注記＋訂正、
              (根拠なし) 削除/匿名化。機械的拒否はしない。B-1 の弁護士レビュー
              自体は据え置き——これは暫定の最適解であり確定法解釈ではない。 */}
          <p>
            <strong>How we handle erasure and objection, concretely.</strong> You can ask us to
            correct a score built on a factual error, and you can object to our scoring your
            address. The free route for both — no account, no fee — is{" "}
            <a className="doc-link" href="/legal/terms#corrections">
              section 8 of the Terms
            </a>
            , and every factual correction we make is published on our{" "}
            <a className="doc-link" href="/corrections">
              corrections log
            </a>
            . You also have the rights to erasure (Art. 17) and to restriction of processing (Art.
            18), and we weigh every verified request <strong>individually</strong> — we do not
            refuse by policy, and &quot;we never delete anything&quot; is not an answer we give.
            Where a legal ground we may rely on — freedom of expression and information (Art. 85),
            the establishment, exercise, or defense of legal claims, or fraud prevention — outweighs
            your request in your specific situation, we respond with <strong>restriction rather
            than nothing</strong>: we stop publishing or stop scoring the entry concerned, annotate
            it, and correct anything inaccurate, instead of leaving it up unchanged. Where no such
            ground prevails, we delete or anonymize the data. What we will not do is silently
            rewrite our own record to hide a mistake we made — accountability for our errors and
            your rights over your data are not in conflict, and we intend to honor both. Either
            way we tell you our decision and our reasons, and if you disagree you can complain to
            your data-protection authority.
          </p>
          <p>
            <strong>A score is an opinion, not an accusation of fact.</strong> A low score or a
            BLOCK is our read of a public record on a given day, not a statement that any person is a
            criminal or a fraudster; the distinction, and why we draw it, is set out in{" "}
            <a className="doc-link" href="/legal/terms">
              sections 6 and 7 of the Terms
            </a>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Your rights over your data</h2>
          <p>
            Depending on where you are, you may have the right to <strong>access</strong> the
            personal data we hold about you (GDPR Art. 15), to have it <strong>corrected</strong>{" "}
            if it is wrong (Art. 16), to have it <strong>deleted</strong> (Art. 17), to ask us to{" "}
            <strong>restrict</strong> a particular use of it (Art. 18), to <strong>object to</strong>{" "}
            processing based on our legitimate interests (Art. 21), to receive it in a{" "}
            <strong>portable</strong> format (Art. 20), and to <strong>withdraw consent</strong>{" "}
            where we relied on consent. We weigh each request on its own facts — none of these is
            answered with a blanket policy — and we do not make automated decisions with legal or
            similarly significant effects about you as a user of this site.
          </p>
          <p>
            To exercise any of these, email{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>{" "}
            from the address on the account, or tell us which address it was. One person reads that
            inbox; we aim to acknowledge within 5 business days (Japan time) and to complete the
            request within 30 days. There is no charge. We will say no only where the law lets us —
            for example where we must keep billing records for tax purposes — and we will say which
            exception we are relying on rather than just declining. If you are unhappy with how we
            handled it, you can complain to your local data-protection authority.
          </p>
          <p>
            Two things we cannot do, and would rather say plainly than leave you to discover.
            First, we cannot erase the blockchain: wallet addresses and their transaction history
            are public records on Base that we read, not records we created or control, so deleting
            your vet402 account does not remove anything from the chain. Second, if you believe a
            trust <em>score</em> about an address is wrong — which is a different problem from a
            privacy request — the route for that is in{" "}
            <a className="doc-link" href="/legal/terms">
              section 8 of the Terms
            </a>
            : it is free, needs no account, and works whether or not you are a customer.
          </p>
        </section>
      </article>
    </main>
  );
}
