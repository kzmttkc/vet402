import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { listCorrections, type CorrectionRow } from "@/lib/observatory/corrections";
import { getEndpointNames } from "@/lib/observatory/reader";

/**
 * /corrections — the log the site has been promising.
 *
 * 2026-08-13 UX監査R1 [C8]。「Corrections are logged publicly」は LP §3.3 と
 * llms.txt の2箇所で約束していたのに、その置き場は 404 だった。約束した
 * 帳簿が存在しないのは、accuracy 頁が存在しないのと同じ性質の欠陥になる
 * ——「実測を公開する」と言っている製品が、自分の誤りの記録だけ持っていない
 * ことになる。
 *
 * 今日の件数は0件。/accuracy が既に採っている作法（数字が無いうちは方法を
 * 先に出し、空であることを正直に書く）をそのまま踏襲する。件数が増えたら
 * ここが表になる ―― その時に初めて表を作るのでは、また同じ空白期間が出る。
 *
 * 記録はまだ手で足す。訂正が発生してから自動化を作るのが順序で、0件のうちに
 * DB テーブルを掘るのは、動いていることの証明にならない配管を1本増やすだけ。
 */

export const metadata: Metadata = pageMetadata({
  title: "Corrections log",
  description:
    "Every correction vet402 has issued to a published score or verification result, with what was wrong and what changed. Empty until the first one is issued.",
  path: "/corrections",
});

type Correction = {
  /** 訂正を公開した日 (UTC, YYYY-MM-DD) */
  date: string;
  /** 何についての訂正か。アドレスや agent id を書く場合は当人の申立てが前提。 */
  subject: string;
  /** 何が間違っていたか */
  wrong: string;
  /** 何をしたか */
  action: string;
};

/**
 * 発行済みの訂正。
 *
 * 空配列は「まだ1件も無い」という事実であって、書き忘れではない。ここに
 * 何かを足すのは、ToS §8 のどちらかの経路で申立てを受け、事実誤認だったと
 * 判断して再スコアした時だけ。「見解の相違で変えなかった」ものはここには
 * 載らない（訂正ではないため）が、それは §2 に書いてある。
 */
