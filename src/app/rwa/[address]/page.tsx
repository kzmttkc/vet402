import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAddress } from "viem";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit } from "@/lib/api/ip-rate-limit";
import { isValidAddress } from "@/lib/chain/client";
import { FAILURE_CODES, emptyAnswer, failureAnswer, tooLargeAnswer, type FailureAnswer } from "../../../../packages/rwa/answers";
import { FREE_DEADLINE_MS, cachedFacts } from "../../../../packages/rwa/cache";
import { EXAMPLE_WALLETS } from "../../../../packages/rwa/examples";
import { METHOD_VERSION, NoStockTokenActivity, WalletTooLarge, type NoActivityAnswer, type RwaFacts, type TooLargeAnswer } from "../../../../packages/rwa/facts";
import { AnchorNote } from "./anchor-note";
import { heldAtBlockLine, holdingsLine, noHeldActionsLine } from "./lines";
import { LookalikesSection } from "./lookalikes";

/**
 * /rwa/[address] — the one public page of the RWA instrument (docs/rwa/SPEC.md §10).
 *
 * Shows only what §10 lists: address, canonical balances (shares and USD in
 * separate columns), feed time / stale, r1_status, events_summary, evidence tx
 * links, the method README and the fixed disclaimer, plus the corporate actions
 * (multiplier updates) of the tokens in the record (SPEC patch 022). No ALLOW / WARN / BLOCK, no
 * CTA, no ranking, and no link into the parent product's pages (2026-09-29 audit).
 *
 * The record is taken from the CDN copy of the facts JSON first, so the page and
 * the JSON a judge opens side by side come from the same cached answer; only if
 * that fails does this render rebuild it (SPEC patch 019).
 *
 * SPEC patch 020: the route's answer is final when it is one of its own. A 404
 * renders the stated empty answer, a 503 renders its reason and wait, and neither
 * starts a second read. Only a transport miss or a shared-bucket 429 falls back to
 * reading here, under the same free deadline.
 */

const README = "https://github.com/kzmttkc/vet402/blob/main/docs/rwa/README.md";
/** Longer than the route's own deadline, so the route answers first (patch 020). */
const CDN_FETCH_TIMEOUT_MS = FREE_DEADLINE_MS + 8_000;

type Outcome =
  | { kind: "facts"; facts: RwaFacts }
  | { kind: "empty"; answer: NoActivityAnswer | null }
  | { kind: "too_large"; answer: TooLargeAnswer }
  | { kind: "failed"; failure: FailureAnswer };

