import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { RECEIPT_BADGE_HEIGHT, receiptBadgeWidth } from "@/lib/badge/receipt-badge";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { TableScroll } from "@/components/site/TableScroll";
import CodeBlock from "@/components/docs/CodeBlock";
import { SITE_URL } from "@/lib/site-url";
import { getEndpointDetail } from "@/lib/observatory/reader";
import { explorerTxUrl } from "@/lib/observatory/chains";
import RecordSubscribe from "@/components/site/RecordSubscribe";
import { VerdictWord, ProbeTimeline, SettleGauge, type L0Verdict } from "@/components/site/Figures";

/**
 * /observatory/e/[id] — one endpoint's full fact history (design §5).
 *
 * Lives under /observatory/e/ so the dynamic segment can never shadow the
 * static siblings (/observatory/state, /methodology): on 2026-08-14 the
 * vet402.com edge matched /observatory/state into [id] (deployment URL did
 * not — a host-dependent router quirk), and the uuid guard turned the page
 * into a 404. Separating the namespaces removes the whole collision class.
 *
 * Every published fail travels with its evidence: timestamp, HTTP status,
 * reason code, latency. Delisting events carry their before/after values.
 * This page is the evidence locker the register links into.
 *
 * NO loading.tsx FOR THIS SEGMENT, DELIBERATELY (2026-08-26 L2 UX audit #7 —
 * ソフト404修正). Do not add one back without re-testing the fix below. A
 * `loading.tsx` anywhere in this route's ancestor chain — this segment's own,
 * OR the parent /observatory/loading.tsx (also removed for the same reason;
 * see its absence) — wraps this page in an automatic <Suspense> boundary.
 * Reproduced with `next build && next start` (no DB configured; a
 * non-existent id short-circuits before any DB call, so this needed no
 * secrets): with that boundary present, Next starts streaming an optimistic
 * 200 shell before the async component reaches `notFound()`, and the HTTP
 * status can never be corrected afterward — the rendered body eventually
 * shows "Not Found" but curl/uptime checks/crawlers see 200. Confirmed by
 * elimination: /blog/[slug] (no loading.tsx anywhere in its chain) already
 * returns a true 404 for a missing post; restoring either loading.tsx here
 * reproduces the bug again — removing both is necessary AND sufficient
 * (verified with `next build && next start` for every combination). The
 * `notFound()` call added to generateMetadata below is a separate, smaller
 * fix on top: on its own it does not correct the HTTP status, but it stops
 * the <head> (title/description) from showing a generic "Endpoint" label
 * for an id that does not exist.
 */

// NOT CACHED, ON PURPOSE (2026-08-26 L2 UX audit residual). This used to be
// `revalidate = 600`. This page calls `headers()` (for the CSP nonce), a
// Dynamic API that already forces per-request rendering — the build has
// always classified this route as dynamic ("ƒ"), so the number never took
// effect (same dead-config shape already fixed once in
// /payee/[address]/page.tsx). Declaring the route's real cardinality is a
// cleanup, not the 404 fix below — see the `notFound()` call in
// generateMetadata for that.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const detail = await getEndpointDetail(id);
  // 2026-08-26 (L2 UX監査 #7 ソフト404修正): 本体の修理は上のファイル先頭コメント
  // の通り loading.tsx を2箇所とも置かないこと（実測で必要十分と確認済み——
  // これ単独で HTTP 404 は直る）。ここで notFound() を早めに呼ぶのはその上の
  // 上乗せ: generateMetadata 単独では ステータスは直らない（loading.tsx が
  // 残っている状態で実測して確認済み）が、<head> がストリーミング開始前に
  // 確定する関数なので、ここで判定しておけば「存在しないIDにも関わらず
  // 見出しが "Endpoint" のまま」というメタデータのズレを避けられる。
  if (!detail) notFound();
  const name = detail.endpoint.resourceKey;
  return pageMetadata({
    title: `${name} — L0 observations`,
    description: `Probe history and catalog listing history for ${name}: 402 challenge measurements with timestamps and reason codes.`,
    path: `/observatory/e/${id}`,
  });
}

function fmt(d: Date | null): string {
  return d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—";
}

