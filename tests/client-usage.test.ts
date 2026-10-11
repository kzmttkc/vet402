// ============================================================
// client_usage_daily の記帳（2026-10-07・2026-10-11 に鍵なしの全部へ）— DB を持ち込まない側。
//
//  1. どの UA も、少数の決まった名前（配布物の `<名前>/<版>`・`<名前>/other`・self-monitor・crawler・site・browser・other）
//     のどれかに寄る。UA の文字列そのものは値にならない
//  2. 自社の監視（`vet402-` / `kizuna-` で始まり配布物でない UA）は self-monitor。リポにある自社の UA を全部当てる
//  3. 書く値は日・client・route と 1 だけ（UA の残り・Referer・IP・鍵は渡らない）
//  4. DB が投げても（同期でも非同期でも）記帳は外へ投げない
// 本物の DB とルートを通す検査は tests/client-usage.pg.test.ts。
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";
import { setAfterResponseSchedulerForTest } from "@/lib/util/after-response";
import {
  BROWSER_CLIENT,
  CRAWLER_CLIENT,
  DISTRIBUTED_CLIENTS,
  FIXED_CLIENTS,
  HERMES_OTHER_VERSION,
  OTHER_CLIENT,
  SELF_MONITOR_CLIENT,
  SITE_CLIENT,
  clientUsageLabel,
  clientUsageOverflowLabel,
  isOwnPageRequest,
  recordClientUsage,
  upsertClientUsage,
} from "@/lib/api/client-usage";

afterEach(() => {
  setAfterResponseSchedulerForTest(null);
  __setDbForTests(null);
});

