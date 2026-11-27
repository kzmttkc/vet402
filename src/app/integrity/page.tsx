// ============================================================
// /integrity（2026-11-27 堀の作業 F9・オーナー承認「F9 規約文 OK」2026-11-27 13:18 JST）。
//
// WHY: vet402 が自分に課している決まりは methodology §8・corrections・llms.txt・
// docs/response-signatures.md に散っていた。1 頁に集め、各項目に裏付け（公開頁か
// コード）を並べる。新しい約束は作らない。ここに書く物は実装と公開頁に既にある物だけ。
//
// 失敗の帰属の表は src/lib/sellers/fix-modes.ts の BUCKET_DOCS（判定の規則の文・llms.txt・
// openapi の元）をそのまま読む。手で写さない。判定の版は DECISION_RULES_VERSION。
//
// 法的な線（legal-check 2026-11-27）: この頁は利用規約を変えない・足さないと明記し、
// 食い違えば利用規約が優先と書く。返金・補償・SLA は書かない。保証・必ず・完全は使わない。
// 公開の英語の決まり: we を使わない・句読点のダッシュを使わない。
// ============================================================
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { TableScroll } from "@/components/site/TableScroll";
import {
  ATTRIBUTION_REVIEW_NOTE,
  BUCKET_DOCS,
  SELLER_CONFIRM_DAYS,
  type Bucket,
} from "@/lib/sellers/fix-modes";
import { DECISION_RULES_VERSION } from "@/lib/decision/rules";
import { METHOD_LIMIT_TEXT, VERDICT_DOCS } from "@/lib/decision/rules-text";
import { L1_CLIENT } from "@/lib/evidence/publishable";

const PATH = "/integrity";
const REPO = "https://github.com/vet402/vet402/blob/main";

/** L1 の購入が名乗る User-Agent（l1-runner.ts の user-agent ヘッダと同じ。tests/integrity-page.test.ts が固定）。 */
export const L1_USER_AGENT = `${L1_CLIENT} (+https://vet402.com/observatory/methodology)`;

/** vet402 がしないこと（llms.txt 冒頭の段落と同じ文。tests/integrity-page.test.ts が固定）。 */
export const DOES_NOT_TEXT = "vet402 does not insure a payment, hold customer funds, or refund a failed one.";

export const metadata: Metadata = pageMetadata({
  title: "vet402 Integrity Terms and failure attribution",
  description:
    "The rules vet402 holds itself to, each with where it is implemented, how one purchase is sorted into delivered, pending, seller, vet402, unsorted or not_bought, and what vet402 does not do.",
  path: PATH,
});

export const revalidate = 86400;

type Term = { id: string; title: string; text: string; sources: readonly { label: string; href: string }[] };