export default async function ObservatoryEndpointPage({ params }: Props) {
  const { id } = await params;
  const detail = await getEndpointDetail(id);
  if (!detail) notFound();

  const { endpoint, probes, events, publishedVerdict, l1, purchases } = detail;
  const lastProbedAt = probes[0]?.probedAt ?? null;
  const lastProbed =
    lastProbedAt && detail.lastProbedAgeDays !== null
      ? `${lastProbedAt.toISOString().slice(0, 10)} · ${detail.lastProbedAgeDays === 0 ? "today" : detail.lastProbedAgeDays === 1 ? "1 day ago" : `${detail.lastProbedAgeDays} days ago`}`
      : "never";
  const usd = (units: string | null) => {
    if (!units || !/^\d+$/.test(units)) return null;
    const n = Number(units) / 1_000_000;
    return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4).replace(/0+$/, "")}`;
  };
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Observatory", path: "/observatory" },
    { name: endpoint.resourceKey, path: `/observatory/e/${id}` },
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
            <span>Endpoint record (L0 · L1)</span>
            <span className="inline-flex items-center gap-1.5">
              Published state: <VerdictWord verdict={publishedVerdict as L0Verdict} />
            </span>
            {/* 2026-09-02 UX 監査: 「毎日プローブ」と読まれないよう、この記録の鮮度を
                doc-head で明示する。日付は UTC、日数は表示時点との差。 */}
            <span>Last probed: {lastProbed}</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory" className="underline">
                Back to the register
              </Link>
            </span>
            <span>
              <Link href="/observatory/methodology" className="underline">
                Methodology
              </Link>
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-10 break-words [overflow-wrap:anywhere]">{endpoint.resourceKey}</h1>
        {endpoint.isOperatorEndpoint && (
          <p className="mt-4 border border-brand-line bg-brand-wash px-4 py-3 text-[0.8125rem] text-brand-lift">
            This is vet402&rsquo;s own endpoint. It is shown here for
            transparency but is <strong>excluded from the network measurements</strong> — a
            measurer is not a neutral third party in its own numbers, and the L1 buyer never
            purchases from it.
          </p>
        )}
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>Catalog declaration</span>
        </h2>
        <TableScroll label="Catalog declaration for this endpoint">
          <table className="fact-table">
            <caption className="sr-only">Catalog declaration for this endpoint</caption>
            <tbody>
              <tr>
                <td>Resource URL</td>
                <td className="break-all">{endpoint.resourceUrl}</td>
              </tr>
              <tr>
                <td>Source</td>
                <td>{endpoint.source}</td>
              </tr>
              <tr>
                <td>Declared method</td>
                <td>{endpoint.method ?? "undeclared"}</td>
              </tr>
              <tr>
                <td>Network</td>
                <td>{endpoint.network ?? "—"}</td>
              </tr>
              <tr>
                <td>Receiving address</td>
                <td className="break-all">{endpoint.payTo ?? "—"}</td>
              </tr>
              <tr>
                <td>Declared price (base units)</td>
                <td>{endpoint.priceAmount ?? "—"}</td>
              </tr>
              <tr>
                <td>Catalog status</td>
                <td>
                  {endpoint.status}
                  {endpoint.delistedAt ? ` (since ${fmt(endpoint.delistedAt)})` : ""}
                </td>
              </tr>
              <tr>
                <td>First seen / last seen</td>
                <td>
                  {fmt(endpoint.firstSeenAt)} / {fmt(endpoint.lastSeenAt)}
                </td>
              </tr>
              <tr>
                <td>Catalog-reported calls / payers (30d)</td>
                <td>
                  {endpoint.qualityCalls30d?.toLocaleString() ?? "—"} /{" "}
                  {endpoint.qualityPayers30d?.toLocaleString() ?? "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroll>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Probe history</span>
        </h2>
        {probes.length === 0 ? (
          <p className="doc-p text-brand-lift">No probes recorded yet.</p>
        ) : (
          <>
          {/* 2026-09-02 UI/UX 監査（続）: 表の前に時間軸を 1 本。いつ・何回・どの判定かが
              読む前に見える。「毎日測っていない」も隠れない。 */}
          <ProbeTimeline
            n={1}
            probes={probes
              .filter((p): p is typeof p & { probedAt: Date } => p.probedAt !== null)
              .map((p) => ({ at: p.probedAt, verdict: (p.verdict === "pass" || p.verdict === "fail" ? p.verdict : "unverified") as L0Verdict }))}
            caption={
              <>
                Probe timeline, last {probes.length} probe{probes.length === 1 ? "" : "s"} for this endpoint (UTC). Filled = pass,
                crossed = fail, dashed = unverified. Same-day probes overlap.
              </>
            }
          />
          <TableScroll label="L0 probe history, newest first">
            <table className="fact-table">
              <caption className="sr-only">L0 probe history, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Probed at</th>
                  <th scope="col">Method</th>
                  <th scope="col">Verdict</th>
                  <th scope="col" className="num">
                    HTTP
                  </th>
                  <th scope="col" className="num">
                    Latency
                  </th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {probes.map((p, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap">{fmt(p.probedAt)}</td>
                    <td>{p.method}</td>
                    <td>
                      {p.verdict === "pass" || p.verdict === "fail" || p.verdict === "unverified" ? (
                        <VerdictWord verdict={p.verdict} />
                      ) : (
                        p.verdict
                      )}
                    </td>
                    <td className="num">{p.httpStatus ?? "—"}</td>
                    <td className="num">{p.latencyMs === null ? "—" : `${p.latencyMs} ms`}</td>
                    <td>{p.failReason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          </>
        )}

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>L1 — real purchases</span>
        </h2>
        {purchases.length === 0 ? (
          <p className="doc-p text-brand-lift">
            No covert purchases recorded for this endpoint yet.
          </p>
        ) : (
          <>
            {/* 2026-09-04 外部監査 E・P0-3: この行は settled だけを出していた。
                settled は転送の確認、delivered は応答の到着で、別の事実である。
                api.exa.ai/search は settled 10 件のうち 2xx が 0 件だった。 */}
            <p className="doc-p">
              {l1.settled} of {l1.attempts} paid attempts settled with a receipt, and{" "}
              {l1.delivered} of those also returned a 2xx response (delivered). Each settled row
              carries its on-chain transaction hash — the receipt is the evidence.{" "}A settled
              row reads as <strong>nonce-bound</strong> when the on-chain re-read also matched the
              one-time signature nonce we generated for that purchase, and{" "}
              <strong>amount + payee</strong> when it matched amount, payee, asset and chain with no
              nonce on record — the binding shipped on 2026-09-04, so earlier rows carry the weaker
              evidence and keep their label rather than being demoted (
              <Link href="/observatory/methodology" className="underline">
                methodology
              </Link>
              ).{" "}
              <strong>settled</strong> is the transfer we confirmed on-chain; <strong>delivered</strong>{" "}
              is the response arriving. A settled row whose paid request answered 4xx or 5xx counts
              as settled and not as delivered —{" "}
              <Link href="/observatory/methodology" className="underline">
                definitions
              </Link>
              .
            </p>
            <SettleGauge
              n={2}
              settled={l1.settled}
              attempts={l1.attempts}
              caption={<>Settle-through: one cell per paid attempt. Filled = settled with an on-chain receipt, crossed = paid but no receipt.</>}
            />
            <TableScroll label="L1 purchase history, newest first">
              <table className="fact-table">
                <caption className="sr-only">L1 purchase history, newest first</caption>
                <thead>
                  <tr>
                    {/* 2026-09-04 監査 P2-18: 390px で HTTP が 2 段目の右端（→ 2 more columns の先）に
                        隠れ、settled でも配達失敗（HTTP 400）が見えなかった。先頭 3 列を
                        Attempted / Result / HTTP に、受領証は 4 列目へ。 */}
                    <th scope="col">Attempted at</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="num">
                      HTTP
                    </th>
                    <th scope="col">Receipt (tx)</th>
                    <th scope="col" className="num">
                      Latency
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {/* 2026-09-02 UX 監査: 7 列だと 1280px でも受領証列が初期表示の外に出ていた
                      （表 731px・紙面 665px）。この製品の主張は「受領証がある」なので、
                      受領証を 3 列目に置き、金額・HTTP・L2 は同じ行の 2 段目に落とす。
                      2026-09-04 P2-18: HTTP を 3 列目へ戻し（配達失敗が見えるように）、受領証は 4 列目。 */}
                  {purchases.map((p, i) => (
                    <Fragment key={i}>
                      {/* 2 段目に続くので 1 段目の罫線は消す。globals.css は触らない——Turbopack の
                          ビルドキャッシュがグローバル CSS の変更だけを落とす事故（2026-08-12・
                          2026-09-02 再発）を避け、ユーティリティで当てる。 */}
                      <tr>
                        {/* 375px では "2026-09-01 12:07 UTC"（20 文字）が受領証列を画面外に押し出す。
                            モバイルは月日と時刻だけ（年と UTC は 1 段目の見出しと doc-head が持つ）。 */}
                        <td className="whitespace-nowrap border-b-0 pb-0.5">
                          <span className="sm:hidden">{fmt(p.attemptedAt).slice(5, 16)}</span>
                          <span className="hidden sm:inline">{fmt(p.attemptedAt)}</span>
                        </td>
                        {/* 2026-09-05 監査 S-4 / S-17: settled の証拠強度は 1 段ではない。
                            nonce 束縛が入ったのは 2026-09-04 12:00 UTC で、それ以前の行は
                            金額・宛先・資産の一致まで。行ごとに強度を出す。 */}
                        <td className="border-b-0 pb-0.5">
                          {p.settledTier === "nonce_bound"
                            ? "settled (nonce-bound)"
                            : p.settledTier === "amount_payee_only"
                              ? "settled (amount + payee)"
                              : p.status}
                        </td>
                        <td
                          className={`num border-b-0 pb-0.5 ${typeof p.httpStatusPaid === "number" && p.httpStatusPaid >= 400 ? "text-[#9f0712]" : ""}`}
                        >
                          {p.httpStatusPaid ?? "—"}
                        </td>
                        <td className="whitespace-nowrap border-b-0 pb-0.5">
                          {/* 2026-09-02 監査: basescan 固定で Solana の受領証が壊れたリンクだった。
                              行き先はチェーンで決め（chains.ts explorerTxUrl）、形が合わなければ
                              リンクにしない。 */}
                          {p.txHash ? (
                            (() => {
                              const url = explorerTxUrl(endpoint.network, p.txHash);
                              const short = `${p.txHash.slice(0, 10)}…${p.txHash.slice(-4)}`;
                              return url ? (
                                <a href={url} className="underline" rel="noopener noreferrer">
                                  {short}
                                </a>
                              ) : (
                                <span title={p.txHash}>{short}</span>
                              );
                            })()
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="num border-b-0 pb-0.5">{p.latencyMs === null ? "—" : `${p.latencyMs} ms`}</td>
                      </tr>
                      <tr className="fact-subrow">
                        <td colSpan={5} className="pt-0 font-[family-name:var(--font-mono)] text-xs font-normal text-brand-lift">
                          {p.amountUnits
                            ? `${p.amountUnits} units${usd(p.amountUnits) ? ` (≈ ${usd(p.amountUnits)} USDC)` : ""}`
                            : "amount —"}
                          {" · "}L2 {p.l2Schema ?? "—"}
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </TableScroll>
            {l1.settled > 0 && (
              <div className="mt-6">
                <p className="doc-caption">Embed this record</p>
                <p className="doc-p mt-2 text-brand-lift">
                  Run this endpoint? Show the settle-through record vet402 measured — the badge
                  reads{" "}
                  <span className="whitespace-nowrap">{`${l1.settled}/${l1.attempts} settled · ${l1.delivered} delivered`}</span>{" "}
                  and updates as the record grows. It states a measurement, not a rating.
                </p>
                <p className="mt-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/badge/endpoint/${id}.svg`}
                    alt={`vet402: ${l1.settled} of ${l1.attempts} paid attempts settled, ${l1.delivered} delivered`}
                    width={receiptBadgeWidth(`${l1.settled}/${l1.attempts} settled · ${l1.delivered} delivered`)}
                    height={RECEIPT_BADGE_HEIGHT}
                  />
                </p>
                <CodeBlock
                  label="Receipt badge embed (Markdown)"
                  code={`[![vet402 receipt](${SITE_URL}/api/badge/endpoint/${id}.svg)](${SITE_URL}/observatory/e/${id})`}
                />
              </div>
            )}
          </>
        )}

        {/* 段 2「名前を取る」（2026-09-02 敵対的監査 F7）: 価値を受け取った直後＝L1 表
            （無ければ §3 本文）の直下。対価は「この記録の判定が変わったら 1 通」。 */}
        <RecordSubscribe endpointId={id} kind="notify" />

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>Catalog listing events</span>
        </h2>
        {events.length === 0 ? (
          <p className="doc-p text-brand-lift">No listing changes observed.</p>
        ) : (
          <TableScroll label="Catalog listing events, newest first">
            <table className="fact-table">
              <caption className="sr-only">Catalog listing events, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Detected on</th>
                  <th scope="col">Event</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap">{e.detectedOn}</td>
                    <td>{e.eventType}</td>
                    <td>
                      <code>{JSON.stringify(e.prevValue)}</code>
                    </td>
                    <td>
                      <code>{JSON.stringify(e.newValue)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <p className="doc-p">
          <em>unverified is not a failure</em>; a <code>fail</code> is published only after two
          consecutive failing probes. Definitions:{" "}
          <Link href="/observatory/methodology" className="underline">
            methodology
          </Link>
          .
        </p>

        {/* 2026-09-02 敵対的監査 F6: 記録頁に異議の入口がなかった（署名付きの API 経路のみ）。 */}
        <h2 className="sec-head">
          <span className="sec-no">5.</span>
          <span>Dispute this record</span>
        </h2>
        <p className="doc-p">
          Think a measurement above is wrong? Say which probe or purchase and what you observed
          instead. One person reads it and replies. The record is never deleted on dispute: if it
          was wrong, the correction is published with the same weight; if it was right, it stands.
          Operators who control the receiving address can also sign a dispute via{" "}
          <code>POST /api/v1/observatory/disputes</code> (
          <Link href="/docs/api" className="underline">
            API reference
          </Link>
          ), which re-measures through the normal publication gate.
        </p>
        <RecordSubscribe endpointId={id} kind="dispute" />
      </article>
    </main>
  );
}