const CORRECTIONS: Correction[] = [
  {
    date: "2026-09-05",
    subject:
      "Naming named companies as having taken payment without delivering, when the failing request may have been ours",
    wrong:
      "Every settled purchase whose paid response was not 2xx was published as settled-and-not-delivered, and the " +
      "endpoint badge distributed that as a sentence a reader takes as a verdict on the seller. Reading the public " +
      "export on 2026-09-05: of 1,669 settled rows, 180 answered 4xx or 5xx, and 157 of those 180 (87%) were 4xx " +
      "— 400 x109, 422 x33, 401 x11, 404 x8, 403 x4. A 4xx means the request that arrived was not one the server " +
      "would accept, and we buy with an empty JSON body and no API key of the seller's, because a catalog listing " +
      "declares a URL, a price and a payee and nothing about the body or the credential. The 401s are almost " +
      "certainly us sending no key. So api.exa.ai/search was carrying a vet402 badge reading '10/10 settled · 0 " +
      "delivered' — a named company, in our own words, taking money and returning nothing. We could not show that. " +
      "Our own methodology already held the right rule and we had applied it too narrowly: it said a 400 from a URL " +
      "we could not have formed correctly is our limitation and not the seller's failure, but only for URLs still " +
      "carrying an unfilled path parameter.",
    action:
      "Found in our own review and changed the same day. The methodology rule now reads on the request rather than " +
      "on the URL — body and authentication header included — and settled attempts answering 4xx are published as " +
      "inconclusive: held, out of the denominator for delivered, and not counted against the seller. Nothing is " +
      "deleted and nothing is hidden: every row keeps its status and HTTP code on the endpoint's page, the count " +
      "ships as l1.inconclusive on /api/v1/observatory/state and as inconclusiveCount on the per-endpoint purchases " +
      "API, and the receipt badge now shows it beside settled and delivered. 5xx is deliberately not covered — a " +
      "server fault is not something the shape of our request explains. deliveryRatePct is now delivered over " +
      "settled minus inconclusive, so the attempts we cannot judge no longer weigh as if we had judged them.",
  },
  {
    date: "2026-09-05",
    subject: "Describing our purchases as covert when they were never covert",
    wrong:
      "The methodology page, the observatory state page, the FAQ and the machine-readable vocabulary all said L1 " +
      "purchases were made covertly. The implementation never did that. Every request in the pipeline — the unpaid " +
      "L0 probe, the unpaid read of the 402 challenge, and the paid request itself — has always sent a User-Agent " +
      "naming vet402 and linking to the methodology page (vet402-observatory-l0/1.0, " +
      "vet402-observatory-l0-recheck/1.0, vet402-observatory-l1/1.0, each with " +
      "+https://vet402.com/observatory/methodology). There is no rotation and no override. Three further things " +
      "would have given us away independently in any case: the payer addresses are one hop from the tx_hash column " +
      "of our own public export.csv, 44% of purchases land in the same UTC hour, and the priority host list and the " +
      "sweep window are published on the methodology page by name.",
    action:
      "Found in our own review and changed the same day: the word is gone from every public surface, replaced by " +
      "what the code does. Naming ourselves is the harder test, not the easier one — a seller that knows exactly " +
      "who is watching and still takes the payment without delivering has been measured under the best conditions " +
      "it will ever get. Anyone who wants to check the claim can: the User-Agent is in the request, and the strings " +
      "are in src/lib/observatory/l1-runner.ts and src/lib/observatory/l0-probe.ts.",
  },
  {
    date: "2026-09-05",
    subject: "How strong the evidence behind our own settled count is",
    wrong:
      "The observatory published one settled number, as if the 1,629 rows behind it rested on the same " +
      "evidence. They do not. Signature-nonce binding shipped at 2026-09-04 12:00 UTC; the 1,558 rows that " +
      "settled before it were confirmed on amount, payee, asset and chain, with nothing tying the transaction " +
      "to the purchase it was offered for. A seller holding several catalog entries at the same price and the " +
      "same payee could have answered with a transfer it had already received. We stated the binding as a " +
      "property of settled without saying when it started.",
    action:
      "Found in our own security audit (S-4 / S-17) and disclosed the same day. The count is unchanged: no row " +
      "was demoted or removed, because demoting one asserts that its transfer was not the purchased one and we " +
      "hold no evidence for that. What changed is that the strength is now printed beside the count — " +
      "settledNonceBound and settledAmountPayeeOnly on /api/v1/observatory/state, summing to l1.settled, with " +
      "the same split per chain and on the state page. The retroactive check we can run is the clock: of the " +
      "1,629 settled rows, 1,589 carry a settlement block time, and those ran from 1 second before the attempt " +
      "to 62 seconds after it, none outside a -5/+15 minute window. Duplicate settlement transactions across " +
      "rows: 0 (1,634 distinct hashes over 1,634 rows). Figures are the 2026-09-05 reading; the live ones are " +
      "on /observatory/state.",
  },
  {
    date: "2026-09-02",
    subject: "This site's own description of how often endpoints are probed",
    wrong:
      'The landing page and the observatory said every catalog-listed endpoint was "probed daily." ' +
      "That was not true. What ran daily was the catalog fetch; probes ran on a rolling schedule, and on " +
      "2026-09-01 only 2,750 of 14,662 active endpoints (18.8%) carried a probe from the previous 7 days. " +
      "The claim and our own published counter contradicted each other on the same page.",
    action:
      "Found in our own adversarial audit and changed the same day (commit a62072c, 2026-09-02 12:51 JST). " +
      "The wording now states the mechanism and prints the measured share: the catalog is re-fetched daily, " +
      "endpoints are probed on a rolling schedule, and the page carries the current percentage of active " +
      "endpoints with a probe in the last 7 days. We also raised the cadence: that share was 68.8% of 15,312 " +
      "active endpoints on 2026-09-04 (reading at 09:00 UTC). That figure is a single reading and moves; the " +
      "live one is on /observatory/state, and it is printed here with its timestamp rather than left to read " +
      "as a standing property. An independent observatory, probe402, published the same finding " +
      "on 2026-09-03 from a 2026-09-01 reading. Their reading was correct.",
  },
];

/**
 * 1 行の描画。before / after は訂正の種類で形が違う——公開判定の訂正は
 * `publishedVerdict` を、台帳の昇格は `status` を持つ。片方しか読んでいなかった
 * ので、昇格 472 行が `— → —` と描かれていた（2026-09-04 外部監査 E・P1-11）。
 */
function stateOf(side: unknown): string {
  const v = side as { publishedVerdict?: string; status?: string } | null;
  return v?.publishedVerdict ?? v?.status ?? "—";
}

function CorrectionTableRow({
  row,
  names,
}: {
  row: CorrectionRow;
  names: Map<string, string>;
}) {
  const before = stateOf(row.before);
  const after = stateOf(row.after);
  const name = names.get(row.subject_id) ?? row.subject_id.slice(0, 8);
  return (
    <tr>
      <td className="whitespace-nowrap">{row.created_at.slice(0, 16).replace("T", " ")}</td>
      <td className="max-w-[24rem] truncate">
        {row.subject_type === "endpoint" ? (
          <Link href={`/observatory/e/${row.subject_id}`} className="underline" title={name}>
            {name}
          </Link>
        ) : (
          name
        )}
      </td>
      <td>{row.level}</td>
      <td className="whitespace-nowrap">
        <code>{before}</code> → <code>{after}</code>
      </td>
      <td>{row.reason}</td>
    </tr>
  );
}

