import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass } from "@/components/ui/Button";
import { TableScroll } from "@/components/site/TableScroll";
import {
  exportDaysFor,
  RETEST_MODE_KEYS,
  type FixGroup,
  type OutcomeCounts,
  type SellerBoard,
  type SellerDetail,
  type SellerListing,
  type SellerSummary,
  type ShownRow,
} from "@/lib/sellers/board";
import { EFFORT_LABEL, SIDE_LABEL } from "@/lib/sellers/fix-modes";

/**
 * /sellers・/sellers/[host]・/sellers/fix-first の描画（純粋なコンポーネント・DB を読まない）。
 * 頁（src/app/sellers/**）がデータを引いてここへ渡す。tests/sellers-views.test.ts が描画を固定する。
 * 数字は props からだけ出す。文中に件数を書かない。
 */

export const SELLERS_PAGE_SIZE = 50;
export const SELLER_LISTINGS_PAGE_SIZE = 50;

function fmtUtc(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—";
}

function n(v: number): string {
  return v.toLocaleString("en-US");
}

export function sellerPath(host: string): string {
  return `/sellers/${encodeURIComponent(host)}`;
}

function FetchedAt({ at, revalidateSec }: { at: string; revalidateSec: number }) {
  return (
    <span>
      Read from the database {fmtUtc(at)} · reused for up to {Math.round(revalidateSec / 60)} min
    </span>
  );
}

function DocHead({ title, fetched }: { title: string; fetched: ReactNode }) {
  return (
    <div className="doc-head">
      <div className="doc-head-col">
        <span>Independent Measurement</span>
        <span>{title}</span>
        {fetched}
      </div>
      <div className="doc-head-col">
        <span>vet402</span>
        <span>
          <Link href="/sellers" className="underline">
            Sellers
          </Link>
          {" · "}
          <Link href="/sellers/fix-first" className="underline">
            What to fix first
          </Link>
        </span>
        <span>
          <Link href="/observatory/methodology" className="underline">
            Methodology
          </Link>
        </span>
      </div>
    </div>
  );
}

function CountsLine({ c }: { c: OutcomeCounts }) {
  return (
    <>
      <strong>{n(c.delivered)}</strong> delivered · <strong>{n(c.seller)}</strong> failed on the seller&apos;s side ·{" "}
      <strong>{n(c.vet402)}</strong> on vet402&apos;s side
      {c.unsorted > 0 && (
        <>
          {" "}
          · <strong>{n(c.unsorted)}</strong> not sorted yet
        </>
      )}{" "}
      · <strong>{n(c.notBought)}</strong> not yet bought
    </>
  );
}

function SearchForm({ q }: { q: string }) {
  return (
    <form method="get" action="/sellers" className="mt-5">
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block min-w-0 basis-full text-[0.8125rem] sm:basis-auto sm:flex-1">
          <span className="doc-caption block">Your domain</span>
          <input name="q" type="search" defaultValue={q} placeholder="api.example.com" className="doc-input mt-1" />
        </label>
        <button type="submit" className={buttonClass({ size: "sm" })}>
          Find
        </button>
      </div>
    </form>
  );
}

