// ============================================================
// 2026-10-31 独立点検と再点検: ClarityConsent の effect の配線を jsdom で動かして確かめる。
// - 選んだ後、root template の再マウント（頁の移動）で帯が出直さない（server の値は最初の読み込みのまま）。
// - 撤回（読み込み済みでの Decline）は consentv2 を呼ばずに読み直す。読み直した denied の頁は
//   _clck・_clsk を最上位ドメインとホスト名の両方で消す。
// - トークンの頁ではタグも帯も出さず、読み込み済みで移ってきたら読み直す。凍結面は出さないだけ。
// - 除外の頁から始まった文書（CSP に Clarity が無い）では、その文書の間はタグを入れない。
// - 同じ区画の中の遷移（再マウントしない再描画）でも同じ判定が効く。
// - server と client の最初の描画が一致する（帯はマウントの後）。GPC では読み込まない。余白。
// ============================================================
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://vet402.com/",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Node 21+ は globalThis.navigator を getter で持つので、代入ではなく定義し直す。
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.self = dom.window;
g.MouseEvent = dom.window.MouseEvent;
g.IS_REACT_ACT_ENVIRONMENT = true;

const ID = "abc123def4";
// react-dom は読み込みの時点で DOM の有無を決めるので、jsdom を globalThis に置いた後で読む。
let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let hydrateRoot: typeof import("react-dom/client").hydrateRoot;
let renderToString: typeof import("react-dom/server").renderToString;
let ClarityConsentView: typeof import("@/components/site/ClarityConsent").ClarityConsentView;
let resetClarityPageChoiceForTests: (startPath?: string) => void;
let PRIVACY_CHOICES_EVENT: string;
let BANNER_TEXT_CONSENT_REQUIRED: string;
let BANNER_TEXT_DEFAULT_ON: string;

before(async () => {
  React = await import("react");
  act = React.act;
  ({ createRoot, hydrateRoot } = await import("react-dom/client"));
  ({ renderToString } = await import("react-dom/server"));
  const mod = await import("@/components/site/ClarityConsent");
  ClarityConsentView = mod.ClarityConsentView;
  resetClarityPageChoiceForTests = mod.resetClarityPageChoiceForTests;
  ({ PRIVACY_CHOICES_EVENT, BANNER_TEXT_CONSENT_REQUIRED, BANNER_TEXT_DEFAULT_ON } = await import("@/lib/clarity"));
});

type Q = unknown[][];
const win = dom.window as unknown as { clarity?: ((...a: unknown[]) => void) & { q?: Q } };

function clarityScripts() {
  return [...dom.window.document.querySelectorAll("script")].filter((s) => s.src.includes("clarity.ms"));
}
// 失敗したときに jsdom の要素を assert の差分に渡すと、窓全体を inspect して数十秒止まる。比べるのは真偽か文字列だけ。
function banner() {
  return dom.window.document.querySelector('[role="region"][aria-label="Privacy choices"]');
}
function button(label: string) {
  return [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent === label);
}
function setGpc(on: boolean) {
  Object.defineProperty(dom.window.navigator, "globalPrivacyControl", { value: on, configurable: true });
}

/** startPath の頁を読み直した直後と同じ状態にする（モジュール変数・window.clarity・タグを消す。cookie は残す）。 */
function freshPage(startPath = "/") {
  resetClarityPageChoiceForTests(startPath);
  delete win.clarity;
  for (const s of clarityScripts()) s.remove();
  dom.window.document.body.style.paddingBottom = "";
}

let container: HTMLElement;
let root: ReturnType<typeof import("react-dom/client").createRoot> | null = null;
let reloads = 0;

type MountProps = {
  consentRequired: boolean;
  initialChoice?: "granted" | "denied" | null;
  pathname?: string;
  gpc?: boolean;
};

function element(props: MountProps) {
  return React.createElement(ClarityConsentView, {
    projectId: ID,
    consentRequired: props.consentRequired,
    initialChoice: props.initialChoice ?? null,
    gpc: props.gpc ?? false,
    pathname: props.pathname ?? "/observatory",
    reload: () => {
      reloads++;
    },
  });
}

