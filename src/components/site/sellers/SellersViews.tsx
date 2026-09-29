import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass } from "@/components/ui/Button";
import { TableScroll } from "@/components/site/TableScroll";
import {
  boardAsOfDay,
  exportDaysFor,
  filterSellersBySide,
  type SellerSideFilter,
  type FixGroup,
  type OutcomeCounts,
  type SellerBoard,
  type SellerDetail,
  type SellerListing,
  type SellerOtherChains,
  type SellerSummary,
  type ShownRow,
} from "@/lib/sellers/board";
import { EFFORT_LABEL, HELD_GLOSS, sideLabelOf, STATUS_GLOSS } from "@/lib/sellers/fix-modes";
import DecisionAnswer, { REASON_CODES_HREF } from "./DecisionAnswer";
import { nextBuyLine } from "@/lib/sellers/next-buy";

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

/** 記録頁の通知登録欄（observatory/e/[id] の RecordSubscribe kind="notify" を包む id）。 */
export const RECORD_NOTIFY_ANCHOR = "notify";

/**
 * 売り手が頁を再訪する理由（2026-09-29 監査 第2巡）: 出品ごとに、記録頁の通知登録（ダブルオプトイン済みの
 * 既存の購読）へ直に飛ぶ。新しい表・新しい購読の種類は作らない。
 */
function NotifyLink({ endpointId }: { endpointId: string }) {
  return (
    <Link href={`/observatory/e/${endpointId}#${RECORD_NOTIFY_ANCHOR}`} className={TAP}>
      Email me when this result changes
    </Link>
  );
}

/** 検索結果の表題が切られずに出る長さの目安（2026-09-28 SEO 監査の基準）。 */
export const TITLE_MAX = 60;

/**
 * /sellers/[host] の表題（<title>・h1・構造化データの name で同じ語）。
 *
 * 2026-09-29 敵対的監査: 以前の "Is X working?" は現在形の問いで、何日も前の購入を「今動いていない」と読ませた。
 * 最新の購入日（UTC の日付）を入れて、いつの結果かを表題で言う。購入が無ければ日付を付けない。
 * " | vet402" を付けて TITLE_MAX を超えるなら付けない（2026-09-28 SEO 監査: 切られるのは接尾辞の側にする）。
 * 2026-09-29 第5巡: 「as of <日付>」は頁を読み出した時刻と読み違えられた。日付は最新の試行の日だと書く
 * （読み出した時刻は h1 の下と doc-head に別に出す）。
 */
export function sellerHeading(host: string, lastAttemptAt: string | null): string {
  const day = lastAttemptAt && /^\d{4}-\d{2}-\d{2}/.test(lastAttemptAt) ? lastAttemptAt.slice(0, 10) : null;
  return day ? `${host}: x402 purchase results on Base, latest attempt ${day}` : `${host}: x402 purchase results on Base`;
}

/** /sellers の表題（2026-09-29 第2巡: いつの結果かを日付で言う）。day は boardAsOfDay。 */
export function sellersIndexHeading(day: string | null): string {
  return day ? `Find your purchase results (Base, as of ${day})` : "Find your purchase results (Base)";
}

/** /sellers/fix-first の表題（同上）。 */
export function fixFirstHeading(day: string | null): string {
  return day ? `What to fix first, as of ${day}` : "What to fix first";
}

export function sellerPageTitle(host: string, lastAttemptAt: string | null = null): string {
  const bare = sellerHeading(host, lastAttemptAt);
  const full = `${bare} | vet402`;
  return full.length <= TITLE_MAX ? full : bare;
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
          <Link href="/sellers" className={TAP}>
            Sellers
          </Link>
          {" · "}
          <Link href="/sellers/fix-first" className={TAP}>
            What to fix first
          </Link>
        </span>
        <span>
          <Link href="/observatory/methodology" className={TAP}>
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
      {c.pending > 0 && (
        <>
          {" "}
          · <strong>{n(c.pending)}</strong> awaiting on-chain verification
        </>
      )}
      {c.unsorted > 0 && (
        <>
          {" "}
          · <strong>{n(c.unsorted)}</strong> not sorted (vet402 cannot show the failure was not its own)
        </>
      )}
      {c.notPaid > 0 && (
        <>
          {" "}
          · <strong>{n(c.notPaid)}</strong> not bought (vet402 did not pay)
        </>
      )}{" "}
      · <strong>{n(c.notTried)}</strong> not tried yet
    </>
  );
}

function SearchForm({ q }: { q: string }) {
  return (
    <form method="get" action="/sellers" className="mt-5">
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block min-w-0 basis-full text-[0.8125rem] sm:basis-auto sm:flex-1">
          <span className="doc-caption block">Your domain</span>
          {/* text-base（16px）: iOS Safari は 16px 未満の入力欄にフォーカスすると頁を拡大する（2026-09-28 監査）。 */}
          <input name="q" type="search" defaultValue={q} placeholder="api.example.com" className="doc-input mt-1 text-base" />
        </label>
        <button type="submit" className={buttonClass({ size: "sm" })}>
          Find
        </button>
      </div>
    </form>
  );
}

