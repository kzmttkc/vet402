"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { markDashboardAuthenticated } from "@/lib/dashboard/client";
import { dashboardErrorMessage } from "@/lib/dashboard/errors";
import { track } from "@/lib/analytics";
import { signupAction, type SignupState } from "./actions";
import { buttonClass } from "@/components/ui/Button";
import CodeBlock from "@/components/docs/CodeBlock";
import { SITE_URL } from "@/lib/site-url";

// 2026-08-06 growth: failure-reason allowlist for the signup_failed event.
// PII guard — analytics props must never carry user input (email/name/invite
// code). The API's error codes are all fixed snake_case constants (measured
// in src/lib/dashboard/signup-core.ts), and anything unrecognized maps to "other".
const KNOWN_SIGNUP_FAILURE_REASONS = new Set([
  "invalid_origin",
  "rate_limit_exceeded",
  "invalid_request",
  "invalid_invite_code",
  "email_already_registered",
  "database_unavailable",
  "signup_failed",
  "please_accept_the_terms_and_privacy_policy",
]);

function signupFailureReason(code: unknown): string {
  return typeof code === "string" && KNOWN_SIGNUP_FAILURE_REASONS.has(code)
    ? code
    : "other";
}

const INITIAL_STATE: SignupState = { status: "idle" };

/**
 * 制約検証に落ちた入力欄を、その欄の言葉で説明する（2026-08-13 全盲ペルソナ監査 R2）。
 *
 * ブラウザ既定の validationMessage（"このチェックボックスをオンにしてください"）でも
 * 内容は正しいが、ネイティブの吹き出しは (1) 数秒で消える (2) 次のキー入力で消える
 * (3) 読み上げの実装がブラウザごとに割れている、の3点で当てにできない。
 * 同じ内容を role="alert" の中へ自前で出し、フォーカスをその欄へ落とす。
 */
function invalidFieldMessage(field: HTMLInputElement): string {
  if (field.name === "acceptedTerms") {
    return "You need to agree to the Terms of Service and the Privacy Policy before an account can be created. The checkbox is now focused — press Space to tick it.";
  }
  if (field.name === "email") {
    return field.validity.valueMissing
      ? "Enter the email address the API key should be tied to. The email field is now focused."
      : "That is not an email address we can send to — it needs an @ and a domain, like you@example.com. The email field is now focused.";
  }
  if (field.name === "inviteCode") {
    return "Enter the invite code you were given. The invite code field is now focused.";
  }
  // 将来ここに欄が増えた時に無言にならないための受け皿。ブラウザの文面をそのまま出す。
  return field.validationMessage || "Something in this form is not filled in correctly.";
}

const SAMPLE_WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

