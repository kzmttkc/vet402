// ============================================================
// 2026-10-31 Microsoft Clarity（オーナー承認 10/31）。Project ID は未着。
// - ID が無ければ何も出さない（今の本番の挙動を変えない）。
// - EEA・UK・スイスと国不明は、同意を取るまで Clarity を呼ばない。断ったら denied を送って止める。
// - それ以外の地域は既定で記録し、Privacy choices から止められる。
// - CSP に Clarity の読み込み先を足すのは ID がある時の HTML 頁だけ。API・CSV・MCP の応答は変えない。
// - 鍵・財布アドレス・検索の欄に data-clarity-mask="true"。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import {
  BANNER_TEXT_CONSENT_REQUIRED,
  BANNER_TEXT_DEFAULT_ON,
  CLARITY_CONSENT_COOKIE,
  choiceFromCookieString,
  clarityCspApplies,
  clarityCspSources,
  clarityExcludedPath,
  clarityPlan,
  clarityProjectId,
  consentRequiredFor,
  denyClarity,
  isHtmlPagePath,
  parseConsentChoice,
  startClarity,
} from "@/lib/clarity";
import { ClarityConsentView } from "@/components/site/ClarityConsent";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const ID = "abc123def4";

test("clarityProjectId: 未設定・空・形の違う値は null（何も読み込まない）", () => {
  assert.equal(clarityProjectId(undefined), null);
  assert.equal(clarityProjectId(""), null);
  assert.equal(clarityProjectId("   "), null);
  assert.equal(clarityProjectId('abc"></script><script>'), null);
  assert.equal(clarityProjectId("abc/def"), null);
  assert.equal(clarityProjectId(` ${ID} `), ID);
});

test("consentRequiredFor: EEA・UK・スイスと国不明は同意が要る側、US・JP は要らない", () => {
  for (const c of [
    "DE", "FR", "IE", "NL", "IS", "LI", "NO", "GB", "CH", "de", "gb",
    // EU の海外の地域とオーランド（独立点検 M2）
    "RE", "GP", "MQ", "GF", "YT", "MF", "AX",
    // ジブラルタルと王室属領
    "GI", "JE", "GG", "IM",
  ]) {
    assert.equal(consentRequiredFor(c), true, c);
  }
  for (const c of [null, undefined, "", "XX", "T1", "EU", "???"]) {
    assert.equal(consentRequiredFor(c), true, `unknown: ${String(c)}`);
  }
  for (const c of ["US", "JP", "SG", "IN", "AE", "us"]) {
    assert.equal(consentRequiredFor(c), false, c);
  }
});

test("parseConsentChoice: granted / denied だけを選択として読む", () => {
  assert.equal(parseConsentChoice("granted"), "granted");
  assert.equal(parseConsentChoice("denied"), "denied");
  assert.equal(parseConsentChoice(undefined), null);
  assert.equal(parseConsentChoice("yes"), null);
  assert.match(CLARITY_CONSENT_COOKIE, /^[a-z0-9_]+$/);
  assert.equal(choiceFromCookieString("a=1; vet402_analytics_consent=denied; b=2"), "denied");
  assert.equal(choiceFromCookieString("vet402_analytics_consent=granted"), "granted");
  assert.equal(choiceFromCookieString("x_vet402_analytics_consent=granted"), null);
  assert.equal(choiceFromCookieString(""), null);
});

test("clarityPlan: 同意が要る地域は、選択の前に読み込まず帯を出す", () => {
  assert.deepEqual(clarityPlan({ consentRequired: true, choice: null, gpc: false }), {
    load: false,
    banner: true,
  });
  assert.deepEqual(clarityPlan({ consentRequired: true, choice: "denied", gpc: false }), {
    load: false,
    banner: false,
  });
  assert.deepEqual(clarityPlan({ consentRequired: true, choice: "granted", gpc: false }), {
    load: true,
    banner: false,
  });
});

test("clarityPlan: それ以外の地域は既定で読み込み、断った人は読み込まない", () => {
  assert.deepEqual(clarityPlan({ consentRequired: false, choice: null, gpc: false }), {
    load: true,
    banner: false,
  });
  assert.deepEqual(clarityPlan({ consentRequired: false, choice: "denied", gpc: false }), {
    load: false,
    banner: false,
  });
});

