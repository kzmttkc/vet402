import Link from "next/link";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getAllPosts } from "@/lib/blog";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { buildMonth } from "@/lib/build-month";
import { SITE_URL } from "@/lib/site-url";

export const metadata: Metadata = pageMetadata({
  // 2026-08-13 [m2]: 接尾辞は layout の template "%s | vet402" が付ける。
  // ここに書くと「Blog — vet402 | vet402」になる。
  title: "Blog",
  description: "Notes on agent-to-agent payments, x402, and trust scoring on Base.",
  path: "/blog",
});

export default async function BlogIndexPage() {
  const posts = getAllPosts();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "vet402 blog",
    itemListElement: posts.map((post, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${SITE_URL}/blog/${post.slug}`,
      name: post.title,
    })),
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Blog", path: "/blog" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListJsonLd) }}
        />
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Notes</span>
            <span>
              Entries: <span className="text-signal">{posts.length}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>{buildMonth()}</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Blog</h1>
        <p className="mx-auto mt-3 max-w-[56ch] text-center text-brand-lift">
          Notes on agent-to-agent payments, x402, and trust scoring on Base.
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <ul className="mt-10 border-t border-brand-deep">
          {posts.map((post) => (
            <li key={post.slug} className="border-b border-hair py-6">
              <Link href={`/blog/${post.slug}`} className="doc-link text-[1.0625rem]">
                {post.title}
              </Link>
              <p className="doc-note mt-1">{post.publishedAt}</p>
              <p className="doc-p mt-2">{post.description}</p>
            </li>
          ))}
        </ul>

        <p className="mt-8 text-[0.8125rem]">
          <Link href="/" className="doc-link">
            Home
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">
            ·
          </span>
          <Link href="/docs/api" className="doc-link">
            API reference
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">
            ·
          </span>
          <a href="/blog/rss.xml" className="doc-link">
            RSS
          </a>
        </p>
      </article>
    </main>
  );
}