/** The facts route's answer through the CDN, or null when it is not one of the route's own answers. */
async function fromRoute(address: string): Promise<Outcome | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const same = (a: unknown) => typeof a === "string" && a.toLowerCase() === address.toLowerCase();
  try {
    const res = await fetch(`${proto}://${host}/api/v1/rwa/facts/${address}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS),
      headers: { "user-agent": "vet402-rwa-page/1.0" },
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    if (res.ok) {
      const facts = body as unknown as RwaFacts;
      return facts.method_version === METHOD_VERSION && same(facts.address) ? { kind: "facts", facts } : null;
    }
    if (res.status === 404 && body.error === "no_stock_token_activity") {
      return { kind: "empty", answer: same(body.address) ? (body as unknown as NoActivityAnswer) : null };
    }
    if (res.status === 422 && body.error === "wallet_too_large" && same(body.address)) {
      return { kind: "too_large", answer: body as unknown as TooLargeAnswer };
    }
    if (res.status === 503 && FAILURE_CODES.includes(body.error as FailureAnswer["error"])) {
      return { kind: "failed", failure: body as unknown as FailureAnswer };
    }
    return null; // 429 from the shared bucket of this server's own requests, or anything else: read here
  } catch {
    return null;
  }
}

async function readHere(address: string): Promise<Outcome> {
  try {
    return { kind: "facts", facts: await cachedFacts(address, { deadlineMs: FREE_DEADLINE_MS }) };
  } catch (err) {
    if (err instanceof NoStockTokenActivity) {
      const a = emptyAnswer(err);
      return { kind: "empty", answer: "as_of_block" in a ? a : null };
    }
    if (err instanceof WalletTooLarge) return { kind: "too_large", answer: tooLargeAnswer(err) };
    return { kind: "failed", failure: failureAnswer(err) };
  }
}

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

/** "-273.01" → "−$273.01"; "12.00" → "+$12.00" */
function signedMoney(usd: string): string {
  return `${usd.startsWith("-") ? "\u2212" : "+"}$${money(usd)}`;
}

/** "1000775159164630595" → "1.000775159" (9 places, enough to see a 0.08% change) */
function multiplier(raw: string): string {
  const n = BigInt(raw);
  const whole = n / 10n ** 18n;
  return `${whole}.${((n % 10n ** 18n) / 10n ** 9n).toString().padStart(9, "0")}`;
}

/** The realized part of the summary line, never a bare total when part of the sales could not be priced. */
function realizedLine(realized: string | null, status: string): string {
  if (realized === null) return status === "partial" ? "sales found, none could be priced" : "nothing realized yet";
  return status === "partial" ? `realized ${signedMoney(realized)} on the sales that could be priced` : `realized ${signedMoney(realized)}`;
}

function TryThese() {
  return (
    <>
      <h2 className="mt-8 text-lg font-semibold">Try a wallet with a record</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {EXAMPLE_WALLETS.map((w) => (
          <li key={w.address}>
            <Link className="font-mono underline" href={`/rwa/${w.address}`}>
              {w.address.slice(0, 10)}…{w.address.slice(-4)}
            </Link>{" "}
            {w.note}
          </li>
        ))}
      </ul>
    </>
  );
}

const Disclaimer = () => (
  <p className="mt-8 text-sm">
    Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens, and not a
    recommendation to acquire, sell or delegate them.
  </p>
);

/** One view for every failure: what happened, and when the page tries again by itself. */
function Busy({ retryAfterSec, detail }: { retryAfterSec: number; detail: string }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <meta httpEquiv="refresh" content={String(retryAfterSec)} />
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-4">{detail}</p>
      <p className="mt-2 text-sm">This page reloads itself in about {retryAfterSec} seconds.</p>
      <TryThese />
    </main>
  );
}

/** A wallet too large for one request: its holdings, and why it is not rebuilt (patch 020). */
function TooLarge({ address, answer }: { address: string; answer: TooLargeAnswer }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-2 break-all font-mono text-sm">{address}</p>
      <p className="mt-4 border-l-2 pl-3 text-base">Too large to rebuild in one request.</p>
      <p className="mt-3 text-sm">{answer.detail}</p>
      <p className="mt-1 text-sm">{heldAtBlockLine(answer.held, answer.as_of_block)}</p>
      <p className="mt-3 text-sm">
        <Link className="underline" href={`/api/v1/rwa/facts/${address}`}>
          facts JSON
        </Link>
      </p>
      <TryThese />
      <Disclaimer />
    </main>
  );
}

/** An address with no canonical Stock Token: what was checked, what was not (patch 020). */
function Empty({ address, answer }: { address: string; answer: NoActivityAnswer | null }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-2 break-all font-mono text-sm">{address}</p>
      <p className="mt-4 border-l-2 pl-3 text-base">No Stock Token record for this wallet.</p>
      {answer ? (
        <>
          <p className="mt-3 text-sm">{answer.detail}</p>
          <p className="mt-1 text-sm">
            {answer.is_contract
              ? "This address is a contract."
              : `This address has sent ${answer.sent_tx_count} transaction${answer.sent_tx_count === 1 ? "" : "s"} on Robinhood Chain.`}
          </p>
          <p className="mt-1 text-sm">
            as_of: {answer.as_of} (block {answer.as_of_block}) · method {answer.method_version}
            {answer.gaps.length > 0 && ` · gaps: ${answer.gaps.join(", ")}`}
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm">No canonical Stock Token transfer to or from this address was found in the tokens read.</p>
      )}
      <p className="mt-3 text-sm">
        <Link className="underline" href={`/api/v1/rwa/facts/${address}`}>
          facts JSON
        </Link>
        {" · "}
        <a className="underline" href={README} rel="noreferrer" target="_blank">
          how this is built
        </a>
      </p>
      <TryThese />
      <Disclaimer />
    </main>
  );
}

export default async function RwaAddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isValidAddress(address)) notFound();

  const ip = getClientIp(new Request("http://localhost", { headers: await headers() })) ?? "unknown";
  const limited = await consumeIpRateLimit(`rwa-page:${ip}`, 10, 60_000);

  if (!limited.allowed) {
    const wait = limited.retryAfter ?? 60;
    return <Busy retryAfterSec={wait} detail={`Too many requests from this network. Try again in about ${wait} seconds.`} />;
  }

  const outcome = (await fromRoute(address)) ?? (await readHere(address));
  if (outcome.kind === "empty") return <Empty address={getAddress(address)} answer={outcome.answer} />;
  if (outcome.kind === "too_large") return <TooLarge address={getAddress(address)} answer={outcome.answer} />;
  if (outcome.kind === "failed") return <Busy retryAfterSec={outcome.failure.retry_after_sec} detail={outcome.failure.detail} />;
  const facts = outcome.facts;

  const shown = getAddress(facts.address);
  const held = facts.tokens.filter((t) => BigInt(t.raw) > 0n);
  const unparsed = facts.events_summary.other_unparsed;
  const movements = facts.events_summary.transfer + facts.events_summary.univ3 + facts.events_summary.univ4 + unparsed;
  const replayOk = facts.tokens.every((t) => t.replayed_raw === t.raw);
  // SPEC patch 022: corporate actions of the tokens in this record, split by whether the wallet held the token then.
  const actions = facts.tokens.flatMap((t) => (t.corporate_actions ?? []).map((a) => ({ ...a, symbol: t.symbol })));
  const actionsHeld = actions.filter((a) => a.held === true).sort((a, b) => a.block - b.block);
  const actionsNotHeld = actions.filter((a) => a.held !== true).sort((a, b) => a.block - b.block);
  const actionsRead = facts.tokens.some((t) => t.corporate_actions !== undefined);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-2 break-all font-mono text-sm">{shown}</p>
      <p className="mt-4 border-l-2 pl-3 text-base">
        {holdingsLine(held.length, facts.unrealized_usd, money)}
        {" · "}
        {facts.r1_status === "unverified" ? "realized not shown" : realizedLine(facts.realized_usd, facts.realized_status)}
        {" · "}
        {!replayOk
          ? "the replay does not match the chain balance"
          : `${unparsed} of ${movements} movement${movements === 1 ? "" : "s"} not decoded`}
      </p>
      <p className="mt-3 text-sm">
        Rebuilt from public Robinhood Chain data, not from anything the wallet owner says: each canonical Stock
        Token&apos;s transfers, Uniswap swaps checked against the official factory, and the Chainlink price feed where
        one exists. Canonical means the address in Robinhood&apos;s own list of {facts.scope.registry_tokens} Stock
        Tokens; a token with the same ticker at another address is not counted.
      </p>

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
        {facts.gaps.includes("exited_positions_not_scanned") ? (
          <>
            Positions in other tokens that were opened and fully closed are not scanned yet (
            <code>exited_positions_not_scanned</code>), so &quot;complete&quot; below means complete within these tokens.
          </>
        ) : (
          "It also covers canonical tokens this wallet sold out of, found through its transfer history."
        )}
      </p>

      {actionsRead && (
        <>
          <h2 className="mt-8 text-lg font-semibold">Corporate actions while this wallet held the token</h2>
          <p className="mt-2 text-sm">
            A Stock Token records a split or a reinvested dividend by changing its share multiplier (UIMultiplierUpdated),
            not the raw balance. Every such update of the tokens above is read from the token&apos;s own logs since genesis.
            Shares are raw × multiplier. Realized PnL is computed on raw amounts and USD, so it does not move.
          </p>
          {actionsHeld.length === 0 ? (
            <p className="mt-2 text-sm">{noHeldActionsLine(actions.length)}</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left">
                    <th className="py-1 pr-6">Effective (UTC)</th>
                    <th className="py-1 pr-6">Token</th>
                    <th className="py-1 pr-6">Multiplier</th>
                    <th className="py-1 pr-6">Shares held</th>
                    <th className="py-1 pr-6">tx</th>
                  </tr>
                </thead>
                <tbody>
                  {actionsHeld.map((a) => (
                    <tr key={`${a.tx}:${a.symbol}`}>
                      <td className="py-1 pr-6 font-mono">{a.effective_at.slice(0, 10)}</td>
                      <td className="py-1 pr-6">{a.symbol}</td>
                      <td className="py-1 pr-6 font-mono">
                        {multiplier(a.multiplier_before)} → {multiplier(a.multiplier_after)}
                      </td>
                      <td className="py-1 pr-6 font-mono">
                        {a.wallet_shares_before} → {a.wallet_shares_after}
                      </td>
                      <td className="py-1 pr-6 font-mono">
                        <a className="underline" href={`${EXPLORER}/tx/${a.tx}`} rel="noreferrer" target="_blank">
                          {a.tx.slice(0, 10)}…
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {actionsNotHeld.length > 0 && (
            <details className="mt-2 text-sm">
              <summary>
                {actionsNotHeld.length} more update{actionsNotHeld.length === 1 ? "" : "s"} on these tokens while this wallet
                held none{actionsNotHeld.some((a) => a.held === null) ? " or its history was not walked" : ""}
              </summary>
              <ul className="mt-1">
                {actionsNotHeld.map((a) => (
                  <li key={`${a.tx}:${a.symbol}`} className="font-mono">
                    {a.effective_at.slice(0, 10)} {a.symbol} {multiplier(a.multiplier_before)} → {multiplier(a.multiplier_after)}
                    {a.held === null ? " (history not walked)" : ""}{" "}
                    <a className="underline" href={`${EXPLORER}/tx/${a.tx}`} rel="noreferrer" target="_blank">
                      {a.tx.slice(0, 10)}…
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <LookalikesSection facts={facts} />

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
      <AnchorNote address={shown} liveBlock={facts.as_of_block} />
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
        <a className="underline" href={README} rel="noreferrer" target="_blank">
          how this is built, and how to check it
        </a>
      </p>

      <p className="mt-8 text-sm">
        Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens, and not a
        recommendation to acquire, sell or delegate them.
      </p>
    </main>
  );
}
