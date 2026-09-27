import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { entryTarget } from "../../../packages/rwa/entry";

/**
 * /rwa — where "paste any wallet" lands. One field, no wallet connection, no
 * sign-in: a GET form that sends the pasted address to /rwa/[address]. The
 * record itself (and everything SPEC §10 limits) lives on that page.
 */

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
        No wallet connection and no sign-in. The page reads the canonical token&apos;s transfers, Uniswap swaps checked
        against the official factory and the Chainlink feed, and says what it could not parse. A first look at a
        wallet can take up to a minute.
      </p>
      <p className="mt-2 text-sm">
        How it works and how we keep it running:{" "}
        <a className="underline" href="https://github.com/kzmttkc/vet402/blob/main/docs/rwa/OPERATING.md" rel="noreferrer" target="_blank">
          OPERATING.md
        </a>{" "}
        ·{" "}
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