test("clarityPlan: GPC では地域と選択に関わらず読み込まず、帯も出さない（clarity-js も GPC では記録しない）", () => {
  for (const consentRequired of [true, false]) {
    for (const choice of [null, "granted", "denied"] as const) {
      assert.deepEqual(clarityPlan({ consentRequired, choice, gpc: true }), { load: false, banner: false });
    }
  }
});

type Win = { clarity?: ((...args: unknown[]) => void) & { q?: unknown[][] } };

test("startClarity: タグより先に consentv2（analytics granted・広告は denied）を積む", () => {
  const win: Win = {};
  const inserted: string[] = [];
  startClarity({ win, insertScript: (src) => inserted.push(src) }, ID);
  assert.deepEqual(inserted, [`https://www.clarity.ms/tag/${ID}`]);
  assert.deepEqual(win.clarity?.q?.[0], [
    "consentv2",
    { ad_Storage: "denied", analytics_Storage: "granted" },
  ]);
});

test("startClarity: タグは二度入れない。広告の denied はどの呼び出しでも変わらない", () => {
  const win: Win = {};
  const inserted: string[] = [];
  const env = { win, insertScript: (src: string) => inserted.push(src) };
  startClarity(env, ID);
  startClarity(env, ID);
  assert.equal(inserted.length, 1);
  for (const call of win.clarity?.q ?? []) {
    assert.deepEqual(call, ["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }]);
  }
});

test("denyClarity: 読み込み済みなら consentv2 denied だけを送って true（呼び手が読み直す）。未読み込みなら何もしない", () => {
  const untouched: Win = {};
  assert.equal(denyClarity(untouched), false);
  assert.equal(untouched.clarity, undefined);

  const win: Win = {};
  startClarity({ win, insertScript: () => {} }, ID);
  assert.equal(denyClarity(win), true);
  assert.deepEqual(win.clarity?.q, [
    ["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }],
    ["consentv2", { ad_Storage: "denied", analytics_Storage: "denied" }],
  ]);
});

test("clarityExcludedPath: トークンを URL に載せる頁と凍結面", () => {
  for (const p of [
    "/observatory/confirm",
    "/observatory/unsubscribe",
    "/rwa",
    "/rwa/board",
    "/tokyo",
    "/ethonline",
  ]) {
    assert.equal(clarityExcludedPath(p), true, p);
  }
  for (const p of ["/", "/observatory", "/observatory/e/abc", "/rwanda", "/tokyo-guide", "/legal/privacy", null]) {
    assert.equal(clarityExcludedPath(p), false, String(p));
  }
});

// effect の配線・再マウント・撤回は tests/clarity-consent-dom.test.ts（jsdom）で確かめる。ここは最初の HTML だけ。
const view = (props: { projectId: string | null; consentRequired: boolean; pathname?: string; initialChoice?: "granted" | "denied" | null }) =>
  renderToStaticMarkup(
    createElement(ClarityConsentView, {
      projectId: props.projectId,
      consentRequired: props.consentRequired,
      initialChoice: props.initialChoice ?? null,
      pathname: props.pathname ?? "/",
    }),
  );

test("ClarityConsentView（最初の HTML）: ID が無ければ何も描かない", () => {
  for (const consentRequired of [true, false]) assert.equal(view({ projectId: null, consentRequired }), "");
});

test("ClarityConsentView（最初の HTML）: DE・GB・CH・国不明は同意を求める帯の文（逐語）と Accept / Decline / ポリシー", () => {
  for (const country of ["DE", "GB", "CH", null]) {
    const html = view({ projectId: ID, consentRequired: consentRequiredFor(country) });
    assert.ok(html.includes(BANNER_TEXT_CONSENT_REQUIRED), `${country}: wording`);
    assert.match(html, />Accept</);
    assert.match(html, />Decline</);
    assert.match(html, /href="\/legal\/privacy#session-analytics"/);
  }
  assert.equal(
    BANNER_TEXT_CONSENT_REQUIRED,
    "vet402 would like to record how pages are used (clicks, scrolling, page layout) with Microsoft Clarity, to find what is hard to use. Page text, form fields and keys are masked. Nothing is recorded unless you accept.",
  );
  assert.equal(
    BANNER_TEXT_DEFAULT_ON,
    "vet402 records how pages are used (clicks, scrolling, page layout) with Microsoft Clarity, to find what is hard to use. Page text, form fields and keys are masked. Choose Decline to turn it off.",
  );
});

test("ClarityConsentView（最初の HTML）: US では帯を出さない。除外の頁では EU でも帯を出さない", () => {
  assert.equal(view({ projectId: ID, consentRequired: consentRequiredFor("US") }), "");
  for (const pathname of ["/observatory/confirm", "/observatory/unsubscribe", "/rwa", "/tokyo", "/ethonline"]) {
    assert.equal(view({ projectId: ID, consentRequired: true, pathname }), "", pathname);
  }
});

test("isHtmlPagePath: API・MCP・ファイル（csv / json / xml / txt）は頁ではない", () => {
  for (const p of [
    "/",
    "/observatory",
    "/legal/privacy",
    "/payee/0xabc",
    "/dashboard/keys",
    // ホスト名を含む頁（独立点検 M1）
    "/sellers/api.example.com",
    "/sellers/edge.goldsky.com",
  ]) {
    assert.equal(isHtmlPagePath(p), true, p);
  }
  for (const p of [
    "/api/v1/resources/x/export.csv",
    "/api/v1/sellers",
    "/api/mcp",
    "/mcp",
    "/llms.txt",
    "/blog/rss.xml",
    "/sitemap.xml",
    "/openapi.yaml",
    "/opengraph-image.png",
    "/manifest.webmanifest",
    "/icon.ico",
    "/.well-known/mcp-registry-auth",
  ]) {
    assert.equal(isHtmlPagePath(p), false, p);
  }
});

test("clarityCspApplies: ホスト名を含む頁（/sellers/api.example.com）には足し、除外の頁とファイルには足さない", () => {
  assert.equal(clarityCspApplies("/sellers/api.example.com"), true);
  assert.equal(clarityCspApplies("/observatory/confirm"), false);
  assert.equal(clarityCspApplies("/tokyo"), false);
  assert.equal(clarityCspApplies("/blog/rss.xml"), false);
});

test("clarityCspSources: 公式どおり *.clarity.ms と c.bing.com", () => {
  const s = clarityCspSources();
  assert.match(s.script, /https:\/\/\*\.clarity\.ms/);
  assert.match(s.connect, /https:\/\/\*\.clarity\.ms/);
  assert.match(s.connect, /https:\/\/c\.bing\.com/);
  assert.match(s.img, /https:\/\/\*\.clarity\.ms/);
  assert.match(s.img, /https:\/\/c\.bing\.com/);
});

async function cspFor(path: string, id: string | undefined): Promise<string> {
  const prev = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  if (id === undefined) delete process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  else process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID = id;
  try {
    const { proxy } = await import("@/proxy");
    const res = await proxy(new NextRequest(`http://localhost${path}`));
    return res.headers.get("content-security-policy") ?? "";
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
    else process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID = prev;
  }
}

test("proxy CSP: ID 未設定ならどこにも Clarity を足さない", async () => {
  for (const p of ["/", "/legal/privacy", "/api/v1/sellers"]) {
    assert.doesNotMatch(await cspFor(p, undefined), /clarity|bing/, p);
  }
});

test("proxy CSP: ID があれば HTML 頁にだけ足す。API・CSV・MCP の CSP は今のまま", async () => {
  const page = await cspFor("/observatory", ID);
  assert.match(page, /connect-src 'self' https:\/\/plausible\.io https:\/\/\*\.clarity\.ms https:\/\/c\.bing\.com/);
  assert.match(page, /img-src 'self' data: https:\/\/\*\.clarity\.ms https:\/\/c\.bing\.com/);
  assert.match(page, /script-src [^;]*https:\/\/\*\.clarity\.ms/);
  // Clarity を動かさない頁（トークンを URL に載せる頁・凍結面）も CSP は今のまま。
  for (const p of [
    "/api/v1/resources/x/export.csv",
    "/mcp",
    "/api/mcp",
    "/llms.txt",
    "/observatory/confirm",
    "/observatory/unsubscribe",
    "/rwa",
    "/tokyo",
    "/ethonline",
  ]) {
    const csp = await cspFor(p, ID);
    assert.doesNotMatch(csp, /clarity|bing/, p);
    assert.equal(csp.replace(/'nonce-[^']+'/, "N"), (await cspFor(p, undefined)).replace(/'nonce-[^']+'/, "N"), p);
  }
});

test("入口: Clarity は root template の呼び出し 1 か所。layout.tsx（凍結面）は触らず、Plausible は残す", () => {
  const template = read("src/app/template.tsx");
  assert.equal(template.match(/<ClarityTag\b/g)?.length ?? 0, 1);
  assert.match(template, /\{children\}/);
  const layout = read("src/app/layout.tsx");
  assert.doesNotMatch(layout, /Clarity/);
  assert.match(layout, /plausible\.io\/js\/script\.js/);
  let calls = 0;
  for (const rel of tsxFiles("src")) calls += read(rel).match(/<ClarityTag\b/g)?.length ?? 0;
  assert.equal(calls, 1);
});

// --- マスク: 画面上の入力欄（hidden 以外）と、鍵・財布アドレスの表示欄 ---

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...tsxFiles(rel));
    else if (rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

/** JSX の開きタグを、{} の深さを数えて閉じの > まで切り出す。 */
function openingTags(src: string, tag: string): string[] {
  const tags: string[] = [];
  const re = new RegExp(`<${tag}(?=[\\s>/])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + 1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push(src.slice(m.index, i + 1));
  }
  return tags;
}

// 凍結面（tests/seo-audit-1026.test.ts が origin/main と同じに保つ）は触らない。
// そこも Clarity は入力欄の中身をどの masking mode でも伏せる（公式 clarity-masking）。
const FROZEN = ["src/app/rwa/", "src/app/tokyo/", "src/app/ethonline/"];

test("マスク: src/ の全 input（hidden 以外）・textarea・select に data-clarity-mask=\"true\"（凍結面を除く）", () => {
  const missing: string[] = [];
  let seen = 0;
  for (const rel of tsxFiles("src")) {
    if (FROZEN.some((f) => rel.startsWith(f))) continue;
    const src = read(rel);
    for (const tag of ["input", "textarea", "select"]) {
      for (const t of openingTags(src, tag)) {
        if (/type="hidden"/.test(t)) continue;
        seen++;
        if (!/data-clarity-mask="true"/.test(t)) missing.push(`${rel}: ${t.slice(0, 80).replace(/\s+/g, " ")}`);
      }
    }
  }
  assert.ok(seen >= 23, `scanned ${seen} fields`);
  assert.deepEqual(missing, []);
});

test("マスク: API キーの表示（signup の発行画面・dashboard の新しい鍵）と、dashboard の照会結果の財布アドレス", () => {
  const signup = read("src/app/signup/page.tsx");
  assert.match(signup, /<code data-clarity-mask="true"[^>]*>\s*\{apiKey\}/);
  assert.match(signup, /<div data-clarity-mask="true">\s*<CodeBlock[\s\S]*?code=\{curlExample\}/);
  const keys = read("src/app/dashboard/keys/page.tsx");
  assert.match(keys, /<code data-clarity-mask="true"[^>]*>\{newKey\}/);
  const lookup = read("src/app/dashboard/lookup/page.tsx");
  assert.equal(lookup.match(/<dl data-clarity-mask="true"/g)?.length ?? 0, 2);
  const login = read("src/app/dashboard/login/page.tsx");
  assert.match(openingTags(login, "input").join("\n"), /name="apiKey"[\s\S]*data-clarity-mask="true"|data-clarity-mask="true"[\s\S]*name="apiKey"/);
});

// --- プライバシーポリシー ---

test("privacy: Clarity の節（取るもの・Microsoft・EEA/UK/CH の同意・オプトアウト・選択の入口）", () => {
  const src = read("src/app/legal/privacy/page.tsx");
  const section = src.match(/<section id="session-analytics"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.ok(section, "section#session-analytics exists");
  for (const needle of [
    "Microsoft Clarity",
    "Microsoft Corporation",
    "clicks",
    "scroll",
    "European Economic Area",
    "United Kingdom",
    "Switzerland",
    "Decline",
    "PrivacyChoices",
    "_clck",
    "_clsk",
    CLARITY_CONSENT_COOKIE,
  ]) {
    assert.ok(section.includes(needle), `mentions ${needle}`);
  }
  assert.doesNotMatch(section, /—/, "no em dash");
  const prose = section.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.doesNotMatch(prose, /\b[Ww]e\b|\bour\b|\bus\b/, "first person is I or vet402");
  assert.match(src, /Revision: <span className="text-signal">October 31, 2026<\/span>/);
  assert.match(src, /Last updated: October 31, 2026/);
  assert.match(src, /<strong>Microsoft Clarity<\/strong>/, "listed among subprocessors and third parties");
  // 「Plausible だけ」「同意に頼らない」「cookie は 1 つ」の旧文は Clarity と食い違うので残さない。
  assert.doesNotMatch(src, /This is the\s+only third party our pages send information to/);
  assert.doesNotMatch(src, /we do not currently rely on consent for any\s+processing/);
  assert.doesNotMatch(src, /We use one cookie, and only after you log in/);
});

test("privacy: 独立点検の英語の直し（逐語）と、Data we collect のセッション解析", () => {
  // JSX の改行・{" "}・&apos;・<code> を畳んで、読まれる文として比べる。
  const text = read("src/app/legal/privacy/page.tsx")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\{" "\}/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/<\/?code[^>]*>/g, "")
    .replace(/<a [^>]*>\s*([^<]*?)\s*<\/a>/g, "$1")
    .replace(/\s+/g, " ");
  for (const sentence of [
    "For Clarity, Microsoft is also an independent controller of the data it receives.",
    "It receives the data described under session analytics . Visitors in the EEA, the UK and Switzerland are recorded only after they accept.",
    "your browser loads Clarity's scripts from clarity.ms and sends Clarity",
    "the address and title of the page and the referring page",
    "so the text and images on the page are replaced with placeholders before they leave your browser. The page address and title are not masked.",
    "_clck, which keeps a pseudonymous Clarity user ID for up to one year, and _clsk, which joins the pages of one visit into one recording and lasts one day.",
    "(Art. 6(1)(a) of the GDPR and the UK GDPR, and consent under Swiss data protection law)",
    "keeps favorited recordings, a random sample of recordings and heatmaps for up to 9 months. Clarity does not let vet402 find or delete one visitor's recordings. They expire on this schedule.",
    "deletes the _clck and _clsk cookies on vet402.com and stops recording. Cookies that Microsoft set on its own domains stay until they expire or you clear them.",
    "vet402 asks for it on a banner at the bottom of the page,",
    "vet402 does not load Clarity, in any region and whatever you choose.",
  ]) {
    assert.ok(text.includes(sentence), `verbatim: ${sentence}`);
  }
  const collect = text.match(/Data we collect(.*?)<\/ul>/)?.[1] ?? "";
  assert.match(collect, /Session analytics/);
  assert.match(collect, /The page address and title are not masked/);
});

test("マスク: DashboardShell の根（ログイン画面と本体の両方）に data-clarity-mask", () => {
  const shell = read("src/components/dashboard/shell.tsx");
  assert.equal(shell.match(/<div data-clarity-mask="true" className="flex min-h-screen flex-col bg-zinc-50/g)?.length ?? 0, 2);
});

test("footer: Privacy choices の入口は ID がある時だけ、ポリシーの選択の節へ", () => {
  const src = read("src/components/site/SiteFooter.tsx");
  assert.match(src, /PRIVACY_CHOICES_HREF = "\/legal\/privacy#privacy-choices"/);
  assert.match(src, /label: "Privacy choices", href: PRIVACY_CHOICES_HREF/);
  assert.match(src, /NEXT_PUBLIC_CLARITY_PROJECT_ID/);
});

test("footer: ID がある時も、凍結面（/rwa・/tokyo・/ethonline）と Clarity を動かさない頁では Privacy choices を出さない", async () => {
  const prev = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID = ID;
  try {
    // SiteFooter は読み込みの時点で ID を読む。この test だけが読み込む。
    const { SiteFooter } = await import("@/components/site/SiteFooter");
    const html = (pathname: string) => renderToStaticMarkup(createElement(SiteFooter, { pathname }));
    for (const p of ["/", "/faq", "/legal/privacy", "/sellers/api.example.com"]) {
      assert.match(html(p), />Privacy choices</, p);
    }
    for (const p of ["/rwa", "/rwa/board", "/tokyo", "/ethonline", "/observatory/confirm", "/observatory/unsubscribe"]) {
      const out = html(p);
      assert.doesNotMatch(out, /Privacy choices/, p);
      assert.doesNotMatch(out, /privacy-choices/, p);
    }
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
    else process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID = prev;
  }
});

test("SiteChrome は今の pathname を SiteFooter に渡す", () => {
  assert.match(read("src/components/site/SiteChrome.tsx"), /<SiteFooter pathname=\{pathname \?\? ""\} \/>/);
});
