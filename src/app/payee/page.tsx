import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { isValidAddress } from "@/lib/chain/client";
import TrackView from "@/components/site/TrackView";
import { buttonClass } from "@/components/ui/Button";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { safeJsonLd } from "@/lib/util/json-ld";

/**
 * /payee — the entry point for the working demo.
 *
 * 2026-08-13: this route did not exist. `/payee/[address]` was reachable only
 * if you already had an address to type into the URL bar, so the one live,
 * public, no-account-needed surface the product has had no front door — and the
 * approved LP pins a "Verify a payee now" CTA to exactly this path.
 *
 * The form is a plain GET with `action="/payee"`, so it submits and lands on a
 * profile with JavaScript disabled — same discipline as the rest of the public
 * surface. The redirect happens on the server, from the query string.
 */

/**
 * 試せる実アドレス（2026-08-13 UX監査R1 [C3]）。
 *
 * 出典は src/lib/benchmark/dataset.ts の KNOWN_GOOD — 公開情報で帰属が判明
 * している、長く動いているアドレス。3件に絞っているのは、入口の紙面で
 * 一覧を作るのが目的ではなく「1つ踏めば製品が見える」ことが目的だから。
 * 説明文は dataset.ts の source / reason をそのまま短くしたもので、
 * 新しい主張は足していない。
 */
const SAMPLE_PAYEES = [
  {
    address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
    note: "ENS primary name on-chain: vitalik.eth",
  },
  {
    address: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
    note: "Ethereum Foundation, publicly documented since 2015",
  },
  {
    address: "0xf977814e90da44bfa03b6295a0616a897441acec",
    note: "Binance cold wallet, from their 2022 proof-of-reserves disclosure",
  },
];

export const metadata: Metadata = pageMetadata({
  title: "Verify a payee",
  description:
    "Look up any Base wallet address: the signature-proven identity claim on file, if there is one, and a live payee score.",
  path: "/payee",
});

