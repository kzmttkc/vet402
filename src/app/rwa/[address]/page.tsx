import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAddress } from "viem";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit } from "@/lib/api/ip-rate-limit";
import { isValidAddress } from "@/lib/chain/client";
import { TooBusy, cachedFacts } from "../../../../packages/rwa/cache";
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
    description: "このアドレスの Stock Token 実績を、公開データから再構成した記録です。",
    robots: { index: false },
  };
}

function Busy({ retryAfterSec }: { retryAfterSec: number }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-4">再構成が立て込んでいます。{retryAfterSec} 秒ほど置いてから開き直してください。</p>
    </main>
  );
}

export default async function RwaAddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isValidAddress(address)) notFound();

  const ip = getClientIp(new Request("http://localhost", { headers: await headers() })) ?? "unknown";
  const limited = await consumeIpRateLimit(`rwa-page:${ip}`, 10, 60_000);
  if (!limited.allowed) return <Busy retryAfterSec={limited.retryAfter ?? 60} />;

  let facts: RwaFacts;
  try {
    facts = await cachedFacts(address);
  } catch (err) {
    if (err instanceof NoStockTokenActivity) notFound();
    if (err instanceof TooBusy) return <Busy retryAfterSec={err.retryAfterSec} />;
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-xl font-semibold">vet402 /rwa</h1>
        <p className="mt-4">チェーンの読み取りに失敗しました。しばらくしてから開き直してください。</p>
      </main>
    );
  }

  const shown = getAddress(facts.address);
  const t = facts.tokens[0];

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-2 break-all font-mono text-sm">{shown}</p>
      <p className="mt-1 text-sm">identity_binding: {facts.identity_binding}</p>

      <h2 className="mt-8 text-lg font-semibold">正本残高</h2>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1">トークン</th>
            <th className="py-1">株数</th>
            <th className="py-1">USD</th>
            <th className="py-1">feed 時刻 (UTC)</th>
            <th className="py-1">stale</th>
            <th className="py-1">weekend</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="py-1">{t.symbol}</td>
            <td className="py-1 font-mono">{t.shares_ui}</td>
            <td className="py-1 font-mono">{t.usd ?? "—（feed が古いため出しません）"}</td>
            <td className="py-1 font-mono">{t.feed_updated_at}</td>
            <td className="py-1">{String(t.stale)}</td>
            <td className="py-1">{String(t.weekend)}</td>
          </tr>
        </tbody>
      </table>

      {facts.realized_usd !== null && (
        <>
          <h2 className="mt-8 text-lg font-semibold">実現損益</h2>
          <p className="mt-2 font-mono text-sm">{facts.realized_usd} USD</p>
          <p className="mt-1 text-sm">
            FIFO で、売った分に対応する買いの原価を古い順に当てた結果です（{facts.realized_status}）。
            {facts.realized_status === "partial" && "原価の分からない口が混ざっているため、その分は含めていません。"}
          </p>
        </>
      )}

      <h2 className="mt-8 text-lg font-semibold">再構成の状態</h2>
      <p className="mt-2 text-sm">r1_status: {facts.r1_status}</p>
      <p className="mt-1 text-sm">
        events_summary: transfer {facts.events_summary.transfer} / univ3 {facts.events_summary.univ3} / univ4{" "}
        {facts.events_summary.univ4} / other_unparsed {facts.events_summary.other_unparsed}
      </p>
      <p className="mt-1 text-sm">as_of: {facts.as_of}（block {facts.as_of_block}）・method {facts.method_version}</p>
      {facts.gaps.length > 0 && <p className="mt-1 text-sm">gaps: {facts.gaps.join(", ")}</p>}

      <h2 className="mt-8 text-lg font-semibold">証拠</h2>
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
        このアドレスの Stock Token 実績を、公開データから再構成した記録です。投資助言ではありません。Stock Token
        の取得・売却・委任を勧めるものではありません。
      </p>
    </main>
  );
}
