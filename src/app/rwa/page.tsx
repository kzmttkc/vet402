import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { entryTarget } from "../../../packages/rwa/entry";
import { EXAMPLE_WALLETS } from "../../../packages/rwa/examples";

/**
 * /rwa — where "paste any wallet" lands. One field, no wallet connection, no
 * sign-in: a GET form that sends the pasted address to /rwa/[address]. Below it,
 * the same 30-second path as docs/rwa/README.md (2026-09-29 audit: the first
 * page a judge opens must carry it). No link into the parent product's pages.
 */

const REPO = "https://github.com/kzmttkc/vet402/blob/main";
const EXPLORER = "https://robinhoodchain.blockscout.com";
/** The demo wallet of the submission (SPEC patch 011/016): a public wallet, not the operator's. */
const DEMO = "0xE9B08727131E34010b34006c660D4c1B436EC25f";
const ANCHOR = "0x1955137e7773f2459eb75fb88842026c6517c22d";
const PAID_TX = "0xeb26d1b5b0b1a12056ec8abd99640fcbb00860552b4c5a44d3e1b67b3da73760";

export const metadata: Metadata = {
  title: "vet402 /rwa — check a Stock Token track record",
  description:
    "Paste a Robinhood Chain wallet and see its Stock Token record rebuilt from public chain data. Not investment advice.",
};

export default async function RwaEntryPage({ searchParams }: { searchParams: Promise<{ address?: string | string[] }> }) {
  const target = entryTarget((await searchParams).address);
  if (target.kind === "go") redirect(target.path);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-4">
        Someone shows you their Stock Token track record. Paste their Robinhood Chain wallet and see what the chain
        says instead.
      </p>

      <form action="/rwa" method="get" className="mt-6 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="address" className="sr-only">
          Wallet address
        </label>
        <input
          id="address"
          name="address"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="0x… or an explorer link"
          className="w-full border px-3 py-2 font-mono text-sm"
        />
        <button type="submit" className="border px-4 py-2 text-sm font-semibold">
          Rebuild
        </button>
      </form>
      {target.kind === "invalid" && (
        <p className="mt-2 text-sm" role="alert">
          That doesn&apos;t contain a wallet address (0x followed by 40 hex characters).
        </p>
      )}

      <p className="mt-6 text-sm">
        No wallet connection and no sign-in. The page reads each canonical Stock Token&apos;s transfers (Robinhood&apos;s own list of 195), Uniswap swaps checked
        against the official factory and the Chainlink feed, and says what it could not parse. A wallet that holds
        none of them gets that answer in seconds. A first look at an active wallet can take up to a minute. The page
        says so and reloads itself.
      </p>
      <h2 className="mt-8 text-lg font-semibold">Try these wallets</h2>
      <p className="mt-2 text-sm">No Stock Token wallet of your own? These traded through the official Uniswap pools.</p>
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
      <h2 className="mt-8 text-lg font-semibold">30 seconds</h2>
      <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">
        <li>
          A real record:{" "}
          <Link className="underline" href={`/rwa/${DEMO}`}>
            {DEMO.slice(0, 10)}…{DEMO.slice(-4)}
          </Link>
          , a public wallet that holds NVDA and QQQ. It is marked <code>partial</code> and says how many of its movements
          were not decoded.
        </li>
        <li>
          Coverage: the 195 canonical Stock Tokens in{" "}
          <a className="underline" href="https://docs.robinhood.com/chain/contracts" rel="noreferrer" target="_blank">
            Robinhood&apos;s own list
          </a>
          , with a Chainlink price for the 33 that have a feed.
        </li>
        <li>
          Three numbers, three meanings: <b>−$9.62</b> is one NVDA round trip priced by hand (
          <a className="underline" href={`${REPO}/fixtures/rwa/B.md`} rel="noreferrer" target="_blank">
            Fixture B
          </a>
          , replayed in CI); <b>−$113.98</b> is that wallet&apos;s realized NVDA; <b>−$284.57</b> is its realized total
          across NVDA and QQQ on the sales that could be priced (both as of 2026-09-29).
        </li>
        <li>
          Anchor: RwaAnchor{" "}
          <a className="underline" href={`${EXPLORER}/address/${ANCHOR}`} rel="noreferrer" target="_blank">
            {ANCHOR.slice(0, 10)}…
          </a>{" "}
          on Robinhood Chain, source verified, no owner and no upgrade path. It holds the hash of that wallet&apos;s record
          at block 74267752; the{" "}
          <a className="underline" href={`${REPO}/docs/rwa/README.md`} rel="noreferrer" target="_blank">
            README
          </a>{" "}
          has the one command that recomputes it.
        </li>
        <li>
          Agents: read this record before acting on a Stock Token wallet. The same JSON is free at{" "}
          <code>/api/v1/rwa/facts/&lt;address&gt;</code>, or paid over x402 at{" "}
          <code>/api/v1/rwa/paid/facts/&lt;address&gt;</code> for 0.01 USDG on Robinhood Chain, charged only when the
          record is returned. First settlement:{" "}
          <a className="underline" href={`${EXPLORER}/tx/${PAID_TX}`} rel="noreferrer" target="_blank">
            {PAID_TX.slice(0, 10)}…
          </a>
          .
        </li>
      </ol>
      <p className="mt-4 text-sm">
        How it is built and how it keeps running:{" "}
        <a className="underline" href={`${REPO}/docs/rwa/README.md`} rel="noreferrer" target="_blank">
          README
        </a>{" "}
        ·{" "}
        <a className="underline" href={`${REPO}/docs/rwa/OPERATING.md`} rel="noreferrer" target="_blank">
          OPERATING.md
        </a>
      </p>

      <p className="mt-8 text-sm">
        Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens, and not a
        recommendation to acquire, sell or delegate them.
      </p>
    </main>
  );
}