const TERMS: readonly Term[] = [
  {
    id: "no-paid-results",
    title: "A result is not for sale",
    text: "No operator gets a different measurement, a suppressed result, or a softer word for the same finding. Partners are told this is not for sale, and being bought from more often is not for sale either. A decision is computed from the recorded measurements and the published rules.",
    sources: [
      { label: "Methodology §8", href: "/observatory/methodology" },
      { label: "Design Partners §1", href: "/partners" },
      { label: "src/lib/decision/rules.ts", href: `${REPO}/src/lib/decision/rules.ts` },
    ],
  },
  {
    id: "published-rules",
    title: "Decisions follow the published rules",
    text: `Every decision carries rules_version (now ${DECISION_RULES_VERSION}). The full text of those rules is published in llms.txt, and every reason code is listed with its effect. The rules text is built from the same constants the code applies, and scripts/gen-rules-text.ts writes it into llms.txt.`,
    sources: [
      { label: "Reason codes", href: "/docs/api#reason-codes" },
      { label: "llms.txt", href: "/llms.txt" },
      { label: "src/lib/decision/rules-text.ts", href: `${REPO}/src/lib/decision/rules-text.ts` },
    ],
  },
  {
    id: "user-agent",
    title: "vet402 buys under its own name",
    text: `Every paid purchase carries the User-Agent ${L1_USER_AGENT}. There is no rotation and no attempt to look like an ordinary buyer. ${METHOD_LIMIT_TEXT}`,
    sources: [
      { label: "Methodology", href: "/observatory/methodology" },
      { label: "src/lib/observatory/l1-runner.ts", href: `${REPO}/src/lib/observatory/l1-runner.ts` },
    ],
  },
  {
    id: "corrections",
    title: "Changes are recorded, not hidden",
    text: "vet402 does not silently edit or remove a published result to look better. A correction is published with what was wrong and what changed. A purchase row that is held is kept in the ledger export with its held_reason, not removed. No code path deletes or edits rows of the correction log, though the table is not write protected against vet402 itself. Verified data protection requests are handled as the corrections page describes.",
    sources: [
      { label: "/corrections", href: "/corrections" },
      { label: "Corrections JSON", href: "/api/v1/observatory/corrections" },
      { label: "src/lib/observatory/delivery.ts", href: `${REPO}/src/lib/observatory/delivery.ts` },
    ],
  },
  {
    id: "anchors",
    title: "Sealed days are anchored on Base",
    text: "Each sealed day's root of the ledger is written to Base as a transaction from one signer, with calldata vet402-anchor:v1:<day>:<root>. A root that changes after its anchor no longer matches Base. The anchors API can recompute a day from the current rows and reports a mismatch if there is one.",
    sources: [
      { label: "Methodology: anchors", href: "/observatory/methodology#anchors" },
      { label: "Anchors JSON", href: "/api/v1/observatory/anchors" },
      { label: "Recompute a day", href: "/api/v1/observatory/anchors/day?day=2026-11-25&view=current" },
    ],
  },
  {
    id: "signatures",
    title: "Responses are signed with Ed25519",
    text: "Selected JSON responses carry a Vet402-Signature header, an Ed25519 signature over the path, a timestamp and the body. The signed routes are /api/v1/check, /api/v1/decision, /api/v1/find, /api/v1/observatory/state, /api/v1/observatory/anchors and /api/v1/delivery/sellers.json. The public key is published, so a third party can check later that a body came from vet402's key.",
    sources: [
      { label: "Signature spec", href: `${REPO}/docs/response-signatures.md` },
      { label: "Public keys", href: "/.well-known/vet402-keys.json" },
    ],
  },
];

/** 区分の順（fix-modes.ts の Bucket と同じ 6 つ）と「売り手に対して数えるか」。条件の文は BUCKET_DOCS から読む。 */
const BUCKET_ROWS: readonly { bucket: Bucket; counts: string }[] = [
  { bucket: "delivered", counts: "Counts for the seller" },
  { bucket: "pending", counts: "Neither way, until it is known whether money moved" },
  { bucket: "seller", counts: "Counts against the seller" },
  { bucket: "vet402", counts: "Neither way. The failure is vet402's" },
  { bucket: "unsorted", counts: "Neither way" },
  { bucket: "not_bought", counts: "Neither way. It is not a purchase result" },
];

/** BUCKET_DOCS の「name (条件)」から条件だけを取り出す。 */
function conditionOf(bucket: Bucket): string {
  const doc = BUCKET_DOCS[bucket];
  const head = `${bucket} (`;
  return doc.startsWith(head) && doc.endsWith(")") ? doc.slice(head.length, -1) : doc;
}

