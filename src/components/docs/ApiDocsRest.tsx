"use client";

import Link from "next/link";
import ApiEndpointsSection from "@/components/docs/ApiEndpointsSectionLazy";
import TrackedLink from "@/components/site/TrackedLink";
import CodeBlock from "@/components/docs/CodeBlock";
import { TryItPanel } from "@/components/docs/TryItPanel";
import { TableScroll } from "@/components/site/TableScroll";
import { SITE_URL } from "@/lib/site-url";
import {
  DECISION_KEYLESS_LIMIT_SINCE,
  KEYLESS_READ_STOP,
  PAYMENT_PROOF_RPC_TIMEOUT_MS,
  keylessDecisionPerMinute,
  keylessDiagnosePerMinute,
  keylessPaymentProofPerMinute,
  keylessRatesSentence,
  keylessResolvePerMinute,
} from "@/lib/api/keyless-limits";
import { DECISION_RULES_TEXT, METHOD_LIMIT_TEXT, VERDICT_DOCS } from "@/lib/decision/rules-text";
import { DECISION_RULES_VERSION } from "@/lib/decision/rules";
import { REASON_CODES, EFFECT_LABEL, type SellerCanFix } from "@/lib/decision/reason-codes";
import { DELIVERY_VALUE_DEFINITIONS } from "@/lib/observatory/delivery-values";
import {
  DELIVERY_CSV_BODY_BYTES_NOTE,
  DELIVERY_CSV_COLUMNS,
  DELIVERY_CSV_HEADER_NOTES,
  DELIVERY_CSV_WHOSE_PURCHASES,
} from "@/lib/observatory/delivery-export";
import { MCP_DOCS_CONNECT_CURSOR } from "@/lib/docs/mcp-connect-cursor-json";
import DocBodySection from "@/components/docs/DocBodySection";

const SELLER_FIX_LABEL: Record<SellerCanFix, string> = { yes: "Yes", partly: "Partly", no: "No", "n/a": "—" };

const errorCodes = [
  { status: "400", meaning: "Bad request", detail: "Malformed body/params (e.g. invalid wallet format, empty batch)." },
  { status: "401", meaning: "Unauthorized", detail: "Missing or invalid API key on the Authorization: Bearer header." },
  { status: "403", meaning: "Forbidden / plan upgrade required", detail: "e.g. score history on a plan below Pro." },
  {
    status: "429",
    meaning: "Rate limited",
    detail: `Two causes, told apart by the error string: "rate_limit_exceeded" is the monthly quota (retry next month), "rate_limited" is a one-minute IP throttle (retry after the reported seconds). See Two kinds of 429 above.`,
  },
];

