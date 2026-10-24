// A-11: public pages name the three measurements. The 0 to 100 score is an older API signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FAQS } from "@/components/site/faq-data";
import { BLOG_POSTS } from "@/lib/blog";

const read = (rel: string) => readFileSync(rel, "utf8");
const firstSentences = (s: string) => s.split(/(?<=\.)\s/);

const Q3_OPENING =
  "vet402 publishes three measurements. L0 asks whether the payment wall answers a valid 402. L1 asks whether a real purchase settled and the response arrived. L2 asks whether that response matches the seller's own declaration. The 0 to 100 score with ALLOW, WARN, or BLOCK is an older signal for API callers. A score is never printed as an L0 to L2 result.";

test("/faq Q3 opens on the three measurements and the L0 sentence comes before L1 and L2", () => {
  const q3 = FAQS[2];
  assert.equal(q3?.question, "What does vet402 actually compute?");
  assert.ok(q3!.answer.startsWith(Q3_OPENING));
  const sentences = firstSentences(q3!.answer);
  assert.equal(sentences[0], "vet402 publishes three measurements.");
  assert.ok(sentences[1].startsWith("L0"), `Q3 measurement sentence does not start with L0: ${sentences[1]}`);
  assert.ok(read("src/app/faq/page.tsx").includes("FAQS.map"), "/faq renders FAQS, so this answer is the page");
  assert.ok(FAQS.some((item) => item.answer.includes("/sellers")), "/faq does not point providers at /sellers");
});

test("画面の Q5 の答えは、決済と配信の句と観測所の句をピリオドでつなぎ、ダッシュを描かない", () => {
  const item = FAQS[4];
  assert.equal(item?.question, "Who is vet402 for — agents, or the providers agents pay?");
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement("span", null, "Q5"),
      createElement("h2", null, item!.question),
      createElement("p", null, item!.answer),
    ),
  );
  const answer = html.slice(html.indexOf("<p>"));
  assert.match(answer, /settles and delivers\. The observatory&#x27;s L0\/L1\/L2 facts/);
  assert.equal(/[—–]|--/.test(answer), false);
  assert.match(html, /<h2>Who is vet402 for — agents, or the providers agents pay\?<\/h2>/);
});

test("/blog does not say trust scoring, and the 2026-07-21 note separates a purchase record from the score", () => {
  const page = read("src/app/blog/page.tsx");
  assert.equal(page.includes("trust scoring"), false);
  const post = BLOG_POSTS.find((p) => p.publishedAt === "2026-07-21");
  assert.ok(post);
  assert.ok(post!.description.endsWith("A purchase record is a separate result from the score."));
  assert.equal(post!.description.includes("trust scoring"), false);
});

test("the SDK description names independent checks, and the footer Use column links Sellers", () => {
  const pkg = JSON.parse(read("packages/sdk/package.json")) as { description: string };
  assert.equal(
    pkg.description,
    "Independent checks for x402 sellers. Read a measured decision before a payment, or let payOrRefuse pay on a supported chain only after every check passes.",
  );
  const footer = read("src/components/site/SiteFooter.tsx");
  assert.match(footer, /label: "Sellers", href: "\/sellers"/);
});