/** template の再マウント（別の区画への移動）: 根を作り直して描く。 */
async function mount(props: MountProps) {
  if (root) await act(async () => root!.unmount());
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element(props)));
}

/** 同じ区画の中の移動: 根はそのまま、props（pathname）だけ変えて描き直す。 */
async function rerender(props: MountProps) {
  assert.ok(root, "mounted");
  await act(async () => root!.render(element(props)));
}

async function click(label: string) {
  const b = button(label);
  assert.ok(b, `button ${label}`);
  await act(async () => b!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}

function cookieNames(): string[] {
  return dom.window.document.cookie
    .split(";")
    .map((c) => c.trim().split("=")[0])
    .filter(Boolean)
    .sort();
}

beforeEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  freshPage();
  for (const c of [
    "vet402_analytics_consent=; Max-Age=0; Path=/",
    "_clck=; Max-Age=0; Path=/",
    "_clsk=; Max-Age=0; Path=/",
    "_clck=; Max-Age=0; Path=/; Domain=.vet402.com",
    "_clsk=; Max-Age=0; Path=/; Domain=.vet402.com",
  ]) {
    dom.window.document.cookie = c;
  }
  setGpc(false);
  reloads = 0;
});

after(() => dom.window.close());

test("EU: 選ぶ前はタグを入れず帯を出す。Accept でタグが入り、consentv2 granted（広告 denied）が先に積まれる", async () => {
  await mount({ consentRequired: true });
  assert.ok(banner(), "banner shown");
  assert.ok(banner()!.textContent!.includes(BANNER_TEXT_CONSENT_REQUIRED));
  assert.equal(clarityScripts().length, 0);
  assert.equal(typeof win.clarity, "undefined");
  await click("Accept");
  assert.equal(Boolean(banner()), false);
  assert.deepEqual(clarityScripts().map((s) => s.src), [`https://www.clarity.ms/tag/${ID}`]);
  assert.deepEqual(win.clarity?.q?.[0], ["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }]);
  assert.match(dom.window.document.cookie, /vet402_analytics_consent=granted/);
});

test("H1: 選んだ後、template の再マウント（server の値は古いまま null）で帯が出直さない", async () => {
  await mount({ consentRequired: true });
  await click("Decline");
  await mount({ consentRequired: true, initialChoice: null, pathname: "/sellers" });
  assert.equal(Boolean(banner()), false, "no banner after a soft navigation");
  // モジュール変数が無くても（別のタブで選んだ等）、cookie を server の値より先に読む。
  resetClarityPageChoiceForTests();
  await mount({ consentRequired: true, initialChoice: null, pathname: "/faq" });
  assert.equal(Boolean(banner()), false, "cookie wins over the stale server prop");
  assert.equal(clarityScripts().length, 0);
});

test("M1: 撤回は consentv2 を呼ばずに cookie を denied にして読み直す", async () => {
  await mount({ consentRequired: true });
  await click("Accept");
  const before = JSON.stringify(win.clarity?.q ?? []);
  await act(async () => dom.window.dispatchEvent(new dom.window.Event(PRIVACY_CHOICES_EVENT)));
  await click("Decline");
  assert.equal(JSON.stringify(win.clarity?.q ?? []), before, "nothing queued on withdrawal");
  assert.equal((win.clarity?.q ?? []).some((c) => c[0] === "consentv2" && JSON.stringify(c).includes('"denied","analytics_Storage":"denied"')), false);
  assert.equal(reloads, 1);
  assert.match(dom.window.document.cookie, /vet402_analytics_consent=denied/);
});

test("M1: 読み直した denied の頁は、_clck・_clsk をホスト名と最上位ドメインの両方で消し、タグを入れない", async () => {
  // jsdom（tough-cookie）は同じ名前の host-only と domain の cookie を別々に持てないので、
  // 書き込まれた cookie 文字列を見て両方を消していることを確かめ、最後の状態も確かめる。
  const desc = Object.getOwnPropertyDescriptor(dom.window.Document.prototype, "cookie")!;
  const writes: string[] = [];
  Object.defineProperty(dom.window.document, "cookie", {
    configurable: true,
    get: () => desc.get!.call(dom.window.document),
    set: (v: string) => {
      writes.push(v);
      desc.set!.call(dom.window.document, v);
    },
  });
  try {
    dom.window.document.cookie = "_clck=host; Path=/";
    dom.window.document.cookie = "_clsk=top; Path=/; Domain=.vet402.com";
    dom.window.document.cookie = "vet402_analytics_consent=denied; Path=/";
    writes.length = 0;
    await mount({ consentRequired: true, initialChoice: "denied" });
    for (const name of ["_clck", "_clsk"]) {
      assert.ok(writes.includes(`${name}=; Max-Age=0; Path=/`), `${name} host-only expiry`);
      assert.ok(writes.includes(`${name}=; Max-Age=0; Path=/; Domain=.vet402.com`), `${name} .vet402.com expiry`);
    }
    assert.deepEqual(cookieNames(), ["vet402_analytics_consent"]);
    assert.equal(clarityScripts().length, 0);
    assert.equal(Boolean(banner()), false);
    // Privacy choices から Accept し直すとタグが入る（読み直しは要らない）。
    await act(async () => dom.window.dispatchEvent(new dom.window.Event(PRIVACY_CHOICES_EVENT)));
    await click("Accept");
    assert.equal(clarityScripts().length, 1);
    assert.equal(reloads, 0);
  } finally {
    delete (dom.window.document as unknown as { cookie?: string }).cookie;
  }
});

test("Decline だけ（未読み込み）なら読み直さない", async () => {
  await mount({ consentRequired: true });
  await click("Decline");
  assert.equal(reloads, 0);
  assert.equal(clarityScripts().length, 0);
});

test("US: 既定で読み込み、帯は出さない。Privacy choices の帯は地域の文", async () => {
  await mount({ consentRequired: false });
  assert.equal(Boolean(banner()), false);
  assert.equal(clarityScripts().length, 1);
  await act(async () => dom.window.dispatchEvent(new dom.window.Event(PRIVACY_CHOICES_EVENT)));
  assert.ok(banner()!.textContent!.includes(BANNER_TEXT_DEFAULT_ON));
  await click("Decline");
  assert.equal(reloads, 1);
});

for (const pathname of ["/observatory/confirm", "/observatory/unsubscribe"]) {
  test(`トークンの頁 ${pathname}: 帯もタグも出さず、読み込み済みで移ってきたら読み直す`, async () => {
    await mount({ consentRequired: false, pathname: "/" });
    assert.equal(clarityScripts().length, 1);
    await mount({ consentRequired: true, pathname });
    assert.equal(Boolean(banner()), false);
    assert.equal(reloads, 1);
  });
}

for (const pathname of ["/rwa", "/rwa/x", "/tokyo", "/ethonline"]) {
  test(`L1 凍結面 ${pathname}: 帯もタグも出さないが、読み直さない`, async () => {
    await mount({ consentRequired: false, pathname: "/" });
    assert.equal(clarityScripts().length, 1);
    await mount({ consentRequired: true, pathname });
    assert.equal(Boolean(banner()), false);
    assert.equal(reloads, 0);
  });
}

for (const start of ["/observatory/confirm", "/tokyo"]) {
  test(`L2: ${start} から始まった文書（CSP に Clarity が無い）は、その後の頁でもタグを入れない`, async () => {
    freshPage(start);
    await mount({ consentRequired: false, pathname: start });
    assert.equal(clarityScripts().length, 0);
    await mount({ consentRequired: false, pathname: "/" });
    assert.equal(clarityScripts().length, 0);
    await mount({ consentRequired: true, pathname: "/faq" });
    assert.equal(clarityScripts().length, 0);
    assert.equal(typeof win.clarity, "undefined");
  });

  test(`最終点検 2: ${start} から始まった文書でも Change privacy choices が帯を開き、Accept は読み直して効かせる`, async () => {
    freshPage(start);
    dom.window.document.cookie = "vet402_analytics_consent=denied; Path=/";
    await mount({ consentRequired: false, pathname: start });
    await mount({ consentRequired: false, initialChoice: "denied", pathname: "/legal/privacy" });
    assert.equal(Boolean(banner()), false);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event(PRIVACY_CHOICES_EVENT)));
    assert.ok(banner(), "banner opens");
    await click("Accept");
    assert.equal(reloads, 1, "reloads to a document whose CSP allows Clarity");
    assert.equal(clarityScripts().length, 0);
    assert.match(dom.window.document.cookie, /vet402_analytics_consent=granted/);
    // Decline は読み込んでいないので読み直さない。
    await act(async () => dom.window.dispatchEvent(new dom.window.Event(PRIVACY_CHOICES_EVENT)));
    await click("Decline");
    assert.equal(reloads, 1);
    assert.match(dom.window.document.cookie, /vet402_analytics_consent=denied/);
  });
}