export default function ApiDocsRest({ inviteRequired }: { inviteRequired: boolean }) {
  return (
    <>
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            2 &mdash; Connect hosted MCP in your agent (no key)
          </p>
          <CodeBlock label="Cursor mcp.json" code={MCP_DOCS_CONNECT_CURSOR} />
          <p className="mt-1 text-[0.84375rem] text-brand-lift">
            Same URL for Claude Code, Claude Desktop, and any MCP client that speaks Streamable HTTP. Setup and example
            chat prompts live on{" "}
            <Link href="/docs/mcp" className="doc-link">
              /docs/mcp
            </Link>{" "}
            and{" "}
            <Link href="/connect" className="doc-link">
              /connect
            </Link>
            .
          </p>
        </div>

      <DocBodySection id="more-keyless-reads" title="More keyless reads" className="space-y-3">
        <p className="text-[0.84375rem] text-brand">
          After the two quickstart paths above, these curls read the same public records without a key.
        </p>

        {/* resolve → decision stays in quickstart after check (2026-11-16 pmf85 r6). */}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            Resolve a URL, then read the decision (no key)
          </p>
          <CodeBlock
            label="curl: resolve a URL to its resource_id, then read the decision"
            code={`# 1. the URL that answers 402 -> its resource_id
curl "${SITE_URL}/api/v1/resolve?q=https://api.exa.ai/search"

# 2. resource_id -> facts + ALLOW / WARN / BLOCK in one document
curl "${SITE_URL}/api/v1/resources/baad6a17bfaf57b11c0c1d8cfb0b38d3d01f09736b7d8af2f92f0313ddef8bdb/decision?role=payer"`}
          />
          <TryItPanel path="/api/v1/resolve?q=https://api.exa.ai/search" label="GET /api/v1/resolve" />
          <TryItPanel
            path="/api/v1/resources/baad6a17bfaf57b11c0c1d8cfb0b38d3d01f09736b7d8af2f92f0313ddef8bdb/decision?role=payer"
            label="GET /api/v1/resources/{resource_id}/decision"
          />
          <p className="mt-1 text-[0.84375rem] text-brand-lift">
            Copy <code className="text-brand-deep">resource.resource_id</code> from the first
            answer into the second. The decision carries <code>recommendation</code>,{" "}
            <code>reason_codes</code> (each one is in{" "}
            <a href="#reason-codes" className="doc-link">
              the reason-code table
            </a>
            ) and the L0&ndash;L2 facts behind them. Without a key,{" "}
            <code className="text-brand-deep">/decision</code> answers {keylessDecisionPerMinute()} requests per minute per IP
            and <code className="text-brand-deep">/resolve</code> {keylessResolvePerMinute()}. Past that you get 429{" "}
            <code>rate_limited</code> with a <code>Retry-After</code> under 60 seconds. A URL that
            is not in the catalog comes back from <code>/resolve</code> with no{" "}
            <code>resource</code> (and, when nothing on its host is on record either, an empty{" "}
            <code>endpoints</code> with <code>not_found</code>); a URL without{" "}
            <code>https://</code> gets 400 <code>invalid_query</code> with a{" "}
            <code>suggestion</code>; and an unknown id gets 404 <code>not_found</code> from{" "}
            <code>/decision</code>.
          </p>
          <p className="mt-1 text-[0.84375rem] text-brand-lift">
            The ledger column l2_schema stores match, mismatch, no_declaration, or not_checked.
            The decision document and the facts document store conform, mismatch, undeclared, or
            not_checked. conform is written when the re-read L2 value (l2_reading) of the latest delivery is match.
            mismatch is written when that re-read value is mismatch. An older mismatch row with no recorded reason is re-read first, and a cut body reads not_checked. In the other cases
            the decision word is not_checked when the current declaration names output (a required
            key or an example property), or when the purchase row of the latest delivery recorded a declaration and its re-read value is not_checked, and undeclared when neither holds. For the quickstart
            resource https://api.exa.ai/search, read facts.l2.status on its decision and on its
            facts document, and l2_schema on its purchase rows.
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            3 &mdash; What happened when vet402 actually paid an endpoint (no key)
          </p>
          <CodeBlock
            label="curl: read an endpoint's real purchase receipts"
            code={`curl "${SITE_URL}/api/v1/observatory/endpoints/521e929e-5f89-4603-a964-d1812caf118f/purchases"`}
          />
          <TryItPanel
            path="/api/v1/observatory/endpoints/521e929e-5f89-4603-a964-d1812caf118f/purchases"
            label="GET /api/v1/observatory/endpoints/{id}/purchases"
          />
          <p className="mt-1 text-[0.84375rem] text-brand-lift">
            n paid attempts, m settled, each settled row carrying its on-chain{" "}
            <code className="text-brand-deep">txHash</code>. A Circle Gateway row on Arc carries{" "}
            <code className="text-brand-deep">gatewayBatchTx</code> instead, because one batch
            transaction can settle many payments. This is the record vet402 exists to
            keep. Swap the id for any endpoint on{" "}
            <Link href="/observatory" className="doc-link">
              the observatory
            </Link>
            .
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            4 &mdash; The public accuracy ledger (no key)
          </p>
          <CodeBlock
            label="curl: read the public accuracy ledger"
            code={`curl "${SITE_URL}/api/v1/accuracy"`}
          />
          <TryItPanel path="/api/v1/accuracy" label="GET /api/v1/accuracy" />
          <p className="mt-1 text-[0.84375rem] text-brand-lift">
            Aggregate counts only. The same numbers{" "}
            <Link href="/accuracy" className="doc-link">
              /accuracy
            </Link>{" "}
            renders, including the operator benchmark.
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            5 &mdash; The exact message a payee has to sign (no key)
          </p>
          <CodeBlock
            label="curl: preview the canonical payee-verify message"
            code={`curl "${SITE_URL}/api/v1/payees/verify?wallet=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&name=Acme%20API"`}
          />
          <TryItPanel
            path="/api/v1/payees/verify?wallet=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&name=Acme%20API"
            label="GET /api/v1/payees/verify"
          />
          <p className="mt-1 text-[0.84375rem] text-brand-lift">
            Returns{" "}
            <code className="text-brand-deep">{`{ "message": "…" }`}</code> &mdash; sign it with
            that wallet and POST it back to the same path to publish a verified-payee page and a
            badge. Read-only; nothing is written.
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            6 &mdash; Score a payee before paying it (key required)
          </p>
          <CodeBlock
            label="curl: score a payee wallet"
            code={`curl -H "Authorization: Bearer vouch_live_…" \\
  "${SITE_URL}/api/v1/payees/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/score"`}
          />
          <p className="mt-1 text-[0.84375rem] text-brand-lift">
            The buyer-side question.{" "}
            <Link href="/signup" className="doc-link">
              Get a key
            </Link>{" "}
            &mdash; the free tier is 1,000 score lookups a month.
          </p>
          {/* 2026-08-12 FIX-4: 発行されるキーの形が docs のどこにも書いておらず、
              LP の MCP 例だけが `vk_...` という実在しない接頭辞を載せていた
              （実物は src/lib/db/api-keys.ts の `vouch_live_<48hex>`）。
              例を直すだけでなく、正しい形をここに1行置いて典拠にする。
              2026-09-28 監査: 頁の冒頭（最初の画面）に旧名が出ていたので、鍵を初めて使う
              この例の直後へ移した。事実は変えていない。 */}
          <p className="mt-1 text-[0.84375rem] text-brand">
            Keys look like{" "}
            <code className="text-brand-deep">vouch_live_…</code> — send them
            as{" "}
            <code className="text-brand-deep">
              Authorization: Bearer vouch_live_…
            </code>
            . The <code className="text-brand-deep">vouch_</code> prefix and the{" "}
            <code className="text-brand-deep">VOUCH_API_KEY</code> variable keep the old name (the
            product was called Vouch until August 2026), so existing keys and configs still work.
          </p>
          {/* 2026-08-13 監査是正 #3: 散文の旧名（Vouch）は vet402 へ統一したが、
              発行済みのキー接頭辞と webhook のヘッダ名は動いている連携を壊すので
              据え置いた。docs で名前が2つ出てくる理由をここで1行明示する。
              これが無いと「ドキュメントが古い」ようにしか読めない。 */}
          <p className="mt-1 text-[0.84375rem] text-brand-lift">
            API keys and webhook headers retain the{" "}
            <code className="text-brand-deep">vouch_</code> /{" "}
            <code className="text-brand-deep">Vouch-</code> prefixes for backward
            compatibility.
          </p>
        </div>

        {/* 2026-08-14 UX（ハッカソン/YC ペルソナ）: 鍵無しで叩ける
            GET /api/demo/score を「任意アドレスを採点するデモ」と読み、「何を
            入れても同じ数字が返る」と報告された。この口は仕様として固定エージェント
            （DEMO_AGENT_ID）を1体だけライブ採点する——リクエストの中身は採点対象を
            選ばない（openapi.yaml にも明記）。その事実と、任意アドレスの照会先を
            1文で示して誤解を消す。 */}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            Note &mdash; the key-less demo scorer
          </p>
          <TryItPanel path="/api/demo/score" label="GET /api/demo/score" />
          <p className="mt-2 text-[0.84375rem] text-brand-lift">
            <code className="text-brand-deep">GET /api/demo/score</code> scores one fixed demo
            agent chosen server-side, so anyone can watch a real verdict get computed without a
            key. Nothing in the request selects what it scores &mdash; it is a demo, not a free
            lookup, so it returns the same agent whatever you pass it. To score an address{" "}
            <em>you</em> choose, open{" "}
            <Link href="/payee" className="doc-link">
              /payee
            </Link>{" "}
            or call the payee-score endpoint above (example 5).
          </p>
        </div>
      </DocBodySection>

      {/* 2026-08-13 UX監査R1 [C4]: 3つのパッケージは npm に公開済み（いずれも
          0.1.0）なのに、サイト全体で "npm" の文字が0件だった。LP は「middleware
          package」と書き、docs は REST しか説明していないので、SDK を入れて
          試したい読者の導線が1本も無い。さらに npm には無関係の別ベンダーの
          `vouch-sdk` / `@getvouch/sdk` が実在するため、スコープ付きの正確な
          名前を名指しする必要がある（打ち間違いの行き先が他人のコードになる）。 */}
      <DocBodySection id="packages" title="Packages" className="space-y-3">
        <p className="text-[0.84375rem] text-brand">
          The unscoped <code className="text-brand-deep">vet402</code> package on npm bundles{" "}
          <code className="text-brand-deep">@vet402/sdk</code> and{" "}
          <code className="text-brand-deep">@vet402/middleware</code> so one install covers buyer and seller entry
          points (<code>vet402/buyer</code>, <code>vet402/seller</code>). Scoped packages below install separately. Each comes from{" "}
          <a
            href="https://github.com/vet402/vet402"
            target="_blank"
            rel="noopener noreferrer"
            className="doc-link"
          >
            this repository
          </a>
          . They wrap the same REST API documented below. Nothing here is available to a package that is not available
          to a plain <code>fetch</code>.
        </p>
        <CodeBlock
          label="npm: install vet402"
          code={`npm install vet402

# or install the scoped packages separately:
npm i @vet402/sdk          # spend guard for an agent about to pay
npm i @vet402/middleware   # x402 request gate for an API provider
npm i @vet402/mcp-server   # local MCP tool (hosted entry: https://vet402.com/mcp)`}
        />
        <p className="text-[0.84375rem] text-brand-lift">
          <code className="text-brand-deep">@vet402/*</code> is the canonical scope.{" "}
          <code className="text-brand-deep">@vouchscore/*</code> is the old name (the product
          was called Vouch until August 2026) and is published from the same npm account and left
          in place only so existing installs keep resolving. It is frozen at the version it had when
          the name changed, not kept in step with{" "}
          <code className="text-brand-deep">@vet402/*</code>, so new work should take the
          canonical scope. Unscoped{" "}
          <code>vouch-sdk</code> and <code>@getvouch/sdk</code> exist on npm and are unrelated
          packages by other publishers. Installing those gets someone else&apos;s code, not vet402&apos;s.
        </p>

        {/* 2026-08-13 UX監査R2: 前回のC4修正で `npm i` の行は載ったが、サイト全体を
            通して `import` を含む SDK の使用例が1件も無かった（docs の <pre> 24個の
            うち JS は webhook の HMAC 検証だけ）。「30分でデモに組み込めるか」を
            計測したペルソナは、インストール行の次に何を書けばいいかをサイトから
            得られず npm ページへ出ていった。npm README の完動例をここへ引く。 */}
        <h3 className="text-[1.0625rem] font-semibold text-brand-deep">SDK: read a score</h3>
        <p className="text-[0.84375rem] text-brand">
          <code>apiUrl</code> defaults to the hosted API, so a key is the only thing you have to
          supply. Copy this into a <code>.mjs</code> file and it runs.
        </p>
        <CodeBlock
          label="TypeScript: read a wallet score and a payee score with @vet402/sdk"
          code={`import { createVouchClient } from "@vet402/sdk";

const vouch = createVouchClient({ apiKey: process.env.VOUCH_API_KEY });

// Seller side — "should I accept payment from this wallet?"
const seller = await vouch.getWalletScore("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
console.log(seller.trustScore, seller.recommendation); // 0–100 and ALLOW | WARN | BLOCK — live values

// Buyer side — "should my agent pay this wallet?"
const payee = await vouch.getPayeeScore("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
console.log(payee.score, payee.recommendation, payee.dataDepth);`}
        />
        {/* 2026-09-29 敵対的監査: SDK の README は getDecision について「鍵なしで答える」と
            「鍵が要る」の両方を書いている（packages/sdk は凍結中で直せない）。実物は
            createVouchClient の apiKey が任意で、未設定なら Authorization を付けない
            （packages/sdk/src/index.ts・09-07、npm の 0.6.0 に含まれる）。正しい挙動をここに書く。 */}
        <h3 className="text-[1.0625rem] font-semibold text-brand-deep">SDK: ask before paying, with or without a key</h3>
        <p className="text-[0.84375rem] text-brand">
          <code>getDecision</code> and <code>resolve</code> work with no key. Leave{" "}
          <code>apiKey</code> unset and the client sends no <code>Authorization</code> header:{" "}
          <code>getDecision</code> is then key-less at {keylessDecisionPerMinute()} requests per minute per IP (429{" "}
          <code>rate_limited</code> beyond), and <code>resolve</code> at 60. With a key,{" "}
          <code>getDecision</code> spends 1 unit of your monthly quota per call. The score calls
          above (<code>getWalletScore</code>, <code>getPayeeScore</code>) do need a key; without one
          the server answers 401 <code>missing_api_key</code>.
        </p>
        <CodeBlock
          label="TypeScript: resolve a URL and read its decision with @vet402/sdk, no key"
          code={`import { createVouchClient } from "@vet402/sdk";

const vouch = createVouchClient({}); // no apiKey: key-less, ${keylessDecisionPerMinute()}/min per IP

const { resource } = await vouch.resolve("https://api.exa.ai/search");
if (!resource?.resource_id) throw new Error("not in the vet402 catalog");
const d = await vouch.getDecision(resource.resource_id, { role: "payer" });
console.log(d.recommendation, d.reason_codes);`}
        />

        <h3 className="text-[1.0625rem] font-semibold text-brand-deep">SDK: gate a payment</h3>
        <p className="text-[0.84375rem] text-brand">
          Gate the payment on the resource decision for the URL, not on the payee wallet score.
          Pay when <code>recommendation</code> is <code>ALLOW</code> and <code>degraded</code> is
          false. A missing resource, a WARN, a BLOCK, or a degraded read stays unpaid.
        </p>
        <CodeBlock
          label="TypeScript: gate a payment on the resource decision"
          code={`import { createVouchClient } from "@vet402/sdk";

const vouch = createVouchClient({}); // no apiKey: key-less, ${keylessDecisionPerMinute()}/min per IP

const { resource } = await vouch.resolve("https://api.exa.ai/search");
if (!resource?.resource_id) throw new Error("not in the vet402 catalog");
const d = await vouch.getDecision(resource.resource_id, { role: "payer" });

if (d.recommendation === "ALLOW" && d.degraded === false) {
  // the caller pays from here. this sample does not sign or send
  console.log("gate open", d.recommendation, d.degraded);
} else {
  console.error(d.recommendation, d.reason_codes, d.degraded);
}`}
        />

        <h3 className="text-[1.0625rem] font-semibold text-brand-deep">SDK: payee wallet score</h3>
        <p className="text-[0.84375rem] text-brand">
          This sample checks the payee wallet score. It does not call the resource decision. A
          wallet score can read ALLOW when the decision for one URL paid to that wallet reads WARN
          or BLOCK. Call getDecision for that URL. Pay only when recommendation is ALLOW and
          degraded is false.
        </p>
        <CodeBlock
          label="TypeScript: read a payee wallet score with SpendGuard"
          code={`const guard = vouch.createSpendGuard({
  maxPerTxUsd: 10,
  dailyBudgetUsd: 50,
});

const scored = await guard.evaluate({ payee: "0xabc...", amountUsd: 5 });
console.log(scored.allow, scored.reasons);`}
        />

        <h3 className="text-[1.0625rem] font-semibold text-brand-deep">
          Middleware: gate an x402 endpoint
        </h3>
        <CodeBlock
          label="TypeScript: Express x402 gate with @vet402/middleware"
          code={`import { createExpressGate } from "@vet402/middleware/express";

// Mount AFTER x402 verification, so \`req.payer\` is set.
app.use("/api/paid", createExpressGate({
  apiUrl: "https://vet402.com/api/v1",
  apiKey: process.env.VOUCH_API_KEY,
  getAddress: (req) => req.payer,   // the counterparty to vet
}));`}
        />
        <p className="text-[0.84375rem] text-brand-lift">
          Anything but <code>ALLOW</code> returns{" "}
          <code>403 {"{ error: \"trust_blocked\" }"}</code> before your handler runs. An{" "}
          <code>ALLOW</code> continues with the full decision on <code>req.vouchTrust</code>.
        </p>
        <p className="text-[0.84375rem] text-brand">
          <strong>Both the SDK and the middleware default to allow-only.</strong> Only an{" "}
          <code>ALLOW</code> passes; a <code>WARN</code>, a <code>BLOCK</code>, a degraded verdict
          and a partially measured one are all denied unless the caller explicitly opts out. That
          default is fail-closed on purpose &mdash; see{" "}
          <a href="#verdicts" className="doc-link">
            Decision verdicts &amp; reason codes
          </a>{" "}
          for what to do about a WARN.
        </p>

        {/* 2026-08-13 UX監査L3 [P5・実装者]。サイトの docs は mcp-server を
            install 一行でしか触れず、設定ブロック・tool 名・mcpServers JSON が
            無かった（SDK/middleware は完備）。MCP 経由の実装者はここで手が
            止まる。設定は packages/mcp-server/README.md の実物をそのまま写す。 */}
        <h3 className="text-[1.0625rem] font-semibold text-brand-deep">Hosted MCP (reads records)</h3>
        <p className="text-[0.84375rem] text-brand">
          For read-only checks before paying, point the MCP client at the hosted server at{" "}
          <a href="/docs/mcp" className="doc-link">
            https://vet402.com/mcp
          </a>{" "}
          (no key, no local process). Full setup is on{" "}
          <Link href="/docs/mcp" className="doc-link">
            /docs/mcp
          </Link>{" "}
          and <Link href="/connect" className="doc-link">/connect</Link>.
        </p>
        <h3 className="text-[1.0625rem] font-semibold text-brand-deep">Local @vet402/mcp-server (can sign and pay)</h3>
        <p className="text-[0.84375rem] text-brand">
          <code>@vet402/mcp-server</code> runs on your machine. With a payer key configured,{" "}
          <code>pay_if_trusted</code> can sign and pay when checks pass. The client launches it with <code>npx</code>.
          Add this to the client config (
          <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> on macOS,{" "}
          <code>%APPDATA%\Claude\claude_desktop_config.json</code> on Windows) and restart:
        </p>
        <CodeBlock
          label="MCP client config for @vet402/mcp-server (local)"
          code={`{
  "mcpServers": {
    "vouch-trust": {
      "command": "npx",
      "args": ["-y", "@vet402/mcp-server"],
      "env": {
        "VOUCH_API_KEY": "vouch_live_your_key_here"
      }
    }
  }
}`}
        />
        {/* 2026-09-29 敵対的監査: ここは「道具 5 つ・VOUCH_API_KEY 必須」と書いていたが、実物は
            7 本（check_resource_decision と pay_if_trusted が 09-02 / 09-05 に増えた）で、
            鍵は 09-07 から任意（/decision は鍵なしで答える）。packages/mcp-server/src/index.ts の
            server.tool 呼び出しと README の表に合わせる。 */}
        <p className="text-[0.84375rem] text-brand">
          <code>VOUCH_API_KEY</code> is optional. Without it the two <code>/decision</code> tools
          work key-less ({keylessDecisionPerMinute()}/min per IP) and the five score and attest tools answer{" "}
          <code>missing_api_key</code>; with one, created at <code>/dashboard/keys</code>, those
          five work too. <code>VOUCH_API_URL</code> is optional and defaults to the hosted API. The
          seven tools: <code>check_resource_decision</code> and <code>pay_if_trusted</code> (the{" "}
          <code>/decision</code> route; <code>pay_if_trusted</code> can sign and pay when a payer key is configured), and{" "}
          <code>check_agent_trust</code>, <code>check_wallet_trust</code>,{" "}
          <code>check_payee_trust</code>, <code>explain_trust_score</code> and{" "}
          <code>attest_x402_payment</code> (key required). In 0.3.1 on npm,{" "}
          <code>check_resource_decision</code> accepts the sha256 <code>resourceId</code> from{" "}
          <code>/api/v1/resolve</code> or the URL itself. Same fail-closed reading as the SDK: treat anything but{" "}
          <code>ALLOW</code> as &ldquo;do not pay yet&rdquo;.
        </p>
      </DocBodySection>

      {/* 2026-09-29.3（監査 6 周目・重要度 高）: 売り手頁の「how the decision counts」は /docs/api#verdicts に飛ぶが、
          そこは旧スコア帯（0–100）の説明で、判定の理由コードの意味が HTML のどこにも無かった。#verdicts を判定の
          説明と理由コードの表に置き換え、スコア帯は #score-bands へ移した。表は src/lib/decision/reason-codes.ts が
          正典で、docs/openapi.yaml の DecisionReasonCode と tests/decision-reason-codes.test.ts が一致を固定する。 */}
      <DocBodySection id="verdicts" title="Decision verdicts & reason codes" className="space-y-3">
        <p className="text-[0.84375rem] text-brand">
          <code className="text-brand-deep">GET /api/v1/resources/&#123;id&#125;/decision</code> answers{" "}
          <code>ALLOW</code>, <code>WARN</code> or <code>BLOCK</code> from vet402&rsquo;s own L0&ndash;L2
          records, and lists the reasons in <code>reason_codes</code>. There is no score behind it: the
          transitional 0&ndash;100 payee score is left out of the response unless you ask for it with{" "}
          <code>include_score=1</code>, and even then it is marked{" "}
          <code>superseded_by: &quot;recommendation&quot;</code> and is not used for the decision.
        </p>
        {/* 2026-09-29 監査 7 周目: 3 語の説明は rules-text.ts の VERDICT_DOCS（手で書かない）。 */}
        <ul className="list-disc space-y-2 pl-5 text-[0.84375rem] text-brand">
          {(["BLOCK", "WARN", "ALLOW"] as const).map((v) => (
            <li key={v}>
              <strong>{v}</strong>: {VERDICT_DOCS[v]}
            </li>
          ))}
        </ul>
        <h3 id="reason-codes" className="scroll-mt-32 text-[1.0625rem] font-semibold text-brand-deep">
          Reason codes (rules {DECISION_RULES_VERSION})
        </h3>
        <p className="text-[0.84375rem] text-brand-lift">
          &ldquo;Verdict&rdquo; is what the code causes on its own; &mdash; means it explains without
          changing the verdict. Codes in angle brackets stand for a family.
        </p>
        <p className="text-[0.84375rem] text-brand-lift">
          With <code>role=payee</code>, <code>facts.short_interval_payment_rate</code> is the share of gaps of 60 s or
          shorter between a payer&rsquo;s settled payments to the same resource. It describes payment timing and does not
          change the verdict. Settled payments do not show whether a payment was a retry.
        </p>
        <TableScroll label="Decision reason codes">
          <table className="fact-table">
            <caption className="sr-only">
              Decision reason codes: meaning, what it means for the payer, and whether the seller can fix it
            </caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Verdict</th>
                <th scope="col">What it means</th>
                <th scope="col">For the payer</th>
                <th scope="col">Seller can fix</th>
              </tr>
            </thead>
            <tbody>
              {REASON_CODES.map((r) => (
                <tr key={r.code} id={`reason-${r.code.replace(/[^a-z0-9_]/g, "")}`}>
                  <td className="whitespace-nowrap text-brand-deep">
                    <code>{r.code}</code>
                    {r.role === "payee" ? <span className="block text-xs text-brand-lift">role=payee</span> : null}
                  </td>
                  <td className="whitespace-nowrap text-brand-deep">{EFFECT_LABEL[r.effect]}</td>
                  <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">{r.meaning}</td>
                  <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">{r.forPayer}</td>
                  <td className="whitespace-nowrap text-brand">{SELLER_FIX_LABEL[r.sellerCanFix]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </DocBodySection>

      {/* 2026-08-13 UX監査R1 [C6]: ALLOW/WARN/BLOCK は全ページに出ているのに、
          境界値がサイトのどこにも書いていなかった。運用者ペルソナは
          「WARN が来たらどうすればいいのか」が決められず統合コードを書けずに
          離脱している。閾値は src/lib/chain/config.ts の SCORE_THRESHOLDS を
          そのまま写す（記憶で書かない）。SDK 既定の fail-closed も、閾値と
          同じ場所で言わないと「WARN は通るのだろう」と読まれる。 */}
      <DocBodySection id="score-bands" title="Score bands (agent, wallet and payee scores)" className="space-y-3">
        <p className="text-[0.84375rem] text-brand">
          Every scored response carries a numeric score and a{" "}
          <code className="text-brand-deep">recommendation</code>. The bands are fixed and the same
          for the agent, wallet and payee engines:
        </p>
        <TableScroll label="Score bands and recommended handling">
          <table className="fact-table">
            <caption className="sr-only">
              Score thresholds for ALLOW, WARN and BLOCK, and what to do with each
            </caption>
            <thead>
              <tr>
                <th scope="col">Verdict</th>
                <th scope="col" className="num">
                  Score
                </th>
                <th scope="col">What it means</th>
                <th scope="col">Recommended handling</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-brand-deep">ALLOW</td>
                <td className="num whitespace-nowrap text-brand-deep">70 &ndash; 100</td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Every check completed and nothing adverse was found.
                </td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Proceed. This is the only band the SDK and the middleware pass by default.
                </td>
              </tr>
              <tr>
                <td className="text-brand-deep">WARN</td>
                <td className="num whitespace-nowrap text-brand-deep">40 &ndash; 69</td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Not cleared. Something is thin, unusual, or only partially measured &mdash; not
                  enough to condemn the address, not enough to pass it either.
                </td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Decide deliberately rather than by default: allow it under a spend ceiling, queue
                  it for review, or require a second signal.
                </td>
              </tr>
              <tr>
                <td className="text-brand-deep">BLOCK</td>
                <td className="num whitespace-nowrap text-brand-deep">0 &ndash; 39</td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Adverse signals, a blacklist hit, or a check that could not be completed at all
                  (<code>degraded: true</code>).
                </td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Do not pay. A degraded BLOCK is a refusal to answer, not a finding &mdash; retry
                  once the upstream recovers.
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
        <ul className="list-disc space-y-2 pl-5 text-[0.84375rem] text-brand">
          <li>
            <strong>Band the recommendation, not the number.</strong> Read{" "}
            <code>recommendation</code>, not <code>trustScore &gt;= 70</code>. A blacklisted address
            and a degraded verdict are <code>BLOCK</code> regardless of what the number says, so a
            numeric comparison in your own code will disagree with ours on exactly the cases that
            cost money.
          </li>
          <li>
            <strong>The default is allow-only, and that is the point.</strong>{" "}
            <code>@vet402/sdk</code> and <code>@vet402/middleware</code> deny everything
            that is not <code>ALLOW</code> unless you opt out explicitly. The asymmetry is
            deliberate: declining a good payee costs a retry, paying a bad one is final under x402&apos;s exact
            scheme.
          </li>
          <li>
            <strong>WARN is where your policy lives, not vet402&apos;s.</strong> vet402 publishes the band and the
            raw signals behind it; what an acceptable risk is at your transaction size is yours to
            set. The one handling vet402 argues against is treating WARN as a quiet ALLOW &mdash; vet402&apos;s{" "}
            <Link href="/accuracy" className="doc-link">
              operator benchmark
            </Link>{" "}
            currently scores known-bad addresses WARN rather than BLOCK in a minority of cases, so
            a pass-on-WARN integration would pay those.
          </li>
        </ul>
      </DocBodySection>

      {/* 2026-08-06: capacity planning. Quotas were on the pricing page but the
          burst behaviour was nowhere — a synchronous gate needs both to size a
          deployment. Values are read from the code (auth.ts PLAN_LIMITS,
          ip-rate-limit call sites), not asserted. */}
      <DocBodySection id="judgments" title="Daily judgments (CDN JSON)" className="space-y-3">
        <p className="text-[0.84375rem] text-brand">
          <code>GET /api/v1/judgments/&#123;file&#125;</code> publishes one JSON judgment per active
          listing in the catalog, built once per UTC day from the same payer record as key-less{" "}
          <code>/decision</code> (no score, no caller_policy). There is no IP rate limit on this path.
          Responses cache at the CDN until the next UTC midnight. A document whose <code>spending_halted</code> or{" "}
          <code>degraded</code> is true caches for 5 minutes instead. Start at{" "}
          <code>/api/v1/judgments/index.json</code>, follow a shard in <code>index-&#123;xx&#125;.json</code>,
          then open <code>&#123;resource_id&#125;.json</code>. Each document carries <code>live</code> for the
          answer as of now. License CC-BY-4.0.
        </p>
      </DocBodySection>

      <DocBodySection id="rate-limits" title="Rate limits" className="space-y-3">
        <p className="text-[0.84375rem] text-brand">
          Scoring is synchronous, so plan for both the monthly quota and the
          burst behaviour below.
        </p>
        <TableScroll label="Monthly request quota by plan">
          <table className="fact-table">
            <caption className="sr-only">Monthly request quota by plan</caption>
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col" className="num">Monthly requests</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="text-brand-deep">Free</td><td className="num text-brand-deep">1,000</td></tr>
              <tr><td className="text-brand-deep">Pro</td><td className="num text-brand-deep">50,000</td></tr>
              <tr><td className="text-brand-deep">Scale</td><td className="num text-brand-deep">500,000</td></tr>
            </tbody>
          </table>
        </TableScroll>
        <ul className="list-disc space-y-2 pl-5 text-[0.84375rem] text-brand">
          <li>
            <strong>Quota is per calendar month (UTC)</strong> and shared across
            all keys on an account. Each <code>/score</code> call is 1 unit; a{" "}
            <code>/scores/batch</code> of N agents is N units. Every scored
            response carries <code>X-RateLimit-Limit</code>,{" "}
            <code>X-RateLimit-Used</code>, and <code>X-RateLimit-Remaining</code>{" "}
            headers so you can track consumption without a separate call.
          </li>
          <li>
            <strong>What spends the monthly units, and what does not.</strong> Only calls that
            carry your key spend units: each score call (agent, wallet, payee), each{" "}
            <code>/decision</code> sent with a key, and the other keyed routes in the reference
            below are 1 unit per call (a batch of N is N). Key-less calls spend no monthly
            units: <code>/decision</code> without a key ({keylessDecisionPerMinute()}/min per IP), <code>/resolve</code>{" "}
            (60/min per IP), and the observatory and accuracy reads each have their own per-IP
            window instead. Those key-less paths return{" "}
            <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code>, and{" "}
            <code>RateLimit-Reset</code> (not <code>X-RateLimit-*</code>, which is only for
            monthly score quota).
          </li>
          <li>
            <strong>No per-second burst throttle on authenticated calls today.</strong>{" "}
            Authenticated requests are governed by the monthly quota only — you
            may spend it as fast as you like — so pace client-side if you must
            not exhaust the month in one run.
          </li>
          {/* 2026-08-13 UX監査2巡目 [m1]: ここの数字が実測と合っていなかった。
              「payee-verify を 10/minute/IP」と書いていたが、実際に本番へ投げると
              `RateLimit-Limit: 30` が返る（GET と POST で別の上限であることが
              docs に無かった）。値は各 route.ts の定数から写している。 */}
          <li>
            <strong>Abuse throttles (IP-based), per minute.</strong> Key-less and
            pre-auth paths carry their own IP cap, independent of the quota:
            authentication <em>failures</em> 60; the unauthenticated demo scorer
            10; <code>GET /api/v1/accuracy</code> 20; the badge SVGs 60; the agent
            passport 20. Verify endpoints split read from write:{" "}
            <code>GET</code> (message preview) 30/IP, while <code>POST</code> is
            8/IP <em>and</em> 4 per wallet or agent, so one identity cannot rewrite
            its public profile in a loop from many IPs. Valid authenticated traffic
            does not hit any of these.
          </li>
        </ul>
        {/* 2026-08-13 [m1]: 429 は2系統あり、区別できないと誤ったリトライを
            書かれる（月次枯渇に指数バックオフを掛けても、翌月まで通らない）。 */}
        <h3 className="sub-head">Two kinds of 429</h3>
        <TableScroll label="The two distinct causes of an HTTP 429">
          <table className="fact-table">
            <caption className="sr-only">
              The two distinct causes of an HTTP 429 and how to tell them apart
            </caption>
            <thead>
              <tr>
                <th scope="col">Cause</th>
                <th scope="col">Body</th>
                <th scope="col">Headers</th>
                <th scope="col">What to do</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-brand-deep">Monthly quota spent (authenticated)</td>
                <td className="break-all text-brand">
                  <code>error: &quot;rate_limit_exceeded&quot;</code> with{" "}
                  <code>retryAfter</code>, <code>usage</code>, <code>limit</code>
                </td>
                <td className="break-all text-brand">
                  <code>X-RateLimit-*</code> and <code>Retry-After</code> (seconds to the start of
                  next month, UTC)
                </td>
                <td className="text-brand">
                  Stop. Retrying inside the month cannot succeed — raise the plan or wait for the
                  reset.
                </td>
              </tr>
              <tr>
                <td className="text-brand-deep">IP throttle (key-less / pre-auth paths)</td>
                <td className="break-all text-brand">
                  <code>error: &quot;rate_limited&quot;</code>
                </td>
                <td className="break-all text-brand">
                  <code>RateLimit-Limit</code> / <code>-Remaining</code> / <code>-Reset</code> and{" "}
                  <code>Retry-After</code> (seconds, always under 60)
                </td>
                <td className="text-brand">
                  Sleep for <code>Retry-After</code> and retry. The window is one minute.
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
        <p className="text-[0.84375rem] text-brand-lift">
          The header families are deliberately different names:{" "}
          <code className="text-brand-deep">X-RateLimit-*</code> reports the monthly plan quota,{" "}
          <code className="text-brand-deep">RateLimit-*</code> (IETF draft names) reports the
          short IP window. No route sets both families on the same response.
        </p>
      </DocBodySection>

      <DocBodySection id="endpoints" title="Endpoints" className="space-y-5">
        <ApiEndpointsSection />
      </DocBodySection>

      <DocBodySection id="score-breakdown" title="Score breakdown" className="space-y-3">
        {/* 2026-08-06 N-21: explainability. Integrators kept asking "why this
            number" — the breakdown answers it in the response itself, so a
            compliance log can record the arithmetic, not just the verdict. */}
        <p className="text-[0.84375rem] text-brand">
          Every scored verdict (agent and wallet endpoints, and each element of a
          batch) carries a <code className="text-brand-deep">breakdown</code>{" "}
          object that decomposes the chain score into its four weighted
          components. It is derived from the same numbers the verdict used, so it
          can never disagree with <code className="text-brand-deep">trustScore</code>.
        </p>
        <ul className="list-disc space-y-2 pl-5 text-[0.84375rem] text-brand">
          <li>
            <strong>components</strong> — each of <code>identity</code>,{" "}
            <code>reputation</code>, <code>wallet</code>, <code>x402</code> reports
            its 0–100 <code>score</code>, its <code>weight</code>, and its{" "}
            <code>contribution</code> (<code>score × weight ÷ 0.8</code>; the four
            contributions sum to <code>weightedSubtotal</code>). Weights are
            identity&nbsp;0.05, reputation&nbsp;0.10, wallet&nbsp;0.25, x402&nbsp;0.40
            — divided by 0.8 because the customer whitelist/blacklist is a policy
            layer, not a signal. Weighted toward the signals that are hardest to
            fake: a real settled x402 payment history counts most, self-asserted
            identity and reputation least. ALLOW additionally requires verifiable
            on-chain evidence — self-assertion alone is capped below ALLOW.
          </li>
          <li>
            <strong>weightedSubtotal</strong> — the weighted average of the four
            components, before any sybil adjustment.
          </li>
          <li>
            <strong>sybilPenalty</strong> — points removed by sybil / data-
            availability flags (always ≤ 0). The specific flags are in{" "}
            <code>signals.sybil.flags</code>.
          </li>
          <li>
            <strong>prePolicyScore</strong> —{" "}
            <code>weightedSubtotal + sybilPenalty</code>, clamped to 0–100. This
            equals <code>trustScore</code> unless a manual list moved it, in which
            case <code>manualOverride</code> is <code>true</code>. The manual
            layer is deliberately kept out of the breakdown so the chain-derived
            explanation stays separable from policy.
          </li>
        </ul>
        <p className="text-[0.84375rem] text-brand">
          Hard-blocked verdicts (wallet mismatch, unregistered agent) omit{" "}
          <code className="text-brand-deep">breakdown</code> — no weighting
          ran — and carry a <code className="text-brand-deep">blockReason</code>{" "}
          instead. Treat the field as optional.
        </p>

        {/* 2026-08-13 UX監査2巡目 [M6]: /payee/:address が出す "37 / 100 · data:
            thin" の出所を書く場所がどこにも無かった。ここが /payee 頁からの
            リンク先（#payee-score）で、閾値と重みは
            src/lib/scoring/payee-engine.ts の determineDataDepth /
            l1DeliveryDepth / WEIGHTS_BY_DEPTH を写している。 */}
        <div id="payee-score" className="scroll-mt-32 space-y-3">
          <h3 className="sub-head">Payee score</h3>
          <p className="text-[0.84375rem] text-brand">
            <code className="break-all text-brand-deep">
              GET /api/v1/payees/:address/score
            </code>{" "}
            — and the public page at{" "}
            <code className="break-all text-brand-deep">/payee/:address</code> — runs a different
            engine from the agent/wallet endpoints above and carries no{" "}
            <code>breakdown</code> object. It weighs three tracks, and the weights shift with how
            much receiving history the wallet actually has, because a cold wallet cannot be judged
            on a track record it does not have.
          </p>
          <TableScroll label="Payee score component weights by data depth">
            <table className="fact-table">
              <caption className="sr-only">
                Payee score component weights by data depth
              </caption>
              <thead>
                <tr>
                  <th scope="col">
                    <code>dataDepth</code>
                  </th>
                  <th scope="col">Means</th>
                  <th scope="col" className="num">
                    Receiving
                  </th>
                  <th scope="col" className="num">
                    Wallet health
                  </th>
                  <th scope="col" className="num">
                    Drain pattern
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-brand-deep">thin</td>
                  <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                    under 3 payments received, or from under 2 distinct payers — and under 3
                    vet402-verified deliveries over 2+ days
                  </td>
                  <td className="num text-brand-deep">15%</td>
                  <td className="num text-brand-deep">45%</td>
                  <td className="num text-brand-deep">40%</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">moderate</td>
                  <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                    3+ payments received from 2+ distinct payers, or 3+ vet402-verified
                    deliveries over 2+ days
                  </td>
                  <td className="num text-brand-deep">35%</td>
                  <td className="num text-brand-deep">35%</td>
                  <td className="num text-brand-deep">30%</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">rich</td>
                  <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                    10+ payments received across 7+ days from 3+ distinct payers, or 10+
                    vet402-verified deliveries across 7+ days
                  </td>
                  <td className="num text-brand-deep">50%</td>
                  <td className="num text-brand-deep">25%</td>
                  <td className="num text-brand-deep">25%</td>
                </tr>
              </tbody>
            </table>
          </TableScroll>
          <ul className="list-disc space-y-2 pl-5 text-[0.84375rem] text-brand">
            <li>
              <strong>What lifts a payee out of &ldquo;thin&rdquo; is an observed fact, never a
              claim.</strong>{" "}
              Two facts count, and only these two. Owner-signed x402 settlements from payers whose
              funding sources are independent (a cluster funded by one address counts as one
              payer). And vet402&rsquo;s own L1 purchases in which the observatory paid the
              address, confirmed the settlement on chain and confirmed the purchased resource was
              delivered — counted by deliveries and by distinct days, because the buyer is always
              vet402 itself and a seller cannot forge or schedule those purchases. Until one of
              those facts exists, the score is capped one point under ALLOW no matter how healthy
              the wallet looks. A payment vet402 made that never settled, or settled without
              delivery, adds nothing here (it is disclosed as{" "}
              <code>l1PaidNeverSettled</code> and can only lower the ceiling).
            </li>
            <li>
              <strong>The raw inputs are in the response.</strong>{" "}
              <code>signals.receiving</code> reports{" "}
              <code>paymentCount / uniqueDays / distinctPayers</code>,{" "}
              <code>signals.walletHealth</code> reports{" "}
              <code>ageDays / txCount / isBurner</code>, and{" "}
              <code>signals.drainPattern</code> reports the in/out counts and ratio — each with
              its own 0–100 <code>score</code>, so the weighted arithmetic above can be re-run
              from the payload.
            </li>
            <li>
              <strong>
                <code>degraded: true</code> is a refusal, not a reading.
              </strong>{" "}
              It means an input could not be read at all. Callers receive a fail-closed{" "}
              <code>BLOCK</code>; the public page prints{" "}
              <em>&ldquo;Not verifiable right now&rdquo;</em> rather than a number, because a
              specific accusation against a named wallet must not rest on an upstream outage.
              <code>dataDepth</code> answers a different question — how much history exists — and
              a data-poor wallet read completely is not the same thing.
            </li>
            <li>
              <strong>Outcomes adjust the score after weighting.</strong>{" "}
              <code>signals.outcomeHistory</code> carries the outcome types on record and the
              points they moved, which is the same ledger{" "}
              <Link href="/accuracy" className="doc-link">
                /accuracy
              </Link>{" "}
              aggregates.
            </li>
          </ul>
        </div>
      </DocBodySection>

      <DocBodySection id="webhooks" title="Webhooks" className="space-y-4">
        {/* 2026-08-06 N-15/C-9 doc gap: the watchlist mentioned the
            watch.verdict_changed webhook but nothing documented registration,
            the payload envelope, or signature verification — the receiver could
            not prove a "ALLOW→BLOCK" notice was really from vet402. This section is
            written from src/lib/webhooks.ts, not from memory. */}
        <p className="text-[0.84375rem] text-brand">
          vet402 is otherwise a pull API. Webhooks turn it into a monitoring
          service: register an endpoint once and vet402 POSTs you a signed event when
          something you care about changes — most importantly a watched target
          whose verdict moved (e.g. an <code>ALLOW</code> you gated a payment on
          becoming a <code>BLOCK</code>). Register with{" "}
          <code className="text-brand-deep">POST /api/v1/webhooks</code>{" "}
          (above); up to 5 endpoints per key.
        </p>

        <div>
          <h3 className="sub-head">Events</h3>
          <TableScroll label="Webhook event types and their payloads">
            <table className="fact-table">
              <caption className="sr-only">Webhook event types and their payloads</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Fires when</th>
                  <th scope="col"><code>data</code> fields</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-brand-deep">watch.verdict_changed</td>
                  <td className="text-brand">A watchlist target&apos;s recommendation changes on a re-scan (daily cron). Verdict changes only — not score jitter.</td>
                  <td className="break-all text-[0.75rem] text-brand">watchId, targetType, target, chainId, previous&#123;score,recommendation&#125;, current&#123;score,recommendation&#125;</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">outcome.recorded</td>
                  <td className="text-brand">An outcome (auto-detected or partner-reported) lands on a verdict you requested.</td>
                  <td className="break-all text-[0.75rem] text-brand">trustEventId, outcomeType, source, wallet, agentId</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">list.changed</td>
                  <td className="text-brand">Your own manual whitelist/blacklist changes (also on import) — a team audit trail.</td>
                  <td className="break-all text-[0.75rem] text-brand">action, wallet, listType</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">endpoint.delisted</td>
                  <td className="text-brand">An x402 endpoint paying a wallet you claim-proved via POST /api/v1/observatory/watch vanished from the public discovery catalog on a complete fetch (daily observatory sync). Factual listing-state notice, not an operator assessment.</td>
                  <td className="break-all text-[0.75rem] text-brand">resourceKey, resourceUrl, payTo, detectedOn, lastSeenAt, historyUrl</td>
                </tr>
              </tbody>
            </table>
          </TableScroll>
          <p className="mt-2 text-[0.84375rem] text-brand">
            A score is never pushed — scores are computed on demand and pushing a
            cached one would invite treating a stale number as fresh.
          </p>
        </div>

        <div>
          <h3 className="sub-head">Delivery payload</h3>
          <p className="mt-1 text-[0.84375rem] text-brand">
            Every delivery is a JSON POST with this envelope. <code>id</code> is
            unique per event — dedupe on it (see idempotency below).
          </p>
          <CodeBlock
            className="mt-2"
            label="Webhook delivery payload envelope"
            code={`POST https://your-host.example/vouch-hook
Content-Type: application/json
Vouch-Signature: t=1723000000,v1=5f2b…   (hex HMAC-SHA256)
User-Agent: vouch-webhooks/1

{
  "id": "evt_9f8a…",
  "type": "watch.verdict_changed",
  "createdAt": "2026-08-06T09:30:00.000Z",
  "data": {
    "watchId": "…",
    "targetType": "wallet",
    "target": "0x…",
    "chainId": 8453,
    "previous": { "score": 74, "recommendation": "ALLOW" },
    "current":  { "score": 31, "recommendation": "BLOCK" }
  }
}`}
          />
        </div>

        <div>
          <h3 className="sub-head">Verifying the signature</h3>
          <p className="mt-1 text-[0.84375rem] text-brand">
            The <code>Vouch-Signature</code> header is{" "}
            <code>t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, where{" "}
            <code>v1</code> is <code>HMAC-SHA256(secret, `${"{"}t{"}"}.${"{"}rawBody{"}"}`)</code>{" "}
            — the timestamp, a literal dot, then the <strong>raw</strong> request
            body. Recompute it with your <code>whsec_…</code> secret, compare in
            constant time, and reject if the timestamp is more than 5 minutes from
            now (replay guard). The reference implementation is below — copy it
            as-is.
          </p>
          <CodeBlock
            className="mt-2"
            label="Node.js webhook signature verification example"
            code={`import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, header, toleranceSec = 300) {
  const parts = new Map(header.split(",").map(p => {
    const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)];
  }));
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false; // replay guard
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}`}
          />
        </div>

        <div>
          <h3 className="sub-head">Delivery, retries &amp; idempotency</h3>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-[0.84375rem] text-brand">
            <li>
              <strong>At-most-once, no retry.</strong> Each event is delivered
              once with a 5-second timeout. A non-2xx response or timeout is not
              re-delivered — it increments a failure counter instead. A 2xx resets
              that counter to zero. (Design your handler to catch up by polling
              the watchlist / outcome endpoints, not by relying on redelivery.)
            </li>
            <li>
              <strong>Auto-disable.</strong> After 20 consecutive failed
              deliveries the endpoint is disabled to stop wasting egress on a dead
              URL. Re-create it (<code>POST /api/v1/webhooks</code>) to re-enable —
              a new secret is issued.
            </li>
            <li>
              <strong>Idempotency.</strong> Treat <code>id</code> as an
              idempotency key: store processed ids and ignore a repeat, so a
              duplicate dispatch (e.g. overlapping cron passes) is a no-op on your
              side.
            </li>
            <li>
              <strong>SSRF safety / redirects.</strong> The target URL is
              re-validated at delivery time and redirects are rejected (a redirect
              at delivery is an SSRF vector, not a feature). Point the endpoint at
              its final https URL directly.
            </li>
          </ul>
        </div>
      </DocBodySection>

      <DocBodySection id="availability" title="Availability" className="space-y-3">
        {/* 2026-08-06: B2B buyers ask for an SLA. Written to the real
            operational posture (single-operator closed beta on Vercel + Neon +
            Base RPC, daily deep health probe), not an aspirational number —
            same honesty discipline as the /accuracy page. Revise the target
            when the operating history and infrastructure justify a commitment. */}
        {/* 2026-09-29 敵対的監査: 「closed beta」と書いていたが、本番は招待コードを求めず
            （GET /api/signup が inviteRequired:false）、無料キーは誰でも発行できる。
            招待制に戻したときに文言が嘘にならないよう、同じ関数（BETA_INVITE_CODE）で分ける。 */}
        <p className="text-[0.84375rem] text-brand">
          vet402 is an early-stage service run by a single operator.{" "}
          {inviteRequired ? (
            <>Keys are issued by invite code for now.</>
          ) : (
            <>
              Anyone can create a free key at{" "}
              <Link href="/signup" className="doc-link">
                /signup
              </Link>
              ; there is no waitlist.
            </>
          )}{" "}
          vet402 publishes its real operating posture rather than a contractual uptime figure it
          can&apos;t yet stand behind:
        </p>
        <ul className="list-disc space-y-2 pl-5 text-[0.84375rem] text-brand">
          <li>
            <strong>No SLA credits during beta.</strong> Service is best-effort,
            with no financial uptime guarantee. When vet402 commits to a numeric target
            it will be backed by measured operating history. vet402 would rather
            under-promise than publish a number the way some vendors publish
            accuracy claims they never measured.
          </li>
          <li>
            <strong>Infrastructure.</strong> Serverless compute (Vercel),
            managed Postgres (Neon), and Base RPC. Availability inherits from
            these providers; there is no independent multi-region failover today.
          </li>
          <li>
            <strong>Fail-closed, not fail-wrong.</strong> When an upstream (RPC,
            indexer, settlement store) is unavailable, the affected signal is
            marked with an <code>*_unavailable</code> flag and penalized rather
            than guessed — a degraded lookup returns a more cautious verdict, not
            a confidently wrong one. Each response&apos;s <code>dataCoverage</code>{" "}
            reports indexer and settlement freshness so you can see what the score
            could draw on.
          </li>
          <li>
            <strong>Monitoring.</strong> A public health endpoint,{" "}
            <code>GET /api/health</code>, returns <code>200</code>/<code>503</code>{" "}
            for uptime pollers. It probes both scoring engines &mdash; seller-side
            and buyer-side &mdash; and reports the worse of the two.{" "}
            <code>200</code> means both answered from complete inputs; anything
            else is <code>503</code>, including a <code>degraded</code> verdict
            where the engine still answers but could not read everything (that is
            what a visitor sees as &ldquo;Not verifiable right now&rdquo;). The
            JSON body carries <code>{"\"degraded\""}</code> or{" "}
            <code>{"\"error\""}</code> so you can tell a partial outage from a
            total one. A deeper env/DB/RPC probe runs on a daily cron and returns{" "}
            <code>503</code> only on a critical failure (indexer catch-up lag is
            reported, not alerted, to avoid backfill alert fatigue).
          </li>
          <li>
            <strong>Status &amp; incidents.</strong> See{" "}
            <Link href="/status" className="doc-link">
              /status
            </Link>
            . During beta, material incidents are communicated to integrators
            directly. Your own uptime monitor can point at <code>/api/health</code>.
          </li>
        </ul>
      </DocBodySection>

      <DocBodySection id="error-codes" title="Error codes" className="space-y-3">
        <TableScroll label="HTTP error codes returned by the vet402 API">
          <table className="fact-table">
            {/* 2026-08-06 a11y: caption + scope="col" bring this table up to the
                same standard /accuracy and /leaderboard already meet, so a
                screen reader announces the column a cell belongs to. */}
            <caption className="sr-only">HTTP error codes returned by the vet402 API</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Meaning</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {errorCodes.map((e) => (
                <tr key={e.status}>
                  <td className="text-brand-deep">{e.status}</td>
                  <td className="text-brand-deep">{e.meaning}</td>
                  <td className="text-brand">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <p className="text-[0.84375rem] text-brand">
          Error bodies are shaped as <code className="text-brand-deep">{`{ "error": string, "details"?: object }`}</code>.
        </p>
      </DocBodySection>

        <p className="text-[0.84375rem]">
          <Link href="/" className="doc-link">
            The memo
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/faq" className="doc-link">
            FAQ
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/dashboard" className="doc-link">
            Dashboard
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/dashboard/integrations" className="doc-link">
            Integrations
          </Link>
        </p>

    </>
  );
}
