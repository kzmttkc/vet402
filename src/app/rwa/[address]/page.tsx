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

/** "78805.22" → "78,805.22" */
function money(usd: string): string {
  const [whole, cents] = usd.replace("-", "").split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/** "-284.57" → "−$284.57"; "12.00" → "+$12.00" */
function signedMoney(usd: string): string {
  return `${usd.startsWith("-") ? "\u2212" : "+"}$${money(usd)}`;
}

/** The realized part of the summary line, never a bare total when part of the sales could not be priced. */
function realizedLine(realized: string | null, status: string): string {
  if (realized === null) return status === "partial" ? "sales found, none could be priced" : "nothing realized yet";
  return status === "partial" ? `realized ${signedMoney(realized)} on the sales that could be priced` : `realized ${signedMoney(realized)}`;
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
  const held = facts.tokens.filter((t) => BigInt(t.raw) > 0n);
  const unparsed = facts.events_summary.other_unparsed;
  const replayOk = facts.tokens.every((t) => t.replayed_raw === t.raw);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-2 break-all font-mono text-sm">{shown}</p>
      <p className="mt-4 border-l-2 pl-3 text-base">
        {held.length} Stock Token{held.length === 1 ? "" : "s"} held
        {" · "}
        {facts.unrealized_usd !== null ? `marked $${money(facts.unrealized_usd)}` : "no complete USD mark"}
        {" · "}
        {facts.r1_status === "unverified" ? "realized not shown" : realizedLine(facts.realized_usd, facts.realized_status)}
        {" · "}
        {!replayOk
          ? "the replay does not match the chain balance"
          : `${unparsed} movement${unparsed === 1 ? "" : "s"} not decoded`}
      </p>
      <p className="mt-3 text-sm">
        Rebuilt from public Robinhood Chain data, not from anything the wallet owner says: each canonical Stock
        Token&apos;s transfers, Uniswap swaps checked against the official factory, and the Chainlink price feed where
        one exists. Canonical means the address in Robinhood&apos;s own list of {facts.scope.registry_tokens} Stock
        Tokens; a token with the same ticker at another address is not counted.
      </p>
      <p className="mt-1 text-sm">identity_binding: {facts.identity_binding}</p>

      <h2 className="mt-8 text-lg font-semibold">Canonical balances</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="py-1 pr-6">Token</th>
              <th className="py-1 pr-6">Shares</th>
              <th className="py-1 pr-6">USD</th>
              <th className="py-1 pr-6">Realized (FIFO)</th>
              <th className="py-1 pr-6">Feed time (UTC)</th>
              <th className="py-1 pr-6">stale</th>
            </tr>
          </thead>
          <tbody>
            {facts.tokens.map((t) => (
              <tr key={t.token}>
                <td className="py-1 pr-6">
                  <a className="underline" href={`${EXPLORER}/address/${t.token}`} rel="noreferrer" target="_blank" title={t.name}>
                    {t.symbol}
                  </a>
                </td>
                <td className="py-1 pr-6 font-mono">{t.shares_ui}</td>
                <td className="py-1 pr-6 font-mono">
                  {t.usd ?? (t.usd_reason === "no_feed" ? "not shown: no Chainlink feed" : "not shown: the price feed is stale")}
                </td>
                <td className="py-1 pr-6 font-mono">{t.realized_usd === null ? "—" : `${t.realized_usd} (${t.realized_status})`}</td>
                <td className="py-1 pr-6 font-mono">{t.feed_updated_at ?? "—"}</td>
                <td className="py-1 pr-6">{t.stale === null ? "—" : String(t.stale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-sm">
        History walked for: {facts.scope.scanned.join(", ")}.
        {facts.scope.history_not_walked.length > 0 &&
          ` Seen inside those transactions, history not walked: ${facts.scope.history_not_walked.join(", ")}.`}{" "}
        Positions in other tokens that were opened and fully closed are not scanned yet (
        <code>exited_positions_not_scanned</code>), so &quot;complete&quot; below means complete within these tokens.
      </p>

      {facts.realized_usd !== null && (
        <>
          <h2 className="mt-8 text-lg font-semibold">Realized PnL</h2>
          <p className="mt-2 font-mono text-sm">{facts.realized_usd} USD</p>
          <p className="mt-1 text-sm">
            First in, first out, per token: each sale is matched against the oldest purchase still held ({facts.realized_status}).
            {facts.realized_status === "partial" &&
              " Some tokens arrived without a known cost, or changed hands for another Stock Token, so those sales are left out rather than guessed."}
          </p>
        </>
      )}

      <h2 className="mt-8 text-lg font-semibold">Reconstruction status</h2>
      <p className="mt-2 text-sm">r1_status: {facts.r1_status}</p>
      <p className="mt-1 text-sm">
        events_summary: transfer {facts.events_summary.transfer} / univ3 {facts.events_summary.univ3} / univ4{" "}
        {facts.events_summary.univ4} / other_unparsed {facts.events_summary.other_unparsed}
      </p>
      <p className="mt-1 text-sm">
        replayed events land on the balance the chain reports: {replayOk ? `yes (${facts.tokens.length}/${facts.tokens.length} tokens)` : "no — see balance_mismatch"}
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
