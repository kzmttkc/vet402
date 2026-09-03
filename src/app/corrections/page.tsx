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
      "endpoints with a probe in the last 7 days. We also raised the cadence: that share is 68.8% of 15,312 " +
      "active endpoints as of 2026-09-04. An independent observatory, probe402, published the same finding " +
      "on 2026-09-03 from a 2026-09-01 reading. Their reading was correct.",
  },
];

export default async function CorrectionsPage() {
  // 2026-09-02: §10 の訂正ログ（correction_log）はここで公開する。9/2 に path_template の
  // 訂正 12 件が入ったのに、この頁は手書きの定数だけを見て「0 件」と言っていた。
  const rows: CorrectionRow[] = await listCorrections({ limit: 500 }).catch(() => []);
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
              {/* この頁のシアン1点。発行済みの件数という事実。 */}
              Entries: <span className="text-signal">{CORRECTIONS.length}</span>
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

        {rows.length > 0 && (
          <>
            <p className="doc-p">
              {rows.length.toLocaleString()} machine-recorded correction{rows.length === 1 ? "" : "s"} to
              published observatory verdicts (product spec §10). Newest first. The same rows are served
              at <code>/api/v1/observatory/corrections</code>.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="fact-table">
                <caption className="sr-only">Machine-recorded corrections, newest first</caption>
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
                  {rows.map((r) => {
                    const before = (r.before as { publishedVerdict?: string } | null)?.publishedVerdict ?? "—";
                    const after = (r.after as { publishedVerdict?: string } | null)?.publishedVerdict ?? "—";
                    const name = names.get(r.subject_id) ?? r.subject_id.slice(0, 8);
                    return (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap">{r.created_at.slice(0, 16).replace("T", " ")}</td>
                        <td className="max-w-[24rem] truncate">
                          {r.subject_type === "endpoint" ? (
                            <Link href={`/observatory/e/${r.subject_id}`} className="underline" title={name}>
                              {name}
                            </Link>
                          ) : (
                            name
                          )}
                        </td>
                        <td>{r.level}</td>
                        <td className="whitespace-nowrap">
                          {before} → {after}
                        </td>
                        <td>{r.reason}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {CORRECTIONS.length === 0 && rows.length === 0 ? (
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
