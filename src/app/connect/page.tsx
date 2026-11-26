import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import TrackView from "@/components/site/TrackView";
import ConnectChooser from "@/components/connect/ConnectChooser";
import { TryInChatConnect } from "@/components/connect/TryInChatConnect";
import MonoCode from "@/components/connect/MonoCode";
import { PromptCopyButton } from "@/components/docs/PromptCopyButton";
import { MCP_FIRST_PROMPTS } from "@/lib/docs/mcp-first-prompts";
import {
  CONNECT_CHOICES,
  CONNECT_KEYLESS_CHECK_CURL,
  CONNECT_CHECK_SHAPE_NOTE,
  CONNECT_KEYLESS_SDK,
  CONNECT_LEAD,
  CONNECT_MCP,
  CONNECT_PASTE_HREF,
  CONNECT_SIGNUP_HREF,
} from "@/lib/connect/snippets";
import { breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import styles from "./connect.module.css";

// 2026-11-08 製品の殻: 買う側・売る側・両方を選ぶ入口。説明と手順だけで、お金は動かさない。
// スニペットの出典と検査は src/lib/connect/snippets.ts と tests/connect-page.test.ts。
const CONNECT_DESCRIPTION = `${CONNECT_LEAD} Start as a buyer, a seller or both, with curl, TypeScript, Python, MCP or no code.`;

export const metadata: Metadata = pageMetadata({
  title: "Connect vet402 for x402 buyer and seller agents",
  description: CONNECT_DESCRIPTION,
  path: "/connect",
});

export default async function ConnectPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Connect", path: "/connect" },
  ]);
  const webPage = webPageJsonLd({
    name: "Connect vet402",
    description: CONNECT_DESCRIPTION,
    path: "/connect",
  });

  return (
    <main className={styles.page}>
      <TrackView event="connect_view" />
      <article className={styles.article}>
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
          dangerouslySetInnerHTML={{ __html: safeJsonLd(webPage) }}
        />
        <div>
          <h1>{CONNECT_LEAD}</h1>
          <p className={styles.lede}>
            vet402 pays x402 sellers itself and keeps a public record of what came back. Pick your side and start in three steps.
          </p>
          <div className={styles.rule} />
        </div>

        <section className={styles.keyless} aria-labelledby="connect-keyless-heading">
          <h2 id="connect-keyless-heading" className={styles.sectionHeading}>
            Three ways that work without a key today
          </h2>
          <ol className={styles.keylessList}>
            <li className={styles.keylessItem}>
              <p className={styles.keylessLabel}>
                <code className={styles.inlineCode}>GET /api/v1/check?url=…</code>
              </p>
              <MonoCode code={CONNECT_KEYLESS_CHECK_CURL} label="curl check without a key" />
            </li>
            <li className={styles.keylessItem}>
              <p className={styles.keylessLabel}>
                The paste field on the{" "}
                <Link href={CONNECT_PASTE_HREF} className={styles.link}>
                  home page
                </Link>
              </p>
            </li>
            <li className={styles.keylessItem}>
              <p className={styles.keylessLabel}>The vet402 package</p>
              <MonoCode code={CONNECT_KEYLESS_SDK} label="TypeScript check without a key" />
            </li>
          </ol>
          <p className={styles.intro}>{CONNECT_CHECK_SHAPE_NOTE}</p>
        </section>

        <section className={styles.stack} aria-labelledby="connect-mcp-heading">
          <h2 id="connect-mcp-heading" className={styles.stackHeading}>
            {CONNECT_MCP.stack}
          </h2>
          <p className={styles.intro}>{CONNECT_MCP.intro}</p>
          <MonoCode code={CONNECT_MCP.code} label="MCP config without a key" />
          <PromptCopyButton prompt={MCP_FIRST_PROMPTS[0]!.prompt} label="Copy first chat prompt" />
        </section>

        <TryInChatConnect />

        <section className={styles.stack} aria-labelledby="connect-key-heading">
          <h2 id="connect-key-heading" className={styles.stackHeading}>
            When you need a key
          </h2>
          <p className={styles.intro}>
            Score lookups above the keyless limit, dashboard tools, and seller gates need a free API key. Seller checks
            with GET /api/v1/check or the home paste field need no key.
          </p>
          <p className={styles.intro}>
            <Link href={CONNECT_SIGNUP_HREF} className={styles.link}>
              Get a free API key
            </Link>
          </p>
        </section>

        <ConnectChooser choices={CONNECT_CHOICES} signupHref={CONNECT_SIGNUP_HREF} />

        <p className={styles.foot}>
          Full reference:{" "}
          <Link href="/docs/api" className={styles.link}>
            API
          </Link>{" "}
          and{" "}
          <Link href="/docs/mcp" className={styles.link}>
            hosted MCP
          </Link>
          .
        </p>
      </article>
    </main>
  );
}