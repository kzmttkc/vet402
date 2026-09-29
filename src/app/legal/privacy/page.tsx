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
              Revision: <span className="text-signal">September 29, 2026</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>September 2026</span>
          </div>
        </div>
        <h1 className="doc-title mt-10">Privacy Policy</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        <p className="doc-note text-center">Last updated: September 29, 2026</p>

        {/* 2026-09-29 監査 4 周目: GDPR 13 条 1 項 (a) の管理者の身元と連絡先を明記。 */}
        <section className="space-y-2">
          <h2 className="sec-head">Who is responsible for your data</h2>
          <p>
            The controller of the personal data described here — the business that decides why and
            how it is processed — is KIZUNA Creation, a sole proprietorship established in Japan,
            which operates vet402. Contact the controller at{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>
            . In Japan, KIZUNA Creation is the business handling personal information under the Act
            on the Protection of Personal Information (APPI).
          </p>
          <p>
            vet402 is operated by KIZUNA Creation. See our{" "}
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
              <strong>Notification consent</strong> (<code>record_subscriptions</code>): a one-way
              hash of the link we emailed you to confirm or stop record notifications, and when you
              confirmed or unsubscribed. Nothing but the confirmation email is sent until you
              confirm, and every notification carries a one-click unsubscribe link
            </li>
            <li>
              <strong>Waitlist entries</strong> (<code>waitlist_entries</code>): the email address
              you entered, which offering you registered interest in, and the free-text note you
              added if you added one
            </li>
            <li>
              <strong>Pre-publication notices to sellers</strong>: the business contact email
              address we wrote to, the seller&apos;s name and endpoints, the measurement facts in the
              message, and any reply. See{" "}
              <a className="doc-link" href="#seller-notices">
                emails we send to sellers before we publish
              </a>{" "}
              below
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
              corrected (see below). The same basis covers the pre-publication notices we email to
              sellers, whose interest is to hear about a result before it is published. You can ask
              us for our balancing assessment.
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

        {/* 2026-09-29 監査 4 周目: 2026-09-28 に records@vet402.com から売り手 5 社へ公開前の
            結果通知を Resend で送った。ポリシーは「Resend は購読通知と異議の返信だけ」と
            書いていて、実態と食い違っていた。目的・宛先の入手元・停止の方法を書く。 */}
        <section id="seller-notices" className="scroll-mt-24 space-y-2">
          <h2 className="sec-head">Emails we send to sellers before we publish</h2>
          <p>
            Before we publish results that name a seller, we may email that seller to tell them what
            we measured — for example that paid calls to their endpoint were not delivered — and when
            we plan to publish, so they can correct us or fix the problem first. These notices come
            from <code>records@vet402.com</code> and replies go to{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>
            . They report measurement facts; they are not advertising and we do not use them to
            sell anything.
          </p>
          <p>
            <strong>Where the address comes from.</strong> We write to a business contact the
            seller has published: the contact in its public listing in an x402 discovery catalog,
            or the support or contact address published on the seller&apos;s own website or domain.
            We do not buy address lists and do not guess personal addresses.
          </p>
          <p>
            <strong>How to stop them.</strong> Reply to a notice, or write to{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>
            , and say you do not want these notices; one person reads that inbox and we will not
            send further pre-publication notices to that address. Stopping notices does not stop
            the measurement or its publication, which follow our published methodology either way.
            We keep the message and any reply in the support inbox and in Resend&apos;s sending log;
            we do not add these addresses to any mailing list.
          </p>
        </section>

        <section id="retention" className="scroll-mt-24 space-y-2">
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
              <strong>Vercel</strong> (United States) — application hosting and edge delivery; sees
              request metadata including IP addresses.
            </li>
            <li>
              <strong>Neon</strong> (United States) — the PostgreSQL database that stores accounts,
              API key hashes, usage logs, and scores.
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
              <strong>Resend</strong> (United States) — email delivery for the record-change
              notifications you asked for, for replies about a dispute, and for the pre-publication
              notices we send to sellers (see{" "}
              <a className="doc-link" href="#seller-notices">
                above
              </a>
              ); receives the recipient email address and the body of that message. We do not use it
              for marketing email and we send no newsletter.
            </li>
            <li>
              <strong>Plausible Analytics</strong> (European Union) — aggregate traffic statistics.
              Plausible is cookieless and sets no persistent identifier; what your browser sends it
              is described under{" "}
              <a className="doc-link" href="#external-transmission">
                information your browser sends to a third party
              </a>{" "}
              below.
            </li>
            <li>
              <strong>GitHub</strong> (United States) — hosts vet402&apos;s public source code and
              issue tracker. If you open an issue or pull request there, it is published under your
              GitHub account and GitHub&apos;s own terms apply.
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

        {/* 2026-08-06 (L4 legal review) で「保存先の地域は実測していないので書かない」とした節。
            2026-09-29 監査 4 周目: 実測が揃ったので地域を書く。Neon は aws-us-east-2
            （docs/audits/2026-09-05-cia-availability-audit.md の実測）、Vercel の関数は
            iad1（本番ログの instance 表記）。Resend・Plausible・GitHub・Stripe は各社の公開情報。
            APPI の安全管理措置（外的環境の把握）として国名を示す。 */}
        <section id="where-stored" className="scroll-mt-24 space-y-2">
          <h2 className="sec-head">Where your data is stored</h2>
          <p>
            The operator administers the service from Japan. The data itself is stored and
            processed by the providers above, in these countries:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>United States</strong> — the database (Neon, on AWS in the US East (Ohio)
              region), the application servers (Vercel, Washington, D.C. region; pages are also
              cached on Vercel&apos;s worldwide edge network), email delivery (Resend), billing
              (Stripe), and source code hosting (GitHub).
            </li>
            <li>
              <strong>European Union (Germany)</strong> — traffic statistics (Plausible).
            </li>
            <li>
              <strong>Japan</strong> — the support inbox is read, and the service is operated, from
              Japan.
            </li>
          </ul>
          <p>
            Personal data originating in the EEA or UK is therefore transferred to and processed in
            third countries, including the United States and Japan. We rely on our providers&apos;
            standard data-processing terms, including standard contractual clauses where they apply,
            for those transfers. Each of these countries has its own data-protection law, and the
            protection there may differ from the protection where you live.
          </p>
        </section>

        {/* 2026-09-29 監査 4 周目: APPI 23 条の安全管理措置のうち公表する要点。書くのは実装にあるものだけ。 */}
        <section id="security" className="scroll-mt-24 space-y-2">
          <h2 className="sec-head">How we protect your data</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Responsibility.</strong> KIZUNA Creation is responsible for handling personal
              data in vet402, and access to the production database and hosting accounts is limited
              to the operator&apos;s accounts.
            </li>
            <li>
              <strong>In transit.</strong> The site and API are served over HTTPS.
            </li>
            <li>
              <strong>Stored secrets.</strong> API keys are stored as keyed hashes, not in the
              clear; the IP address behind a notification sign-up is stored only as a one-way hash;
              and secrets are redacted from server logs.
            </li>
            <li>
              <strong>Retention.</strong> Query logs are deleted on the schedule in{" "}
              <a className="doc-link" href="#retention">
                Retention
              </a>{" "}
              by a scheduled job.
            </li>
            <li>
              <strong>Facilities.</strong> We run no servers of our own; the data sits with the
              providers named above, in the countries named above.
            </li>
          </ul>
        </section>

        {/* 2026-09-29 監査 4 周目: 電気通信事業法 27 条の 12（外部送信規律）。CSP の connect-src は
            'self' と plausible.io だけ（src/proxy.ts）なので、ブラウザから第三者へ送る先は Plausible 1 つ。 */}
        <section id="external-transmission" className="scroll-mt-24 space-y-2">
          <h2 className="sec-head">Information your browser sends to a third party</h2>
          <p>
            When you open a page on vet402.com, your browser loads a script from{" "}
            <code>plausible.io</code> and sends Plausible Analytics (Plausible Insights OÜ) the
            address of the page you are on (including any campaign parameters in it), the referring
            page, your screen width, and the names of a few events we define, such as a button
            click, with non-identifying details about them. Plausible also receives your IP address
            and browser user-agent with the request. According to Plausible&apos;s published data
            policy, it uses them only to count unique visitors with a daily-changing hash and to
            derive the country, browser and device type, and does not store the IP address. We use
            the result for aggregate traffic statistics only. Plausible sets no cookie. This is the
            only third party our pages send information to from your browser; Stripe receives your
            details only on its own checkout and portal pages.
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
