import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { VerdictBadge } from "@/components/site/VerdictBadge";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { agentPassports } from "@/lib/db/schema";
import { parseAgentId } from "@/lib/chain/client";
import { scoreAgentById } from "@/lib/scoring/engine";
import { hasUnavailableInput } from "@/lib/scoring/verdict";
import TrackView from "@/components/site/TrackView";

// A-10 — public agent passport profile: the symmetric twin of the payee
// profile (/payee/[address]). Where a payee proves control of a receiving
// wallet, an agent proves control of its ERC-8004 identity. The agent presents
// this proactively to win better terms; a counterparty reads it to decide.
// Rendered per request, NOT ISR-cached (2026-08-12). This page shows a verdict
// and links the reader to /api/v1/agents/{id}/passport for the same agent —
// and the passport is force-dynamic. With `revalidate = 300` the page served a
// separately-aged generation of the same verdict, so at 10:30:22Z agent 1 read
// 83/ALLOW here and 48/BLOCK on the passport this page points at. A trust
// layer that contradicts itself between two of its own surfaces is worse than
// one that is slow.
//
// The cost is bounded: scoreAgentById is memoised for CACHE_TTL_MS, so a
// request usually resolves against the same cached verdict the passport reads
// rather than recomputing — the page stops holding its own private generation,
// it does not start recomputing per view.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agentId: string }>;
}): Promise<Metadata> {
  const { agentId } = await params;
  // 2026-08-13 [m2]: 二重サフィックス解消（template が " | vet402" を付ける）。
  // 2026-08-14: openGraph/twitter/canonical を pageMetadata で個別化。
  // 2026-08-19: 未登録エージェント（agent_passports 行なし）は noindex。/agent/{整数}
  // は形式が整数でありさえすれば 200 を返すため、登録の有無を検証しないと
  // /agent/0..∞ の全整数が indexable なソフト404になる（sibling の /observatory/e・
  // /payee は不在時 noindex 済み）。ページ自体は直接照会のため引き続き閲覧可能。
  // 2026-08-26: 不正な（数値でない）agentId は本文側の notFound() と揃えてここでも
  // 404 判定する。<head> がストリーミング開始前に確定する関数なので、ここで先に
  // 弾いておけば「存在しないIDにも関わらず一般的なタイトル」というメタデータの
  // 齟齬を避けられる（/observatory/e/[id] と同じ形——このコミット単独では
  // HTTP ステータスは直らない。直るのは同梱の loading.tsx 削除の方）。
  if (parseAgentId(agentId) === null) notFound();
  return pageMetadata({
    title: `Agent ${agentId} — trust passport`,
    description: "Verified AI agent: signature-proven identity claim plus a live trust score and x402 payment record.",
    path: `/agent/${agentId}`,
    noindex: !(await agentHasRegisteredIdentity(agentId)),
  });
}

/**
 * True iff `agentId` resolves to a registered ERC-8004 identity we hold a
 * passport row for. Unregistered ids still render (a score anyone can look up),
 * but must not be indexed. Fails safe to `false` (noindex) when the id is
 * malformed or the DB is unreachable — never invent an indexable page.
 */