function SellersTable({ sellers, label }: { sellers: readonly SellerSummary[]; label: string }) {
  return (
    <TableScroll label={label}>
      <table className="fact-table">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            <th scope="col">Seller</th>
            <th scope="col" className="num">
              Listings
            </th>
            <th scope="col" className="num">
              Delivered
            </th>
            <th scope="col" className="num">
              Seller&apos;s side
            </th>
            <th scope="col" className="num">
              vet402&apos;s side
            </th>
            <th scope="col" className="num">
              Not sorted
            </th>
            <th scope="col" className="num">
              Not yet bought
            </th>
            <th scope="col">Latest purchase</th>
          </tr>
        </thead>
        <tbody>
          {sellers.map((s) => (
            <tr key={s.host}>
              <td className="whitespace-nowrap">
                <Link href={sellerPath(s.host)} className="block max-w-[14rem] truncate underline sm:max-w-[24rem]" title={s.host}>
                  {s.host}
                </Link>
              </td>
              <td className="num">{n(s.listings)}</td>
              <td className="num">{n(s.delivered)}</td>
              <td className="num">{n(s.seller)}</td>
              <td className="num">{n(s.vet402)}</td>
              <td className="num">{n(s.unsorted)}</td>
              <td className="num">{n(s.notBought)}</td>
              <td className="whitespace-nowrap">{fmtUtc(s.lastAttemptAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function Pager({ page, totalPages, href, label }: { page: number; totalPages: number; href: (p: number) => string; label: string }) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label={label} className="doc-p flex flex-wrap items-center gap-x-4 gap-y-2">
      {page > 1 && (
        <Link href={href(page - 1)} className="underline">
          ← Previous
        </Link>
      )}
      <span>
        Page {page} of {totalPages}
      </span>
      {page < totalPages && (
        <Link href={href(page + 1)} className="underline">
          Next →
        </Link>
      )}
    </nav>
  );
}

// ------------------------------------------------------------
// /sellers
// ------------------------------------------------------------

export function SellersIndexView({
  board,
  page,
  q,
  search,
  revalidateSec,
}: {
  board: SellerBoard;
  page: number;
  q: string;
  search: { exact: SellerSummary | null; matches: SellerSummary[] } | null;
  revalidateSec: number;
}) {
  const totalPages = Math.max(1, Math.ceil(board.sellers.length / SELLERS_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const shown = board.sellers.slice((p - 1) * SELLERS_PAGE_SIZE, p * SELLERS_PAGE_SIZE);
  const t = board.totals;
  return (
    <article className="sheet">
      <DocHead title="Sellers on Base: purchase results" fetched={<FetchedAt at={board.fetchedAt} revalidateSec={revalidateSec} />} />
      <h1 className="doc-title mt-10">Find your purchase results</h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <p className="doc-p">
        vet402 buys x402 listings with real USDC on Base and publishes what happened. Type your domain to see each
        of your Base listings: when we last bought it, what we saw, what to fix, and whether a failure was on your
        side or on vet402&apos;s.
      </p>
      <SearchForm q={q} />

      {search && (
        <section aria-label="Search results" className="mt-6">
          {search.exact ? (
            <p className="doc-p">
              <Link href={sellerPath(search.exact.host)} className="underline">
                {search.exact.host}
              </Link>{" "}
              — {n(search.exact.listings)} Base {search.exact.listings === 1 ? "listing" : "listings"}.
            </p>
          ) : search.matches.length === 0 ? (
            <p className="doc-p">
              No seller on Base matches <code>{q}</code>. The list below holds hosts with an active listing whose
              catalog network is Base; a listing that names another chain first is not in it.
            </p>
          ) : null}
          {search.matches.length > 0 && <SellersTable sellers={search.matches} label="Sellers whose host contains the search" />}
        </section>
      )}

      <h2 className="sec-head">
        <span className="sec-no">1.</span>
        <span>Sellers on Base</span>
      </h2>
      <p className="doc-p">
        {n(t.sellers)} sellers with {n(t.listings)} Base listings; vet402 has bought from {n(t.sellersBought)} of the
        sellers. By the latest purchase of each listing: <CountsLine c={t} />.{" "}
        <Link href="/sellers/fix-first" className="underline">
          What to fix first
        </Link>{" "}
        groups the failures by kind.
      </p>
      <SellersTable sellers={shown} label="Sellers on Base, most recent purchase first" />
      <Pager page={p} totalPages={totalPages} href={(x) => `/sellers?page=${x}`} label="Seller pages" />
      <ReadingNotes />
    </article>
  );
}

function ReadingNotes() {
  return (
    <>
      <h2 className="sec-head">
        <span className="sec-no">2.</span>
        <span>How to read this</span>
      </h2>
      <p className="doc-p">
        A seller is a host name from the catalog, with the port dropped, as in the census. A listing counts once,
        by its latest purchase on Base (or its latest attempt that stopped before payment). <strong>Delivered</strong>{" "}
        means vet402 confirmed the USDC transfer on-chain and the paid request answered 2xx.{" "}
        <strong>Seller&apos;s side</strong> means the seller&apos;s answer or listing explains the failure.{" "}
        <strong>vet402&apos;s side</strong> means the cause was ours or a limit of ours: our wallet ran out of USDC,
        we did not send the declared request body, the price was over our per-purchase ceiling, our run did not
        finish, or our on-chain check has not run yet. A count is one purchase attempt, not a rating (
        <Link href="/observatory/methodology" className="underline">
          methodology
        </Link>
        ).
      </p>
    </>
  );
}

// ------------------------------------------------------------
// /sellers/[host]
// ------------------------------------------------------------

function seenLine(r: ShownRow): string {
  if (r.bucket === "delivered") {
    return `Paid; vet402 confirmed the transfer on-chain and the paid request answered HTTP ${r.facts.httpStatusPaid ?? "—"}.`;
  }
  return r.mode?.what ?? "";
}

function ResultWord({ r }: { r: ShownRow }) {
  if (r.bucket === "delivered") return <>delivered</>;
  return <>{r.mode?.title}</>;
}

function RecordedFacts({ r }: { r: ShownRow }) {
  const f = r.facts;
  const short = f.txHash ? `${f.txHash.slice(0, 10)}…${f.txHash.slice(-4)}` : null;
  return (
    <>
      <code>{f.status}</code> · HTTP {f.httpStatusPaid ?? "—"}
      {f.status === "no_402" && f.unpaidStatus !== null && <> (unpaid answer {f.unpaidStatus})</>}
      {" · "}
      {short ? (
        r.txUrl ? (
          <a href={r.txUrl} className="underline" rel="noopener noreferrer">
            tx {short}
          </a>
        ) : (
          <span title={f.txHash ?? undefined}>tx {short}</span>
        )
      ) : (
        "no tx"
      )}
      {r.held && (
        <>
          {" · "}held as <code>{r.held}</code>
        </>
      )}
      {f.selection && (
        <>
          {" · "}bought by the <code>{f.selection}</code>
        </>
      )}
    </>
  );
}

function ExportTrace({ r, resourceKey, now }: { r: ShownRow; resourceKey: string; now: number }) {
  if (!r.inExport) return <>Not in the public export: a vet402-side state it leaves out.</>;
  const days = exportDaysFor(r.facts.attemptedAt, now);
  if (days === null) return <>Older than the public export&apos;s 366-day window.</>;
  return (
    <>
      In{" "}
      <a href={`/api/v1/observatory/export.csv?days=${days}`} className="underline">
        export.csv?days={days}
      </a>
      : the row with <code>attempted_at</code> {r.facts.attemptedAt} and <code>resource_key</code> {resourceKey}.
    </>
  );
}

function ListingRows({ l, now }: { l: SellerListing; now: number }) {
  const r = l.latest;
  return (
    <>
      <tr>
        <td className="border-b-0 pb-0.5">
          <Link href={`/observatory/e/${l.endpointId}`} className="block max-w-[14rem] break-all underline sm:max-w-[26rem]" title={l.resourceUrl}>
            {l.resourceKey}
          </Link>
          <span className="block text-xs font-normal text-brand-lift">{l.method ?? "method undeclared"}</span>
        </td>
        <td className="whitespace-nowrap border-b-0 pb-0.5">{r ? fmtUtc(r.facts.attemptedAt) : "not yet bought"}</td>
        <td className={`border-b-0 pb-0.5 ${r && r.bucket !== "delivered" ? "text-[#9f0712]" : ""}`}>{r ? <ResultWord r={r} /> : "—"}</td>
        <td className="whitespace-nowrap border-b-0 pb-0.5">{r && r.mode ? SIDE_LABEL[r.mode.side] : "—"}</td>
      </tr>
      <tr className="fact-subrow">
        <td colSpan={4} className="pt-0 text-[0.8125rem] font-normal">
          {r ? (
            <>
              <span className="block">
                <strong>What we saw:</strong> {seenLine(r)}
              </span>
              {r.mode && (
                <span className="block">
                  <strong>What to fix:</strong> {r.mode.fix}
                  {r.mode.side === "seller" && <span className="text-brand-lift"> ({EFFORT_LABEL[r.mode.effort]})</span>}
                </span>
              )}
              {r.mode && RETEST_MODE_KEYS.has(r.mode.key) && (
                <span className="block">
                  <strong>Re-buy:</strong> a failure like this one is what the retest covers: when a seller&apos;s most
                  recent purchase failed this way, vet402 buys from that seller again and adds the new row here.
                </span>
              )}
              {l.deliveredAfterFailure && (
                <span className="block">The latest purchase delivered. An earlier purchase listed below did not.</span>
              )}
              <span className="block font-[family-name:var(--font-mono)] text-xs text-brand-lift">
                Recorded: <RecordedFacts r={r} />
              </span>
              <span className="block text-xs text-brand-lift">
                <ExportTrace r={r} resourceKey={l.resourceKey} now={now} />
              </span>
              {l.earlier.length > 0 && (
                <span className="block text-xs text-brand-lift">
                  Earlier:{" "}
                  {l.earlier.map((e, i) => (
                    <span key={i}>
                      {i > 0 && " · "}
                      {fmtUtc(e.facts.attemptedAt)} {e.bucket === "delivered" ? "delivered" : `${e.mode?.title} (${e.mode ? SIDE_LABEL[e.mode.side] : ""})`}
                      {e.facts.selection ? ` [${e.facts.selection}]` : ""}
                    </span>
                  ))}
                </span>
              )}
            </>
          ) : (
            <span className="text-brand-lift">vet402 has not bought this listing yet.</span>
          )}
        </td>
      </tr>
    </>
  );
}

export function SellerDetailView({
  detail,
  page,
  now,
  revalidateSec,
}: {
  detail: SellerDetail;
  page: number;
  now: number;
  revalidateSec: number;
}) {
  const s = detail.summary;
  const totalPages = Math.max(1, Math.ceil(detail.listings.length / SELLER_LISTINGS_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const shown = detail.listings.slice((p - 1) * SELLER_LISTINGS_PAGE_SIZE, p * SELLER_LISTINGS_PAGE_SIZE);
  return (
    <article className="sheet">
      <DocHead title="Seller: purchase results on Base" fetched={<FetchedAt at={detail.fetchedAt} revalidateSec={revalidateSec} />} />
      <h1 className="doc-title mt-10 break-words [overflow-wrap:anywhere]">{detail.host}</h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <p className="doc-p">
        {n(s.listings)} Base {s.listings === 1 ? "listing" : "listings"}. By the latest purchase of each: <CountsLine c={s} />.
        {s.lastAttemptAt && <> Latest purchase: {fmtUtc(s.lastAttemptAt)}.</>}
      </p>
      {s.retestDue && (
        <p className="doc-p">
          <strong>Your most recent purchase failed on vet402&apos;s side.</strong> That makes this seller one the retest
          buys from again (
          <Link href="/observatory/methodology" className="underline">
            methodology
          </Link>
          ). The new row will appear below, next to the old one.
        </p>
      )}
      {(detail.selectedBy.census > 0 || detail.selectedBy.retest > 0) && (
        <p className="doc-p">
          Rows marked <code>census</code> or <code>retest</code> were bought to give this seller a row of its own, or
          to buy again after a failure on vet402&apos;s side.
        </p>
      )}

      <h2 className="sec-head">
        <span className="sec-no">1.</span>
        <span>Your listings</span>
      </h2>
      <TableScroll label="Base listings of this seller, most recent purchase first">
        <table className="fact-table">
          <caption className="sr-only">Base listings of this seller, most recent purchase first</caption>
          <thead>
            <tr>
              <th scope="col">Listing</th>
              <th scope="col">Latest purchase</th>
              <th scope="col">Result</th>
              <th scope="col">Whose side</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <ListingRows key={l.endpointId} l={l} now={now} />
            ))}
          </tbody>
        </table>
      </TableScroll>
      <Pager
        page={p}
        totalPages={totalPages}
        href={(x) => `${sellerPath(detail.host)}?page=${x}`}
        label="Listing pages"
      />

      <h2 className="sec-head">
        <span className="sec-no">2.</span>
        <span>How to read this</span>
      </h2>
      <p className="doc-p">
        Each listing shows its latest purchase on Base and up to four earlier ones. <strong>Whose side</strong> says
        where the failure came from: the seller&apos;s answer or listing, or vet402 itself. A row{" "}
        <strong>held</strong> (<code>held_reason</code> in the export) is not counted against the seller in the
        delivered numbers, because vet402 cannot rule out that its request was the problem. The transaction link opens
        the settlement on Basescan. Listings removed from the Bazaar, and listings whose catalog network is not Base,
        are not on this page. The{" "}
        <Link href="/sellers/fix-first" className="underline">
          fix-first page
        </Link>{" "}
        groups the same results across sellers (
        <Link href="/observatory/methodology" className="underline">
          methodology
        </Link>
        ).
      </p>

      <h2 className="sec-head">
        <span className="sec-no">3.</span>
        <span>Think a row is wrong?</span>
      </h2>
      <p className="doc-p">
        Open the listing&apos;s record (the link in the first column) and use &ldquo;Dispute this record&rdquo; there.
        Say which purchase and what you saw instead. The row is not deleted on dispute; a correction is published
        with the same weight.
      </p>
    </article>
  );
}

// ------------------------------------------------------------
// /sellers/fix-first
// ------------------------------------------------------------

const HOSTS_SHOWN = 12;

function GroupCard({ g, i }: { g: FixGroup; i: number }) {
  const first = g.sellers.slice(0, HOSTS_SHOWN);
  const rest = g.sellers.slice(HOSTS_SHOWN);
  const hostLink = (s: { host: string; listings: number }) => (
    <li key={s.host}>
      <Link href={sellerPath(s.host)} className="underline">
        {s.host}
      </Link>{" "}
      <span className="text-brand-lift">{n(s.listings)}</span>
    </li>
  );
  return (
    <li id={g.key} className="mt-8">
      <h3 className="text-base font-semibold">
        <span className="text-brand-lift">{i + 1}.</span> {g.title}
      </h3>
      <p className="doc-p mt-1">
        <strong>{n(g.hosts)}</strong> {g.hosts === 1 ? "seller" : "sellers"} · <strong>{n(g.listings)}</strong>{" "}
        {g.listings === 1 ? "listing" : "listings"} · {SIDE_LABEL[g.side]}
        {g.side === "seller" && <> · effort {g.effort}: {EFFORT_LABEL[g.effort]}</>}
      </p>
      <p className="doc-p mt-1">
        <strong>{g.side === "seller" ? "Fix: " : ""}</strong>
        {g.fix}
      </p>
      <p className="doc-p mt-1">
        <strong>What happened:</strong> {g.what}
      </p>
      <p className="doc-p mt-1 text-xs text-brand-lift">
        From the ledger status:{" "}
        {Object.entries(g.statuses)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([st, c], j) => (
            <span key={st}>
              {j > 0 && ", "}
              <code>{st}</code> {n(c)}
            </span>
          ))}
      </p>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem]">{first.map(hostLink)}</ul>
      {rest.length > 0 && (
        <details className="mt-1 text-[0.8125rem]">
          <summary className="cursor-pointer text-brand-lift">{n(rest.length)} more sellers</summary>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{rest.map(hostLink)}</ul>
        </details>
      )}
    </li>
  );
}

export function FixFirstView({ board, revalidateSec }: { board: SellerBoard; revalidateSec: number }) {
  const seller = board.groups.filter((g) => g.side === "seller");
  const ours = board.groups.filter((g) => g.side === "vet402");
  const unsorted = board.groups.filter((g) => g.side === "unsorted");
  const failed = board.totals.seller + board.totals.vet402 + board.totals.unsorted;
  return (
    <article className="sheet">
      <DocHead title="What to fix first (Base)" fetched={<FetchedAt at={board.fetchedAt} revalidateSec={revalidateSec} />} />
      <h1 className="doc-title mt-10">What to fix first</h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <p className="doc-p">
        The Base listings whose latest purchase did not deliver ({n(failed)} of{" "}
        {n(board.totals.listings - board.totals.notBought)} bought), grouped by what went wrong. Seller-side groups
        come first, the fix that reaches the most sellers at the top; effort is 1 for a listing or config change, 2
        for a server change, 3 when it depends on the facilitator. Each seller links to its own page.
      </p>
      <h2 className="sec-head">
        <span className="sec-no">1.</span>
        <span>On the seller&apos;s side</span>
      </h2>
      {seller.length === 0 ? <p className="doc-p text-brand-lift">None.</p> : <ol className="list-none p-0">{seller.map((g, i) => <GroupCard key={g.key} g={g} i={i} />)}</ol>}
      <h2 className="sec-head">
        <span className="sec-no">2.</span>
        <span>On vet402&apos;s side: nothing for sellers to fix</span>
      </h2>
      {ours.length === 0 ? <p className="doc-p text-brand-lift">None.</p> : <ol className="list-none p-0">{ours.map((g, i) => <GroupCard key={g.key} g={g} i={seller.length + i} />)}</ol>}
      {unsorted.length > 0 && (
        <>
          <h2 className="sec-head">
            <span className="sec-no">3.</span>
            <span>Not grouped yet</span>
          </h2>
          <ol className="list-none p-0">
            {unsorted.map((g, i) => (
              <GroupCard key={g.key} g={g} i={seller.length + ours.length + i} />
            ))}
          </ol>
        </>
      )}
      <p className="doc-p">
        A count is one listing&apos;s latest purchase, not a rating: one attempt can fail for reasons on either side.
        The groups come from the status and HTTP code vet402 recorded (
        <Link href="/observatory/methodology" className="underline">
          methodology
        </Link>
        {" · "}
        <a href="/api/v1/observatory/export.csv" className="underline">
          export.csv
        </a>
        ).
      </p>
    </article>
  );
}

// ------------------------------------------------------------
// 共通の状態
// ------------------------------------------------------------

export function SellersNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="sheet">
      <h1 className="doc-title mt-4">{title}</h1>
      <p className="doc-p">{children}</p>
    </article>
  );
}
