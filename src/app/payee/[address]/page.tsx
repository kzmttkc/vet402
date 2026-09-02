import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { VerdictBadge } from "@/components/site/VerdictBadge";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { verifiedPayees } from "@/lib/db/schema";
import { isValidAddress } from "@/lib/chain/client";
import { scorePayeeWallet } from "@/lib/scoring/payee-engine";
import TrackView from "@/components/site/TrackView";
import FocusOnArrival from "@/components/site/FocusOnArrival";
import CodeBlock from "@/components/docs/CodeBlock";
import { getAddress } from "viem";
import { SITE_URL } from "@/lib/site-url";

/**
 * dataDepth の1行定義（2026-08-13 UX監査2巡目 [M6]）。
 * "data: thin" とだけ出していたので、読んだ人には thin が「素性が薄い」のか
 * 「こちらが読めていない」のか区別できなかった（後者は degraded という別の
 * 状態で、上の分岐が受け持っている）。閾値と重みは src/lib/scoring/payee-engine.ts
 * の determineDataDepth / l1DeliveryDepth / WEIGHTS_BY_DEPTH をそのまま写している。推測しない。
 * 2026-09-02: 観測所自身の配達確認（observed_purchases）は件数と日数で深さに効く
 * （買い手は常に vet402 なので「distinct payers」の条件は掛からない）。
 */
const DATA_DEPTH_NOTE: Record<string, string> = {
  thin: "fewer than 3 payments received, or from fewer than 2 distinct payers — and fewer than 3 vet402-verified deliveries over 2 or more days. Receiving history carries 15% of this score; wallet health and drain patterns carry the rest.",
  moderate:
    "at least 3 payments received from at least 2 distinct payers, or at least 3 vet402-verified deliveries over 2 or more days. Receiving history carries 35% of this score.",
  rich: "at least 10 payments received across 7 or more days from at least 3 distinct payers, or at least 10 vet402-verified deliveries across 7 or more days. Receiving history carries 50% of this score.",
};

// N-16 — public payee profile: verified identity claim + live payee score.
// The two-sided surface: spending agents check it, payees link it.
//
// NOT CACHED, ON PURPOSE (2026-08-13). This used to be `revalidate = 300`.
// The build has always classified the route as dynamic, so that number never
// actually took effect — but it stated an intent that contradicts the engine:
// scorePayeeWallet refuses to cache a verdict computed with an input it could
// not read, and tests/verdict-consistency.test.ts pins the rule that no
// surface may outlive the engine's own confidence in a verdict. A 300s ISR
// generation is exactly how /agent/[id] pinned one flap of a Blockscout
// outage for five minutes on 2026-08-12. The engine's own 5-minute in-process
// cache already absorbs the repeat cost for healthy verdicts, and it is the
// one cache that knows which verdicts are safe to keep.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  // 2026-08-14: openGraph/twitter/canonical を pageMetadata で個別化。
  return pageMetadata({
    title: `Payee ${address.slice(0, 10)}…`,
    description: "Verified x402 payee: signature-proven identity claim plus a live payee score.",
    path: `/payee/${address}`,
  });
}

