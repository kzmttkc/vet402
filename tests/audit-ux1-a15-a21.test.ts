// A-15 / A-21 (2026-10-21). A loading.tsx on /payee/[address] makes Next stream
// a 200 shell before notFound(), and it parks the finished profile in a hidden
// slot until a script moves it. The mobile list has to be a <details> in the
// first HTML, not a button that waits for hydration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import PayeeNotFound from "@/app/payee/[address]/not-found";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("no loading.tsx above /payee/[address] (would soft-404 and hide the result)", () => {
  for (const rel of [
    "src/app/loading.tsx",
    "src/app/payee/loading.tsx",
    "src/app/payee/[address]/loading.tsx",
  ]) {
    assert.equal(
      existsSync(join(ROOT, rel)),
      false,
      `${rel} must not exist. It wraps the page in Suspense, so a bad address stays HTTP 200 and the score stays hidden without JS.`,
    );
  }
});

test("generateMetadata rejects a malformed payee address before writing a title", () => {
  const src = read("src/app/payee/[address]/page.tsx");
  const metaFn = src.slice(
    src.indexOf("export async function generateMetadata"),
    src.indexOf("export default async function"),
  );
  const check = metaFn.indexOf("if (!isValidAddress(address)) notFound()");
  const title = metaFn.indexOf("pageMetadata");
  assert.ok(check !== -1 && title !== -1 && check < title);
});

test("the finished payee main is not hidden and is not left aria-busy", () => {
  const src = read("src/app/payee/[address]/page.tsx");
  const main = src.slice(src.indexOf("return ("));
  assert.match(main, /<main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">/);
  assert.doesNotMatch(main.slice(0, 400), /hidden|aria-busy/);
});

test("malformed payee copy renders in HTML, with no dash", () => {
  const html = renderToStaticMarkup(createElement(PayeeNotFound));
  assert.match(html, /<h1[^>]*>That is not a valid wallet address<\/h1>/);
  assert.match(html, /A payee profile URL is <code>0x<\/code> followed by 40 hexadecimal characters\./);
  assert.doesNotMatch(html, /—|–/);
});

test("proxy answers a malformed payee with 404 HTML before the page renders", async () => {
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  const bad = await proxy(new NextRequest("http://localhost/payee/not-an-address"));
  assert.equal(bad.status, 404);
  assert.match(bad.headers.get("content-type") ?? "", /text\/html/);
  const html = await bad.text();
  assert.match(html, /<h1>That is not a valid wallet address<\/h1>/);
  assert.match(html, /A payee profile URL is <code>0x<\/code> followed by 40 hexadecimal characters\./);
  assert.doesNotMatch(html, /<script/i);
  const good = await proxy(
    new NextRequest("http://localhost/payee/0xd8da6bf26964af9d7eed9e03e53415d37aa96045"),
  );
  assert.notEqual(good.status, 404);
  const index = await proxy(new NextRequest("http://localhost/payee"));
  assert.notEqual(index.status, 404);
});

test("inputs under 640px use 16px, including the observatory fields", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /@media \(max-width: 639px\) \{\s*\.doc-input \{\s*font-size: 1rem;/);
  assert.match(css, /\.site-menu:not\(\[open\]\) > nav \{\s*display: none;/);
  const header = read("src/components/site/SiteHeader.tsx");
  const mobileNav = header.slice(header.indexOf('aria-label="Mobile navigation"'), header.indexOf("</nav>", header.indexOf('aria-label="Mobile navigation"')));
  assert.doesNotMatch(mobileNav, /\bflex\b/, "display:flex on the details panel overrides the closed state");
  const observatory = read("src/app/observatory/page.tsx");
  const form = observatory.slice(observatory.indexOf('action="/observatory"'), observatory.indexOf("</form>"));
  assert.match(form, /name="q"[\s\S]*max-sm:text-base/);
  assert.match(form, /name="verdict"[\s\S]*max-sm:text-base/);
  assert.match(form, /name="network"[\s\S]*max-sm:text-base/);
  const playground = read("src/app/playground/playground-client.tsx");
  assert.match(playground, /className="doc-input mt-1 w-full"/);
  assert.match(playground, /className="doc-input shrink-0/);
});
