import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getAllPosts, getPostBySlug } from "@/lib/blog";
import { SITE_URL } from "@/lib/site-url";
import { safeJsonLd } from "@/lib/util/json-ld";
import { buildMonth } from "@/lib/build-month";
import { pageMetadata, breadcrumbJsonLd, publisherOrg } from "@/lib/seo";

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) return {};

  return pageMetadata({
    title: post.title,
    description: post.description,
    path: `/blog/${post.slug}`,
    ogType: "article",
    publishedTime: post.publishedAt,
    modifiedTime: post.updatedAt,
  });
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) notFound();

  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    // 2026-08-14: author/image は BlogPosting の推奨フィールド。author は
    // 擬名運用なので発行主体の Organization を充てる（新しい主張は足さない）。
    // image はファイル規約の og 画像（RFC 第1頁の組版）をそのまま指す。
    author: { "@type": "Organization", name: "vet402", url: SITE_URL },
    image: `${SITE_URL}/opengraph-image.png`,
    mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE_URL}/blog/${post.slug}` },
    publisher: publisherOrg(),
    url: `${SITE_URL}/blog/${post.slug}`,
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Blog", path: "/blog" },
    { name: post.title, path: `/blog/${post.slug}` },
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
        <script
          type="application/ld+json"
          nonce={nonce}
          // Browsers blank the reflected `nonce` attribute right after the
          // element is inserted (a CSP anti-exfiltration measure), which
          // otherwise trips a harmless React hydration-mismatch warning here.
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
        />

        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Note</span>
            <span>
              Published <span className="text-signal">{post.publishedAt}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>
              {post.updatedAt !== post.publishedAt ? `Updated ${post.updatedAt}` : buildMonth()}
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-10">{post.title}</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        {post.editorsNote ? (
          <p className="doc-note mt-8">{post.editorsNote}</p>
        ) : null}

        <div className="mt-8 space-y-4 text-brand">
          {post.body.map((paragraph, i) => (
            <p key={i} className="doc-p">
              {paragraph}
            </p>
          ))}
        </div>

        <p className="mt-10 text-[0.8125rem]">
          <Link href="/blog" className="doc-link">
            All posts
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
          <Link href="/signup" className="doc-link">
            Get an API key
          </Link>
        </p>
      </article>
    </main>
  );
}
