import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass } from "@/components/ui/Button";
import { purchaseShownAsWithdrawn, WITHDRAWN_FROM_CATALOG, withdrawnL0FailNote, withdrawnRoutesHeading, withdrawnRoutesParagraph } from "@/lib/observatory/l0-verdict";
import { WideColumn } from "@/components/site/WideColumn";
import { TableScroll } from "@/components/site/TableScroll";
import {
  boardAsOfDay,
  exportDaysFor,
  filterSellersBySide,
  sellerHeadline,
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
import {
  ATTRIBUTION_REVIEW_NOTE,
  ATTRIBUTION_UNDER_REVIEW,
  EFFORT_LABEL,
  fixMode,
  HELD_GLOSS,
  isAnsweredWithNamedTx,
  LATE_LINK_PENDING_MINUTES,
  ONCE_SUFFIX,
  sideLabelOf,
  STATUS_GLOSS,
  utcDayOf,
} from "@/lib/sellers/fix-modes";
import DecisionAnswer, { REASON_CODES_HREF } from "./DecisionAnswer";
import { SELLERS_PAGE_DECISION_TEXT } from "@/lib/decision/rules-text";
import { l0ProbeLine, nextBuyLine, NON_SETTLING_COOLDOWN_STREAK, type NextBuy } from "@/lib/sellers/next-buy";
import { explorerTxUrl, paymentChainLabel } from "@/lib/observatory/chains";
import type { OtherChainAttempt } from "@/lib/sellers/board";

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
export function sellerHeading(host: string, lastAttemptAt: string | null, chain: string | null = null): string {
  const day = lastAttemptAt && /^\d{4}-\d{2}-\d{2}/.test(lastAttemptAt) ? lastAttemptAt.slice(0, 10) : null;
  if (!day) return `${host}: x402 purchase results on Base`;
  return chain
    ? `${host}: x402 purchase results on Base, latest attempt ${day} on ${chain}`
    : `${host}: x402 purchase results on Base, latest attempt ${day}`;
}

/** /sellers の表題（2026-09-29 第2巡: いつの結果かを日付で言う）。day は boardAsOfDay。 */
export function sellersIndexHeading(day: string | null): string {
  return day ? `Find your purchase results (Base, as of ${day})` : "Find your purchase results (Base)";
}

/** /sellers/fix-first の表題（同上）。 */
export function fixFirstHeading(day: string | null): string {
  return day ? `What to fix first, as of ${day}` : "What to fix first";
}

export function sellerPageTitle(host: string, lastAttemptAt: string | null = null, chain: string | null = null): string {
  const bare = sellerHeading(host, lastAttemptAt, chain);
  const full = `${bare} | vet402`;
  return full.length <= TITLE_MAX ? full : bare;
}

/** meta description と JSON-LD。最新の購入が Base 以外なら、その鎖の公開名を入れる。 */
export function sellerDescription(host: string, chain: string | null = null): string {
  const lead = chain
    ? `What happened when vet402 paid ${host} over x402. The latest purchase is on ${chain}`
    : `What happened when vet402 paid ${host} over x402 on Base`;
  return `${lead}: each purchase result, what to fix, and whose side a failure was on.`;
}

function FetchedAt({ at, revalidateSec }: { at: string; revalidateSec: number }) {
  return (
    <span className="doc-asof">
      Read from the database {fmtUtc(at)} · reused for up to {Math.round(revalidateSec / 60)} min
    </span>
  );
}

function DocHead({ title, fetched }: { title: string; fetched: ReactNode }) {
  return (
    <div className="doc-head doc-head-compact">
      <div className="doc-head-col">
        <span>Independent Measurement</span>
        <span>{title}</span>
        {fetched}
      </div>
      <div className="doc-head-col">
        <span>vet402</span>
        <span className="doc-head-links">
          <Link href="/sellers" className="underline">
            Sellers
          </Link>
          <span className="doc-head-join">
            {" · "}
            <Link href="/sellers/fix-first" className="underline">
              What to fix first
            </Link>
          </span>
          <span className="doc-head-join">
            {" · "}
            <Link href="/observatory/methodology" className="underline">
              Methodology
            </Link>
          </span>
        </span>
      </div>
    </div>
  );
}

function CountsLine({ c, notTriedWord = "with no Base purchase" }: { c: OutcomeCounts; notTriedWord?: string }) {
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
      · <strong>{n(c.notTried)}</strong> {notTriedWord}
    </>
  );
}