test("L3: 同じ区画の中の遷移（再マウントなし）: /observatory で動いた Clarity は /observatory/confirm で読み直す", async () => {
  await mount({ consentRequired: false, pathname: "/observatory" });
  assert.equal(clarityScripts().length, 1);
  await rerender({ consentRequired: false, pathname: "/observatory/confirm" });
  assert.equal(reloads, 1);
});

test("L3: 同じ区画の中の遷移（再マウントなし）: /observatory/confirm から /observatory へ移ってもタグを入れない", async () => {
  freshPage("/observatory/confirm");
  await mount({ consentRequired: true, pathname: "/observatory/confirm" });
  assert.equal(Boolean(banner()), false);
  await rerender({ consentRequired: true, pathname: "/observatory" });
  // 帯は出てよい（Accept は読み直して効かせる）。この文書ではタグを入れない。
  assert.equal(clarityScripts().length, 0);
});

test("L4: server の HTML は帯を含まず、client だけが GPC や cookie を知っていても初回の描画が食い違わない", async () => {
  const props = { consentRequired: true, pathname: "/faq" };
  const serverHtml = renderToString(element(props));
  assert.equal(serverHtml, "");
  for (const scenario of ["gpc", "cookie"] as const) {
    freshPage();
    if (scenario === "gpc") setGpc(true);
    else dom.window.document.cookie = "vet402_analytics_consent=granted; Path=/";
    const host = dom.window.document.createElement("div");
    host.innerHTML = serverHtml;
    dom.window.document.body.appendChild(host);
    const errors: string[] = [];
    let hydrated: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      hydrated = hydrateRoot(host, element(props), {
        onRecoverableError: (e: unknown) => errors.push(String(e)),
      });
    });
    assert.deepEqual(errors, [], scenario);
    await act(async () => hydrated!.unmount());
    host.remove();
    setGpc(false);
  }
});

test("GPC: 地域・選択に関わらず読み込まず、帯も出さない", async () => {
  setGpc(true);
  await mount({ consentRequired: false });
  assert.equal(clarityScripts().length, 0);
  await mount({ consentRequired: true });
  assert.equal(Boolean(banner()), false);
  dom.window.document.cookie = "vet402_analytics_consent=granted; Path=/";
  await mount({ consentRequired: true, initialChoice: "granted" });
  assert.equal(clarityScripts().length, 0);
});

test("GPC の帯の文（Privacy choices から開いたとき）", async () => {
  setGpc(true);
  await mount({ consentRequired: false });
  await act(async () => dom.window.dispatchEvent(new dom.window.Event(PRIVACY_CHOICES_EVENT)));
  assert.ok(
    banner()!.textContent!.includes(
      "Your browser sends a Global Privacy Control signal, so vet402 does not load Microsoft Clarity and nothing is recorded.",
    ),
  );
});

test("帯が出ている間だけ body の下に余白を置き、閉じたら外す", async () => {
  await mount({ consentRequired: true });
  assert.match(dom.window.document.body.style.paddingBottom, /^\d+px$/);
  await click("Decline");
  assert.equal(dom.window.document.body.style.paddingBottom, "");
});
