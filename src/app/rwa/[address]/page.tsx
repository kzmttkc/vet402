import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAddress } from "viem";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit } from "@/lib/api/ip-rate-limit";
import { isValidAddress } from "@/lib/chain/client";
import { ReconstructionTimeout, TooBusy, cachedFacts } from "../../../../packages/rwa/cache";
import { NoStockTokenActivity, type RwaFacts } from "../../../../packages/rwa/facts";

/**
 * /rwa/[address] — the one public page of the RWA instrument (docs/rwa/SPEC.md §10).
 *
 * Shows only what §10 lists: address, identity_binding, canonical balance
 * (shares and USD in separate columns), feed time / stale / weekend, r1_status,
 * events_summary, evidence tx links, a link to accuracy and the fixed
 * disclaimer. No ALLOW / WARN / BLOCK, no CTA, no ranking. realized is not
 * rendered until Fixture B passes.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EXPLORER = "https://robinhoodchain.blockscout.com";

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  return {
    title: `vet402 /rwa — ${address.slice(0, 10)}…`,
    description: "A Stock Token track record rebuilt from public Robinhood Chain data. Not investment advice.",
    robots: { index: false },
  };
}

function Busy({ retryAfterSec, reason }: { retryAfterSec: number; reason: "busy" | "timeout" | "limited" }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-4">
        {reason === "busy"
          ? "Another reconstruction is running."
          : reason === "timeout"
            ? "Reading the chain took too long this time."
            : "Too many requests from this network."}{" "}
        Please reload in about {retryAfterSec} seconds.
      </p>
    </main>
  );
}

export default async function RwaAddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isValidAddress(address)) notFound();

  const ip = getClientIp(new Request("http://localhost", { headers: await headers() })) ?? "unknown";
  const limited = await consumeIpRateLimit(`rwa-page:${ip}`, 10, 60_000);
  if (!limited.allowed) return <Busy retryAfterSec={limited.retryAfter ?? 60} reason="limited" />;

  let facts: RwaFacts;
  try {
    facts = await cachedFacts(address);
  } catch (err) {
    if (err instanceof NoStockTokenActivity) notFound();
    if (err instanceof TooBusy) return <Busy retryAfterSec={err.retryAfterSec} reason="busy" />;
    if (err instanceof ReconstructionTimeout) return <Busy retryAfterSec={err.retryAfterSec} reason="timeout" />;
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-xl font-semibold">vet402 /rwa</h1>
        <p className="mt-4">Reading the chain failed. Please reload in a minute.</p>
      </main>
    );
  }

  const shown = getAddress(facts.address);
  const t = facts.tokens[0];

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-2 break-all font-mono text-sm">{shown}</p>
      <p className="mt-2 text-sm">
        This Stock Token track record is rebuilt from public Robinhood Chain data: the token&apos;s transfers,
        Uniswap swaps checked against the official factory, and the Chainlink price feed. Nothing here is self-reported.
      </p>
      <p className="mt-1 text-sm">identity_binding: {facts.identity_binding}</p>

      <h2 className="mt-8 text-lg font-semibold">Canonical balance</h2>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1 pr-6">Token</th>
            <th className="py-1 pr-6">Shares</th>
            <th className="py-1 pr-6">USD</th>
            <th className="py-1 pr-6">Feed time (UTC)</th>
            <th className="py-1 pr-6">stale</th>
            <th className="py-1 pr-6">weekend</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="py-1 pr-6">{t.symbol}</td>
            <td className="py-1 pr-6 font-mono">{t.shares_ui}</td>
            <td className="py-1 pr-6 font-mono">{t.usd ?? "not shown: the price feed is stale"}</td>
            <td className="py-1 pr-6 font-mono">{t.feed_updated_at}</td>
            <td className="py-1 pr-6">{String(t.stale)}</td>
            <td className="py-1 pr-6">{String(t.weekend)}</td>
          </tr>
        </tbody>
      </table>

      {facts.realized_usd !== null && (
        <>
          <h2 className="mt-8 text-lg font-semibold">Realized PnL</h2>
          <p className="mt-2 font-mono text-sm">{facts.realized_usd} USD</p>
          <p className="mt-1 text-sm">
            First in, first out: each sale is matched against the oldest purchase still held ({facts.realized_status}).
            {facts.realized_status === "partial" && " Some tokens arrived without a known cost, so those sales are left out rather than guessed."}
          </p>
        </>
      )}

      <h2 className="mt-8 text-lg font-semibold">Reconstruction status</h2>
      <p className="mt-2 text-sm">r1_status: {facts.r1_status}</p>
      <p className="mt-1 text-sm">
        events_summary: transfer {facts.events_summary.transfer} / univ3 {facts.events_summary.univ3} / univ4{" "}
        {facts.events_summary.univ4} / other_unparsed {facts.events_summary.other_unparsed}
      </p>
      <p className="mt-1 text-sm">as_of: {facts.as_of} (block {facts.as_of_block}) · method {facts.method_version}</p>
      {facts.gaps.length > 0 && <p className="mt-1 text-sm">gaps: {facts.gaps.join(", ")}</p>}

      <h2 className="mt-8 text-lg font-semibold">Evidence (transactions)</h2>
      <ul className="mt-2 max-h-64 overflow-y-auto text-sm">
        {facts.evidence.txs.map((tx) => (
          <li key={tx} className="font-mono">
            <a className="underline" href={`${EXPLORER}/tx/${tx}`} rel="noreferrer" target="_blank">
              {tx}
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm">
        <Link className="underline" href={`/api/v1/rwa/facts/${shown}`}>
          facts JSON
        </Link>
        {" · "}
        <Link className="underline" href="/accuracy">
          accuracy
        </Link>
      </p>

      <p className="mt-8 text-sm">
        Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens, and not a
        recommendation to acquire, sell or delegate them.
      </p>
    </main>
  );
}
