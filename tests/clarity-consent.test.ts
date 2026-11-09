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
  clarityCookieExpiries,
  clarityFrozenPath,
  clarityTokenPath,
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

test("clarityCookieExpiries: _clck・_clsk をホスト名だけと最上位ドメインの両方で期限切れにする", () => {
  assert.deepEqual(clarityCookieExpiries("vet402.com"), [
    "_clck=; Max-Age=0; Path=/",
    "_clck=; Max-Age=0; Path=/; Domain=.vet402.com",
    "_clsk=; Max-Age=0; Path=/",
    "_clsk=; Max-Age=0; Path=/; Domain=.vet402.com",
  ]);
  assert.ok(clarityCookieExpiries("www.vet402.com").includes("_clck=; Max-Age=0; Path=/; Domain=.vet402.com"));
  // ホスト名の後ろからたどれる 2 段以上の全部のドメイン（最終点検 1）
  assert.deepEqual(clarityCookieExpiries("a.b.x.vercel.app").filter((c) => c.startsWith("_clck")), [
    "_clck=; Max-Age=0; Path=/",
    "_clck=; Max-Age=0; Path=/; Domain=.a.b.x.vercel.app",
    "_clck=; Max-Age=0; Path=/; Domain=.b.x.vercel.app",
    "_clck=; Max-Age=0; Path=/; Domain=.x.vercel.app",
    "_clck=; Max-Age=0; Path=/; Domain=.vercel.app",
  ]);
  assert.equal(clarityCookieExpiries("a.b.x.vercel.app").length, 10);
  assert.equal(clarityCookieExpiries("a.b.x.vercel.app").some((c) => c.endsWith("Domain=.app")), false);
  // localhost と IP は domain を付けない。
  assert.deepEqual(clarityCookieExpiries("localhost"), ["_clck=; Max-Age=0; Path=/", "_clsk=; Max-Age=0; Path=/"]);
  assert.deepEqual(clarityCookieExpiries("127.0.0.1"), ["_clck=; Max-Age=0; Path=/", "_clsk=; Max-Age=0; Path=/"]);
});