async function agentHasRegisteredIdentity(agentIdParam: string): Promise<boolean> {
  const agentId = parseAgentId(agentIdParam);
  if (agentId === null) return false;
  const db = getDb();
  if (!db) return false;
  try {
    const rows = await db
      .select({ agentId: agentPassports.agentId })
      .from(agentPassports)
      .where(eq(agentPassports.agentId, agentId))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId: agentIdParam } = await params;
  const agentId = parseAgentId(agentIdParam);
  if (agentId === null) notFound();

  const db = getDb();
  let entry: { name: string; url: string | null; wallet: string; verifiedAt: Date | null } | null = null;
  if (db) {
    try {
      const rows = await db
        .select()
        .from(agentPassports)
        .where(eq(agentPassports.agentId, agentId))
        .limit(1);
      if (rows[0]) {
        entry = { name: rows[0].name, url: rows[0].url, wallet: rows[0].wallet, verifiedAt: rows[0].verifiedAt };
      }
    } catch {
      entry = null;
    }
  }

  let score:
    | {
        value: number;
        recommendation: string;
        paymentCount: number;
        uniqueDays: number;
        degraded: boolean;
      }
    | null = null;
  try {
    // 2026-08-06: scoreAgentById reads chain state several calls deep. A HANG
    // in that await chain (a slow/unreachable RPC) is not a rejection, so the
    // catch below never fires and the whole page hangs until Vercel kills it
    // with a 504 — reproduced 504 on /agent/1 in production, the same failure
    // class already fixed in /api/demo/score. Race the score against a timeout
    // well under the platform limit so an unresponsive dependency degrades to
    // "Score unavailable right now." instead of taking the page down.
    const result = await Promise.race([
      scoreAgentById(agentId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("agent_score_timeout")), 8_000),
      ),
    ]);
    score = {
      value: result.trustScore,
      recommendation: result.recommendation,
      paymentCount: result.signals.x402.paymentCount,
      uniqueDays: result.signals.x402.uniqueDays,
      // 2026-08-13: the same definition of "degraded" the engine uses to decide
      // a verdict is not safe to cache (verdict.ts). Read here so this page can
      // say it, instead of printing the fail-closed number as if it were a
      // reading of the agent.
      degraded: hasUnavailableInput(result.signals.sybil.flags),
    };
  } catch {
    score = null;
  }

  // Coarse band for the passport_view event — map the product's own
  // ALLOW/WARN/BLOCK banding rather than invent numeric thresholds. The
  // agentId is deliberately NOT a prop (the URL path already carries it).
  // 2026-08-13: `degraded` is its own band here too. /payee/[address] already
  // separated it; folding a fail-closed refusal into "low" on this side made an
  // upstream outage indistinguishable, in the same funnel data, from a genuinely
  // bad agent.
  const band = !score
    ? "unavailable"
    : score.degraded
      ? "degraded"
      : score.recommendation === "ALLOW"
        ? "high"
        : score.recommendation === "WARN"
          ? "medium"
          : score.recommendation === "BLOCK"
            ? "low"
            : "unknown";

  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Leaderboard", path: "/leaderboard" },
    { name: `Agent #${agentId.toString()}`, path: `/agent/${agentIdParam}` },
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
        <TrackView event="passport_view" props={{ band, verified: Boolean(entry) }} withReferrerType />

        <div className="doc-head">
          <div className="doc-head-col">
            <span>{entry ? "Verified agent" : "Agent passport"}</span>
            <span>Subject: ERC-8004 agent id</span>
            <span>
              Identity:{" "}
              <span className="text-signal">{entry ? "claimed and proven" : "unclaimed"}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>Claim: wallet control by signature</span>
            <span>Engine: agent/wallet, computed on request</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Agent #{agentId.toString()}</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        {entry ? (
          <div className="mt-8 border-l-[3px] border-emerald-700 bg-emerald-50 px-5 py-4">
            <p className="text-emerald-900">{entry.name}</p>
            <p className="mt-2 text-[0.8125rem] text-emerald-800">
              Control of this agent was proven by a signature from its on-chain wallet
              {entry.verifiedAt ? ` on ${entry.verifiedAt.toISOString().slice(0, 10)}` : ""}.
            </p>
            <p className="mt-1 break-all font-mono text-xs text-emerald-800">{entry.wallet}</p>
            {entry.url ? (
              <p className="mt-2 text-[0.8125rem] text-emerald-800">
                Site:{" "}
                <a href={entry.url} rel="noopener noreferrer nofollow" target="_blank" className="underline">
                  {entry.url}
                </a>
              </p>
            ) : null}
            <p className="mt-2 text-xs text-emerald-800">
              Verification proves wallet control only — it is not an endorsement, and the score below is
              computed independently of it.
            </p>
          </div>
        ) : (
          <p className="doc-p mt-8">
            This agent has not registered a trust passport.{" "}
            <span className="text-brand-lift">
              Own it? Claiming a passport is API-only — there is no in-browser form. POST a signed
              claim to{" "}
              <code className="break-all text-brand-deep">/api/v1/agents/verify</code> (free, no API
              key, signature required). See the{" "}
              <Link href="/docs/api#post-api-v1-agents-verify" className="doc-link">
                API reference
              </Link>
              .
            </span>
          </p>
        )}

        <div className="dashbox mt-8">
          <p className="doc-caption">Live trust score</p>
          {score?.degraded ? (
            <>
              <h2 className="mt-3 font-[family-name:var(--font-display)] text-[1.375rem] font-semibold leading-tight text-brand-deep">
                Not verifiable right now
              </h2>
              <p className="mt-2 text-[0.8125rem] text-brand-lift">
                One or more upstream checks could not be completed, so no score is published for this
                agent. This is not a finding against it. Callers of the API receive a fail-closed{" "}
                <code className="text-brand-deep">BLOCK</code> until the checks succeed.
              </p>
            </>
          ) : score ? (
            <p className="mt-3 font-[family-name:var(--font-display)] text-[1.75rem] font-semibold text-brand-deep">
              <span
                role="img"
                aria-label={`Trust score ${score.value} out of 100, recommendation ${score.recommendation}`}
              >
                {score.value}
                <span className="align-baseline text-base font-normal text-brand-lift"> / 100</span>{" "}
                <VerdictBadge verdict={score.recommendation} className="align-middle" />
              </span>
            </p>
          ) : (
            <p className="mt-3 text-brand-lift">Score unavailable right now.</p>
          )}
          {score && !score.degraded ? (
            <p className="mt-2 text-[0.8125rem] text-brand-lift">
              x402 settlement record: {score.paymentCount} payment{score.paymentCount === 1 ? "" : "s"} over{" "}
              {score.uniqueDays} distinct day{score.uniqueDays === 1 ? "" : "s"}.{" "}
              <Link href="/docs/api#score-breakdown" className="doc-link">
                Score breakdown
              </Link>
              .
            </p>
          ) : null}
          <p className="mt-2 text-[0.8125rem] text-brand-lift">
            This is an agent/wallet-engine score, not an observatory measurement and not a payee score.{" "}
            <Link href="/accuracy" className="doc-link">Methodology and measured accuracy</Link>.{" "}
            Machine-readable passport:{" "}
            <code className="break-all text-brand-deep">/api/v1/agents/{agentId.toString()}/passport</code>.{" "}
            Badge:{" "}
            <code className="break-all text-brand-deep">/api/badge/agent/{agentId.toString()}</code>
          </p>
        </div>
      </article>
    </main>
  );
}
