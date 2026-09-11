import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import CodeBlock from "@/components/docs/CodeBlock";
import { pageMetadata } from "@/lib/seo";

/**
 * /ethonline — the page an ETHOnline 2026 judge lands on from the submission's Demo URL.
 *
 * 2026-09-09: the submission form points judges at https://vet402.com. Judges look at the
 * video, then the description, then the demo URL — and the home page is a measurement
 * body's front page, not a hackathon page. This one says in ten seconds what to look at:
 * one command that runs the gate without a key, the four documents in reading order, the
 * pre-existing-work disclosure the Continuity track asks for, and the two partner tracks.
 *
 * Every number here is copied from README §ETHOnline 2026 and
 * docs/ethonline-2026/DISCLOSURE_2026-09-05.md and must stay identical to them. The
 * transaction below was re-read on chain (eth_getTransactionReceipt: status 0x1, block
 * 50898704) before it was written here.
 *
 * In sitemap.ts since 2026-09-09: the site's rule (sitemap.ts, 2026-09-02) is that a page with
 * zero internal links is not listed, and this page had none on 2026-09-09 morning. The home
 * page's doc-head now links here ("ETHOnline 2026 judges →"), so the rule says list it.
 */

const REPO = "https://github.com/kzmttkc/vet402";
const TX = "0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad";
const BASESCAN_TX = `https://basescan.org/tx/${TX}`;

const READING_ORDER: { n: number; label: string; href: string; why: string }[] = [
  {
    n: 1,
    label: "README — §ETHOnline 2026 (Continuity)",
    href: `${REPO}#ethonline-2026-continuity--what-is-ours-from-this-window`,
    why: "the boundary tag, the two git log commands (what we claim / everything on main), the caveat.",
  },
  {
    n: 2,
    label: "SKILL.md",
    href: `${REPO}/blob/main/SKILL.md#how-a-judge-can-run-it`,
    why: "the gate itself, as commands you can paste. Each block is re-run against production on a schedule, in CI.",
  },
  {
    n: 3,
    label: "docs/ethonline-2026/DISCLOSURE_2026-09-05.md",
    href: `${REPO}/blob/main/docs/ethonline-2026/DISCLOSURE_2026-09-05.md`,
    why: "the message we sent ETHGlobal before judging, verbatim, and the two corrections we made to it.",
  },
  {
    n: 4,
    label: "AI_USAGE.md",
    href: `${REPO}/blob/main/AI_USAGE.md`,
    why: "who wrote which code, by area and representative file, and what the human did.",
  },
];

