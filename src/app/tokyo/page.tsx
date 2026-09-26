import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  EXPLORER, KEY, MAX_AGE_SECONDS, P_D, REPO_DEMO, SELLER_METHOD, SELLER_RESOURCE, TRUSTED_ATTESTERS, W_OP,
} from "../api/tokyo/_lib/constants";
import { readKeyScope, verifyName, type KeyScope, type VerifyError, type VerifyView } from "../api/tokyo/_lib/verify";
import { JudgePanel } from "./judge-panel";
import { TraceView } from "./trace-view";

/**
 * /tokyo — ETHGlobal Tokyo 2026（ENS）の審査員が開く面。PLAN_v4.3 §3.7。
 *
 * 1. 任意の ENSv2 Sepolia 名で ENSIP-29 草案の7段を今のチェーンで走らせる（サーバで描画。読むだけ）
 * 2. 審査員ボタン: seller-d.eth の約束を1文字変える／戻す（./judge-panel.tsx → /api/tokyo/*）
 * 3. 鍵を隠す代わりに、鍵の狭さをチェーンから示す（roles と eth_call）
 *
 * このファイルとその下（judge-panel・trace-view）には署名器も鍵も置かない。署名は
 * /api/tokyo/mutate・reset・state の中だけ（W01〜W06 は tests/tokyo-mutate.test.ts）。
 * 支払い先の審査の外部 API（§3.10 の枠）はこの面から呼ばない・表示しない（§3.10-4）。
 * 既存の src/lib は import しない（W01。メタデータも手で書く）。
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TITLE = "ENS x402 offer check — ETHGlobal Tokyo 2026";
const DESCRIPTION =
  "Run the seven steps of the ENSIP-29 draft on any ENSv2 Sepolia name, then change one character of seller-d.eth's x402 offer yourself and watch the check refuse it.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "https://vet402.com/tokyo" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "https://vet402.com/tokyo", siteName: "vet402", type: "website" },
};

const DEFAULT_NAME = "seller-a.eth";
const CLI = `git clone --depth 1 --branch tokyo-2026-submission https://github.com/kzmttkc/vet402 && cd vet402/examples/tokyo-2026-demo && npm ci && npm run verify -- seller-a.eth`;
const VERIFY_BUDGET_MS = 40_000;

function withBudget<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), VERIFY_BUDGET_MS))]);
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export default async function TokyoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.name) ? sp.name[0] : sp.name;
  const name = (raw ?? DEFAULT_NAME).trim() || DEFAULT_NAME;

  const timeout: VerifyError = { name, error: "verify_failed", message: "The check did not finish in time. Reload to try again." };
  const [result, scope] = await Promise.all([
    withBudget<VerifyView | VerifyError>(verifyName(name), timeout),
    withBudget<KeyScope | null>(readKeyScope(), null),
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>ETHGlobal Tokyo 2026 — ENS</span>
            <span>ENSIP-29 draft · Sepolia {11155111}</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Ext href={REPO_DEMO}>Demo source</Ext>
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Check the x402 offer a seller published on its ENS name</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <p className="doc-p mt-6">
          A seller writes its price and payee as an <code>{KEY}</code> text record. An attester signs that exact
          line. Before an agent pays, vet402 reads the record and the signature at one pinned Sepolia block from two
          RPC providers and runs the seven steps of the ENSIP-29 draft. The name is yours to choose: type any ENSv2
          Sepolia name.
        </p>

        <form method="get" action="/tokyo" className="mt-4 flex flex-col gap-2 sm:flex-row">
          <label htmlFor="tokyo-name" className="sr-only">
            ENS name
          </label>
          <input
            id="tokyo-name"
            name="name"
            defaultValue={name}
            maxLength={255}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 border border-hair px-2 py-1"
          />
          <button type="submit" className="border border-brand-deep px-3 py-1 text-brand-deep">
            Run the seven steps
          </button>
        </form>
        <p className="doc-p mt-2 text-sm text-brand-mist">
          Names registered on the ENSv2 Sepolia deployment of 2026-09-15. The request is fixed to this demo&apos;s
          seller route.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>The seven steps, on the chain as it is now</span>
        </h2>
        <p className="doc-p text-brand-mist">
          Request compared against the offer: <code>{SELLER_METHOD}</code> <code>{SELLER_RESOURCE}</code>. Trusted
          attester: {TRUSTED_ATTESTERS.map((a) => `${a.name} (${a.address})`).join(", ")}. Freshness window:{" "}
          {MAX_AGE_SECONDS / 86_400} days.
        </p>
        {"error" in result ? (
          <p className="doc-p text-block-ink">{result.message}</p>
        ) : (
          <TraceView data={result} />
        )}

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Change one character yourself</span>
        </h2>
        <p className="doc-p">
          The button below writes <code>seller-d.eth</code>&apos;s <code>{KEY}</code> on Sepolia and flips its amount
          from 10000 to 10001. The attestation was signed over the old line, so the check above refuses it on the
          next read. Put it back and it passes again. <code>seller-a.eth</code> and the CLI example are not touched by
          this button.
        </p>
        <JudgePanel />

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>The key behind the button</span>
        </h2>
        <p className="doc-p">
          The judge button signs with a delegated Sepolia key held on the server. On chain, that key holds one role on{" "}
          <code>seller-d.eth</code>&apos;s own resolver: writing <code>{KEY}</code>. The button can set two fixed
          values, 10000 and 10001.
        </p>
        <ul className="doc-p list-none pl-0 text-sm">
          <li>
            Key (W_op):{" "}
            <Ext href={`${EXPLORER}/address/${W_OP}`}>
              <code>{W_OP}</code>
            </Ext>
          </li>
          <li>
            Resolver (P_d):{" "}
            <Ext href={`${EXPLORER}/address/${P_D}`}>
              <code>{P_D}</code>
            </Ext>
          </li>
          <li>
            <code>roles(keccak256(&quot;{KEY}&quot;), W_op)</code> on P_d:{" "}
            <strong>{scope?.roleBitmap ?? "(not readable right now)"}</strong> (0x10 = setText)
          </li>
          <li>
            The same key writing the attestation key (<code>eth_call</code>, not sent):{" "}
            <strong>{scope?.attestationWrite ?? "(not readable right now)"}</strong>
          </li>
        </ul>

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>Run it from a terminal</span>
        </h2>
        <p className="doc-p">
          The same check, from a clean clone. It reads Sepolia and signs nothing.
        </p>
        <pre className="doc-p overflow-x-auto border border-hair p-3 text-sm">
          <code>{CLI}</code>
        </pre>
      </article>
    </main>
  );
}