test("clientUsageLabel: vet402-hermes/ は版だけを残す（配布物）", () => {
  assert.equal(clientUsageLabel("vet402-hermes/0.1.0"), "vet402-hermes/0.1.0");
  assert.equal(clientUsageLabel("vet402-hermes/0.2.0 (+https://github.com/kzmttkc/vet402-hermes)"), "vet402-hermes/0.2.0");
  assert.equal(clientUsageLabel("vet402-hermes/1.0.0; python-httpx/0.27"), "vet402-hermes/1.0.0");
  // 版は数字 3 組の semver だけ。プレリリース・自由な文字列・4 桁は other
  assert.equal(clientUsageLabel("vet402-hermes/0.2.0-rc.1"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/abc"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/1000.0.0"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/0.1"), HERMES_OTHER_VERSION);
  // 版の形でないもの・長すぎる版は版の文字列を保存しない
  assert.equal(clientUsageLabel("vet402-hermes/"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/<script>"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel("vet402-hermes/0.1.0?q=https://example.com/x"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageLabel(`vet402-hermes/${"1".repeat(33)}`), HERMES_OTHER_VERSION);
  // 配布物の名前は先頭に完全一致するときだけ（大文字・途中・別名は配布物にしない）
  assert.equal(clientUsageLabel("VET402-HERMES/0.1.0"), OTHER_CLIENT);
  assert.equal(clientUsageLabel("Mozilla/5.0 vet402-hermes/0.1.0"), BROWSER_CLIENT);
  assert.equal(clientUsageLabel("vet402-hermes-fork/0.1.0"), SELF_MONITOR_CLIENT);
});

test("clientUsageLabel: 自社の監視は self-monitor（リポにある自社の UA を全部当てる）", () => {
  // vet402 リポ: scripts/surface-consistency-canary.ts（鍵なしで resolve と decision を毎日呼ぶ）・scripts/claims-canary.ts ほか
  // Takeshi_Automation の scripts/: `kizuna-<名前>/1` と `vet402-<名前>/1.0`
  for (const ua of [
    "vet402-surface-consistency-canary",
    "vet402-claims-canary",
    "vet402-state-snapshot/1.0",
    "vet402-weekly-facts/1.0",
    "vet402-gtm-weekly/1.0",
    "vet402-payer-balance/1.1 (+https://vet402.com/observatory/methodology)",
    "vet402-rwa-page/1.0",
    "vet402-verifier/0.1 (+https://vet402.com)",
    "vet402-observatory-l1/1.0 (+https://vet402.com/observatory/methodology)",
    "kizuna-grant-figures/1",
    "kizuna-surface-scan/1 (+https://vet402.com)",
    "kizuna-l1-canary/1",
    "kizuna-ethonline-status/1",
  ]) {
    assert.equal(clientUsageLabel(ua), SELF_MONITOR_CLIENT, ua);
  }
  // UA を名乗っていない配布物の名前は、足すまで self-monitor（少なく数える側）。足したら配布物になる
  assert.equal(clientUsageLabel("vet402-sdk/0.5.0 (+https://vet402.com)"), SELF_MONITOR_CLIENT);
  assert.equal(clientUsageLabel("vet402-mcp/0.9.0"), SELF_MONITOR_CLIENT);
  assert.deepEqual([...DISTRIBUTED_CLIENTS], ["vet402-hermes"]);
  // 先頭でなければ自社にしない
  assert.equal(clientUsageLabel("curl/8.7.1 vet402-claims-canary"), OTHER_CLIENT);
});

test("clientUsageLabel: crawler・site・browser・other", () => {
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  assert.equal(clientUsageLabel(chrome), BROWSER_CLIENT);
  assert.equal(clientUsageLabel(chrome, true), SITE_CLIENT);
  // crawler はブラウザの形でも、自サイトの頁の中でも crawler
  const googlebot = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
  assert.equal(clientUsageLabel(googlebot), CRAWLER_CLIENT);
  assert.equal(clientUsageLabel(googlebot, true), CRAWLER_CLIENT);
  assert.equal(clientUsageLabel("GPTBot/1.2"), CRAWLER_CLIENT);
  assert.equal(clientUsageLabel("ClaudeBot/1.0; +claudebot@anthropic.com"), CRAWLER_CLIENT);
  assert.equal(clientUsageLabel("Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)"), CRAWLER_CLIENT);
  assert.equal(clientUsageLabel("Scrapy/2.11 (+https://scrapy.org) spider"), CRAWLER_CLIENT);
  // other: UA 無し・道具の既定の UA（SDK と MCP サーバは Node の fetch の既定 `node`）
  assert.equal(clientUsageLabel(null), OTHER_CLIENT);
  assert.equal(clientUsageLabel(undefined), OTHER_CLIENT);
  assert.equal(clientUsageLabel(""), OTHER_CLIENT);
  assert.equal(clientUsageLabel("node"), OTHER_CLIENT);
  assert.equal(clientUsageLabel("curl/8.7.1"), OTHER_CLIENT);
  assert.equal(clientUsageLabel("python-httpx/0.27.0"), OTHER_CLIENT);
  assert.equal(clientUsageLabel("Python-urllib/3.12"), OTHER_CLIENT);
  // ownPage はブラウザの UA のときだけ効く（ヘッダを足すだけで site にはならない）
  assert.equal(clientUsageLabel("curl/8.7.1", true), OTHER_CLIENT);
  assert.equal(clientUsageLabel("vet402-hermes/0.1.0", true), "vet402-hermes/0.1.0");
});

test("clientUsageLabel: 返る値は決まった名前だけ（UA の文字列そのものは値にならない）", () => {
  const allowed = (v: string) => FIXED_CLIENTS.includes(v) || /^vet402-hermes\/(\d{1,3}\.\d{1,3}\.\d{1,3}|other)$/.test(v);
  const samples = [
    "x".repeat(10_000),
    "secret-internal-agent/9.9.9 (token=abc123; user=alice@example.com)",
    "https://example.com/?q=private",
    "vet402-" + "a".repeat(5_000),
    "kizuna-\n\r\t",
    "Mozilla/" + "z".repeat(5_000),
    "bot",
    "\u0000\u0001",
    "vet402-hermes/0.1.0\nself-monitor",
    "self-monitor",
    "browser",
    "site",
    // 512 文字より後ろは読まない（後ろに bot があっても crawler にしない）
    "curl/8.7.1 " + " ".repeat(600) + "bot",
  ];
  for (const ua of samples) {
    for (const own of [false, true]) {
      const v = clientUsageLabel(ua, own);
      assert.ok(allowed(v), `${JSON.stringify(ua.slice(0, 40))} → ${v}`);
    }
  }
  assert.equal(clientUsageLabel("curl/8.7.1 " + " ".repeat(600) + "bot"), OTHER_CLIENT);
  assert.equal(clientUsageLabel("self-monitor"), OTHER_CLIENT);
  assert.equal(FIXED_CLIENTS.length, 5);
});

test("clientUsageOverflowLabel: 配布物の版は <名前>/other、決まった名前は自分自身", () => {
  assert.equal(clientUsageOverflowLabel("vet402-hermes/0.1.0"), HERMES_OTHER_VERSION);
  assert.equal(clientUsageOverflowLabel(HERMES_OTHER_VERSION), HERMES_OTHER_VERSION);
  for (const fixed of FIXED_CLIENTS) assert.equal(clientUsageOverflowLabel(fixed), fixed);
  // 表に無い名前が渡っても、その文字列を寄せ先にしない
  assert.equal(clientUsageOverflowLabel("anything/1.0.0"), OTHER_CLIENT);
  assert.equal(clientUsageOverflowLabel("anything"), OTHER_CLIENT);
});

test("isOwnPageRequest: Sec-Fetch-Site: same-origin か、Referer が自サイト", () => {
  assert.equal(isOwnPageRequest(new Headers({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(isOwnPageRequest(new Headers({ "sec-fetch-site": "Same-Origin " })), true);
  assert.equal(isOwnPageRequest(new Headers({ referer: "https://vet402.com/sellers/example.com" })), true);
  assert.equal(isOwnPageRequest(new Headers({ referer: "https://www.vet402.com/" })), true);
  assert.equal(isOwnPageRequest(new Headers({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(isOwnPageRequest(new Headers({ "sec-fetch-site": "none" })), false);
  assert.equal(isOwnPageRequest(new Headers({ "sec-fetch-site": "cross-site", referer: "https://example.com/?u=https://vet402.com/" })), false);
  assert.equal(isOwnPageRequest(new Headers({ referer: "https://vet402.com.example.net/" })), false);
  assert.equal(isOwnPageRequest(new Headers({ referer: "not a url" })), false);
  assert.equal(isOwnPageRequest(new Headers({ referer: `https://vet402.com/${"a".repeat(3000)}` })), false);
  assert.equal(isOwnPageRequest(new Headers()), false);
});

test("recordClientUsage: どの UA でも応答後の処理を 1 つ予約する（UA 無しも other で数える）", () => {
  const tasks: Array<() => Promise<void>> = [];
  setAfterResponseSchedulerForTest((task) => tasks.push(task));
  recordClientUsage(new Headers({ "user-agent": "curl/8.7.1" }), "resolve");
  recordClientUsage(new Headers(), "decision");
  recordClientUsage(new Headers({ "user-agent": "vet402-hermes/0.1.0" }), "resolve");
  assert.equal(tasks.length, 3);
});

test("recordClientUsage: 書く値は日・client・route と 1 だけ（URL や IP は渡らない）", async () => {
  const tasks: Array<() => Promise<void>> = [];
  setAfterResponseSchedulerForTest((task) => tasks.push(task));
  const seen: string[] = [];
  __setDbForTests({
    execute: async (q: unknown) => {
      seen.push(JSON.stringify(q));
      return { rows: [] };
    },
  });
  recordClientUsage(
    new Headers({ "user-agent": "vet402-hermes/0.1.0", "x-forwarded-for": "203.0.113.7", authorization: "Bearer vk_live_secret" }),
    "decision",
  );
  assert.equal(tasks.length, 1);
  await tasks[0]();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /client_usage_daily/);
  assert.match(seen[0], /vet402-hermes\/0\.1\.0/);
  assert.match(seen[0], /"decision"/);
  assert.doesNotMatch(seen[0], /203\.0\.113\.7/);
  assert.doesNotMatch(seen[0], /vk_live_secret/);
});

test("recordClientUsage: UA の生の文字列と Referer は SQL にもパラメータにも渡らない", async () => {
  const tasks: Array<() => Promise<void>> = [];
  setAfterResponseSchedulerForTest((task) => tasks.push(task));
  const seen: string[] = [];
  __setDbForTests({
    execute: async (q: unknown) => {
      seen.push(JSON.stringify(q));
      return { rows: [] };
    },
  });
  const cases: Array<[Record<string, string>, string]> = [
    [{ "user-agent": "AcmeAgent/7.7.7 (build 4242; contact ops@acme.example)" }, OTHER_CLIENT],
    [{ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0 UniqueMarker", "sec-fetch-site": "cross-site", referer: "https://partner.example/page?id=9" }, BROWSER_CLIENT],
    [{ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0 UniqueMarker", referer: "https://vet402.com/sellers/secret-host.example" }, SITE_CLIENT],
    [{ "user-agent": "vet402-surface-consistency-canary" }, SELF_MONITOR_CLIENT],
    [{ "user-agent": "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)" }, CRAWLER_CLIENT],
  ];
  for (const [h] of cases) recordClientUsage(new Headers(h), "resolve");
  assert.equal(tasks.length, cases.length);
  for (const task of tasks) await task();
  assert.equal(seen.length, cases.length);
  cases.forEach(([, label], i) => {
    assert.ok(seen[i].includes(`"${label}"`), `${label}: ${seen[i]}`);
    assert.doesNotMatch(seen[i], /AcmeAgent|4242|acme\.example|Mozilla|Firefox|UniqueMarker|partner\.example|secret-host|surface-consistency|AhrefsBot|ahrefs/);
  });
});

test("upsertClientUsage: DB が投げても外へ投げない（非同期の失敗・同期の失敗・DB 未設定）", async () => {
  __setDbForTests({
    execute: async () => {
      throw new Error('relation "client_usage_daily" does not exist');
    },
  });
  assert.equal(await upsertClientUsage("vet402-hermes/0.1.0", "resolve"), undefined);
  __setDbForTests({
    execute: () => {
      throw new Error("sync failure");
    },
  });
  assert.equal(await upsertClientUsage("vet402-hermes/0.1.0", "resolve"), undefined);
  __setDbForTests(null);
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.equal(await upsertClientUsage("vet402-hermes/0.1.0", "resolve"), undefined);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test("プライバシーポリシーがこの表と保存しない値を書いている", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync("src/app/legal/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  assert.match(page, /<code>client_usage_daily<\/code>/);
  assert.match(page, /made without an API key, a count per UTC day, client name and API route/);
  // 頁が挙げる名前は、実装が返す名前の全部（配布物の先頭と FIXED_CLIENTS）
  for (const name of DISTRIBUTED_CLIENTS) assert.ok(page.includes(`<code>${name}/</code>`), name);
  for (const name of FIXED_CLIENTS) assert.ok(page.includes(`<code>${name}</code>`), name);
  assert.match(page, /We do not store the User-Agent text, the IP address, the URL or query being looked up, or any API key/);
  assert.match(page, /Key-less API call counts are kept without an expiry date/);
  assert.doesNotMatch(page, /Hermes plugin call counts/);
});
