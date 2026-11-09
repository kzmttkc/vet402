// ============================================================
// 確認・配信停止の頁のトークン（URL の #）を解析へ渡さない（2026-11-02 監査 L1）。
// トークンは first-party site_events に載せない。# は頁先頭の inline script で URL から消す。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { NextRequest } from "next/server";
import { TOKEN_STASH_SCRIPT, clearLinkHash, readLinkHash } from "@/lib/observatory/token-page";

delete process.env.DATABASE_URL;

const open = (url: string) => {
  const dom = new JSDOM("<!doctype html><body></body>", { url, runScripts: "outside-only" });
  return dom.window;
};

test("script は # を URL から消し、頁はトークンを読める。消した後の URL に残らない", () => {
  const win = open("https://vet402.com/observatory/unsubscribe#id=abc&t=secret-token");
  win.eval(TOKEN_STASH_SCRIPT);
  assert.equal(win.location.href, "https://vet402.com/observatory/unsubscribe");
  assert.equal(readLinkHash(win as unknown as Window), "#id=abc&t=secret-token");
});

test("再読み込みしても同じタブなら読める。押し終えたら消える", () => {
  const win = open("https://vet402.com/observatory/confirm#t=secret-token");
  win.eval(TOKEN_STASH_SCRIPT);
  win.eval("delete window.__vet402LinkHash"); // 読み込み直し
  assert.equal(readLinkHash(win as unknown as Window), "#t=secret-token");
  clearLinkHash(win as unknown as Window);
  assert.equal(readLinkHash(win as unknown as Window), "");
  assert.equal(win.sessionStorage.length, 0);
});

test("sessionStorage が使えなくても # は消え、頁は読める", () => {
  const win = open("https://vet402.com/observatory/confirm#t=secret-token");
  Object.defineProperty(win, "sessionStorage", {
    get() {
      throw new Error("blocked");
    },
  });
  win.eval(TOKEN_STASH_SCRIPT);
  assert.equal(win.location.href, "https://vet402.com/observatory/confirm");
  assert.equal(readLinkHash(win as unknown as Window), "#t=secret-token");
  clearLinkHash(win as unknown as Window);
  assert.equal(readLinkHash(win as unknown as Window), "");
});

test("# の無い URL では何もしない・別の頁のトークンを読まない", () => {
  const win = open("https://vet402.com/observatory/confirm");
  win.sessionStorage.setItem("vet402-link:/observatory/unsubscribe", "#id=a&t=b");
  win.eval(TOKEN_STASH_SCRIPT);
  assert.equal(win.location.href, "https://vet402.com/observatory/confirm");
  assert.equal(readLinkHash(win as unknown as Window), "");
});

test("script が走らなかった頁でも # から読める（同じ部品で読む）", () => {
  const win = open("https://vet402.com/observatory/confirm#t=direct");
  assert.equal(readLinkHash(win as unknown as Window), "#t=direct");
});

test("2 頁とも <main> より前に script を置き、部品は URL に頼らず読む", () => {
  for (const page of ["src/app/observatory/confirm/page.tsx", "src/app/observatory/unsubscribe/page.tsx"]) {
    const src = readFileSync(page, "utf8");
    const at = src.indexOf("<TokenStashScript");
    assert.ok(at > 0, `${page}: TokenStashScript が無い`);
    assert.ok(at < src.indexOf("<main"), `${page}: main より後にある`);
  }
  const tag = readFileSync("src/components/site/TokenStashScript.tsx", "utf8");
  assert.match(tag, /nonce=\{nonce\}/);
  const action = readFileSync("src/components/site/SubscriptionAction.tsx", "utf8");
  assert.match(action, /readLinkHash\(window\)/);
  assert.match(action, /clearLinkHash\(window\)/);
  assert.doesNotMatch(action, /window\.location\.hash/);
});

test("CSP: connect-src に plausible.io が無い", async () => {
  const { proxy } = await import("@/proxy");
  const connectSrc = async (path: string) => {
    const res = await proxy(new NextRequest(`https://vet402.com${path}`));
    const csp = res.headers.get("content-security-policy") ?? "";
    return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src")) ?? "";
  };
  for (const path of ["/observatory/confirm", "/observatory/unsubscribe", "/", "/observatory"]) {
    const c = await connectSrc(path);
    assert.doesNotMatch(c, /plausible/, path);
    assert.match(c, /^connect-src 'self'/);
  }
});

test("古い説明を残さない（# は解析のビーコンに乗る前提で書く）", () => {
  for (const f of ["src/lib/observatory/record-subscriptions.ts", "src/components/site/SubscriptionAction.tsx"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /解析のビーコン(に|へ)(も)?(乗らない|送られない)/, f);
  }
});