export default async function CorrectionsPage() {
  // 2026-09-02: §10 の訂正ログ（correction_log）はここで公開する。9/2 に path_template の
  // 訂正 12 件が入ったのに、この頁は手書きの定数だけを見て「0 件」と言っていた。
  const rows: CorrectionRow[] = await listCorrections({ limit: 500 }).catch(() => []);
  // 2026-09-04 外部監査 E・P1-11: この表は 484 行を丸ごと "machine-recorded
  // corrections" と呼んでいたが、うち 472 行は settlement_backfill——
  // settle_claimed → settled という**想定内の昇格**で、誤りの訂正ではない。
  // しかも昇格行は before/after に publishedVerdict を持たないので、表には
  // 「— → —」と描かれていた。2 つは別のものなので、別の表にする。
  const verdictCorrections = rows.filter((r) => r.reason !== "settlement_backfill");
  const ledgerPromotions = rows.filter((r) => r.reason === "settlement_backfill");
  const names = await getEndpointNames(rows.filter((r) => r.subject_type === "endpoint").map((r) => r.subject_id)).catch(() => new Map<string, string>());
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Corrections", path: "/corrections" },
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
            <span>Register: corrections issued</span>
            <span>
              {/* この頁のシアン1点。発行済みの件数という事実。
                  2026-09-04 監査 E・P1-11: 見出しは 1、本文は 484 と、同じ頁で
                  別の数を名乗っていた。訂正の件数（散文 + 機械）に統一し、
                  昇格は訂正ではないので別に数える。 */}
              Corrections:{" "}
              <span className="text-signal">{CORRECTIONS.length + verdictCorrections.length}</span>{" "}
              · Ledger promotions: {ledgerPromotions.length.toLocaleString()}
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>No silent edits, no silent removals</span>
            <span>Aggregate and per-subject</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Corrections</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          {/* 2026-08-14 (legal compliance audit, B-1): 旧文は "Nothing is removed
              from this list once it is on it."——絶対の append-only 宣言だった。
              GDPR Art.17/18/21 の検証済みリクエストに対して「絶対に消さない」は
              単体では拒否の正当根拠にならない。残すのは誠実さの核（自己都合の
              無音書換え・削除をしない）だけで、データ主体の権利は honor する
              運用へ改める。処理の実体は Privacy の scored-third-parties 節。 */}
          <p className="min-w-0 max-w-[62ch] text-brand">
            When vet402 publishes something about an address and gets it wrong, the correction is
            published here with what was wrong and what changed. We never silently edit or silently
            remove an entry to make ourselves look better. What we will do is honor verified
            data-protection requests: an entry can be restricted or annotated — see 2.4 below — but
            the log is never quietly rewritten as if a mistake had not happened.
          </p>
        </div>

        {/* ===== 1. The log ===== */}
        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>Issued corrections</span>
        </h2>

        {verdictCorrections.length > 0 && (
          <>
            <p className="doc-p">
              {verdictCorrections.length.toLocaleString()} machine-recorded correction
              {verdictCorrections.length === 1 ? "" : "s"} to a <em>published</em> observatory verdict
              (product spec §10) — a verdict we had put on a public page and then had to take back.
              Newest first. The same rows are served at{" "}
              <code>/api/v1/observatory/corrections</code>.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="fact-table">
                <caption className="sr-only">
                  Machine-recorded corrections to published verdicts, newest first
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Recorded (UTC)</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Level</th>
                    <th scope="col">Before → after</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {verdictCorrections.map((r) => (
                    <CorrectionTableRow key={r.id} row={r} names={names} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {CORRECTIONS.length === 0 && verdictCorrections.length === 0 ? (
          <div className="dashbox mt-6 max-w-[64ch]">
            <p className="doc-caption">Empty log</p>
            <p className="mt-3 text-brand">No corrections have been issued yet.</p>
            <p className="doc-note mt-3">
              This is the count, not a claim about our accuracy: the product is in closed beta and
              the volume of published verdicts about named addresses is still small. The page exists
              before the first entry for the same reason{" "}
              <Link href="/accuracy" className="doc-link">
                the accuracy ledger
              </Link>{" "}
              published its methodology before it had numbers &mdash; a log that appears only once
              there is something flattering to put in it is not a log.
            </p>
          </div>
        ) : (
          <div className="mt-6 divide-y divide-hair border-t border-brand-deep">
            {CORRECTIONS.map((entry) => (
              <div key={`${entry.date}-${entry.subject}`} className="py-5">
                <p className="text-[0.8125rem] text-brand-lift">{entry.date}</p>
                <p className="mt-1 break-all font-[family-name:var(--font-display)] font-semibold text-brand-deep">
                  {entry.subject}
                </p>
                <p className="mt-2 max-w-[64ch] text-brand">
                  <strong>What was wrong.</strong> {entry.wrong}
                </p>
                <p className="mt-2 max-w-[64ch] text-brand">
                  <strong>What changed.</strong> {entry.action}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* ===== 1b. 昇格（訂正ではない） ===== */}
        {ledgerPromotions.length > 0 && (
          <>
            <h2 className="sec-head">
              <span className="sec-no">1b.</span>
              <span>Ledger promotions — recorded here, but not corrections</span>
            </h2>
            <p className="doc-p">
              {ledgerPromotions.length.toLocaleString()} row
              {ledgerPromotions.length === 1 ? "" : "s"} where a purchase moved from{" "}
              <code>settle_claimed</code> (the seller asserted a settlement we had not re-read) to{" "}
              <code>settled</code> (we re-read it on-chain and found the transfer). That is the
              verification pipeline finishing its job on schedule, not vet402 publishing something
              untrue and taking it back. They are written to the same append-only log so the path
              from claim to confirmation is auditable, and they are listed separately here because
              counting them as corrections would inflate our own error count and bury the{" "}
              {verdictCorrections.length.toLocaleString()} entries above. Until 2026-09-04 this page
              called all {rows.length.toLocaleString()} of them &ldquo;machine-recorded
              corrections&rdquo; and drew every row as <code>— → —</code>, because a promotion
              carries a <code>status</code>, not a <code>publishedVerdict</code>.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="fact-table">
                <caption className="sr-only">
                  Ledger status promotions, newest first
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Recorded (UTC)</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Level</th>
                    <th scope="col">Before → after</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerPromotions.slice(0, 100).map((r) => (
                    <CorrectionTableRow key={r.id} row={r} names={names} />
                  ))}
                </tbody>
              </table>
            </div>
            {ledgerPromotions.length > 100 && (
              <p className="doc-note mt-3">
                Newest 100 of {ledgerPromotions.length.toLocaleString()} shown. The full set is at{" "}
                <code>/api/v1/observatory/corrections</code>.
              </p>
            )}
          </>
        )}

        {/* ===== 2. What gets logged ===== */}
        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>What lands here, and what does not</span>
        </h2>

        <div className="mt-6 space-y-5">
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">2.1</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              <strong>A fact we got wrong, and fixed.</strong> If we published something about an
              address that was not true &mdash; a mis-read signal, a mis-attributed wallet, a stale
              input treated as current &mdash; the correction and the re-score are logged, whether
              the challenge came from a customer or from a stranger.
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">2.2</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              <strong>Not: a score that moved on its own.</strong> Scores change constantly as
              on-chain behavior changes. That is the instrument working, not a correction, and
              logging it would bury the entries that matter.
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">2.3</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              <strong>Not: a disagreement we did not concede.</strong> A score is our opinion and
              sometimes we will disagree with the person challenging it. Those are answered
              directly, in writing, and are not corrections. The route stays open either way.
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">2.4</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              <strong>Data-protection requests are honored, not logged away.</strong> If an entry
              names an address that is personal data about you, you can ask us to erase it or to
              restrict it, and we weigh each request individually — the grounds and the process are
              in{" "}
              <Link href="/legal/privacy#scored-third-parties" className="doc-link">
                the privacy policy
              </Link>
              . Where a request is granted in part, the entry is restricted or annotated in place
              rather than silently deleted: the log keeps the fact that a correction was issued,
              without continuing to publish data we no longer have grounds to publish. Every entry
              here states what we verified, in factual terms and with its date; the log does not
              brand anyone a fraudster.
            </p>
          </div>
        </div>

        {/* ===== 3. How to get one ===== */}
        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>If you think a score about you is wrong</span>
        </h2>
        <p className="doc-p">
          You do not need an account, an API key, a payment, or a lawyer to challenge a score. Two
          routes, both free: prove control of the address by signing our canonical message and
          posting it to <code className="break-all text-brand-deep">/api/v1/payees/verify</code>, or
          write to{" "}
          <a className="doc-link" href={SUPPORT_MAILTO}>
            {SUPPORT_EMAIL}
          </a>{" "}
          with the address and what you think is wrong. One person reads that inbox and will
          acknowledge within 5 business days.{" "}
          <Link href="/legal/terms#corrections" className="doc-link">
            Section 8 of the Terms of Service
          </Link>{" "}
          is the full text of both.
        </p>

        <p className="mt-8 text-[0.8125rem]">
          <Link href="/accuracy" className="doc-link">
            Measured accuracy
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">
            ·
          </span>
          <Link href="/payee" className="doc-link">
            Verify a payee
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">
            ·
          </span>
          <Link href="/legal/terms#corrections" className="doc-link">
            Terms of Service, section 8
          </Link>
        </p>
      </article>
    </main>
  );
}
