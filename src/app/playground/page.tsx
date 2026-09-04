import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { getCoverageShare, getObservatoryOverview } from "@/lib/observatory/reader";
import PlaygroundClient, { type PlaygroundCandidate } from "./playground-client";

/**
 * /playground — 実購入検証のライブデモ（Phase 0.1・仕様書§4）。
 *
 * 初見の審査員が5分以内に「カタログ → ライブL0プローブ → 実購入レシート →
 * 下流バッジ」の一本道を体験できることが受け入れ条件。語彙は観測所と同じ
 * 閉集合（pass / fail / unverified）。スコアや評価語はここにも出さない —
 * L1 の実購入証拠（txハッシュ付き）へ実物のまま接続するのがデモの価値。
 *
 * 候補は「直近の L0 が pass のエンドポイント」に限定する: 初手で
 * 死んだ壁を踏ませると、デモの5分が製品でなく相手側の不調の説明で終わる。
 */

export const metadata: Metadata = pageMetadata({
  title: "Playground — watch a live verification",
  description:
    "Pick a listed x402 endpoint and watch vet402 probe its payment wall live: the 402 challenge, the catalog cross-check, and the real-purchase receipt trail behind it.",
  path: "/playground",
});

export const revalidate = 600;

export default async function PlaygroundPage() {
  const overview = await getObservatoryOverview({ verdict: "pass", pageSize: 20 });
  // 2026-09-04 外部監査 E・P0-5: §4 は「on the whole public catalog daily」と
  // 書いていた。それは 9/2 に訂正した文と同じ主張で、訂正が伝播していなかった。
  // 実測（カタログは日次再取得・プローブはローリング）を出す。
  const coverage = await getCoverageShare().catch(() => null);
  const candidates: PlaygroundCandidate[] = overview.rows.map((r) => ({
    id: r.id,
    resourceKey: r.resourceKey,
    network: r.network,
    method: r.method,
  }));
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Playground", path: "/playground" },
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
            <span>Independent Measurement</span>
            <span>Live demonstration: one endpoint, one probe</span>
            <span>
              Candidates: {candidates.length} endpoints whose latest L0 measurement is{" "}
              <span className="text-signal">pass</span>
            </span>
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
            <span>No account. No key. Facts only</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Playground</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            vet402 verifies x402 payment endpoints by <strong>actually using them</strong>: probing
            the payment wall (L0), and above that, paying the listed price with its own funds and
            recording whether the payment settles (L1) — every receipt public, transaction hash
            included. This page lets you run the L0 step yourself, live, against a real listed
            endpoint, and then follow the same evidence trail a paying agent would read.{" "}
            <strong>pass / fail / unverified</strong> are defined measurements, not opinions —{" "}
            <Link href="/observatory/methodology" className="underline">
              definitions here
            </Link>
            .
          </p>
        </div>

        {candidates.length === 0 ? (
          <p className="mt-8 max-w-[62ch] font-semibold text-brand-deep">
            The catalog reader is not reachable right now — the full register is at{" "}
            <Link href="/observatory" className="underline">
              /observatory
            </Link>
            .
          </p>
        ) : (
          <PlaygroundClient candidates={candidates} />
        )}

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>What you just ran</span>
        </h2>
        <p className="doc-p">
          The probe approached the endpoint with the HTTP method its catalog entry declares, and
          read the wall&apos;s answer: did it return <code>402</code> with a parseable{" "}
          <code>accepts</code> array, and does that answer agree with what the catalog promised
          (price, asset, network, payee)? That is L0 — no payment attached, the challenge itself is
          the observable. It is the same measurement the{" "}
          <Link href="/observatory" className="underline">
            Observatory
          </Link>{" "}
          performs over the public catalog. The catalog itself is re-fetched daily; the probes run
          on a rolling schedule rather than sweeping every endpoint every day
          {coverage && coverage.pct !== null ? (
            <>
              , and {coverage.measuredLast7d.toLocaleString()} of{" "}
              {coverage.activeEndpoints.toLocaleString()} active listed endpoints ({coverage.pct}% of
              active listed endpoints) carry an L0 measurement from the last 7 days
            </>
          ) : null}
          . Demo probes are not written into the public register.
        </p>
        <p className="doc-p">
          L1 receipts on each endpoint&apos;s page are real purchases made under a hard daily
          budget, and failures are published with the same weight as successes —{" "}
          <Link href="/observatory/state" className="underline">
            State of x402
          </Link>{" "}
          carries the aggregate numbers.
        </p>
      </article>
    </main>
  );
}
