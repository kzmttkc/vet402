import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { VerdictBadge } from "@/components/site/VerdictBadge";
import { TableScroll } from "@/components/site/TableScroll";
import { fetchLeaderboard } from "@/lib/db/leaderboard";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";

// N-17 — public agent leaderboard. Latest verdict per agent, aggregate only.
// Honest empty state, same discipline as /accuracy.
// 2026-08-13 vet402: typeset as a register of the memo.
export const metadata: Metadata = pageMetadata({
  title: "Register of recently verified subjects",
  description:
    "The highest-scoring ERC-8004 agents and wallets vet402 has recently verified: identity, reputation, wallet history and x402 settlement record, summarized as one score.",
  path: "/leaderboard",
});
export const revalidate = 600;

// Short 0x… form for wallet-keyed rows (benchmark seeds have no agent id).
function shortWallet(wallet: string | null): string {
  if (!wallet) return "—";
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

// Inline, honest marker for operator self-benchmark rows. Kept tiny so it
// annotates without competing with the real ranking data.
function SeedTag() {
  return <span className="marker marker-plan ml-2 align-middle">benchmark</span>;
}

/**
 * 表のセルの中で SeedTag の前に置く、視覚に出ない読点（2026-08-13 全盲ペルソナ
 * 監査 R2【イライラ級】）。
 *
 * `ml-2` は視覚的な余白でしかなく、読み上げには何の隙間も作らない。実測では
 * セルの本文が `0x3304…566aBENCHMARK` と1語に繋がって聞こえていた。
 * SeedTag 自身に持たせないのは、上の説明文（"Rows marked [benchmark] are
 * operator benchmark entries"）では読点が文法を壊すため——区切りが要るのは
 * 「識別子のすぐ後ろに付く」表の中だけ。
 */
function SeedGap() {
  return <span className="sr-only">, </span>;
}

/**
 * 順位表の Subject セル用クラス（2026-08-13 全盲ペルソナ監査 R2【イライラ級】）。
 *
 * この列は `<td>` だった。行見出しが1つも無いので、表移動で聞こえるのは
 * 「SCORE、49」だけ——**どのアドレスの 49 なのかが分からない**。行の主キーは
 * Subject なので、ここを `th scope="row"` にする。
 *
 * ただし globals.css の `.fact-table th` は見出し行（大文字・0.6875rem・字間
 * 0.08em・下罫は紺・vertical-align:bottom）向けに書かれていて、そのまま当たると
 * 本文行の組版が崩れる。globals.css は他部門が並行で触っているので、打ち消しは
 * ユーティリティ側で行う（`@layer components` はユーティリティに負けるよう
 * 意図的に置かれている——globals.css 257行目の注記）。値は `.fact-table td` の
 * 実測値をそのまま写したもので、見た目は 1px も変わらない。
 */
const SUBJECT_CELL =
  "font-[family-name:var(--font-sans)] font-normal normal-case tracking-[normal] whitespace-normal align-top border-b border-hair py-[0.6875rem] pr-5 text-[0.8125rem] text-brand";

/**
 * 既定で紙面に載せる行数。
 *
 * 2026-08-13 UX監査R1 [A1]: ヘッダは "Rows: 25 of 25" と刷っていたが、窓の中に
 * 実在する被検体は42件（既知悪25 + 既知良17）で、25 は上位25件という表示上の
 * 都合でしかなかった。分母を表示件数と同じ数にすると「全部見えている」と
 * 読める。しかも落ちていた17件は**全部 BLOCK**（既知悪の下位）で、可視な
 * 登録簿は良い側へ系統的に偏っていた——「Nothing on this site is an estimate」
 * を掲げる製品としては、順位表の分母が一番落としてはいけない数字だった。
 *
 * 直し方は3つあった（正しい分母を出すだけ／全件出す／ページング）。全件出す
 * ことにして、既定は上位25件・?all=1 で残りも同じ表に続ける形にしている。
 * 順位表としての読みやすさ（上位が上）と、隠していないこと（続きへの導線と
 * 内訳が常に見える）を両立させるにはこれが一番安い。
 */
const DEFAULT_ROWS = 25;
/** 窓は30日なので現実には数十件だが、DBが荒れた時に紙面が無限に伸びない上限。 */
const MAX_ROWS = 500;

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string | string[] }>;
}) {
  const allParam = (await searchParams).all;
  const showAll = (Array.isArray(allParam) ? allParam[0] : allParam) === "1";

  let all: Awaited<ReturnType<typeof fetchLeaderboard>> = [];
  try {
    all = await fetchLeaderboard(MAX_ROWS);
  } catch {
    all = [];
  }
  const total = all.length;
  const rows = showAll ? all : all.slice(0, DEFAULT_ROWS);
  const hidden = all.slice(rows.length);
  // 隠れている行の判定内訳。件数だけ書くと「下位が切れている」としか読めず、
  // それが良い側への偏りだと分からない。
  const hiddenByVerdict = hidden.reduce<Record<string, number>>((acc, r) => {
    const key = r.recommendation || "—";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const hasSeeded = rows.some((r) => r.seeded);
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "vet402 — recently verified subjects",
    numberOfItems: total,
    itemListElement: rows
      .filter((r) => r.agentId || r.wallet)
      .map((r, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: r.agentId ? `${SITE_URL}/agent/${r.agentId}` : `${SITE_URL}/payee/${r.wallet}`,
        name: r.agentId ? `Agent #${r.agentId}` : shortWallet(r.wallet),
      })),
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Register", path: "/leaderboard" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListJsonLd) }}
        />
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />

        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Register of recently verified subjects</span>
            <span>
              {/* この頁のシアン1点。表に何行載っているかという事実。分母は
                  「表示上限」ではなく「窓の中に実在する被検体の数」。 */}
              Rows:{" "}
              <span className="text-signal">
                {rows.length} of {total}
                {rows.length < total ? ` (top ${rows.length} by score)` : ""}
              </span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            {/* 2026-08-13 UX監査R1 [A6]: 同じアドレスに2つの公開スコアが出る
                （例: /payee は payee エンジン、この表は agent/wallet エンジン）。
                docs には「別エンジン」と書いてあるが、どちらの頁にもその表示が
                無かったので、読者からは同じ物差しの数字が食い違って見えた。
                どのエンジンのどの時点の測定かを、両方の頁の書誌欄に出す。 */}
            <span>Engine: agent / wallet</span>
            <span>Latest verdict per subject</span>
            <span>Aggregate only</span>
          </div>
        </div>

        {/* 2026-09-02 監査: title / 見出し行 / H1 で呼称が 3 つあった。Register に統一。
            ヘッダーのナビ「Leaderboard」は SiteHeader.tsx 側（別系統）。 */}
        <h1 className="doc-title mt-10">Register of recently verified subjects, ranked</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            The latest verdict per subject, ranked by score. Every row is computed from public
            on-chain state &mdash; ERC-8004 identity and reputation, wallet history, x402
            settlements. This is not the observatory and not a payee score. Run the same lookup
            yourself with an API key.
          </p>
        </div>

        {/* 2026-08-13 UX監査R1 [A6]: どちらのエンジンの数字かを本文にも1行。
            /payee/:address が同じアドレスに別の数字を出すのは仕様だが、
            その旨がどこにも書いていなければ読者には食い違いにしか見えない。 */}
        <p className="doc-note mt-6 max-w-[70ch]">
          These are agent/wallet-engine verdicts, each one the latest benchmark or lookup result
          for that subject. A payee page at <code className="text-brand-deep">/payee/&lt;address&gt;</code>{" "}
          runs a different engine on the request, weighted for the buyer-side question, so the same
          address can carry two different published numbers.{" "}
          <Link href="/docs/api#payee-score" className="doc-link">
            How the two differ
          </Link>
          .
        </p>

        {/* 2026-08-06 UX audit item 6: distinguish operator self-benchmark rows
            from customer traffic, in plain sight, so the board can be full
            without ever implying usage it does not have. */}
        {hasSeeded ? (
          <p className="doc-note mt-6 max-w-[70ch]">
            Rows marked <SeedTag /> are operator benchmark entries &mdash; publicly known addresses
            we score ourselves to prove the engine is live and calibrated, not customer traffic. See
            the{" "}
            <Link href="/accuracy" className="doc-link">
              measured accuracy
            </Link>{" "}
            report for how they are used.
          </p>
        ) : null}

        {rows.length === 0 ? (
          <div className="dashbox mt-10 max-w-[64ch]">
            <p className="doc-caption">Empty register</p>
            <p className="mt-3 text-brand">The board is warming up.</p>
            <p className="doc-note mt-3">
              No verdicts are in the current window yet. It will never be padded with fabricated
              agents &mdash; rows appear only as real lookups happen, and as our{" "}
              <Link href="/accuracy" className="doc-link">
                operator benchmark
              </Link>{" "}
              scores known addresses. Want to be the first real entry?{" "}
              <Link href="/signup" className="doc-link">
                Get an API key
              </Link>{" "}
              and run a lookup.
            </p>
          </div>
        ) : (
          <TableScroll label="Recently verified subjects, ranked by score">
            <table className="fact-table">
              <caption className="sr-only">
                Recently verified subjects, ranked by trust score
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    #
                  </th>
                  <th scope="col">Subject</th>
                  <th scope="col" className="num">
                    Score
                  </th>
                  <th scope="col">Verdict</th>
                  {/* 2026-08-13 監査是正 #6: 390px では5列が紙面に入らず、
                      SCORED（日付）列が .table-scroll の外へ押し出されていた。
                      横スクロールできること自体は手掛かりが無いので、
                      「隠れている列がある」と気付けない。順位表の主眼は
                      #・被検体・スコア・判定の4つで、日付は各行の詳細頁にも
                      あるため、480px 未満ではこの列を落とす（表示しない列は
                      display:none なので支援技術にも二重に出ない）。 */}
                  <th scope="col" className="num hidden xs:table-cell">
                    Scored
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.identity}>
                    {/* 順位は表の意味を担う情報なので装飾扱いにしない。 */}
                    <td className="num text-brand-lift">{i + 1}</td>
                    {/* 2026-08-12 FIX-7: 行内に <a> が0個で、/agent/:id と
                        /payee/:address というプロフィールページが実在するのに一覧から
                        辿れず行き止まりだった。順位表の主キーである Subject を
                        その行の詳細へ繋ぐ。 */}
                    {/* 行見出し。Score / Verdict / Scored の各セルは、これが
                        scope="row" であることによって「どの被検体の値か」を
                        伴って読み上げられる。 */}
                    <th scope="row" className={SUBJECT_CELL}>
                      {r.agentId ? (
                        <Link href={`/agent/${r.agentId}`} className="doc-link">
                          Agent #{r.agentId}
                        </Link>
                      ) : r.wallet ? (
                        // 2026-08-13 全盲ペルソナ監査 R2: 字面は `0x3304…566a` の
                        // 短縮形のままにする（紙面の列幅がこの表の可読性そのもの）。
                        // ただし短縮形からは音声でフルアドレスを復元できないので、
                        // 読み上げ側には 42 桁を丸ごと渡す。
                        <Link href={`/payee/${r.wallet}`} className="doc-link">
                          <span aria-hidden="true">{shortWallet(r.wallet)}</span>
                          <span className="sr-only">Wallet {r.wallet}</span>
                        </Link>
                      ) : (
                        <span>{shortWallet(r.wallet)}</span>
                      )}
                      {r.seeded ? (
                        <>
                          <SeedGap />
                          <SeedTag />
                        </>
                      ) : null}
                    </th>
                    <td className="num text-brand-deep">{r.trustScore}</td>
                    <td>
                      <VerdictBadge verdict={r.recommendation} />
                    </td>
                    <td className="num hidden xs:table-cell whitespace-nowrap text-brand-lift">
                      {r.scoredAt.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        {/* 2026-08-13 UX監査R1 [A1]: 隠れている行の内訳を、隠したその場に置く。
            件数だけでは「下位が切れている」としか読めないが、実測では欠落17件が
            全部 BLOCK で、可視な登録簿は良い側へ偏っていた。偏りの向きを言わずに
            件数だけ直すのは、分母を直したことにならない。 */}
        {hidden.length > 0 ? (
          <p className="doc-note mt-5 max-w-[70ch]">
            {hidden.length} further {hidden.length === 1 ? "subject is" : "subjects are"} in the
            window and not shown above (
            {Object.entries(hiddenByVerdict)
              .sort((a, b) => b[1] - a[1])
              .map(([verdict, count]) => `${count} ${verdict}`)
              .join(", ")}
            ) &mdash; they score below the top {rows.length}, so what is visible here is the
            flattering end of the register.{" "}
            <Link href="/leaderboard?all=1" className="doc-link">
              Show all {total}
            </Link>
            .
          </p>
        ) : showAll && total > DEFAULT_ROWS ? (
          <p className="doc-note mt-5 max-w-[70ch]">
            All {total} subjects in the window, lowest scores included.{" "}
            <Link href="/leaderboard" className="doc-link">
              Back to the top {DEFAULT_ROWS}
            </Link>
            .
          </p>
        ) : null}

        {/* 2026-08-06 a11y (WCAG 2.4.4): the link text was the bare path
            "/accuracy", which a screen reader's link list renders as "slash
            accuracy" with no indication of where it goes. */}
        <p className="mt-8 text-[0.8125rem]">
          <Link href="/accuracy" className="doc-link">
            Methodology and measured accuracy
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/payee" className="doc-link">
            Verify a payee
          </Link>
        </p>
      </article>
    </main>
  );
}
