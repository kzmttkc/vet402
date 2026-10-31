// ============================================================
// 2026-10-31 独立点検 H1・H2・H3・H4・Low: ClarityConsent の effect の配線を jsdom で動かして確かめる。
// - 選んだ後、root template の再マウント（頁の移動）で帯が出直さない（server の値は最初の読み込みのまま）。
// - 撤回（Accept → Decline）は consentv2 denied の直後に頁を読み直す。stop / consent false は呼ばない。
// - 読み直した後（cookie denied）はタグを入れず、Privacy choices から Accept し直せばタグが入る。
// - トークンを URL に載せる頁と凍結面ではタグも帯も出さず、読み込み済みなら読み直す。
// - GPC では読み込まない。帯が出ている間だけ body の下に余白を置く。
// ============================================================
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://vet402.test/",
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
let ClarityConsentView: typeof import("@/components/site/ClarityConsent").ClarityConsentView;
let resetClarityPageChoiceForTests: () => void;
let PRIVACY_CHOICES_EVENT: string;
let BANNER_TEXT_CONSENT_REQUIRED: string;
let BANNER_TEXT_DEFAULT_ON: string;

before(async () => {
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
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

/** 頁を読み直した直後と同じ状態にする（モジュール変数・window.clarity・タグを消す。cookie は残す）。 */
function freshPage() {
  resetClarityPageChoiceForTests();
  delete win.clarity;
  for (const s of clarityScripts()) s.remove();
  dom.window.document.body.style.paddingBottom = "";
}

let container: HTMLElement;
let root: ReturnType<typeof import("react-dom/client").createRoot> | null = null;
let reloads = 0;

async function mount(props: { consentRequired: boolean; initialChoice?: "granted" | "denied" | null; pathname?: string; gpc?: boolean }) {
  if (root) await act(async () => root!.unmount());
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(ClarityConsentView, {
        projectId: ID,
        consentRequired: props.consentRequired,
        initialChoice: props.initialChoice ?? null,
        gpc: props.gpc ?? false,
        pathname: props.pathname ?? "/observatory",
        reload: () => {
          reloads++;
        },
      }),
    );
  });
}

async function click(label: string) {
  const b = button(label);
  assert.ok(b, `button ${label}`);
  await act(async () => b!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}

beforeEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  freshPage();
  dom.window.document.cookie = "vet402_analytics_consent=; Max-Age=0; Path=/";
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
  // 頁の移動: 同じ古い props でマウントし直す。
  await mount({ consentRequired: true, initialChoice: null, pathname: "/sellers" });
  assert.equal(Boolean(banner()), false, "no banner after a soft navigation");
  // モジュール変数が無くても（別のタブで選んだ等）、cookie を server の値より先に読む。
  resetClarityPageChoiceForTests();
  await mount({ consentRequired: true, initialChoice: null, pathname: "/faq" });
  assert.equal(Boolean(banner()), false, "cookie wins over the stale server prop");
  assert.equal(clarityScripts().length, 0);
});

test("H2: Accept → Decline は consentv2 denied の直後に読み直す。stop・consent false は呼ばない", async () => {
  await mount({ consentRequired: true });
  await click("Accept");
  await act(async () => dom.window.dispatchEvent(new dom.window.Event(PRIVACY_CHOICES_EVENT)));
  await click("Decline");
  const q = win.clarity?.q ?? [];
  assert.deepEqual(q[q.length - 1], ["consentv2", { ad_Storage: "denied", analytics_Storage: "denied" }]);
  assert.equal(q.some((c) => c[0] === "stop" || c[0] === "consent"), false);
  assert.equal(reloads, 1);
  assert.match(dom.window.document.cookie, /vet402_analytics_consent=denied/);
});

test("H2: 読み直した頁（cookie denied）はタグを入れない。Privacy choices から Accept し直すとタグが入る", async () => {
  dom.window.document.cookie = "vet402_analytics_consent=denied; Path=/";
  await mount({ consentRequired: true, initialChoice: "denied" });
  assert.equal(clarityScripts().length, 0);
  assert.equal(Boolean(banner()), false);
  await act(async () => dom.window.dispatchEvent(new dom.window.Event(PRIVACY_CHOICES_EVENT)));
  await click("Accept");
  assert.equal(clarityScripts().length, 1);
  assert.equal(reloads, 0);
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

for (const pathname of ["/observatory/confirm", "/observatory/unsubscribe", "/rwa", "/rwa/x", "/tokyo", "/ethonline"]) {
  test(`H3/H4: ${pathname} ではタグも帯も出さない。読み込み済みで移ってきたら読み直す`, async () => {
    await mount({ consentRequired: true, pathname });
    assert.equal(Boolean(banner()), false);
    await mount({ consentRequired: false, pathname });
    assert.equal(clarityScripts().length, 0);
    assert.equal(typeof win.clarity, "undefined");
    assert.equal(reloads, 0);
    // 別の頁で読み込んだ後、この頁へ移る。
    await mount({ consentRequired: false, pathname: "/" });
    assert.equal(clarityScripts().length, 1);
    await mount({ consentRequired: false, pathname });
    assert.equal(reloads, 1);
  });
}

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

test("帯が出ている間だけ body の下に余白を置き、閉じたら外す", async () => {
  await mount({ consentRequired: true });
  assert.match(dom.window.document.body.style.paddingBottom, /^\d+px$/);
  await click("Decline");
  assert.equal(dom.window.document.body.style.paddingBottom, "");
});