export const metadata: Metadata = pageMetadata({
  // layout の template "%s | vet402" が接尾辞を付ける。
  title: "payOrRefuse — ETHOnline 2026",
  description:
    "The judge's page for vet402's ETHOnline 2026 submission: one command that runs the x402 payment gate without a key, the documents in reading order, the pre-existing-work disclosure, and the on-chain proof.",
  path: "/ethonline",
});

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export default function EthOnlinePage() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>ETHOnline 2026 — Continuity track</span>
            <span>For judges. The first command needs no key.</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Ext href={REPO}>GitHub</Ext>
              {" · "}
              <Link href="/observatory" className="underline">
                Observatory
              </Link>
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-10">
          payOrRefuse — an x402 payment gate that refuses before a signature exists
        </h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        {/* 2026-09-09 検証役の指摘: 判定者が最初に欲しいのは「貼れる1行」。§1 まで
            スクロールさせず、見出し直下に置く（1470×757 と 375×812 の初画面に入ることを
            Playwright で実測）。§1 は同じコマンドの説明だけを持つ。 */}
        <CodeBlock
          className="mt-6"
          label="run the gate without a key"
          code={`git clone ${REPO}.git && cd vet402 && npm run judge-check`}
        />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">What</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            A gate an AI agent passes through <strong>before</strong> it pays an x402 endpoint it
            has not seen before. The question is not &quot;can I pay&quot; but &quot;is there evidence
            this wallet delivers&quot; — and if there is none, no signature is created.
          </p>
        </div>
        <div className="mt-4 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">How</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            It reads two sources live: vet402&apos;s own ledger of real purchases, and The
            Graph&apos;s x402 subgraph on Base. If either source cannot be read, or the evidence
            is below the caller&apos;s floor, it <strong>refuses</strong> — the signing module is
            not even loaded. It does not fall back to a cached number.
          </p>
        </div>
        <div className="mt-4 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Proof</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            On 2026-09-05 the gate read <strong>259</strong> receipts from The Graph&apos;s
            subgraph and paid <strong>0.01 USDC</strong> to The Graph&apos;s own receiving wallet:{" "}
            <Ext href={BASESCAN_TX}>
              <span className="text-signal">block 50898704</span> on Basescan
            </Ext>
            . Our own engine rated that payee WARN; the record keeps the WARN next to the payment.
            We did not rewrite our judgement to match the money.
          </p>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>Run it yourself — no key, one command</span>
        </h2>
        <p className="doc-p">
          The command under the title, explained. A clean clone. <code>judge-check</code> installs
          the SDK, the MCP server, the demo and the A/B harness, runs the test suites, and prints
          one exit code per step. Any API key in your environment is dropped first, so a green run
          cannot be borrowing our credentials.
        </p>
        <p className="doc-p">
          Then the walkthrough in{" "}
          <Ext href={`${REPO}/blob/main/SKILL.md#how-a-judge-can-run-it`}>
            SKILL.md — How a judge can run it
          </Ext>
          : the gate refusing offline, the MCP server listing its tool over stdio, and the gate
          failing closed against the live API with a deliberately wrong key. The last block that
          actually pays is marked <code>--live</code> and is a human decision, not a default.
        </p>
        <p className="doc-p">
          The demo CLI&apos;s <code>pay</code> and <code>refuse</code> need a free Graph key:{" "}
          <code>export GRAPH_API_KEY=…</code> from{" "}
          <Ext href="https://thegraph.com/studio">https://thegraph.com/studio</Ext> (both commands).
          <code>pay</code> also needs <code>VOUCH_API_KEY</code> (free, no card:{" "}
          <Ext href="https://vet402.com/signup">vet402.com/signup</Ext>): its payee, The Graph&apos;s
          gateway, is not in our catalogue, so the verdict comes from a keyed payee-score read. With the
          Graph key alone, <code>pay</code> prints <code>verdict not read</code> and predicts a refusal;{" "}
          <code>refuse</code> runs without it. <code>judge-check</code> above needs neither.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>What to read, in order</span>
        </h2>
        <ol className="doc-p list-none space-y-3 pl-0">
          {READING_ORDER.map((r) => (
            <li key={r.n} className="flex gap-3">
              <span className="shrink-0 text-brand-deep">{r.n}.</span>
              <span className="min-w-0">
                <Ext href={r.href}>{r.label}</Ext> — {r.why}
              </span>
            </li>
          ))}
        </ol>

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>Pre-existing work (Continuity)</span>
        </h2>
        <p className="doc-p">
          vet402 existed before the hackathon. The boundary tag{" "}
          <Ext href={`${REPO}/tree/pre-ethonline-2026`}>
            <code>pre-ethonline-2026</code>
          </Ext>{" "}
          is commit <code>c42daca</code>, cut <strong>2026-09-04 00:05:36 UTC</strong>. Hacking
          began at <strong>2026-09-04 16:00 UTC</strong> (ETHGlobal&apos;s published schedule), so
          the tag sits <strong>15 h 54 min before</strong> the start. Between our application
          (2026-08-23) and the tag we made <strong>214 commits</strong> of ordinary product work. The
          message we sent ETHGlobal on 2026-09-05 said 207; the disclosure explains why the count
          here is 214. <strong>Three commits</strong>{" "}
          in the range we claim were made before 16:00 UTC — their SHAs, times and contents are
          listed in the disclosure, with the command that lists them. We are not moving the tag:
          the submission and the disclosure link to it.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>The Graph</span>
        </h2>
        <p className="doc-p">
          <strong>Load-bearing, not decorative.</strong> With{" "}
          <code>policy.evidence.source: &quot;subgraph&quot;</code> the gate reads the x402 Base
          subgraph through the Graph Gateway; if the read fails it refuses with{" "}
          <code>evidence_unavailable</code> + <code>subgraph_evidence_unavailable</code> and does
          not fall back to our ledger.
        </p>
        <p className="doc-p">
          <strong>Live, and provably so.</strong> The evidence row on the decision carries the
          subgraph&apos;s own <code>_meta.block</code> and <code>queriedAt</code>, so a reader can tell
          a live read from a cached number. <strong>Pinned.</strong> The caller may name a{" "}
          <code>deploymentId</code>; the response&apos;s <code>_meta.deployment</code> must match
          or the read counts as unavailable.
        </p>
        <p className="doc-p">
          The payment above ran on exactly this path — The Graph&apos;s data, not ours. Details:{" "}
          <Ext href={`${REPO}/blob/main/SKILL.md#paying-on-the-graphs-own-data`}>
            SKILL.md — Paying on The Graph&apos;s own data
          </Ext>
          .
        </p>

        <h2 className="sec-head">
          <span className="sec-no">5.</span>
          <span>Bazantic</span>
        </h2>
        <p className="doc-p">
          <strong>Recipe vs no Recipe, 10 trials each, same model, same prompt, same 57 tools.</strong>{" "}
          Success (right verdict, and each reason code real) was <strong>5/10 and 5/10</strong> — no difference, and we say so first. What
          the Recipe did fix is vocabulary: the share of reason codes that are real vet402
          identifiers went from <strong>63% to 91%</strong> (20/32 → 29/32). That metric is
          exploratory and labelled so.
        </p>
        <p className="doc-p">
          <strong>One finding for Bazantic itself.</strong> $0 routes still answer 402, and paying
          $0 posts a real 0-USDC transfer on chain: in 20 trials, 110 tool calls, 88 settled,{" "}
          <strong>88 free reads cost 88 facilitator transactions</strong>. Each hash is in the raw
          log. Harness and results:{" "}
          <Ext href={`${REPO}/tree/main/examples/ethonline-2026-ab`}>
            examples/ethonline-2026-ab
          </Ext>
          {" · "}
          <Ext href={`${REPO}/blob/main/docs/ethonline-2026/BAZANTIC_FEEDBACK.md`}>
            BAZANTIC_FEEDBACK.md
          </Ext>
          .
        </p>

        <div className="rule-single mt-12" />
        <p className="doc-note mt-4">
          The demo the gate protects is the same one the public uses:{" "}
          <Link href="/payee" className="underline">
            verify a payee
          </Link>{" "}
          (no key), the{" "}
          <Link href="/observatory" className="underline">
            observatory
          </Link>{" "}
          (each purchase we made, settled or not), and the{" "}
          <Ext href={`${REPO}/tree/main/examples/ethonline-2026-demo`}>
            demo CLI
          </Ext>{" "}
          (<code>refuse</code>, <code>pay</code> dry-run, <code>judge &lt;url&gt;</code>).
        </p>
      </article>
    </main>
  );
}