test("撤回は consentv2 を呼ばない（src に consentv2 denied を送る経路が無い）", () => {
  for (const rel of ["src/lib/clarity.ts", "src/components/site/ClarityConsent.tsx"]) {
    assert.doesNotMatch(read(rel), /analytics_Storage:\s*"denied"/, rel);
    assert.doesNotMatch(read(rel), /clarity!?\(\s*"(stop|consent)"/, rel);
  }
});

test("clarityTokenPath / clarityFrozenPath: 読み直すのはトークンの頁だけ", () => {
  assert.equal(clarityTokenPath("/observatory/confirm"), true);
  assert.equal(clarityTokenPath("/observatory/unsubscribe"), true);
  assert.equal(clarityTokenPath("/tokyo"), false);
  assert.equal(clarityFrozenPath("/tokyo"), true);
  assert.equal(clarityFrozenPath("/rwa/board"), true);
  assert.equal(clarityFrozenPath("/ethonline"), true);
  assert.equal(clarityFrozenPath("/observatory/confirm"), false);
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

// effect の配線・再マウント・撤回・帯の文は tests/clarity-consent-dom.test.ts（jsdom）で確かめる。
// ここは server の HTML だけ: 帯はマウントの後に描くので、server の HTML は常に空（再点検 L4）。
const view = (props: { projectId: string | null; consentRequired: boolean; pathname?: string; initialChoice?: "granted" | "denied" | null; gpc?: boolean }) =>
  renderToStaticMarkup(
    createElement(ClarityConsentView, {
      projectId: props.projectId,
      consentRequired: props.consentRequired,
      initialChoice: props.initialChoice ?? null,
      gpc: props.gpc ?? false,
      pathname: props.pathname ?? "/",
    }),
  );

test("ClarityConsentView（server の HTML）: ID・地域・選択・GPC・頁に関わらず空", () => {
  for (const projectId of [null, ID]) {
    for (const country of ["DE", "GB", "CH", null, "US"]) {
      for (const pathname of ["/", "/observatory/confirm", "/tokyo"]) {
        for (const gpc of [false, true]) {
          assert.equal(
            view({ projectId, consentRequired: consentRequiredFor(country), pathname, gpc }),
            "",
            `${projectId} ${country} ${pathname} ${gpc}`,
          );
        }
      }
    }
  }
});

test("帯の文（逐語・地域で 2 通り）", () => {
  assert.equal(
    BANNER_TEXT_CONSENT_REQUIRED,
    "vet402 would like to record how pages are used (clicks, scrolling, page layout) with Microsoft Clarity, to find what is hard to use. Page text, form fields and keys are masked. Nothing is recorded unless you accept.",
  );
  assert.equal(
    BANNER_TEXT_DEFAULT_ON,
    "vet402 records how pages are used (clicks, scrolling, page layout) with Microsoft Clarity, to find what is hard to use. Page text, form fields and keys are masked. Choose Decline to turn it off.",
  );
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
    // TLD が拡張子と同じ売り手（再点検 L2）
    "/sellers/agent.md",
    "/sellers/files.zip",
    "/sellers/data.json",
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
  assert.match(page, /connect-src 'self' https:\/\/\*\.clarity\.ms https:\/\/c\.bing\.com/);
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

test("入口: Clarity は root template の呼び出し 1 か所。layout は PageViewBeacon のみ（Plausible なし）", () => {
  const template = read("src/app/template.tsx");
  assert.equal(template.match(/<ClarityTag\b/g)?.length ?? 0, 1);
  assert.match(template, /\{children\}/);
  const layout = read("src/app/layout.tsx");
  assert.doesNotMatch(layout, /Clarity/);
  assert.doesNotMatch(layout, /plausible/i);
  assert.match(layout, /PageViewBeacon/);
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
  assert.match(src, /Revision: <span className="text-signal">November 9, 2026<\/span>/);
  assert.match(src, /Last updated: November 9, 2026/);
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
    "keeps favorited recordings, a random sample of recordings and heatmaps for up to 9 months.",
    "deletes the _clck and _clsk cookies on vet402.com and stops recording. Cookies that Microsoft set on its own domains stay until they expire or you clear them.",
    "vet402 asks for it on a banner at the bottom of the page,",
    // 再点検の英語（逐語）
    // "Data we collect" の他の項目と同じく句点無しの 1 文（最終点検 3）
    "(Microsoft Clarity; details under session analytics ): how pages are used, such as clicks, scrolling and page layout, with page text, images and form fields masked (the page address and title are not masked) </li>",
    "Clarity does not run on the two pages that notification emails link to, because their addresses carry a token.",
    "You can withdraw it at any time under Privacy choices below. Withdrawing does not affect recording made before you withdrew.",
    "vet402 does not load Clarity, wherever you are and whatever you choose.",
    "vet402 cannot tell which recordings are yours, and Clarity can delete recordings only by deleting the whole project, so recordings expire on this schedule rather than on request.",
    "and is an independent controller of the data it receives, which it handles under the Microsoft Privacy Statement",
  ]) {
    assert.ok(text.includes(sentence), `verbatim: ${sentence}`);
  }
  const collect = text.match(/Data we collect(.*?)<\/ul>/)?.[1] ?? "";
  assert.match(collect, /Session analytics/);
  assert.match(collect, /\(the page address and title are not masked\) <\/li>/);
});

test("マスク: DashboardShell の根（ログイン画面と本体の両方）に data-clarity-mask。ID が無い時は属性を出さない", () => {
  const shell = read("src/components/dashboard/shell.tsx");
  assert.equal(shell.match(/<div data-clarity-mask=\{CLARITY_MASK\} className="flex min-h-screen flex-col bg-zinc-50/g)?.length ?? 0, 2);
  assert.match(
    shell,
    /const CLARITY_MASK = clarityProjectId\(process\.env\.NEXT_PUBLIC_CLARITY_PROJECT_ID\) \? "true" : undefined;/,
  );
  assert.equal(shell.includes('data-clarity-mask="true"'), false);
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