export default async function IntegrityPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Integrity Terms", path: PATH },
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
        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Integrity Terms</span>
            <span>Rules {DECISION_RULES_VERSION}</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>Each term links to its source</span>
            <span>Failure attribution</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">Integrity Terms</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            A buyer relies on vet402 to say what a seller delivered. That is worth relying on when vet402 is held to rules a reader
            can check. This page lists those rules, each next to the page or the code where it is implemented, and shows
            how one purchase is sorted and which outcomes count against a seller. It describes how vet402 runs. It does
            not add to or change the{" "}
            <Link href="/legal/terms" className="underline">
              Terms of Service
            </Link>
            , and where the two differ, the Terms of Service apply.
          </p>
        </div>

        <h2 className="sec-head" id="terms">
          <span className="sec-no">1.</span>
          <span>Integrity Terms</span>
        </h2>
        <ol className="space-y-6">
          {TERMS.map((t, i) => (
            <li key={t.id} id={t.id}>
              <h3 className="doc-p font-semibold">
                1.{i + 1} {t.title}
              </h3>
              <p className="doc-p">{t.text}</p>
              <p className="doc-note">
                Source:{" "}
                {t.sources.map((s, j) => (
                  <span key={s.href}>
                    {j > 0 ? " · " : ""}
                    {s.href.startsWith("/") && !s.href.startsWith("/api") && !s.href.startsWith("/.well-known") && !s.href.endsWith(".txt") ? (
                      <Link href={s.href} className="doc-link">
                        {s.label}
                      </Link>
                    ) : (
                      <a href={s.href} className="doc-link">
                        {s.label}
                      </a>
                    )}
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ol>

        <h2 className="sec-head" id="attribution">
          <span className="sec-no">2.</span>
          <span>Failure attribution</span>
        </h2>
        <p className="doc-p">
          Each purchase row is sorted by one function into one of six outcomes. The decision API, /sellers and
          /api/v1/sellers/export.csv read the same result. An attempt counts for or against the seller only when it
          delivered or is on the seller&apos;s side. A failure goes on the seller&apos;s side only when the row itself
          shows vet402 was not at fault, and only once such a failure was seen at the listing on {SELLER_CONFIRM_DAYS}{" "}
          or more different UTC days. The conditions below are the same text as the published rules ({DECISION_RULES_VERSION}).
        </p>
        <TableScroll label="Outcomes of one purchase">
          <table className="fact-table">
            <caption className="sr-only">Outcomes of one purchase and whether each counts against the seller</caption>
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">When</th>
                <th scope="col">Counts against the seller?</th>
              </tr>
            </thead>
            <tbody>
              {BUCKET_ROWS.map((r) => (
                <tr key={r.bucket} id={`outcome-${r.bucket}`}>
                  <td>
                    <code>{r.bucket}</code>
                  </td>
                  <td>{conditionOf(r.bucket)}</td>
                  <td>{r.counts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <p className="doc-p">
          An outcome that counts neither way can still keep a check from ALLOW. WARN means: {VERDICT_DOCS.WARN}
        </p>
        <p className="doc-p">{ATTRIBUTION_REVIEW_NOTE}</p>
        <p className="doc-note">
          Source:{" "}
          <a href={`${REPO}/src/lib/sellers/fix-modes.ts`} className="doc-link">
            src/lib/sellers/fix-modes.ts
          </a>{" "}
          ·{" "}
          <a href={`${REPO}/src/lib/observatory/delivery.ts`} className="doc-link">
            src/lib/observatory/delivery.ts
          </a>{" "}
          ·{" "}
          <Link href="/observatory/methodology#whose-side" className="doc-link">
            Methodology: whose side
          </Link>
        </p>

        <h2 className="sec-head" id="does-not">
          <span className="sec-no">3.</span>
          <span>What vet402 does not do</span>
        </h2>
        <p className="doc-p">
          {DOES_NOT_TEXT} ALLOW, WARN and BLOCK are recommendations to the customer who asked. vet402 does not accept,
          refuse, delay or reverse anyone&apos;s payment. An ALLOW is the fact that the terms vet402 paid were delivered,
          not a promise about a different recipient or a higher price.
        </p>
        <p className="doc-note">
          Source:{" "}
          <Link href="/legal/terms" className="doc-link">
            Terms of Service §6
          </Link>{" "}
          ·{" "}
          <a href="/llms.txt" className="doc-link">
            llms.txt
          </a>
        </p>

        <p className="doc-p">
          Related:{" "}
          <Link href="/observatory/methodology" className="doc-link">
            Methodology
          </Link>{" "}
          ·{" "}
          <Link href="/corrections" className="doc-link">
            Corrections
          </Link>{" "}
          ·{" "}
          <Link href="/x402/glossary" className="doc-link">
            Glossary
          </Link>
        </p>
      </article>
    </main>
  );
}
