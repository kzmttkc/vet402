// ============================================================
// 審査員ボタンの欄の読み込み（2026-11-02 独立レビュー）。jsdom で実際に描く。
// state が revertDue なら POST /api/tokyo/reset?check=0 を 1 回だけ呼び、state を読み直してから描く。
// ============================================================
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://vet402.com/tokyo", pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.self = dom.window;
g.MouseEvent = dom.window.MouseEvent;
g.IS_REACT_ACT_ENVIRONMENT = true;

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let JudgePanel: typeof import("@/app/tokyo/judge-panel").JudgePanel;
const realFetch = globalThis.fetch;

before(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ JudgePanel } = await import("@/app/tokyo/judge-panel"));
});
after(() => {
  globalThis.fetch = realFetch;
});

const stateBody = (amount: string, revertDue: boolean) => ({
  name: "seller-d.eth",
  amount,
  canonical: amount === "10000",
  changedByButton: amount === "10001",
  mutatedAt: null,
  lastTx: null,
  revertAfterSeconds: 90,
  revertDue,
  log: [],
  canPress: true,
  blockers: [],
  pressesToday: 0,
  dailyMax: 60,
});

async function load(answers: { states: ReturnType<typeof stateBody>[]; resetThrows?: boolean }) {
  const calls: string[] = [];
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("/api/tokyo/reset")) {
      if (answers.resetThrows) throw new Error("offline");
      assert.equal(init?.body, '{"to":"10000"}');
      return Response.json({ ok: true, status: "reverted", check: null });
    }
    const body = answers.states[Math.min(n, answers.states.length - 1)];
    n += 1;
    return Response.json(body);
  }) as typeof fetch;
  const host = dom.window.document.createElement("div");
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(JudgePanel));
    await new Promise((r) => setTimeout(r, 20));
  });
  return { calls, text: host.textContent ?? "", done: () => React.act(async () => root.unmount()) };
}

test("revertDue: reset?check=0 を 1 回呼び、読み直した値を描く", async () => {
  const r = await load({ states: [stateBody("10001", true), stateBody("10000", false)] });
  assert.deepEqual(r.calls, ["GET /api/tokyo/state", "POST /api/tokyo/reset?check=0", "GET /api/tokyo/state"]);
  assert.match(r.text, /amount now: 10000/);
  assert.doesNotMatch(r.text, /A judge changed one character/);
  await r.done();
});

test("revertDue でなければ state を 1 回読むだけ", async () => {
  const r = await load({ states: [stateBody("10001", false)] });
  assert.deepEqual(r.calls, ["GET /api/tokyo/state"]);
  assert.match(r.text, /amount now: 10001/);
  await r.done();
});

test("reset が届かなくても繰り返さず、読み直した値を描く", async () => {
  const r = await load({ states: [stateBody("10001", true), stateBody("10001", true)], resetThrows: true });
  assert.deepEqual(r.calls, ["GET /api/tokyo/state", "POST /api/tokyo/reset?check=0", "GET /api/tokyo/state"]);
  assert.match(r.text, /amount now: 10001/);
  await r.done();
});