export default function SignupPage() {
  const [inviteCode, setInviteCode] = useState("");
  const [inviteRequired, setInviteRequired] = useState(false);
  // 2026-08-06 (L5 legal review): explicit clickwrap consent — an unticked-by-
  // default checkbox that blocks submission is the form courts uphold. The
  // `required` attribute gates the native (no-JS) submit and the Server Action
  // re-checks server-side.
  //
  // 2026-08-13 全盲ペルソナ監査 R2【離脱級】: この state は以前 submit ボタンの
  // `disabled` を駆動していた。disabled なボタンはフォーカス不能で AX ツリーにも
  // 出ないので、**この製品で唯一お金に繋がる段が、スクリーンリーダ利用者の世界
  // からは存在しないページ**になっていた。しかも HTML の暗黙送信は既定ボタンが
  // disabled だと何もしないので、email 欄で Enter を押しても無反応（遷移も
  // エラーも通知も無し）という完全な行き止まりだった。
  // いまはボタンを常に有効に保ち、同意が無いまま送信された時に role="alert" で
  // 理由を告げてチェックボックスへフォーカスを移す（下の handleInvalid）。
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  // クライアント側の検証エラー。nonce は同じ文面を2回目に出す時にも role="alert"
  // を鳴らすため（同一テキストのまま残った要素は再読み上げされない）。
  const [formError, setFormError] = useState<{ text: string; nonce: number } | null>(null);
  const errorNonce = useRef(0);
  // 1回の検証パスで複数の欄が invalid になる（email 未入力 かつ 同意なし 等）。
  // 報告するのは DOM 順で最初の1件だけにする。
  const reportingInvalid = useRef(false);

  function handleInvalid(event: React.FormEvent<HTMLInputElement>) {
    // ネイティブの吹き出しを止めて、こちらの role="alert" に一本化する。
    event.preventDefault();
    if (reportingInvalid.current) return;
    reportingInvalid.current = true;
    queueMicrotask(() => {
      reportingInvalid.current = false;
    });
    const field = event.currentTarget;
    errorNonce.current += 1;
    setFormError({ text: invalidFieldMessage(field), nonce: errorNonce.current });
    field.focus();
  }

  // 2026-08-06 (UX audit item 7): the form is now driven by a Server Action via
  // useActionState. Without JS the browser POSTs to the action natively and the
  // returned key renders server-side; with JS this enhances in place. This
  // replaced the fetch()-only handler that dead-ended when JS was disabled.
  const [state, formAction, pending] = useActionState(signupAction, INITIAL_STATE);
  const apiKey = state.status === "success" ? state.apiKey ?? null : null;

  useEffect(() => {
    fetch("/api/signup")
      .then((res) => res.json())
      .then((data) => setInviteRequired(Boolean(data.inviteRequired)))
      .catch(() => {});
  }, []);

  // 2026-08-06 growth: signup_view completes the form funnel. Mount-once.
  useEffect(() => {
    track("signup_view");
  }, []);

  // Fire the completion/failure analytics off the action result, once per
  // transition. (The JS path previously fired these inline in the fetch
  // handler; with useActionState the result arrives as state, so we react to
  // it here. No-JS users never run this — analytics needs JS by nature.)
  const reportedFor = useRef<SignupState | null>(null);
  useEffect(() => {
    if (state.status === "idle" || reportedFor.current === state) return;
    reportedFor.current = state;
    if (state.status === "success") {
      markDashboardAuthenticated();
      track("signup_completed");
    } else if (state.status === "error") {
      track("signup_failed", { reason: signupFailureReason(state.error) });
    }
  }, [state]);

  if (apiKey) {
    const base =
      typeof window !== "undefined"
        ? `${window.location.origin}/api/v1`
        : `${SITE_URL}/api/v1`;
    const curlExample = `curl -H "Authorization: Bearer ${apiKey}" \\
  ${base}/payees/${SAMPLE_WALLET}/score`;

    return (
      <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
        <article className="sheet">
          <div className="doc-head">
            <div className="doc-head-col">
              <span>Access granted</span>
              <span>
                {/* この頁のシアン1点。1回しか出ないという事実。 */}
                Secret: <span className="text-signal">shown once</span>
              </span>
            </div>
            <div className="doc-head-col">
              <span>vet402</span>
              <span>Signed in</span>
            </div>
          </div>

          <h1 className="doc-title mt-10">Your API key</h1>
          <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

          <p className="doc-p mt-8">
            Copy this key now. <strong>It will not be shown again.</strong> You are signed in to the
            dashboard.
          </p>
          <code className="mt-4 block break-all border border-dashed border-brand-lift bg-paper px-4 py-3 text-[0.8125rem] text-brand-deep">
            {apiKey}
          </code>

          <h2 className="sec-head">
            <span className="sec-no">1.</span>
            <span>Try your first lookup</span>
          </h2>
          <p className="doc-p">
            Score any Base wallet. The address below is a public example — swap it for the payee
            you are about to pay:
          </p>
          {/* 2026-08-13 全盲ペルソナ監査 R2: ここは素の <pre className="overflow-x-auto">
              だった。サイト内の他 24 個のコードブロックには role="region" +
              tabIndex + 説明的 aria-label + コピーボタンが付いているのに、この1個
              だけ付いていない——横スクロールする領域にキーボードで入れず、
              axe も scrollable-region-focusable (serious) を出す。
              この画面が誰にも到達できなかった間、それが見つからなかっただけ
              （送信ボタンが disabled で、キーボード利用者はここへ来られなかった）。
              docs と同じ CodeBlock に寄せる。鍵を配る画面なのでコピーボタンが
              付くこと自体も効く。 */}
          <CodeBlock
            className="mt-4"
            label="First lookup: score a wallet with your new API key"
            code={curlExample}
          />
          <p className="doc-p">
            Prefer the browser? Open a public{" "}
            <Link href={`/payee/${SAMPLE_WALLET}`} className="doc-link">
              payee profile
            </Link>
            , read the{" "}
            <Link href="/docs/api" className="doc-link">
              API reference
            </Link>
            , or raise the quota on{" "}
            <Link href="/dashboard/billing" className="doc-link">
              Billing
            </Link>{" "}
            when Free is not enough. No second signup. Create a spare key on{" "}
            <Link href="/dashboard/keys" className="doc-link">
              API keys
            </Link>{" "}
            while this session is open — the secret is not recoverable later.
          </p>
          <div className="mt-8">

          {/* Plain link (not a router push) so this works with JS disabled too. */}
          <Link href="/dashboard" className={buttonClass({ size: "md" })}>
            Go to dashboard
          </Link>
          </div>
        </article>
      </main>
    );
  }

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Access request</span>
            <span>
              {/* この頁のシアン1点。無料枠という事実。 */}
              Tier: <span className="text-signal">Free — 1,000 lookups / month</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>No card required</span>
          </div>
        </div>

        {/* 2026-07-27 growth施策(週次): 見出しコピーは 2026-07-27 のもののまま。
            2026-08-13 の改装では組版だけを直し、文言には触れていない
            （抽象的な製品説明から具体的なユースケース訴求へ、という判断を保つ）。
            eyebrow の "Vouch" は削除した — craft-floor が kicker/eyebrow を
            明示的に禁じており、ワードマークは走り出しに既に在る。 */}
        <h1 className="doc-title mt-10 max-w-[42ch]">
          Score a payee before you pay — one API call.
        </h1>
        <p className="mx-auto mt-3 max-w-[56ch] text-center text-brand-lift">
          A key is for programmatic lookups. The observatory and payee lookup stay public without
          one. Free: 1,000 lookups a month. No card.
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

      {/* 2026-08-06 (UX audit item 7): this form now submits with or without
          JavaScript. The Server Action is the form's action, the inputs carry
          name attributes, and the email travels in the POST body (never a query
          string), so a no-JS user gets their key on the next render instead of a
          silently wiped form. */}
      <noscript>
        <p className="mt-8 border border-dashed border-brand-lift px-4 py-3 text-[0.8125rem] text-brand-deep">
          JavaScript is off — that is fine. Submitting will reload this page with your new API key
          shown once. Copy it before navigating away.
        </p>
      </noscript>

      <form
        action={formAction}
        onSubmit={(event) => {
          // 2026-08-13: ボタンは pending 中も aria-disabled で残す（disabled に
          // するとフォーカスが body へ落ちて、送信した本人が現在地を失う）。
          // 実際の二重送信はここで止める。
          if (pending) {
            event.preventDefault();
            return;
          }
          // ここへ来た＝制約検証を通過した。前回の検証エラーは用済み。
          setFormError(null);
          track("signup_started");
        }}
        className="mt-10 space-y-5 border-t border-brand-deep pt-8"
      >
        {/* 2026-08-12: 入力欄の枠線は白地 3:1 を満たす階調でなければならない。
            それまでの zinc-300 (#D4D4D8) は白地 1.48:1 で、WCAG 2.2 の 1.4.11
            （非テキストコントラスト 3:1）を満たしていなかった。この枠線が入力欄の
            唯一の境界表現なので免除されない。
            2026-08-13 vet402: 紺の階調へ移して brand-lift (#55688c・白地 5.61:1)。
            brand-mist (#8f9cb2) は 2.78:1 なので枠線には使えない。
            tests/contrast-tokens.test.ts が入力欄の弱い枠線を静的に禁じている。 */}
        {/* 2026-09-28 監査: 入力欄は text-base（16px）。iOS Safari は 16px 未満の欄にフォーカスすると
            頁を拡大し、送信ボタンが画面の外へ出る。 */}
        <label className="block space-y-2 text-sm">
          <span className="doc-caption block">Email</span>
          {/* autoComplete (WCAG 1.3.5 Identify Input Purpose) — lets the browser
              and assistive tech fill known values instead of retyping them. */}
          <input
            type="email"
            name="email"
            autoComplete="email"
            className="doc-input text-base"
            required
            onInvalid={handleInvalid}
          />
        </label>

        <label className="block space-y-2 text-sm">
          <span className="doc-caption block">Name (optional)</span>
          <input
            name="name"
            autoComplete="name"
            className="doc-input text-base"
          />
        </label>

        {inviteRequired && (
          <label className="block space-y-2 text-sm">
            <span className="doc-caption block">Invite code</span>
            <input
              name="inviteCode"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              className="doc-input text-base"
              required
              onInvalid={handleInvalid}
            />
          </label>
        )}

        {/* Clickwrap consent. `required` makes the browser refuse the submit
            with its own message, so the gate works before any JS of ours runs
            AND on the no-JS native submit. stopPropagation on the two links: an
            <a> inside a <label> would otherwise toggle the checkbox on the way
            to the page the user actually asked for. */}
        <label
          htmlFor="accept-terms"
          className="flex cursor-pointer items-start gap-3 text-[0.8125rem] text-brand"
        >
          <input
            id="accept-terms"
            name="acceptedTerms"
            type="checkbox"
            checked={acceptedTerms}
            onChange={(e) => {
              setAcceptedTerms(e.target.checked);
              // 直したものについてのエラーを読み上げ続けない。
              if (e.target.checked) setFormError(null);
            }}
            className="mt-0.5 h-4 w-4 shrink-0 rounded-[2px] border-brand-lift accent-brand-deep"
            required
            onInvalid={handleInvalid}
          />
          <span>
            I have read and agree to the{" "}
            <Link href="/legal/terms" className="doc-link" onClick={(e) => e.stopPropagation()}>
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/legal/privacy" className="doc-link" onClick={(e) => e.stopPropagation()}>
              Privacy Policy
            </Link>
            .
          </span>
        </label>

        {/* 検証エラー（クライアント）とサーバ側の失敗を1つの alert 口に束ねる。
            key に nonce を混ぜているのは、同じ文面をもう一度出した時にも要素を
            付け替えて role="alert" を鳴らすため。 */}
        {formError ? (
          <p
            key={`client-${formError.nonce}`}
            role="alert"
            className="border-l-[3px] border-red-700 bg-red-50 px-4 py-3 text-[0.8125rem] text-red-800"
          >
            {formError.text}
          </p>
        ) : state.status === "error" && state.error ? (
          <p role="alert" className="border-l-[3px] border-red-700 bg-red-50 px-4 py-3 text-[0.8125rem] text-red-800">{dashboardErrorMessage(state.error)}</p>
        ) : null}

        {/* 2026-08-13 全盲ペルソナ監査 R2: 同意が前提であることを、送信して失敗する
            前に伝える。ボタンにフォーカスが載った時点で読み上げられる。視覚面は
            チェックボックスの文言が既に同じことを言っているので、こちらは
            読み上げ専用にして紙面を増やさない。 */}
        <span id="signup-terms-note" className="sr-only">
          Creating an account requires ticking the agreement checkbox above.
        </span>

        {/* pending 中も disabled にしない — disabled はフォーカスを body へ落とす。
            押せないことは aria-disabled と地色で伝え、実際の二重送信は
            form の onSubmit で止める。 */}
        <button
          type="submit"
          aria-disabled={pending || undefined}
          aria-describedby="signup-terms-note"
          className={buttonClass({
            size: "md",
            className:
              "w-full aria-disabled:bg-ground aria-disabled:text-brand aria-disabled:ring-1 aria-disabled:ring-hair aria-disabled:cursor-default",
          })}
        >
          {pending ? "Creating..." : "Create account"}
        </button>
      </form>

      <p className="mt-8 text-center text-[0.8125rem] text-brand">
          Already have a key?{" "}
          <Link href="/dashboard/login" className="doc-link">
            Sign in
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">
            ·
          </span>
          <Link href="/observatory" className="doc-link">
            Read measurements
          </Link>
        </p>
      </article>
    </main>
  );
}
