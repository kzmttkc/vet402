import Link from "next/link";
import type { Metadata } from "next";

// 2026-09-07 ETHOnline (audit E): generateMetadata calls notFound() before returning, so
// this boundary owned no title and <head> fell back to the layout default (the home
// title). Same title as the root not-found; the template appends " | vet402".
export const metadata: Metadata = {
  title: "404 Not Found",
};

// A-10 — AgentPage calls notFound() only when parseAgentId fails (a
// non-numeric agent id). A valid-but-unregistered agent still renders the
// profile ("has not registered a passport"). So the only way here is a
// malformed id; name the actual problem and offer a way forward.
export default function AgentNotFound() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Status report</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">That is not a valid agent id</h1>
        <p className="mx-auto mt-3 max-w-[56ch] text-center text-brand-lift">
          An agent passport URL is an ERC-8004 agent id — a whole number, e.g.{" "}
          <code>/agent/42</code>.
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <p className="doc-p mt-8">
          Check the id for a typo, then try again. You can also{" "}
          <Link href="/leaderboard" className="doc-link">
            browse recently verified agents
          </Link>{" "}
          or read{" "}
          <Link href="/docs/api" className="doc-link">
            how scoring works
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