function SearchForm({ q }: { q: string }) {
  return (
    <form method="get" action="/sellers" className="mt-6">
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block min-w-0 basis-full text-[0.84375rem] sm:basis-auto sm:flex-1">
          <span className="doc-caption block">Your domain</span>
          {/* 17px: iOS Safari は 16px 未満の入力欄にフォーカスすると頁を拡大する。階段に 16px は無い（2026-09-28 監査、2026-10-22 に 17px）。 */}
          <input name="q" type="search" defaultValue={q} placeholder="api.example.com" className="doc-input mt-1 text-[1.0625rem]" />
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
    { label: `Seller's side (${ATTRIBUTION_UNDER_REVIEW})`, value: (s) => n(s.seller) },
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
          <Link href={sellerPath(s.host)} className="flex min-h-11 items-center font-semibold underline decoration-1 hover:decoration-2 [overflow-wrap:anywhere]">
            {s.host}
          </Link>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-[0.84375rem]">
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
              <span className="block text-xs font-normal">{ATTRIBUTION_UNDER_REVIEW}</span>
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
                <Link href={sellerPath(s.host)} className="flex min-h-11 min-w-0 max-w-[14rem] items-center underline decoration-1 hover:decoration-2 sm:max-w-[24rem]" title={s.host}>
                  <span className="min-w-0 truncate">{s.host}</span>
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
    <nav aria-label="Show sellers by result" className="doc-p mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.84375rem]">
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
  purchasedLookupFailed = false,
}: {
  board: SellerBoard;
  page: number;
  q: string;
  search: { exact: SellerSummary | null; matches: SellerSummary[] } | null;
  revalidateSec: number;
  /** 区分の絞り込み（GET ?side=・2026-09-29 第6巡）。null は全部。 */
  side?: SellerSideFilter | null;
  /** 購入ホストの読み取りに失敗した（空の結果とは別）。 */
  purchasedLookupFailed?: boolean;
}) {
  const listed = filterSellersBySide(board.sellers, side);
  const totalPages = Math.max(1, Math.ceil(listed.length / SELLERS_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const shown = listed.slice((p - 1) * SELLERS_PAGE_SIZE, p * SELLERS_PAGE_SIZE);
  const t = board.totals;
  return (
    <article className="sheet sheet-wide">
      <WideColumn />
      <DocHead title="Sellers on Base: purchase results" fetched={<FetchedAt at={board.fetchedAt} revalidateSec={revalidateSec} />} />
      <h1 className="doc-title mt-8">{sellersIndexHeading(boardAsOfDay(board))}</h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <p className="doc-p">
        vet402 buys x402 listings with real USDC on Base and publishes what happened. Type your domain to see each
        of your Base listings: when vet402 last bought it, what it saw, what to fix, and whether a failure was on your
        side or on vet402&apos;s.
      </p>
      <p className="doc-p">
        Before an agent pays,{" "}
        <Link href="/x402/check-a-seller" className="doc-link">
          check an x402 seller
        </Link>{" "}
        against the decision and the purchases vet402 has already made.
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
            purchasedLookupFailed ? (
              <p className="doc-p">Reading the ledger failed. Please reload in a minute.</p>
            ) : (
              <p className="doc-p">
                No seller on Base matches <code>{q}</code>. Enter the host of the seller you care about (for example{" "}
                <code>api.yourcompany.com</code>). This page holds Base purchase results; for other chains, search the{" "}
                <Link href={`/observatory?q=${encodeURIComponent(q)}`} className="doc-link">observatory</Link>.
              </p>
            )
          ) : null}
          {search.matches.length > 0 && (
            <>
              <AttributionReviewNote />
              <SellersTable sellers={search.matches} label="Sellers whose host contains the search" />
            </>
          )}
        </section>
      )}

      <h2 className="sec-head">
        <span className="sec-no">1.</span>
        <span>Sellers on Base</span>
      </h2>
      <p className="doc-p">
        {n(t.sellers)} sellers with {n(t.listings)} Base listings; vet402 has tried to buy from {n(t.sellersTried)} of
        the sellers. By the latest attempt at each listing: <CountsLine c={t} notTriedWord="with no Base purchase" />.{" "}
        <Link href="/sellers/fix-first" className="underline">
          What to fix first
        </Link>{" "}
        groups the failures by kind.
      </p>
      {/* 2026-10-21 A-17: 個別頁の帯と同じく、一覧の表の上でも帰属が見直し中だと言う（CSV の column notes と同じ文）。 */}
      <AttributionReviewNote />
      <SideFilter board={board} side={side} />
      {side && (
        <p className="doc-p text-[0.84375rem]">
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

/** 帰属の見直しの注記（/sellers・/sellers/fix-first・sellers の CSV の column notes で同じ文）。 */
export function AttributionReviewNote() {
  return (
    <p className="doc-note mt-3" data-attribution-review="">
      <strong>{upperFirst(ATTRIBUTION_UNDER_REVIEW)}.</strong> {ATTRIBUTION_REVIEW_NOTE}
    </p>
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
        means vet402 re-read the transfer on-chain in that chain&apos;s pinned settlement asset and the paid request answered 2xx.{" "}
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
      : isAnsweredWithNamedTx(r.facts)
        ? `The paid request answered HTTP ${r.facts.httpStatusPaid ?? "—"} and the seller named a settlement transaction, although its receipt did not say success. vet402 has not confirmed that transaction on-chain yet. Until it is confirmed or refuted, this purchase is neither delivered nor failed.`
        : // 2026-10-21 A-16: 5xx の行を「失敗ではない」と読ませない。HTTP の値を先に言い、数え方だけを保留と書く。
          `${paidAnswerSentence(r)} vet402 signed this payment less than ${LATE_LINK_PENDING_MINUTES} minutes before this read and is still looking for the transfer on-chain (late linking), so this row is not counted as delivered or failed yet. Until then it is not known whether money moved.`;
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

/** 支払い付き要求への答えの 1 文（記録した HTTP の値だけ）。 */
function paidAnswerSentence(r: ShownRow): string {
  return r.facts.httpStatusPaid !== null
    ? `The paid request answered HTTP ${r.facts.httpStatusPaid}.`
    : "The paid request got no HTTP answer.";
}

/**
 * 遅延回収の待ちの行（署名した失敗の行で、試行から LATE_LINK_PENDING_MINUTES 分のうち）。照合待ち（settle_claimed）と
 * 2xx で tx を名指した行は別（売り手がレシートか tx を返している）。
 */
export function isLateLinkPendingRow(r: ShownRow): boolean {
  return r.bucket === "pending" && r.facts.status !== "settle_claimed" && !isAnsweredWithNamedTx(r.facts);
}

/** 遅延回収の待ちが明ける時刻（試行 + LATE_LINK_PENDING_MINUTES 分）。読めなければ null。 */
function lateLinkUntil(r: ShownRow): string | null {
  const t = Date.parse(r.facts.attemptedAt);
  if (!Number.isFinite(t)) return null;
  return fmtUtc(new Date(t + LATE_LINK_PENDING_MINUTES * 60_000).toISOString());
}

/**
 * Result の語。2026-10-21 A-16: 遅延回収の待ちの行は「awaiting on-chain verification」だけにしない
 * （HTTP 503 の行が、見出しで「まだ失敗ではない」と読まれた）。記録した HTTP の値を先に出す。
 */
export function resultWordText(r: ShownRow): string {
  if (r.bucket === "delivered") return "delivered";
  if (r.bucket === "pending") {
    if (!isLateLinkPendingRow(r)) return "awaiting on-chain verification";
    return r.facts.httpStatusPaid !== null
      ? `HTTP ${r.facts.httpStatusPaid} on the paid request, payment still being checked`
      : "no answer to the paid request, payment still being checked";
  }
  return r.mode?.title ?? "";
}

function ResultWord({ r }: { r: ShownRow }) {
  return <>{resultWordText(r)}</>;
}

/** 「どちらの側か」の語（delivered・照合待ちは側を持たない）。 */
function sideWord(r: ShownRow): string {
  if (r.bucket === "delivered") return "no failure (delivered)";
  if (r.bucket === "pending") {
    // 2026-10-21 A-16 再点検: 遅延回収の待ちは HTTP の値を言う（awaiting on-chain は照合待ちと tx を名指した 2xx だけ）。
    // 「still checking the chain」は surface-canary の sideFromWords が pending と読む語。
    if (!isLateLinkPendingRow(r)) return "not sorted: awaiting on-chain verification";
    return r.facts.httpStatusPaid !== null
      ? `not sorted yet: HTTP ${r.facts.httpStatusPaid}, vet402 is still checking the chain`
      : "not sorted yet: no HTTP answer, vet402 is still checking the chain";
  }
  return r.mode ? sideLabelOf(r.mode) : "—";
}

/**
 * seller の側（確定）の行の印。頁の冒頭の帯と同じ語。2026-10-21 A-17: 一覧・CSV と同じ「attribution under review」に揃えた
 * （以前は "under re-check"。語が 2 つあると、母語でない売り手には別のことに読める）。
 */
export const UNDER_RECHECK = ATTRIBUTION_UNDER_REVIEW;

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
const TAP = "inline-flex min-h-11 items-center underline decoration-1 hover:decoration-2";

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
  if (!r.signed) return "Recorded (attempt, vet402 did not pay, not an L1 result)";
  return r.facts.status === "settled"
    ? "Recorded (L1 paid purchase)"
    : "Recorded (L1 attempt, vet402 signed a payment, not settled on-chain)";
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

/**
 * 異議は購入を始めない（2026-10-21 A-16）。署名付きの経路（src/lib/observatory/disputes.ts）は L0 を 1 回測り直すだけ。
 * 売り手頁の After a fix と記録頁の異議欄で同じ文。
 */
export const DISPUTE_NO_PURCHASE =
  "A dispute does not start a purchase. The signed dispute route runs one fresh L0 check, an unpaid request.";

/** 記録頁の異議欄（observatory/e/[id] の id="dispute"）。購入の時刻を ?purchase= で渡し、欄に書き込ませる。 */
export const RECORD_DISPUTE_ANCHOR = "dispute";

export function disputeHref(endpointId: string, attemptedAt: string | null): string {
  const q = attemptedAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(attemptedAt) ? `?purchase=${encodeURIComponent(attemptedAt)}` : "";
  return `/observatory/e/${endpointId}${q}#${RECORD_DISPUTE_ANCHOR}`;
}

function DisputeLink({ endpointId, attemptedAt }: { endpointId: string; attemptedAt: string | null }) {
  return (
    <Link href={disputeHref(endpointId, attemptedAt)} className={TAP}>
      {attemptedAt ? "Dispute this purchase" : "Dispute this record"}
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

/** 他チェーンの購入が、その出品の Base の最新行より新しい（Base の行が無いときを含む）。 */
function otherPurchaseIsNewer(l: SellerListing | undefined): boolean {
  const other = l?.otherChain;
  if (!other) return false;
  const baseAt = l.latest?.facts.attemptedAt;
  return !baseAt || other.attemptedAt > baseAt;
}

/** 売り手について何かを言う最新の行（最新の行が vet402 の側などのとき・2026-09-29 第4巡）。 */
function SellerSignalLine({ l, rebuyEligible }: { l: SellerListing; rebuyEligible: boolean }) {
  const r = l.latest;
  if (!r || r.bucket === "delivered" || r.bucket === "seller") return null;
  const sig = l.lastSellerSignal;
  // より新しい他チェーンの購入があるとき、Base の行を latest attempt と呼ばない。Result は Base の行のまま。
  const laterOther = otherPurchaseIsNewer(l);
  const attempt = laterOther ? "latest Base attempt" : "latest attempt";
  const latestPhrase =
    r.bucket === "vet402"
      ? `The ${attempt} failed on vet402's side`
      : r.bucket === "not_bought"
        ? `The ${attempt} was not a purchase (vet402 did not pay)`
        : r.bucket === "pending"
          ? isLateLinkPendingRow(r)
            ? `The ${laterOther ? "latest Base purchase" : "latest purchase"} ${
                r.facts.httpStatusPaid !== null ? `answered HTTP ${r.facts.httpStatusPaid}` : "got no HTTP answer"
              }. vet402 is still checking the chain`
            : laterOther
              ? "The latest Base purchase is awaiting on-chain verification"
              : "The latest purchase is awaiting on-chain verification"
          : `The ${attempt} is not sorted`;
  const after = rebuyEligible
    ? ". This listing is eligible for a re-buy."
    : laterOther
      ? "."
      : ". There has been no attempt since.";
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
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-brand-lift">What vet402 recorded</summary>
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
  const disputeAt = r?.facts.attemptedAt ?? l.otherChain?.attemptedAt ?? null;
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
        <DisputeLink endpointId={l.endpointId} attemptedAt={disputeAt} />
      </span>
      {/* 2026-10-21 A-16: 異議で買い直すと読ませない（disputes.ts は L0 を 1 回測り直すだけ・利用規約と同じ）。 */}
      <span className="block">{DISPUTE_NO_PURCHASE}</span>
      {r && otherPurchaseIsNewer(l) ? (
        <span className="block">The time filled in for the dispute is the latest Base attempt.</span>
      ) : null}
    </div>
  );
}

/** Base の行の文。他チェーンの方が新しいときは Latest Base attempt の下に置く。 */
function BaseAttemptBody({ l, r, now, rebuyEligible }: { l: SellerListing; r: ShownRow; now: number; rebuyEligible: boolean }) {
  return (
    <>
      <span className="block">
        <strong>What vet402 saw:</strong> {seenLine(r)}
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
        {recordedLabel(r)}: <RecordedFacts r={r} />
      </span>
      <span className="block break-words text-xs text-brand-lift">
        <ExportTrace r={r} resourceKey={l.resourceKey} now={now} />
      </span>
    </>
  );
}

/** 直し方の文の最初の節（「:」「;」「.」の前）。種類の fix は命令形の節で始まる。 */
function firstClause(fix: string): string {
  return fix.split(/[:;]/)[0].replace(/\.\s*$/, "").trim();
}

function lowerFirst(x: string): string {
  return x ? x[0].toLowerCase() + x.slice(1) : x;
}

function upperFirst(x: string): string {
  return x ? x[0].toUpperCase() + x.slice(1) : x;
}

function joinAnd(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** 次の購入の時期（next-buy.ts の計算だけ・予約は無い）。カードの先頭の 3 文目の後半。 */
function nextBuyWhen(nb: NextBuy | null): string {
  if (!nb) return "vet402 has no computed time for its next purchase here";
  if (nb.kind === "not_bought") {
    return nb.reason === "path_template"
      ? "vet402 does not buy this listing, because its URL has a path parameter vet402 cannot fill"
      : "vet402 does not buy this listing, because its URL is not https";
  }
  if (nb.kind === "cooldown") {
    return `the regular sweep does not pick this listing for now, because the last ${NON_SETTLING_COOLDOWN_STREAK} paid attempts here did not settle`;
  }
  // 2026-10-21 再点検 中1: 窓が明けていても「いつでも買える」と読ませない。時刻は notBefore だけ（日数の理由は nextBuyLine）。
  const l0 = nb.l0 === "pass" ? "" : ` (it needs a passing L0 check first, and the latest one reads ${nb.l0 ?? "not probed"})`;
  return `the next purchase by vet402 is not before ${nb.notBefore}${l0}, with no booked time. After that it depends on the daily budget and the order of demand`;
}

/** 2 日の規則が数える失敗（方法論の (a)〜(e)）。種類は問わない。 */
const SUCH_A_FAILURE = "such a failure (a failure vet402 can show was not its own)";

/**
 * 2026-10-21 A-16（個人開発の売り手の所見）: 失敗のカードは平易な 3 文で始める。
 *   1. 何が起きたか（記録した HTTP の値）  2. どちらの側か（なぜそうなのか）  3. 売り手にできることと、次に vet402 が買う時期
 * 時期は next-buy.ts の計算だけ（予約の日付を作らない）。異議は購入を始めない（AfterFix に書く）。
 * delivered の行・購入の無い出品には出さない。
 */
export function cardLead(l: Pick<SellerListing, "latest" | "earlier" | "nextBuy">): [string, string, string] | null {
  const r = l.latest;
  if (!r || r.bucket === "delivered") return null;
  const at = fmtUtc(r.facts.attemptedAt);
  const paid = r.facts.httpStatusPaid;
  const unpaid = r.facts.unpaidStatus ?? null;
  const notBoughtWhy = r.mode ? lowerFirst(r.mode.title.replace(/^Not bought:\s*/, "")) : "no recorded reason";

  // 1. 何が起きたか
  let what: string;
  if (!r.signed) {
    if (r.bucket === "vet402") what = `On ${at}, vet402 stopped before paying (${r.mode ? lowerFirst(r.mode.title) : "its own limit"}).`;
    else if (unpaid !== null && unpaid !== 402) what = `On ${at}, the unpaid request answered HTTP ${unpaid} instead of a 402, so vet402 did not sign a payment.`;
    else what = `On ${at}, vet402 did not sign a payment (${notBoughtWhy}).`;
  } else if (r.facts.status === "settled") {
    what =
      paid !== null
        ? `On ${at}, vet402 paid, the payment settled on-chain, and the paid request answered HTTP ${paid}.`
        : `On ${at}, vet402 paid, the payment settled on-chain, and the paid request got no HTTP answer.`;
  } else if (r.facts.status === "settle_claimed") {
    what = `On ${at}, vet402 signed a payment and the seller returned a settlement receipt.`;
  } else {
    what =
      paid !== null
        ? `On ${at}, vet402 signed a payment and the paid request answered HTTP ${paid}.`
        : `On ${at}, vet402 signed a payment and the paid request got no HTTP answer.`;
  }

  // 2. どちらの側か
  let side: string;
  const once = !!r.mode && r.mode.key.endsWith(ONCE_SUFFIX);
  if (r.bucket === "seller") {
    // 2026-10-21 再点検 高: 2 日の規則は種類を分けずに数える（429 の日と 503 の日でも確定する）。理由は「such a failure」
    // （(a)〜(e) を満たす失敗・方法論と同じ語）で言い、日付は最新の行と同じ種類の日だけを挙げる。
    const kind = r.mode?.key ?? null;
    const sameKindDays = [
      ...new Set([r, ...l.earlier].filter((x) => x.confirmedSeller && x.mode?.key === kind).map((x) => utcDayOf(x.facts.attemptedAt))),
    ].sort();
    const kindDays = sameKindDays.length > 0 ? `, and the kind of failure on this row was seen on ${joinAnd(sameKindDays)}` : "";
    side = `This row is on the seller's side (${ATTRIBUTION_UNDER_REVIEW}), because ${SUCH_A_FAILURE} happened at this listing on two or more different UTC days${kindDays}.`;
  } else if (once) {
    side = `This row is not on the seller's side yet, because that needs ${SUCH_A_FAILURE} at this listing on two different UTC days.`;
  } else if (r.bucket === "vet402") {
    side = "This failure is on vet402's side, not the seller's.";
  } else if (r.bucket === "pending") {
    const until = isLateLinkPendingRow(r) ? lateLinkUntil(r) : null;
    side = until
      ? `vet402 is still looking for the transfer on-chain until ${until}, so this row is not counted as delivered or failed yet.`
      : "vet402 has not confirmed the named transaction on-chain yet, so this row is not counted as delivered or failed yet.";
  } else if (r.bucket === "not_bought") {
    side = "This is not a purchase result, so it is not counted against the seller.";
  } else {
    side = `This row is not counted against the seller (${r.mode ? sideLabelOf(r.mode) : "not sorted yet"}).`;
  }

  // 3. 売り手にできることと、次に vet402 が買う時期
  let act: string | null = null;
  if (r.bucket === "seller" && r.mode) act = firstClause(r.mode.fix);
  else if (once && r.mode) act = `If the failure is real, ${lowerFirst(firstClause(fixMode(r.mode.key.slice(0, -ONCE_SUFFIX.length)).fix))}`;
  else if (r.bucket === "vet402") act = "Nothing is needed from the seller";
  if (!act) {
    const code = r.signed ? paid : unpaid;
    if (code !== null && code >= 500) act = `If HTTP ${code} is unexpected, check the route's logs`;
  }
  const when = nextBuyWhen(l.nextBuy);
  const next = act ? `${act}, and ${when}.` : `${upperFirst(when)}.`;
  return [what, side, next];
}

function CardLead({ l }: { l: SellerListing }) {
  const lead = cardLead(l);
  if (!lead) return null;
  return <p className="mt-2 mb-0 max-w-[70ch] text-[0.84375rem]">{lead.join(" ")}</p>;
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
  const failed = !!r && (r.bucket === "seller" || r.bucket === "vet402");
  const l0Line = l0ProbeLine(l.nextBuyFacts, now);
  const baseAttemptLabel = r && otherPurchaseIsNewer(l) ? "Latest Base attempt" : "Latest attempt";
  return (
    <li className="border-b border-hair py-4" id={`listing-${l.endpointId}`}>
      <Link href={`/observatory/e/${l.endpointId}`} className={`${TAP} font-semibold [overflow-wrap:anywhere]`} title={l.resourceUrl}>
        {l.resourceKey}
      </Link>
      <span className="block text-xs font-normal text-brand-lift">{l.method ?? "method undeclared"}</span>
      <CardLead l={l} />
      <dl className="mt-2 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-0.5 text-[0.84375rem]">
        <dt className="text-brand-lift">{baseAttemptLabel}</dt>
        <dd className="m-0">{r ? fmtUtc(r.facts.attemptedAt) : "not tried on Base yet"}</dd>
        <dt className="text-brand-lift">Result</dt>
        <dd className={`m-0 ${failed ? "text-[#9f0712]" : ""}`}>{r ? <ResultWord r={r} /> : "not tried on Base yet"}</dd>
        <dt className="text-brand-lift">Whose side</dt>
        <dd className="m-0">{r ? <WhoseSide r={r} /> : "not tried on Base yet"}</dd>
        {l.otherChain ? (
          <>
            <dt className="text-brand-lift">Other chains</dt>
            <dd className="m-0">
              <OtherChainFacts a={l.otherChain} />
            </dd>
          </>
        ) : null}
      </dl>
      {/* 2026-09-29 第6巡: 判定 API の答えはカードの先頭近く（以前は 375px で 2 画面以上下）。 */}
      {/* 2026-09-29 監査 7 周目: 購入していない出品にも判定 API の答えを出す（未プローブ・unverified の BLOCK が見えなかった）。 */}
      {l.resourceId && (
        <div className="mt-2 text-[0.84375rem]">
          <DecisionAnswer resourceId={l.resourceId} auto={autoDecision} sellerSide={r?.bucket === "seller"} />
        </div>
      )}
      {l0Line && <span className="mt-1 block text-[0.84375rem]">{l0Line}</span>}
      <div className="mt-2 space-y-1 text-[0.84375rem]">
        {r ? (
          <BaseAttemptBody l={l} r={r} now={now} rebuyEligible={rebuyEligible} />
        ) : (
          <span className="block text-brand-lift">No Base purchase is on this listing.</span>
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
  const first = d.listings[0];
  if (otherPurchaseIsNewer(first)) return false;
  return first?.latest?.mode?.side === "vet402";
}

/** 先頭の件数の下の 1 文。他チェーンの最新購入がある出品を、鎖の公開名で数える。 */
function otherChainSummaryLine(listings: readonly SellerListing[]): string | null {
  const counts = new Map<string, number>();
  let nListings = 0;
  for (const l of listings) {
    if (!l.otherChain) continue;
    nListings += 1;
    const chain = paymentChainLabel(l.otherChain.network);
    counts.set(chain, (counts.get(chain) ?? 0) + 1);
  }
  if (nListings === 0) return null;
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([chain, count]) => `${chain} ${count}`);
  const word = nListings === 1 ? "listing" : "listings";
  return `Also bought on other chains: ${n(nListings)} ${word} (${parts.join(", ")}). Each card lists them under Other chains.`;
}

/** カードの Other chains。Base の Result とは別の欄。 */
function OtherChainFacts({ a }: { a: OtherChainAttempt }) {
  const http = a.httpStatusPaid !== null ? `, HTTP ${a.httpStatusPaid}` : "";
  const body = a.payloadNonEmpty === false ? ", body empty" : "";
  const tx = a.txHash ? explorerTxUrl(a.network, a.txHash) : null;
  return (
    <>
      {paymentChainLabel(a.network)}, {fmtUtc(a.attemptedAt)}, {a.status}
      {http}
      {body}
      {tx ? (
        <>
          {" "}
          <a href={tx} className="underline">transaction</a>
        </>
      ) : null}
    </>
  );
}

/**
 * 冒頭の要約（2026-09-29 第5巡）: 主は「売り手について言える直近の結果」（出品ごとに、表示した試行のうち最新の
 * delivered か seller の側（確定）。最新の試行が vet402 の側の失敗でも、その前に delivered があればそれ）。
 * 最新の試行で数えた数は補足に回す（以前は先頭が「0 delivered」のままで、補足の行だけが付いていた）。
 */
function SellerSummaryLines({ d, revalidateSec }: { d: SellerDetail; revalidateSec: number }) {
  const s = d.summary;
  const v = d.sellerView;
  const head = sellerHeadline(d);
  const otherLine = otherChainSummaryLine(d.listings);
  return (
    <>
      <p className="doc-p">
        {n(s.listings)} Base {s.listings === 1 ? "listing" : "listings"}. <strong>Latest result about the seller</strong>{" "}
        at each listing: <strong>{n(v.delivered)}</strong> delivered · <strong>{n(v.seller)}</strong> failed on the
        seller&apos;s side · <strong>{n(v.none)}</strong> with no such result among the attempts shown ·{" "}
        <strong>{n(s.notTried)}</strong> with no Base purchase. This counts, for each listing, the newest Base purchase
        that delivered or the newest Base failure on the seller&apos;s side. Attempts on vet402&apos;s side, not bought,
        not sorted, or awaiting on-chain verification are skipped.
      </p>
      {otherLine ? <p className="doc-p">{otherLine}</p> : null}
      <p className="doc-p text-[0.84375rem] text-brand-lift">
        By the latest attempt at each listing, whatever it was: <CountsLine c={s} notTriedWord="with no Base purchase" />.
      </p>
      <p className="doc-p text-[0.84375rem] text-brand-lift">
        {head.at ? (
          <>
            Latest attempt{head.chain ? ` on ${head.chain}` : ""}: {fmtUtc(head.at)}.{" "}
          </>
        ) : null}
        This page read the ledger at {fmtUtc(d.fetchedAt)} and reuses that read for up to{" "}
        {Math.round(revalidateSec / 60)} min. The first view after a quiet period can show an older read.
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
      .filter((l) => l.resourceId)
      .slice(0, DECISION_AUTO_LISTINGS)
      .map((l) => l.endpointId),
  );
  const newest = detail.listings[0];
  const newestSignal = newest?.lastSellerSignal;
  const head = sellerHeadline(detail);
  return (
    <article className="sheet sheet-wide">
      <WideColumn />
      <DocHead title="Seller: purchase results on Base" fetched={<FetchedAt at={detail.fetchedAt} revalidateSec={revalidateSec} />} />
      {/* 2026-09-29: 表題は最新の購入日つきの事実の言い方（sellerHeading）。ホスト名は長いのでどこででも折り返す。 */}
      <h1 className="doc-title mt-8 break-words [overflow-wrap:anywhere]">{sellerHeading(detail.host, head.at, head.chain)}</h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <SellerSummaryLines d={detail} revalidateSec={revalidateSec} />
      {(detail.withdrawnRoutes ?? []).length > 0 && (
        <>
          <h2 className="sec-head">
            <span>{withdrawnRoutesHeading()}</span>
          </h2>
          <p className="doc-p">
            {withdrawnRoutesParagraph()}
          </p>
          <ul className="doc-p list-disc pl-5">
            {(detail.withdrawnRoutes ?? []).map((w) => (
              <li key={w.endpointId}>
                <Link href={`/observatory/e/${w.endpointId}`} className="underline">
                  {w.resourceKey}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {s.rebuyEligible && !otherPurchaseIsNewer(detail.listings[0]) ? (
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
        Each listing shows its latest Base attempt and up to four earlier Base attempts. Result and Whose side follow
        that Base attempt. A purchase on another chain is listed under Other chains, with the chain name, time, status,
        HTTP status, and a transaction link when one was recorded. The record page shows that purchase in the Payment
        chain column. A row where
        vet402 signed a
        payment and sent the paid request is an <strong>L1</strong> result: &ldquo;Recorded (L1 paid
        purchase)&rdquo; when the payment settled on-chain, and &ldquo;signed, not settled on-chain&rdquo; when it
        did not. A row where vet402 did not sign is marked &ldquo;not bought&rdquo; and is not an L1 result. The listing&apos;s record page also shows the <strong>L0</strong> state (&ldquo;Published
        state&rdquo;), which checks that an unpaid request gets a valid 402, so a listing can pass L0 and still fail
        here. <strong>Whose side</strong> puts a failure on the seller&apos;s side when the row shows vet402 was not
        at fault: it signed on the listing&apos;s terms, its wallet held the price, it sent the declared input, and the
        seller answered explicitly or had its declared time. Even then, one such failure is &ldquo;not sorted: one
        failure so far&rdquo;: a failure goes on the seller&apos;s side only when the same listing has one on two
        different days (UTC), and those rows are marked &ldquo;{UNDER_RECHECK}&rdquo; while that review runs. The review has no set date. A row
        that cannot show all of that is &ldquo;not sorted&rdquo;, and so is a <strong>held</strong> row (
        <code>held_reason</code> in the export), a failure where no payment was taken (&ldquo;no charge&rdquo;), and a
        payment that settled before the seller refused an input vet402 had not sent. &ldquo;Signed payment&rdquo;
        and &ldquo;Answer to the paid request&rdquo; show what the row recorded, and nothing else: the answer&apos;s
        body and header values are not published. The maxTimeoutSeconds on a row is the listing&apos;s value today;
        a declared price or address on a not-bought row is the value recorded at the time of the attempt. The
        transaction link opens the settlement on Basescan when the purchase is on Base. &ldquo;Decision API now&rdquo; is what the decision API
        (<code>GET /api/v1/resources/&#123;id&#125;/decision?role=payer</code>, no key) answers for the listing when
        you open this page; your browser asks it for the first {DECISION_AUTO_LISTINGS} listings, and for the others
        when you ask. {SELLERS_PAGE_DECISION_TEXT} The codes that decided the answer come first, each with the meaning
        from the reason-code table (
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
          <Link href={disputeHref(newest.endpointId, newest.latest?.facts.attemptedAt ?? newest.otherChain?.attemptedAt ?? null)} className="underline">
            Dispute this record
          </Link>
        ) : (
          <>&ldquo;Dispute this record&rdquo;</>
        )}{" "}
        on the listing&apos;s record page with the purchase time filled in. The time filled in is the latest Base
        attempt when that listing has a Base purchase. Say what you saw instead. The row is not
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

function chainPhrase(labels: readonly string[]): string {
  const names = [...new Set(labels)];
  if (names.length === 0) return "another chain";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
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
    <article className="sheet sheet-wide">
      <WideColumn />
      <DocHead title="Seller: purchase records" fetched={<FetchedAt at={other.fetchedAt} revalidateSec={revalidateSec} />} />
      <h1 className="doc-title mt-8 break-words">
        Purchase records for <span className="[overflow-wrap:anywhere]">{other.host}</span>
      </h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <p className="doc-p">
        {other.host} has no active Base listing. Purchase records on {chainPhrase(other.listings.map((l) => l.chain))} are
        on this page. The host is absent from the{" "}
        <Link href="/sellers" className="underline">
          Base seller list
        </Link>
        .
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
                <td className="whitespace-nowrap">
                  {l.chain}
                  {l.latest.facts.network ? (
                    <>
                      {" "}
                      <code>{l.latest.facts.network}</code>
                    </>
                  ) : null}
                </td>
                <td className="whitespace-nowrap">{fmtUtc(l.latest.facts.attemptedAt)}</td>
                <td className={!purchaseShownAsWithdrawn(l.catalogStatus, l.latest.facts.status) && l.latest.bucket !== "delivered" ? "text-[#9f0712]" : ""}>
                  {purchaseShownAsWithdrawn(l.catalogStatus, l.latest.facts.status) ? (
                    <>
                      {WITHDRAWN_FROM_CATALOG}
                      <span className="block text-xs font-normal text-brand-lift">{withdrawnL0FailNote()}</span>
                    </>
                  ) : (
                    <OtherChainResult l={l} />
                  )}
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
      <Link href={sellerPath(s.host)} className="inline-flex min-h-11 items-center underline decoration-1 hover:decoration-2">
        {s.host}
      </Link>{" "}
      <span className="text-brand-lift">{n(s.listings)}</span>
    </li>
  );
  return (
    <li id={g.key} className="mt-8">
      <h3 className="text-[1.0625rem] font-semibold">
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
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.84375rem]">{first.map(hostLink)}</ul>
      {rest.length > 0 && (
        <details className="mt-1 text-[0.84375rem]">
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
    <article className="sheet sheet-wide">
      <WideColumn />
      <DocHead title="What to fix first (Base)" fetched={<FetchedAt at={board.fetchedAt} revalidateSec={revalidateSec} />} />
      <h1 className="doc-title mt-8">{fixFirstHeading(boardAsOfDay(board))}</h1>
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
      <AttributionReviewNote />
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
    <article className="sheet sheet-wide">
      <WideColumn />
      <h1 className="doc-title mt-4">{title}</h1>
      <p className="doc-p">{children}</p>
    </article>
  );
}