/**
 * 640px 未満の売り手一覧（2026-09-28 監査）。9 列の表は電話の幅で横スクロールになり、host と
 * 数字が同じ画面に並ばなかった。行ごとにラベル付きの縦並びへ組み替える。数字は表と同じ props から出す。
 */
function SellersCards({ sellers, label }: { sellers: readonly SellerSummary[]; label: string }) {
  const facts: { label: string; value: (s: SellerSummary) => string }[] = [
    { label: "Listings", value: (s) => n(s.listings) },
    { label: "Delivered", value: (s) => n(s.delivered) },
    { label: "Seller's side", value: (s) => n(s.seller) },
    { label: "vet402's side", value: (s) => n(s.vet402) },
    { label: "Not sorted", value: (s) => n(s.unsorted) },
    { label: "Awaiting verification", value: (s) => n(s.pending) },
    { label: "Not bought (vet402 did not pay)", value: (s) => n(s.notPaid) },
    { label: "Not tried yet", value: (s) => n(s.notTried) },
    { label: "Latest attempt", value: (s) => fmtUtc(s.lastAttemptAt) },
  ];
  return (
    <ul aria-label={label} className="mt-4 list-none border-t border-hair p-0 sm:hidden">
      {sellers.map((s) => (
        <li key={s.host} className="border-b border-hair py-3">
          <Link href={sellerPath(s.host)} className="block font-semibold underline [overflow-wrap:anywhere]">
            {s.host}
          </Link>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-[0.8125rem]">
            {facts.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-brand-lift">{f.label}</dt>
                <dd className="m-0 text-right tabular-nums">{f.value(s)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

function SellersTable({ sellers, label }: { sellers: readonly SellerSummary[]; label: string }) {
  return (
    <>
      <SellersCards sellers={sellers} label={label} />
      {/* デスクトップ（640px 以上）は表のまま。 */}
      <div className="hidden sm:block">
        <SellersTableWide sellers={sellers} label={label} />
      </div>
    </>
  );
}

function SellersTableWide({ sellers, label }: { sellers: readonly SellerSummary[]; label: string }) {
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
              Awaiting verification
            </th>
            <th scope="col" className="num">
              Not bought (vet402 did not pay)
            </th>
            <th scope="col" className="num">
              Not tried yet
            </th>
            <th scope="col">Latest attempt</th>
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
              <td className="num">{n(s.pending)}</td>
              <td className="num">{n(s.notPaid)}</td>
              <td className="num">{n(s.notTried)}</td>
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

/** 区分の絞り込みの語（2026-09-29 第6巡・列の見出しと同じ語）。 */
export const SIDE_FILTER_LABEL: Readonly<Record<SellerSideFilter, string>> = {
  seller: "Seller's side",
  vet402: "vet402's side",
  unsorted: "Not sorted",
  delivered: "Delivered",
};

/** 文の中の言い方（「latest attempt is …」）。 */
const SIDE_FILTER_PHRASE: Readonly<Record<SellerSideFilter, string>> = {
  seller: "on the seller's side",
  vet402: "on vet402's side",
  unsorted: "not sorted",
  delivered: "delivered",
};

/** /sellers の頁の URL（区分と頁番号・既定の値はクエリに書かない）。 */
export function sellersIndexHref(side: SellerSideFilter | null, page = 1): string {
  const qs = new URLSearchParams();
  if (side) qs.set("side", side);
  if (page > 1) qs.set("page", String(page));
  const q = qs.toString();
  return q ? `/sellers?${q}` : "/sellers";
}

function SideFilter({ board, side }: { board: SellerBoard; side: SellerSideFilter | null }) {
  const items: { key: SellerSideFilter | null; label: string; count: number }[] = [
    { key: null, label: "All", count: board.sellers.length },
    ...(Object.keys(SIDE_FILTER_LABEL) as SellerSideFilter[]).map((k) => ({
      key: k,
      label: SIDE_FILTER_LABEL[k],
      count: filterSellersBySide(board.sellers, k).length,
    })),
  ];
  return (
    <nav aria-label="Show sellers by result" className="doc-p mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem]">
      <span className="text-brand-lift">Show sellers with at least one listing whose latest attempt is:</span>
      {items.map((it) => (
        <Link
          key={it.key ?? "all"}
          href={sellersIndexHref(it.key)}
          aria-current={it.key === side ? "page" : undefined}
          className={`${TAP} ${it.key === side ? "font-semibold decoration-2" : ""}`}
        >
          {it.label} ({n(it.count)})
        </Link>
      ))}
    </nav>
  );
}

export function SellersIndexView({
  board,
  page,
  q,
  search,
  revalidateSec,
  side = null,
}: {
  board: SellerBoard;
  page: number;
  q: string;
  search: { exact: SellerSummary | null; matches: SellerSummary[] } | null;
  revalidateSec: number;
  /** 区分の絞り込み（GET ?side=・2026-09-29 第6巡）。null は全部。 */
  side?: SellerSideFilter | null;
}) {
  const listed = filterSellersBySide(board.sellers, side);
  const totalPages = Math.max(1, Math.ceil(listed.length / SELLERS_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const shown = listed.slice((p - 1) * SELLERS_PAGE_SIZE, p * SELLERS_PAGE_SIZE);
  const t = board.totals;
  return (
    <article className="sheet">
      <DocHead title="Sellers on Base: purchase results" fetched={<FetchedAt at={board.fetchedAt} revalidateSec={revalidateSec} />} />
      <h1 className="doc-title mt-10">{sellersIndexHeading(boardAsOfDay(board))}</h1>
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
        {n(t.sellers)} sellers with {n(t.listings)} Base listings; vet402 has tried to buy from {n(t.sellersTried)} of
        the sellers. By the latest attempt at each listing: <CountsLine c={t} />.{" "}
        <Link href="/sellers/fix-first" className="underline">
          What to fix first
        </Link>{" "}
        groups the failures by kind.
      </p>
      <SideFilter board={board} side={side} />
      {side && (
        <p className="doc-p text-[0.8125rem]">
          Showing {n(listed.length)} of {n(board.sellers.length)} sellers: those with at least one Base listing whose
          latest attempt is <strong>{SIDE_FILTER_PHRASE[side]}</strong>.{" "}
          <Link href={sellersIndexHref(null)} className={TAP}>
            Show all
          </Link>
        </p>
      )}
      {shown.length === 0 ? (
        <p className="doc-p text-brand-lift">No seller has a listing in this group.</p>
      ) : (
        <SellersTable
          sellers={shown}
          label={side ? `Sellers on Base with a listing whose latest attempt is ${SIDE_FILTER_PHRASE[side]}, most recent purchase first` : "Sellers on Base, most recent purchase first"}
        />
      )}
      <Pager page={p} totalPages={totalPages} href={(x) => sellersIndexHref(side, x)} label="Seller pages" />
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
        by its latest attempt on Base, paid or stopped before payment. <strong>Delivered</strong>{" "}
        means vet402 confirmed the USDC transfer on-chain and the paid request answered 2xx.{" "}
        <strong>Seller&apos;s side</strong> is used for a failed purchase when the row itself shows that vet402 was
        not at fault: vet402 signed the payment on the terms the listing declares, its wallet held the price, it
        sent the input the listing declares, and the seller gave an explicit answer (or had its full declared time to
        give one). A row that cannot show one of these is <strong>not sorted</strong>.{" "}
        <strong>vet402&apos;s side</strong> means the row shows the cause was ours or a limit of ours: our wallet held
        less USDC than the price, we did not send the request body or query the seller declared and the input was
        refused, the price was over our per-purchase ceiling, or our run did not finish.{" "}
        <strong>Not bought</strong> means vet402 did not sign a payment (for example the 402 offered no option
        vet402 can sign, or its price differed from the listing); it is not a purchase result.{" "}
        <strong>Awaiting on-chain verification</strong> means the seller returned a receipt that vet402 has not
        re-read on-chain yet; it is neither delivered nor failed. A count is one attempt, not a rating (
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

/**
 * 照合待ち（settle_claimed）の行。照合の時刻は書かない（照合は Vercel の cron と管理用 Mac の launchd の
 * 両方から走り、後者は Mac が起きているときしか動かない・独立レビュー 2026-09-28）。
 * 2026-09-29 第4巡: 2xx で売り手が tx を名指したが、決済の申告が success:false だった行（wazir 型）も照合待ち。
 */
function pendingLine(r: ShownRow): string {
  const base =
    r.facts.status === "settle_claimed"
      ? "The seller returned a settlement receipt, and vet402 has not confirmed that transaction on-chain yet. Until it is confirmed or refuted, this purchase is neither delivered nor failed."
      : `The paid request answered HTTP ${r.facts.httpStatusPaid ?? "—"} and the seller named a settlement transaction, although its receipt did not say success. vet402 has not confirmed that transaction on-chain yet. Until it is confirmed or refuted, this purchase is neither delivered nor failed.`;
  const reason = r.facts.verifyReason;
  return reason ? `${base} vet402 looked for that transaction on-chain and has not found it yet (${reason}).` : base;
}

function seenLine(r: ShownRow): string {
  if (r.bucket === "pending") return pendingLine(r);
  if (r.bucket === "delivered") {
    return `Paid; vet402 confirmed the transfer on-chain and the paid request answered HTTP ${r.facts.httpStatusPaid ?? "—"}.`;
  }
  return r.mode?.what ?? "";
}

function ResultWord({ r }: { r: ShownRow }) {
  if (r.bucket === "delivered") return <>delivered</>;
  if (r.bucket === "pending") return <>awaiting on-chain verification</>;
  return <>{r.mode?.title}</>;
}

/** 「どちらの側か」の語（delivered・照合待ちは側を持たない）。 */
function sideWord(r: ShownRow): string {
  if (r.bucket === "delivered") return "no failure (delivered)";
  if (r.bucket === "pending") return "not sorted: awaiting on-chain verification";
  return r.mode ? sideLabelOf(r.mode) : "—";
}

/** seller の側（確定）の行の印。頁の冒頭の帯と同じ語。 */
export const UNDER_RECHECK = "under re-check";

export function WhoseSide({ r }: { r: ShownRow }) {
  return (
    <>
      {sideWord(r)}
      {r.confirmedSeller && (
        <>
          {" "}
          <span className="whitespace-nowrap border border-[#9f0712] px-1 text-xs font-semibold text-[#9f0712]">{UNDER_RECHECK}</span>
        </>
      )}
    </>
  );
}

/** 行内のリンク: タップ領域を 24px 以上にする（2026-09-29 第4巡・WCAG 2.5.8）。 */
const TAP = "inline-flex min-h-6 items-center underline";

function StatusWord({ status }: { status: string }) {
  const gloss = STATUS_GLOSS[status];
  return (
    <>
      <code>{status}</code>
      {gloss && <span className="font-[family-name:var(--font-sans)]"> ({gloss})</span>}
    </>
  );
}

/**
 * 署名した条件の見出し（2026-09-29 第5巡）: 決済がチェーンで確かめられた行（settled）だけ「paid」。
 * tx の無い行・照合待ちの行は「signed」（決済が成立していない行を「払った」と書かない）。
 */
export function termsLabel(r: ShownRow): string {
  if (!r.signed) return "The 402 vet402 saw:";
  return r.facts.status === "settled" ? "The 402 terms vet402 paid:" : "The 402 terms vet402 signed:";
}

/**
 * 最新の行の記録の見出し（2026-09-29 第6巡）: 決済がチェーンで確かめられた行（settled）だけ「paid purchase」。
 * 署名したが決済が成立していない行（tx の無い行・照合待ち・反証された行）は「signed」、署名していない行は「attempt」。
 */
export function recordedLabel(r: ShownRow): string {
  if (!r.signed) return "Recorded (attempt; vet402 did not pay, not an L1 result)";
  return r.facts.status === "settled"
    ? "Recorded (L1 paid purchase)"
    : "Recorded (L1 attempt; vet402 signed a payment, not settled on-chain)";
}

function RecordedFacts({ r }: { r: ShownRow }) {
  const f = r.facts;
  const short = f.txHash ? `${f.txHash.slice(0, 10)}…${f.txHash.slice(-4)}` : null;
  return (
    <>
      <StatusWord status={f.status} /> · HTTP {f.httpStatusPaid ?? "—"}
      {f.status === "no_402" && f.unpaidStatus !== null && <> (unpaid answer {f.unpaidStatus})</>}
      {" · "}
      {short ? (
        r.txUrl ? (
          <a href={r.txUrl} className={TAP} rel="noopener noreferrer">
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
          {(HELD_GLOSS as Readonly<Record<string, string>>)[r.held] && (
            <span className="font-[family-name:var(--font-sans)]"> ({(HELD_GLOSS as Readonly<Record<string, string>>)[r.held]})</span>
          )}
        </>
      )}
      {f.selection && (
        <>
          {" · "}
          {f.status === "settled" ? "bought" : "attempted"} by the <code>{f.selection}</code>
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
      <a href={`/api/v1/observatory/export.csv?days=${days}`} className={TAP}>
        export.csv?days={days}
      </a>
      : the row with <code>attempted_at</code> {r.facts.attemptedAt} and <code>resource_key</code> {resourceKey}.
    </>
  );
}

/** 記録頁の異議欄（observatory/e/[id] の id="dispute"）。購入の時刻を ?purchase= で渡し、欄に書き込ませる。 */
export const RECORD_DISPUTE_ANCHOR = "dispute";

export function disputeHref(endpointId: string, attemptedAt: string | null): string {
  const q = attemptedAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(attemptedAt) ? `?purchase=${encodeURIComponent(attemptedAt)}` : "";
  return `/observatory/e/${endpointId}${q}#${RECORD_DISPUTE_ANCHOR}`;
}

function DisputeLink({ endpointId, attemptedAt }: { endpointId: string; attemptedAt: string | null }) {
  return (
    <Link href={disputeHref(endpointId, attemptedAt)} className={TAP}>
      Dispute this purchase
    </Link>
  );
}

/** 署名した支払いと、支払い付き要求への応答の要点（記録済みのものだけ）。 */
function Evidence({ r }: { r: ShownRow }) {
  if (!r.evidence) return null;
  return (
    <>
      <span className="block">
        <strong>Signed payment:</strong> {r.evidence.signed}
      </span>
      <span className="block">
        <strong>Answer to the paid request:</strong> {r.evidence.answer}
      </span>
    </>
  );
}

/** 売り手について何かを言う最新の行（最新の行が vet402 の側などのとき・2026-09-29 第4巡）。 */
function SellerSignalLine({ l, rebuyEligible }: { l: SellerListing; rebuyEligible: boolean }) {
  const r = l.latest;
  if (!r || r.bucket === "delivered" || r.bucket === "seller") return null;
  const sig = l.lastSellerSignal;
  const latestPhrase =
    r.bucket === "vet402"
      ? "The latest attempt failed on vet402's side"
      : r.bucket === "not_bought"
        ? "The latest attempt was not a purchase (vet402 did not pay)"
        : r.bucket === "pending"
          ? "The latest purchase is awaiting on-chain verification"
          : "The latest attempt is not sorted";
  // 2026-09-29 第6巡: 最新の試行は購入とは限らない（tx の無い行・vet402 が払っていない行）。「bought again」と書かない。
  const after = rebuyEligible ? "; this listing is eligible for a re-buy." : "; there has been no attempt since.";
  return (
    <span className="block">
      <strong>Last result about the seller:</strong>{" "}
      {sig ? (
        <>
          {sig.bucket === "delivered" ? "delivered" : "failed on the seller's side"} on {fmtUtc(sig.at)}. {latestPhrase}
          {after}
        </>
      ) : (
        <>
          none among the attempts shown. {latestPhrase}
          {after}
        </>
      )}
    </span>
  );
}

/**
 * 頁の先頭から自動で判定 API に問い合わせる出品の数（2026-09-29 第5巡・DecisionAnswer.tsx）。鍵なしの判定 API は
 * 同じ IP から 10 回/分で、同じ IP の鍵なしの利用者（エージェント）と枠を分け合うので、頁の閲覧で使う分は小さくする
 * （独立レビュー WARNING: 5 件は枠の半分）。残りの出品はボタンで 1 件ずつ。
 */
export const DECISION_AUTO_LISTINGS = 2;

function EarlierRow({ e, endpointId }: { e: ShownRow; endpointId: string }) {
  return (
    <li className="border-t border-hair py-1.5 first:border-t-0">
      <span className="block">
        {fmtUtc(e.facts.attemptedAt)} · <ResultWord r={e} /> · <WhoseSide r={e} />
        {e.facts.selection ? ` [${e.facts.selection}]` : ""}
      </span>
      <span className="block font-[family-name:var(--font-mono)] text-brand-lift">
        <RecordedFacts r={e} />
      </span>
      {(e.evidence || e.seen402 || e.note || e.exportReason) && (
        <details className="mt-0.5">
          <summary className="inline-flex min-h-6 cursor-pointer items-center text-brand-lift">What vet402 recorded</summary>
          <span className="block">{seenLine(e)}</span>
          {e.seen402 && (
            <span className="block">
              <strong>{termsLabel(e)}</strong> {e.seen402}
            </span>
          )}
          <Evidence r={e} />
          {e.note && <span className="block">{e.note}</span>}
          {e.exportReason && <span className="block">{e.exportReason}</span>}
        </details>
      )}
      <span className="block">
        <DisputeLink endpointId={endpointId} attemptedAt={e.facts.attemptedAt} />
      </span>
    </li>
  );
}

/**
 * 「直した後にやること」（2026-09-29 第6巡）: 次に vet402 が買う目安（next-buy.ts・計算できなければ書かない）、
 * 買い直しの予定、結果が変わったときの通知の登録、異議の導線を 1 つのブロックに。
 */
function AfterFix({ l, rebuyEligible }: { l: SellerListing; rebuyEligible: boolean }) {
  const next = nextBuyLine(l.nextBuy);
  const r = l.latest;
  return (
    <div className="mt-2 border-l-2 border-hair pl-3 text-xs" aria-label="After a fix">
      <span className="block font-semibold text-brand-lift">After a fix</span>
      {next && (
        <span className="block">
          <strong>Next purchase by vet402:</strong> {next}
        </span>
      )}
      {rebuyEligible && (
        <span className="block">
          <strong>Re-buy:</strong> this listing is eligible for a re-buy under the rules on the{" "}
          <Link href="/observatory/methodology" className={TAP}>
            methodology page
          </Link>
          .
        </span>
      )}
      <span className="flex flex-wrap gap-x-4">
        <NotifyLink endpointId={l.endpointId} />
        {r && <DisputeLink endpointId={l.endpointId} attemptedAt={r.facts.attemptedAt} />}
      </span>
    </div>
  );
}

/**
 * 1 出品を 1 枚のカードに（2026-09-29 第4巡: 4 列の表は電話の幅で横スクロールになり、文が切れていた）。
 * 見出しの事実（最新の試行・結果・どちらの側か）はラベル付きの 2 列、文はその下に表の外で折り返す。
 */
function ListingCard({
  l,
  now,
  rebuyEligible,
  autoDecision = false,
}: {
  l: SellerListing;
  now: number;
  rebuyEligible: boolean;
  /** 判定 API に自動で問い合わせる（頁の先頭の DECISION_AUTO_LISTINGS 件）。 */
  autoDecision?: boolean;
}) {
  const r = l.latest;
  const failed = r && (r.bucket === "seller" || r.bucket === "vet402");
  return (
    <li className="border-b border-hair py-4" id={`listing-${l.endpointId}`}>
      <Link href={`/observatory/e/${l.endpointId}`} className={`${TAP} font-semibold [overflow-wrap:anywhere]`} title={l.resourceUrl}>
        {l.resourceKey}
      </Link>
      <span className="block text-xs font-normal text-brand-lift">{l.method ?? "method undeclared"}</span>
      <dl className="mt-2 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-0.5 text-[0.8125rem]">
        <dt className="text-brand-lift">Latest attempt</dt>
        <dd className="m-0">{r ? fmtUtc(r.facts.attemptedAt) : "not tried yet"}</dd>
        <dt className="text-brand-lift">Result</dt>
        <dd className={`m-0 ${failed ? "text-[#9f0712]" : ""}`}>{r ? <ResultWord r={r} /> : "—"}</dd>
        <dt className="text-brand-lift">Whose side</dt>
        <dd className="m-0">{r ? <WhoseSide r={r} /> : "—"}</dd>
      </dl>
      {/* 2026-09-29 第6巡: 判定 API の答えはカードの先頭近く（以前は 375px で 2 画面以上下）。 */}
      {r && l.resourceId && (
        <div className="mt-2 text-[0.8125rem]">
          <DecisionAnswer resourceId={l.resourceId} auto={autoDecision} sellerSide={r.bucket === "seller"} />
        </div>
      )}
      <div className="mt-2 space-y-1 text-[0.8125rem]">
        {r ? (
          <>
            <span className="block">
              <strong>What we saw:</strong> {seenLine(r)}
            </span>
            <SellerSignalLine l={l} rebuyEligible={rebuyEligible} />
            {r.seen402 && (
              <span className="block">
                <strong>{termsLabel(r)}</strong> {r.seen402}
              </span>
            )}
            <Evidence r={r} />
            {r.mode && (
              <span className="block">
                <strong>What to fix:</strong> {r.mode.fix}
                {r.mode.side === "seller" && <span className="text-brand-lift"> ({EFFORT_LABEL[r.mode.effort]})</span>}
              </span>
            )}
            {r.note && <span className="block">{r.note}</span>}
            {r.exportReason && <span className="block">{r.exportReason}</span>}
            {r.mode?.side === "vet402" && (
              <span className="block">This failure was on vet402&apos;s side, not the seller&apos;s.</span>
            )}
            {l.deliveredAfterFailure && (
              <span className="block">The latest purchase delivered. An earlier attempt listed below did not.</span>
            )}
            <span className="block break-words font-[family-name:var(--font-mono)] text-xs text-brand-lift">
              {recordedLabel(r)}:{" "}
              <RecordedFacts r={r} />
            </span>
            <span className="block break-words text-xs text-brand-lift">
              <ExportTrace r={r} resourceKey={l.resourceKey} now={now} />
            </span>
          </>
        ) : (
          <span className="block text-brand-lift">vet402 has not tried to buy this listing yet.</span>
        )}
        <AfterFix l={l} rebuyEligible={rebuyEligible} />
        {l.earlier.length > 0 && (
          <div className="mt-2 text-xs">
            <span className="block font-semibold text-brand-lift">Earlier attempts</span>
            <ol className="m-0 list-none p-0">
              {l.earlier.map((e, i) => (
                <EarlierRow key={i} e={e} endpointId={l.endpointId} />
              ))}
            </ol>
          </div>
        )}
      </div>
    </li>
  );
}

function latestFailedOnOurSide(d: SellerDetail): boolean {
  return d.listings[0]?.latest?.mode?.side === "vet402";
}

/**
 * 冒頭の要約（2026-09-29 第5巡）: 主は「売り手について言える直近の結果」（出品ごとに、表示した試行のうち最新の
 * delivered か seller の側（確定）。最新の試行が vet402 の側の失敗でも、その前に delivered があればそれ）。
 * 最新の試行で数えた数は補足に回す（以前は先頭が「0 delivered」のままで、補足の行だけが付いていた）。
 */
function SellerSummaryLines({ d, revalidateSec }: { d: SellerDetail; revalidateSec: number }) {
  const s = d.summary;
  const v = d.sellerView;
  return (
    <>
      <p className="doc-p">
        {n(s.listings)} Base {s.listings === 1 ? "listing" : "listings"}. <strong>Latest result about the seller</strong>{" "}
        at each listing: <strong>{n(v.delivered)}</strong> delivered · <strong>{n(v.seller)}</strong> failed on the
        seller&apos;s side · <strong>{n(v.none)}</strong> with no such result among the attempts shown ·{" "}
        <strong>{n(s.notTried)}</strong> not tried yet. This counts, for each listing, the newest purchase that
        delivered or the newest failure on the seller&apos;s side. Attempts on vet402&apos;s side, not bought, not
        sorted, or awaiting on-chain verification are skipped.
      </p>
      <p className="doc-p text-[0.8125rem] text-brand-lift">
        By the latest attempt at each listing, whatever it was: <CountsLine c={s} />.
      </p>
      <p className="doc-p text-[0.8125rem] text-brand-lift">
        {s.lastAttemptAt ? <>Latest attempt: {fmtUtc(s.lastAttemptAt)}. </> : null}
        This page read the ledger at {fmtUtc(d.fetchedAt)} and reuses that read for up to{" "}
        {Math.round(revalidateSec / 60)} min.
      </p>
    </>
  );
}

/** 売り手頁のその頁に出す出品（頁番号は 1 から・範囲外は端に寄せる）。 */
export function sellerListingsOnPage(detail: Pick<SellerDetail, "listings">, page: number): { page: number; totalPages: number; listings: SellerListing[] } {
  const totalPages = Math.max(1, Math.ceil(detail.listings.length / SELLER_LISTINGS_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  return { page: p, totalPages, listings: detail.listings.slice((p - 1) * SELLER_LISTINGS_PAGE_SIZE, p * SELLER_LISTINGS_PAGE_SIZE) };
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
  const { page: p, totalPages, listings: shown } = sellerListingsOnPage(detail, page);
  const autoIds = new Set(
    shown
      .filter((l) => l.latest && l.resourceId)
      .slice(0, DECISION_AUTO_LISTINGS)
      .map((l) => l.endpointId),
  );
  const newest = detail.listings[0];
  const newestSignal = newest?.lastSellerSignal;
  return (
    <article className="sheet">
      <DocHead title="Seller: purchase results on Base" fetched={<FetchedAt at={detail.fetchedAt} revalidateSec={revalidateSec} />} />
      {/* 2026-09-29: 表題は最新の購入日つきの事実の言い方（sellerHeading）。ホスト名は長いのでどこででも折り返す。 */}
      <h1 className="doc-title mt-10 break-words [overflow-wrap:anywhere]">{sellerHeading(detail.host, s.lastAttemptAt)}</h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <SellerSummaryLines d={detail} revalidateSec={revalidateSec} />
      {s.rebuyEligible ? (
        <p className="doc-p">
          <strong>Your most recent purchase failed on vet402&apos;s side.</strong> This seller is eligible for a re-buy
          under the rules on the{" "}
          <Link href="/observatory/methodology" className="underline">
            methodology page
          </Link>
          .
          {newestSignal?.bucket === "delivered" && <> Before that, this listing delivered on {fmtUtc(newestSignal.at)}.</>}
        </p>
      ) : (
        latestFailedOnOurSide(detail) && (
          <p className="doc-p">
            <strong>Your most recent purchase failed on vet402&apos;s side.</strong> Nothing for you to fix there.
            {newestSignal?.bucket === "delivered" && (
              <> Before that, this listing delivered on {fmtUtc(newestSignal.at)}.</>
            )}
          </p>
        )
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
      <ol aria-label="Base listings of this seller, most recent purchase first" className="mt-4 list-none border-t border-hair p-0">
        {shown.map((l) => (
          <ListingCard
            key={l.endpointId}
            l={l}
            now={now}
            rebuyEligible={s.rebuyEligible && s.rebuyEndpointId === l.endpointId}
            autoDecision={autoIds.has(l.endpointId)}
          />
        ))}
      </ol>
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
        Each listing shows its latest attempt on Base and up to four earlier ones. A row where vet402 signed a
        payment and sent the paid request is an <strong>L1</strong> result: &ldquo;Recorded (L1 paid
        purchase)&rdquo; when the payment settled on-chain, and &ldquo;signed, not settled on-chain&rdquo; when it
        did not. A row where vet402 did not sign is marked &ldquo;not bought&rdquo; and is not an L1 result. The listing&apos;s record page also shows the <strong>L0</strong> state (&ldquo;Published
        state&rdquo;), which checks that an unpaid request gets a valid 402, so a listing can pass L0 and still fail
        here. <strong>Whose side</strong> puts a failure on the seller&apos;s side when the row shows vet402 was not
        at fault: it signed on the listing&apos;s terms, its wallet held the price, it sent the declared input, and the
        seller answered explicitly or had its declared time. Even then, one such failure is &ldquo;not sorted: one
        failure so far&rdquo;: a failure goes on the seller&apos;s side only when the same listing has one on two
        different days (UTC), and those rows are marked &ldquo;{UNDER_RECHECK}&rdquo; while we re-check them. A row
        that cannot show all of that is &ldquo;not sorted&rdquo;, and so is a <strong>held</strong> row (
        <code>held_reason</code> in the export), a failure where no payment was taken (&ldquo;no charge&rdquo;), and a
        payment that settled before the seller refused an input vet402 had not sent. &ldquo;Signed payment&rdquo;
        and &ldquo;Answer to the paid request&rdquo; show what the row recorded, and nothing else: the answer&apos;s
        body and header values are not published. The maxTimeoutSeconds on a row is the listing&apos;s value today;
        a declared price or address on a not-bought row is the value recorded at the time of the attempt. The
        transaction link opens the settlement on Basescan. &ldquo;Decision API now&rdquo; is what the decision API
        (<code>GET /api/v1/resources/&#123;id&#125;/decision?role=payer</code>, no key) answers for the listing when
        you open this page; your browser asks it for the first {DECISION_AUTO_LISTINGS} listings, and for the others
        when you ask. It is cautious for the payer: it leaves out the attempts that show vet402&apos;s fault, are held, or
        took no payment, and counts the rest, so it can say WARN or BLOCK for a listing whose failures this page
        leaves not sorted. The codes that decided the answer come first, each with one sentence on what it means
        for that listing (
        <Link href={REASON_CODES_HREF} className="underline">
          reason codes
        </Link>
        ). &ldquo;After a fix&rdquo; gives the earliest date vet402&apos;s regular sweep can buy the listing again,
        where the rules let it be worked out, and the links to be told of a change or to dispute a row. Listings removed from the Bazaar, and listings whose catalog network is not Base, are not
        on this page. The{" "}
        <Link href="/sellers/fix-first" className="underline">
          fix-first page
        </Link>{" "}
        groups the same results across sellers (
        <Link href="/observatory/methodology#whose-side" className="underline">
          methodology
        </Link>
        ).
      </p>

      <h2 className="sec-head">
        <span className="sec-no">3.</span>
        <span>Think a row is wrong?</span>
      </h2>
      <p className="doc-p">
        Use &ldquo;Dispute this purchase&rdquo; on the row: it opens{" "}
        {newest ? (
          <Link href={disputeHref(newest.endpointId, newest.latest?.facts.attemptedAt ?? null)} className="underline">
            Dispute this record
          </Link>
        ) : (
          <>&ldquo;Dispute this record&rdquo;</>
        )}{" "}
        on the listing&apos;s record page with the purchase time filled in. Say what you saw instead. The row is not
        deleted on dispute; a correction is published with the same weight.
      </p>
    </article>
  );
}

// ------------------------------------------------------------
// /sellers/[host]（Base の出品が無い売り手・2026-09-29）
// ------------------------------------------------------------

export function sellerOtherChainsTitle(host: string): string {
  return `x402 purchase records for ${host}`;
}

/** 平易な結果（Base の頁の ResultWord と同じ言葉）。台帳の status は括弧で添える。 */
function OtherChainResult({ l }: { l: SellerOtherChains["listings"][number] }) {
  const r = l.latest;
  return (
    <>
      <ResultWord r={r} />
      {r.mode && <span className="text-brand-lift"> ({sideLabelOf(r.mode)})</span>}
      <span className="block font-[family-name:var(--font-mono)] text-xs font-normal text-brand-lift">
        <code>{r.facts.status}</code>
        {r.facts.httpStatusPaid !== null && <> · HTTP {r.facts.httpStatusPaid}</>}
      </span>
    </>
  );
}

export function SellerOtherChainsView({ other, revalidateSec }: { other: SellerOtherChains; revalidateSec: number }) {
  return (
    <article className="sheet">
      <DocHead title="Seller: purchase records" fetched={<FetchedAt at={other.fetchedAt} revalidateSec={revalidateSec} />} />
      <h1 className="doc-title mt-10 break-words">
        Purchase records for <span className="[overflow-wrap:anywhere]">{other.host}</span>
      </h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <p className="doc-p">
        This seller has no active Base listing, so it is not on the{" "}
        <Link href="/sellers" className="underline">
          Base seller list
        </Link>
        . vet402 did buy from its listings on other chains (or from listings since removed). Each purchase is on the
        listing&apos;s record page, linked below.
      </p>
      <TableScroll label="Listings of this seller that vet402 bought, most recent purchase first">
        <table className="fact-table">
          <caption className="sr-only">Listings of this seller that vet402 bought, most recent purchase first</caption>
          <thead>
            <tr>
              <th scope="col">Listing record</th>
              <th scope="col">Chain</th>
              <th scope="col">Latest purchase</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {other.listings.map((l) => (
              <tr key={l.endpointId}>
                <td>
                  <Link href={`/observatory/e/${l.endpointId}`} className="block max-w-[14rem] break-all underline sm:max-w-[26rem]">
                    {l.resourceKey}
                  </Link>
                  <span className="block text-xs font-normal">
                    <NotifyLink endpointId={l.endpointId} />
                  </span>
                </td>
                <td className="whitespace-nowrap">{l.chain}</td>
                <td className="whitespace-nowrap">{fmtUtc(l.latest.facts.attemptedAt)}</td>
                <td className={l.latest.bucket !== "delivered" ? "text-[#9f0712]" : ""}>
                  <OtherChainResult l={l} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <p className="doc-p">
        Think a row is wrong? Open the listing&apos;s record and use &ldquo;Dispute this record&rdquo; there (
        <Link href="/observatory/methodology" className="underline">
          methodology
        </Link>
        ).
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
        {g.listings === 1 ? "listing" : "listings"} · {sideLabelOf(g)}
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
  const notPaid = board.groups.filter((g) => g.side === "not_bought");
  const failed = board.totals.seller + board.totals.vet402 + board.totals.unsorted;
  const paid = failed + board.totals.delivered + board.totals.pending;
  return (
    <article className="sheet">
      <DocHead title="What to fix first (Base)" fetched={<FetchedAt at={board.fetchedAt} revalidateSec={revalidateSec} />} />
      <h1 className="doc-title mt-10">{fixFirstHeading(boardAsOfDay(board))}</h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <p className="doc-p">
        The Base listings whose latest purchase did not deliver ({n(failed)} of {n(paid)} that vet402 paid for),
        grouped by what went wrong.
        {board.totals.pending > 0 && (
          <>
            {" "}
            {n(board.totals.pending)} more are awaiting on-chain verification and are not counted here.
          </>
        )}{" "}
        A failure is on the seller&apos;s side when the row shows vet402 was not at fault (
        <Link href="/observatory/methodology#whose-side" className="underline">
          the rules
        </Link>
        ); a row that cannot show it is not sorted. Seller-side groups come first, the fix that reaches the most
        sellers at the top; effort is 1 for a listing or config change, 2 for a server change, 3 when it depends on
        the facilitator. Listings vet402 tried but did not pay for ({n(board.totals.notPaid)}) are listed last and are
        not purchase results. Each seller links to its own page.
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
            <span>Not counted against either side</span>
          </h2>
          <ol className="list-none p-0">
            {unsorted.map((g, i) => (
              <GroupCard key={g.key} g={g} i={seller.length + ours.length + i} />
            ))}
          </ol>
        </>
      )}
      {notPaid.length > 0 && (
        <>
          <h2 className="sec-head">
            <span className="sec-no">{unsorted.length > 0 ? "4." : "3."}</span>
            <span>Not bought: vet402 did not pay</span>
          </h2>
          <ol className="list-none p-0">
            {notPaid.map((g, i) => (
              <GroupCard key={g.key} g={g} i={seller.length + ours.length + unsorted.length + i} />
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
