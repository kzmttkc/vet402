import type { Metadata } from "next";
import Link from "next/link";
import TrackView from "@/components/site/TrackView";
import ConnectChooser from "@/components/connect/ConnectChooser";
import { CONNECT_CHOICES, CONNECT_LEAD, CONNECT_SIGNUP_HREF } from "@/lib/connect/snippets";
import { pageMetadata } from "@/lib/seo";
import styles from "./connect.module.css";

// 2026-11-08 製品の殻: 買う側・売る側・両方を選ぶ入口。説明と手順だけで、お金は動かさない。
// スニペットの出典と検査は src/lib/connect/snippets.ts と tests/connect-page.test.ts。
export const metadata: Metadata = pageMetadata({
  title: "Connect",
  description: `${CONNECT_LEAD} Start as a buyer, a seller or both, with curl, TypeScript, Python, MCP or no code.`,
  path: "/connect",
});

export default function ConnectPage() {
  return (
    <main className={styles.page}>
      <TrackView event="connect_view" />
      <article className={styles.article}>
        <div>
          <h1>{CONNECT_LEAD}</h1>
          <p className={styles.lede}>
            vet402 pays x402 sellers itself and keeps a public record of what came back. Pick your side and start in three steps.
          </p>
          <div className={styles.rule} />
        </div>

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