export default async function PayeePage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  if (!isValidAddress(address)) notFound();
  const wallet = address.toLowerCase();
  // 表示用だけの正規化。isValidAddress は形だけを見るので getAddress が投げる
  // ことはないが、表示のために例外でページを落とす価値は無いので受けておく。
  let checksummed = wallet;
  try {
    checksummed = getAddress(wallet);
  } catch {
    checksummed = wallet;
  }

  const db = getDb();
  let entry: { name: string; url: string | null; verifiedAt: Date | null } | null = null;
  if (db) {
    try {
      const rows = await db
        .select()
        .from(verifiedPayees)
        .where(eq(verifiedPayees.wallet, wallet))
        .limit(1);
      if (rows[0]) entry = { name: rows[0].name, url: rows[0].url, verifiedAt: rows[0].verifiedAt };
    } catch {
      entry = null;
    }
  }

  let score: {
    value: number;
    recommendation: string;
    dataDepth: string;
    degraded: boolean;
    unavailable: string[];
    // 2026-08-13 UX監査R1 [A5]: エンジンは最初から scoredAt を返していて、
    // API の応答にも出ているのに、この公開ページだけが「いつ測ったか」を
    // 出していなかった。数字だけが置いてあると、それが今日の測定なのか
    // 3週間前のキャッシュなのかを読者は判定できない。
    scoredAt: string;
  } | null = null;
  try {
    const result = await scorePayeeWallet(wallet);
    score = {
      value: result.score,
      recommendation: result.recommendation,
      dataDepth: result.dataDepth,
      degraded: result.degraded,
      unavailable: result.signalsUnavailable,
      scoredAt: result.scoredAt,
    };
  } catch {
    score = null;
  }

  // 表示用。ISO のまま出すと秒とタイムゾーンで桁が伸びて、事実より書式が
  // 目立つ。UTC の「分」まで — 秒はこの頁の読者の判断を1つも変えない。
  const scoredAtLabel = score
    ? `${score.scoredAt.slice(0, 10)} ${score.scoredAt.slice(11, 16)} UTC`
    : null;

  // 2026-08-13: an incompletely measured score says so on the page, in the
  // same plain terms the API reports it. The engine's own field names are the
  // source — a hand-kept second list here would drift from what was actually
  // not read.
  const UNMEASURED_LABELS: Record<string, string> = {
    native_drain: "ETH outflow leg unmeasured",
    usdc_drain: "USDC outflow leg unmeasured",
    wallet_metrics: "wallet history unmeasured",
    outcome_history: "outcome history unmeasured",
  };
  const unmeasuredNote =
    score && !score.degraded && score.unavailable.length > 0
      ? score.unavailable.map((name) => UNMEASURED_LABELS[name] ?? name).join(" · ")
      : null;

  // 2026-08-06 growth: coarse score band for the payee_view event. The
  // recommendation is the product's own three-way banding (ALLOW/WARN/BLOCK),
  // so we map it instead of inventing new numeric thresholds that could
  // drift from the scoring engine. The wallet address is deliberately NOT a
  // prop — aggregating per-address in analytics is both a privacy smell and
  // useless (the URL path already exists in the automatic pageview).
  // 2026-08-13: `degraded` is its own band. Folding a fail-closed refusal into
  // "low" would make an upstream outage indistinguishable, in the funnel data,
  // from a genuinely bad wallet — and it was a BLOCK-shaped refusal that
  // produced the 88.2% false-positive figure on /accuracy.
  const band = !score
    ? "unavailable"
    : score.degraded
      ? "degraded"
      : score.recommendation === "ALLOW"
        ? "high"
        : score.recommendation === "WARN"
          ? "medium"
          : score.recommendation === "BLOCK"
            ? "low"
            : "unknown";

  // 2026-08-14 UX（プロ/YC/ベテランエンジニアの所見）: 同じアドレスに公開スコアが
  // 2つ出る（この payee エンジンと /leaderboard の agent/wallet エンジン）ため、
  // 買い手が最初に問う「このウォレットに支払っていいか」がノイズに埋もれていた。
  // 頁の頭にその一語の答え（Go / Caution / Stop）を最大字級で置き、数値の内訳と
  // 二エンジンの差は下の枠・折りたたみへ降ろす。degraded は判定ではなく計測不能
  // なので、名指しの告発になる BLOCK 語を出さず「保留(Hold)」に寄せる —— 下の
  // 枠の "Not verifiable right now" と同じ方針。
  const decision: { word: string; verdict: string | null; gloss: string } = !score
    ? {
        word: "Unavailable",
        verdict: null,
        gloss: "No score can be computed for this wallet right now.",
      }
    : score.degraded
      ? {
          word: "Hold",
          verdict: null,
          gloss:
            "A check could not be completed, so callers receive a fail-closed hold. This is not a finding against the wallet.",
        }
      : score.recommendation === "ALLOW"
        ? { word: "Go", verdict: "ALLOW", gloss: "Every check cleared. Clear to pay." }
        : score.recommendation === "WARN"
          ? {
              word: "Caution",
              verdict: "WARN",
              gloss:
                "Not cleared and not condemned. Decide deliberately rather than by default.",
            }
          : score.recommendation === "BLOCK"
            ? { word: "Stop", verdict: "BLOCK", gloss: "Adverse signals. Do not pay this wallet." }
            : {
                word: "Review",
                verdict: score.recommendation,
                gloss: "Read the signals below before paying.",
              };

  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Verify a payee", path: "/payee" },
    { name: `Payee ${checksummed.slice(0, 10)}…`, path: `/payee/${address}` },
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
        {/* payee_view: the two-sided loop's read side. referrer=external is the
            closest observable proxy for badge-embed inflow (the badge image on a
            payee's own site links here); the referring URL itself is never sent. */}
        <TrackView
          event="payee_view"
          props={{ band, verified: Boolean(entry) }}
          withReferrerType
        />
        {/* payee_scored: 買い手のコア価値到達＝金に一番近い段。payee_view は
            「頁に着いた」だけで、上流障害の fail-closed hold（degraded）や
            計算不能（score=null → band=unavailable）も含む。ここは実際に
            支払い判定（Go/Caution/Stop）が計算されて出た時だけ発火させ、
            ファネルの本命指標を頁到達から分離する。verdict は band を流用
            （high/medium/low）。events 数でなく visitors 数で意味を持つ。 */}
        {score && !score.degraded ? (
          <TrackView event="payee_scored" props={{ band, verified: Boolean(entry) }} />
        ) : null}

        <div className="doc-head">
          <div className="doc-head-col">
            <span>Verified Payee</span>
            <span>Subject: Base wallet</span>
            <span>
              {/* この頁のシアン1点。識別が済んでいるかどうかという事実。 */}
              Identity:{" "}
              <span className="text-signal">{entry ? "claimed and proven" : "unclaimed"}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            {/* 2026-08-13 UX監査2巡目 [M5]: ここは "Level: L0 identity claim" と
                書いていた。LP §2 の L0 は Liveness（エンドポイントが正しく答えるか）
                で、この頁の L0 とは別物 — 同じサイトに L0 の定義が2つあった。
                claim 側から L 記号を外し、事実語だけで何の記録かを言う。 */}
            <span>Claim: wallet control by signature</span>
            {/* 2026-08-13 UX監査R1 [A6]: 同じアドレスに公開スコアが2つ出る
                （この頁の payee エンジンと、/leaderboard の agent/wallet
                エンジン）。docs には「別エンジン」と書いてあったが、どちらの
                頁にもその表示が無かったので、読者からは同じ物差しの数字が
                食い違って見えた。どちらのエンジンかを書誌欄に出す。 */}
            <span>Engine: payee, computed on request</span>
          </div>
        </div>

        {/* 2026-08-13 UX監査2巡目 [m7]: 見出しは EIP-55 チェックサム表記で出す。
            DB のキーもバッジ URL も小文字のままで（照合は今までどおり）、人が
            読み比べる1箇所だけを大文字混じりの正規形にする。ウォレットの
            打ち間違いはチェックサムでしか目視検出できない。 */}
        {/* 2026-08-13 アクセシビリティ監査 [E3]: /payee のフォームから届いた時
            だけ、この見出しへフォーカスを移す（素の GET フォーム + サーバ
            redirect なので完全な再読込になり、フォーカスは BODY に落ちていた）。
            tabIndex={-1} は見出しを Tab 順に入れずにプログラム的なフォーカス先に
            するための標準の作法で、SiteChrome の #main-content と同じ。 */}
        {/* 2026-08-13 全盲ペルソナ監査 R2【イライラ級】: この h1 は 42 桁の生 hex
            1個だけだった。/payee のフォームから届いた読者はここにフォーカスが
            落ちるので、着地して最初に聞くのが大小混在の 42 文字で、自分が何の
            ページに居るのかが分からない。見えている面は変えずに、読み上げにだけ
            「何の頁のどのアドレスか」を前置きする。 */}
        <FocusOnArrival targetId="payee-subject" fromPathPrefix="/payee" />
        <h1
          id="payee-subject"
          tabIndex={-1}
          className="mt-10 break-all text-center text-[clamp(0.8125rem,2.6vw,1.125rem)] text-brand-deep"
        >
          <span className="sr-only">Payee verification result for wallet </span>
          {checksummed}
        </h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        {/* 2026-08-14 UX: 買い手の一語の答えを頁の頭・最大字級で。ALLOW/WARN/BLOCK
            と Go/Caution/Stop を並べ、判定バッジ（同製品唯一の判定表示体）を添える。
            数値・データの厚み・二エンジン差は下の枠へ降ろす。 */}
        <section aria-labelledby="pay-decision" className="mt-8">
          <p className="doc-caption">Should your agent pay this wallet?</p>
          <p
            id="pay-decision"
            className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-[family-name:var(--font-display)] text-[2rem] font-semibold leading-none text-brand-deep"
          >
            <span>{decision.word}</span>
            {decision.verdict ? (
              <VerdictBadge verdict={decision.verdict} className="align-middle" />
            ) : null}
          </p>
          <p className="doc-note mt-3 max-w-[60ch]">{decision.gloss}</p>
        </section>

        {entry ? (
          <div className="mt-8 border-l-[3px] border-emerald-700 bg-emerald-50 px-5 py-4">
            <p className="text-emerald-900">{entry.name}</p>
            <p className="mt-2 text-[0.8125rem] text-emerald-800">
              Control of this wallet was proven by signature
              {entry.verifiedAt ? ` on ${entry.verifiedAt.toISOString().slice(0, 10)}` : ""}.
              {entry.url ? (
                <>
                  {" "}
                  Site:{" "}
                  <a
                    href={entry.url}
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                    className="break-all underline"
                  >
                    {entry.url}
                  </a>
                </>
              ) : null}
            </p>
            <p className="mt-2 text-xs text-emerald-800">
              Verification proves wallet control only — it is not an endorsement, and the score
              below is computed independently of it.
            </p>
          </div>
        ) : (
          <p className="doc-p mt-8">
            This wallet has not registered a verified-payee profile.{" "}
            <span className="text-brand-lift">
              Own it? Claiming a payee is API-only — there is no in-browser form. POST a signed
              claim to{" "}
              <code className="break-all text-brand-deep">/api/v1/payees/verify</code> (free, no
              API key, signature required). See the{" "}
              <Link href="/docs/api#post-api-v1-payees-verify" className="doc-link">
                API reference
              </Link>
              .
            </span>
          </p>
        )}

        <div className="dashbox mt-8">
          <p className="doc-caption">Live payee score</p>
          {score?.degraded ? (
            // 2026-08-13: a degraded result is a refusal, not a reading. The
            // API and the SDK still receive BLOCK — "do not pay this wallet
            // right now" is the correct answer to a caller about to move money
            // when a check could not be completed. But this page is read by
            // humans, and printing "39 BLOCK" here would publish a specific
            // accusation about a named wallet on the strength of an upstream
            // outage, on a site whose masthead is "Nothing on this site is an
            // estimate." So the page says the one true thing instead.
            <>
              {/* 2026-08-13 全盲ペルソナ監査 R2【イライラ級】: 肝心の判定が
                  ただの <p> だったので、この頁の見出しは h1（生アドレス）1個きり
                  だった。見出しジャンプで結論に届かず、毎回全文を矢印で流すしか
                  なかった。判定行そのものを h2 にする（組版クラスは据え置き。
                  Tailwind の preflight が見出しの既定字級・余白を潰しているので、
                  要素名を変えても紙面は1px も動かない）。 */}
              <h2 className="mt-3 font-[family-name:var(--font-display)] text-[1.375rem] font-semibold leading-tight text-brand-deep">
                Not verifiable right now
              </h2>
              <p className="mt-2 text-[0.8125rem] text-brand-lift">
                One or more upstream checks could not be completed, so no score is published for
                this wallet. This is not a finding against it. Callers of the API receive a
                fail-closed <code className="text-brand-deep">BLOCK</code> until the checks
                succeed.
              </p>
            </>
          ) : score ? (
          <>
          {/* 2026-08-06 a11y (keyboard+screen-reader persona audit L5): the verdict
          // word used to be separated from the data-depth note by nothing but a
          // visual `ml-2` margin, so innerText read "37 BLOCKdata: thin" and the
          // verdict — the single most important word on this public, unauthenticated
          // page — was announced glued to the next string as "BLOCKdata".
          // Two fixes, both needed: real whitespace between the two elements, and
          // an explicit accessible name so "37" is not heard without its scale.
              The role="img" + aria-label shape is deliberately the same one the
              homepage gauge already uses ("Trust score 78 out of 100"). */}
            {/* 2026-08-13 UX監査2巡目 [M6]: 尺度が読み上げにしか無かった。
                aria-label は "out of 100" と言っているのに、目で見える面には
                裸の 37 しか出ていない — 100点満点なのか1000点満点なのかが
                視認面から分からない状態だった。"/ 100" を字面にも出す。 */}
            {/* 2026-08-13 全盲ペルソナ監査 R2【イライラ級】: 判定行を h2 へ。
                見出し名は内側の role="img" の aria-label から算出されるので、
                見出しジャンプで聞こえるのは
                "Trust score 37 out of 100, recommendation BLOCK" ——
                結論だけで自足する1行になる。 */}
            <h2 className="mt-3 font-[family-name:var(--font-display)] text-[1.75rem] font-semibold leading-none text-brand-deep">
              <span
                role="img"
                aria-label={`Trust score ${score.value} out of 100, recommendation ${score.recommendation}`}
              >
                {score.value}
                <span className="align-baseline text-[0.9375rem] font-normal text-brand-lift">
                  {" "}
                  / 100
                </span>{" "}
                <VerdictBadge verdict={score.recommendation} className="align-middle" />
              </span>
            </h2>
            {/* データの厚みは「判定」ではなく「どれだけ材料があったか」なので、
                判定行から降ろして自分の1行にした。thin/moderate/rich の閾値は
                エンジン側の determineDataDepth と同じものを写している。 */}
            <p className="mt-3 text-[0.8125rem] text-brand-lift">
              <span className="text-brand-deep">data: {score.dataDepth}</span>
              {DATA_DEPTH_NOTE[score.dataDepth] ? ` — ${DATA_DEPTH_NOTE[score.dataDepth]}` : null}{" "}
              <Link href="/docs/api#payee-score" className="doc-link">
                Score breakdown
              </Link>
              .
            </p>
            {unmeasuredNote ? (
              // Partial measurement, disclosed rather than absorbed. The score
              // above is backed by the legs that DID answer, and is capped
              // below ALLOW precisely because this line is here.
              <p className="mt-2 border-l-[3px] border-amber-600 bg-amber-50 px-3 py-2 text-[0.8125rem] text-amber-900">
                Partial measurement — {unmeasuredNote} (upstream outage). The score above reflects
                only the checks that completed and is capped below ALLOW until the rest can be
                read.
              </p>
            ) : null}
          </>
          ) : (
            // 判定が出せなかった時も、見出しの並びに穴を空けない。
            <h2 className="mt-3 text-brand-lift">Score unavailable right now.</h2>
          )}
          {/* 2026-08-13 UX監査R1 [A5][A6]: 測定時刻とエンジン名を、数字と同じ
              囲みの中に置く。「いつ・どの物差しで」が数字から離れると、離れた
              ぶんだけ読者は数字だけを持ち出す。 */}
          {scoredAtLabel ? (
            <p className="doc-note mt-4">
              Payee engine, computed on this request at{" "}
              <span className="text-brand-deep">{scoredAtLabel}</span>.
            </p>
          ) : null}
          {/* 2026-08-14 UX: 同一アドレスに数字が2つ出る理由は、支払うか否かの判断に
              要らない補足なので折りたたむ（プロ複数が「2スコアで混乱」と所見）。
              頁の頭の一語の答えを主役にし、内訳の差はここで開けば読める。 */}
          {scoredAtLabel ? (
            <details className="doc-note mt-2">
              <summary className="doc-link cursor-pointer">
                Why /leaderboard may show a different number
              </summary>
              <p className="mt-2 max-w-[60ch]">
                This page runs the payee engine (&ldquo;should my agent pay this wallet?&rdquo;). The
                register at{" "}
                <Link href="/leaderboard" className="doc-link">
                  /leaderboard
                </Link>{" "}
                runs the agent/wallet engine, so it can carry a different number for the same
                address. Neither is stale &mdash; they answer different questions.
              </p>
            </details>
          ) : null}
          <p className="doc-note mt-4">
            {/* 2026-08-06 a11y (WCAG 2.4.4): the link text used to be the bare
                path "/accuracy", which reads as "slash accuracy" in a screen
                reader's link list. The descriptive phrase is now the link. */}
            <Link href="/accuracy" className="doc-link">
              Methodology and measured accuracy
            </Link>
            .
          </p>
          {/* 2026-08-13 UX監査R1 [C7]: この頁は名指しのアドレスについて数字を
              公開している当の場所なのに、異議申立の入口が無かった（唯一の記述は
              ToS §8＝全文の27%地点）。文言は ToS §8 の見出しをそのまま使う。 */}
          <p className="doc-note mt-2">
            <Link href="/legal/terms#corrections" className="doc-link">
              Think this score is wrong?
            </Link>{" "}
            Two free routes, no account needed. Corrections we issue are listed in the{" "}
            <Link href="/corrections" className="doc-link">
              corrections log
            </Link>
            .
          </p>
        </div>

        {/* 2026-08-13 UX監査2巡目 [m6]: バッジは「あなたのサイトへ貼れる」ことが
            価値なのに、これまで置いていたのは裸のパス1本（/api/badge/0x…）で、
            貼るための <img> は読者が自分で書く必要があった。docs と同じ
            CodeBlock を使ってコピーボタン付きで丸ごと渡す。URL は絶対 URL で
            なければ他所のサイトで壊れるので SITE_URL から組む。.svg 付きなのは
            拡張子で判断する埋め込み先（GitHub の README 等）があるため — ルートは
            末尾の .svg を落としてから照合する。 */}
        <div className="dashbox mt-8">
          <p className="doc-caption">Badge for your site</p>
          <p className="mt-3 text-[0.8125rem] text-brand-lift">
            The badge reports whether a signed claim exists for this wallet. It carries no score
            &mdash; a cached number on someone else&apos;s page would outlive its freshness window.
          </p>
          <CodeBlock
            className="mt-3"
            label="Badge embed snippet for this payee"
            code={`<a href="${SITE_URL}/payee/${wallet}">
  <img src="${SITE_URL}/api/badge/${wallet}.svg" alt="vet402 verified payee" height="24">
</a>`}
          />
        </div>

        <p className="mt-8 text-[0.8125rem]">
          <Link href="/payee" className="doc-link">
            Verify another payee
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/docs/api" className="doc-link">
            API reference
          </Link>
        </p>
      </article>
    </main>
  );
}
