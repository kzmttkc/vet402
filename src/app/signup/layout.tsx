import type { Metadata } from "next";
import { headers } from "next/headers";
import { BILLING_PLANS } from "@/lib/billing/plans";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

const FREE_QUOTA = BILLING_PLANS.free.monthlyLimit.toLocaleString("en-US");

/**
 * /signup の metadata の置き場所（2026-08-13 UX監査2巡目 [m2]）。
 *
 * page.tsx は "use client" なので metadata を export できない（Next.js は
 * クライアントコンポーネントの metadata を無視する）。このルート専用の
 * layout を1枚挟むのが公式の逃げ道。挟んでいなかったので、このページは
 * layout の default —— LP と同じ長い表題 —— をそのまま名乗っていた。
 *
 * 接尾辞は書かない。ルート layout の template "%s | vet402" が付ける。
 * 2026-08-14: openGraph/twitter/canonical を pageMetadata で個別化。
 */
export const metadata: Metadata = pageMetadata({
  title: "Get an API key",
  description:
    `Create a vet402 API key for score lookups. Observatory, seller checks, and payee lookup stay public without a key. Free: ${FREE_QUOTA} score lookups a month.`,
  path: "/signup",
});

export default async function SignupLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Get an API key", path: "/signup" },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      {children}
    </>
  );
}