export default async function PayeeIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ address?: string | string[] }>;
}) {
  const rawParam = (await searchParams).address;
  const raw = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  const submitted = raw?.trim() ?? "";

  if (submitted && isValidAddress(submitted)) {
    redirect(`/payee/${submitted.toLowerCase()}`);
  }

  // 2026-08-13 全盲ペルソナ監査 R2【イライラ級】: 空のまま送信すると `?address=`
  // へ遷移するだけで、フォーカスは BODY・role="alert" 無し・aria-invalid 無し。
  // 「何も起きなかったのか処理されたのか」が判別できない完全な無音だった。
  // 無効値の側（42文字必要／あなたは14文字）は既に十分なので、空だけ同じ水準へ
  // 揃える。`raw !== undefined` は「フォームから戻ってきた」ことを意味する
  // ——初回訪問には address パラメータ自体が無い。
  const attempted = raw !== undefined;
  const empty = attempted && submitted.length === 0;
  const invalid = submitted.length > 0;
  const errored = empty || invalid;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const howTo = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "Look up a payee on vet402",
    description:
      "Look up any Base wallet address: the signature-proven identity claim on file, if there is one, and a live payee score. No account required.",
    url: `${SITE_URL}/payee`,
    step: [
      {
        "@type": "HowToStep",
        position: 1,
        name: "Open the payee lookup",
        text: "Go to https://vet402.com/payee. No account or API key is required.",
      },
      {
        "@type": "HowToStep",
        position: 2,
        name: "Enter a wallet address",
        text: "Paste a 0x-prefixed address and submit the form. Invalid input stays on this page with an error.",
      },
      {
        "@type": "HowToStep",
        position: 3,
        name: "Read the claim and the score",
        text: "The profile shows whether a signed wallet-control claim exists, and the live payee score. A score is informational, not a guarantee.",
      },
    ],
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Verify a payee", path: "/payee" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <TrackView event="payee_lookup_view" />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(howTo) }}
      />
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Address control verified</span>
            {/* 2026-08-13 [M5]: "Level: L0 identity claim" をやめた。LP §2 の
                L0 は Liveness で、同じ記号が別の意味で2箇所にあった。 */}
            <span>Claim: wallet control by signature</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              {/* この頁のシアン1点。鍵が要らないという事実。 */}
              Access: <span className="text-signal">no account required</span>
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-8">Verify a payee</h1>
        <p className="mx-auto mt-3 max-w-[56ch] text-center text-brand-lift">
          Who controls this wallet, and what did the record say the last time we looked?
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <form method="get" action="/payee" className="mt-10">
          <label htmlFor="address" className="doc-caption block">
            Base wallet address
          </label>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <input
              id="address"
              name="address"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              defaultValue={submitted}
              placeholder="0x0000000000000000000000000000000000000000"
              aria-describedby={errored ? "address-error" : "address-hint"}
              aria-invalid={errored || undefined}
              // 2026-08-13 全盲ペルソナ監査 R2: 空送信をブラウザ側でも止める。
              // 制約検証は JS 無しでも効くので、この頁の「JS を足さない」方針を
              // 崩さずに、無音の遷移そのものを起こさせない。下の empty 分岐は
              // それでも `?address=` に着地した場合（直リンク・古いブックマーク）
              // の受け皿として残す。
              required
              // 2026-08-13 アクセシビリティ監査 [E3]: バリデーション失敗後、
              // document.activeElement が BODY に落ちていた。role="alert" で
              // 読み上げは出るのに、直す対象の入力欄まではヘッダから Tab を
              // 打ち直すしかない。JS を足さずに済ませるため、失敗して再描画
              // された時だけ autofocus を付ける（正常時は付かないので、
              // 初回訪問でモバイルのキーボードが勝手に開くことはない）。
              autoFocus={errored}
              // 枠線は brand-lift (#55688c・白地 5.61:1)。入力欄の唯一の境界表現
              // なので WCAG 1.4.11 の 3:1 が要る（2026-08-12 の是正と同じ理由）。
              className="doc-input min-w-0 flex-1"
            />
            <button type="submit" className={buttonClass({ size: "md", className: "shrink-0" })}>
              Verify
            </button>
          </div>

          {empty ? (
            <p id="address-error" role="alert" className="mt-3 text-[0.8125rem] text-brand-deep">
              Nothing was submitted &mdash; the address field was empty. Enter a Base address:{" "}
              <code>0x</code> followed by 40 hexadecimal characters, 42 characters in total. The
              field is focused, or pick one of the examples below.
            </p>
          ) : invalid ? (
            <p id="address-error" role="alert" className="mt-3 text-[0.8125rem] text-brand-deep">
              That is not a Base address. An address is <code>0x</code> followed by 40 hexadecimal
              characters &mdash; 42 characters in total. You entered {submitted.length}.
            </p>
          ) : (
            <p id="address-hint" className="doc-note mt-3">
              Any Base address works. Nothing is stored by looking one up.
            </p>
          )}
        </form>

        {/* 2026-08-13 UX監査R1 [C3]: この画面はウォレットを持っていない読者には
            行き止まりだった — 空欄と Verify ボタンだけで、試せるアドレスが1つも
            無い。皮肉なことに、でたらめを入れてエラーを出した先の画面にだけ
            実例（0x + 40桁）と説明が出ていた。踏める実アドレスを最初から置く。
            アドレスは src/lib/benchmark/dataset.ts の known-good エントリ
            （公開情報で帰属が判明しているもの）で、順位表にも同じものが載る。 */}
        <div className="dashbox mt-6">
          {/* .doc-caption は line-height:1 なので、375px で2行に折れると行が
              重なって見える。1行に収まる長さにしてある。 */}
          <p className="doc-caption">Try one of these</p>
          <ul className="mt-3 space-y-2 text-[0.8125rem]">
            {SAMPLE_PAYEES.map((sample) => (
              <li key={sample.address} className="flex flex-col gap-0.5">
                <Link href={`/payee/${sample.address}`} className="doc-link break-all">
                  {sample.address}
                </Link>
                <span className="text-brand-lift">{sample.note}</span>
              </li>
            ))}
          </ul>
          <p className="doc-note mt-4">
            These are publicly attributed addresses from our own benchmark set, not customer
            traffic.{" "}
            <Link href="/leaderboard" className="doc-link">
              The register of recently verified subjects
            </Link>{" "}
            lists every address we have scored in the last 30 days.
          </p>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>What the page reports</span>
        </h2>
        <div className="mt-6 space-y-5">
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">1.1</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              <strong>The identity claim, if one exists.</strong> A payee proves control of the
              wallet by signing a message. Verification proves control and nothing else &mdash; it
              is not an endorsement.
            </p>
          </div>
          <div className="flex gap-4">
            <span className="w-[4ch] shrink-0 text-brand-lift">1.2</span>
            <p className="min-w-0 max-w-[64ch] text-brand">
              <strong>A live score, computed on the request.</strong> Read from public on-chain
              state, and computed independently of whether an identity claim was filed.
            </p>
          </div>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Claiming a wallet you control</span>
        </h2>
        <p className="doc-p">
          POST a signed claim to <code className="text-brand-deep">/api/v1/payees/verify</code>.
          Free, no API key, signature required. The result is a public page at{" "}
          <code className="break-all text-brand-deep">/payee/&lt;address&gt;</code> and an SVG badge
          you can embed.
        </p>
        <p className="mt-6">
          <Link href="/docs/api" className="doc-link">
            API reference
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/observatory" className="doc-link">
            Catalog measurements
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/accuracy" className="doc-link">
            Score accuracy ledger
          </Link>
        </p>
      </article>
    </main>
  );
}
