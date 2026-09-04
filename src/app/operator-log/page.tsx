import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { listOperatorOverrides } from "@/lib/db/operator-overrides";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

/**
 * /operator-log — the public, append-only record of every GLOBAL operator
 * override (an operator-wide blacklist).
 *
 * 2026-08-14 (EF/Vitalik blocker). vet402 could globally block an address with
 * no reason, no signal trail, and nothing the scored party could see — a silent
 * single censorship point that contradicts the credible-neutrality the product
 * claims. This page turns each such act into an auditable public record: the
 * address, what happened, the operator's stated reason, and when. It follows the
 * /corrections model — the log exists before the first entry, and says so
 * honestly, so it is a real ledger rather than something that appears only when
 * there is something flattering to put in it.
 *
 * What is NOT here: a customer blacklisting an address for their OWN integration.
 * That is the customer's private management right over their own traffic, not an
 * operator act of network-wide censorship, and exposing it would leak one
 * customer's risk decisions to everyone.
 */

export const metadata: Metadata = pageMetadata({
  title: "Operator override log",
  description:
    "Every global override vet402's operator has applied to a score — the address, the stated reason, and when. Customer-scoped lists are private and never appear here. Empty until the first one.",
  path: "/operator-log",
});

// Read fresh on each request (append-only, low volume); the API route caches.
export const dynamic = "force-dynamic";

export default async function OperatorLogPage() {
  const overrides = await listOperatorOverrides();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Operator log", path: "/operator-log" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Credible Neutrality</span>
            <span>Register: operator overrides</span>
            <span>
              Entries: <span className="text-signal">{overrides.length}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>Global acts only, append-only</span>
            <span>Address · reason · time</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Operator overrides</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            When vet402&rsquo;s operator globally blocks an address, that act is recorded here with
            the address, the stated reason, and the time. Enforcement and this public record land
            together &mdash; there is no way to block globally without leaving this trace. Nothing is
            removed from this list once it is on it.
          </p>
        </div>

        {/* ===== 1. The log ===== */}
        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>Applied overrides</span>
        </h2>

        {overrides.length === 0 ? (
          <div className="dashbox mt-6 max-w-[64ch]">
            <p className="doc-caption">Empty log</p>
            <p className="mt-3 text-brand">No global operator overrides have been applied.</p>
            <p className="doc-note mt-3">
              This is the count, not a claim: it says vet402 has censored no address network-wide,
              and it is verifiable at{" "}
              <code className="break-all text-brand-deep">/api/transparency/operator-overrides</code>
              . The page exists before the first entry for the same reason{" "}
              <Link href="/corrections" className="doc-link">
                the corrections log
              </Link>{" "}
              does &mdash; a censorship ledger that appears only after the first act of censorship is
              not a check on it.
            </p>
          </div>
        ) : (
          <div className="mt-6 divide-y divide-hair border-t border-brand-deep">
            {overrides.map((entry) => (
              <div key={`${entry.createdAt}-${entry.wallet}-${entry.action}`} className="py-5">
                <p className="text-[0.8125rem] text-brand-lift">
                  {entry.createdAt.slice(0, 19).replace("T", " ")} UTC &middot; {entry.action}
                </p>
                <p className="mt-1 break-all font-[family-name:var(--font-display)] font-semibold text-brand-deep">
                  {entry.wallet}
                </p>
                <p className="mt-2 max-w-[64ch] text-brand">
                  <strong>Reason.</strong> {entry.reason}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* ===== 2. What lands here ===== */}
        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>What lands here, and what does not</span>
        </h2>

        <div className="mt-6 space-y-5">
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">2.1</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              <strong>A global operator block.</strong> If vet402&rsquo;s operator adds an address to
              the network-wide blacklist &mdash; the &ldquo;operator_policy&rdquo; block that appears
              on every customer&rsquo;s score &mdash; the address and the stated reason are recorded
              here at the moment it takes effect.
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">2.2</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              <strong>Not: a customer&rsquo;s own list.</strong> A customer whitelisting or
              blacklisting an address for their own integration is their private decision about their
              own traffic. It is not an operator act, it does not appear on anyone else&rsquo;s score,
              and it is never published here.
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">2.3</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              <strong>Not: the score itself.</strong> A block here is advice, not custody. vet402
              never holds or moves customer funds; a customer&rsquo;s SDK decides what to do with the
              verdict. (The observatory does spend vet402&rsquo;s own funds to buy from endpoints —
              that is our money, and it never touches yours.) This log records what vet402 said and
              why, not an action taken on anyone else&rsquo;s money.
            </p>
          </div>
        </div>

        {/* ===== 3. Disputing an entry ===== */}
        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>If you are on this list and think it is wrong</span>
        </h2>
        <p className="doc-p">
          The same two free routes that challenge any score apply here, no account required: prove
          control of the address by signing our canonical message and posting it to{" "}
          <code className="break-all text-brand-deep">/api/v1/payees/verify</code>, or write to{" "}
          <a className="doc-link" href={SUPPORT_MAILTO}>
            {SUPPORT_EMAIL}
          </a>{" "}
          with the address and why the block is wrong. One person reads that inbox and will
          acknowledge within 5 business days.{" "}
          <Link href="/legal/terms#corrections" className="doc-link">
            Section 8 of the Terms of Service
          </Link>{" "}
          is the full text, and{" "}
          <Link href="/corrections" className="doc-link">
            the corrections log
          </Link>{" "}
          records any block we concede was wrong and reverse.
        </p>

        <p className="mt-8 text-[0.8125rem]">
          <Link href="/corrections" className="doc-link">
            Corrections log
          </Link>{" "}
          &middot; Raw JSON at{" "}
          <code className="break-all text-brand-deep">/api/transparency/operator-overrides</code>
        </p>
      </article>
    </main>
  );
}
