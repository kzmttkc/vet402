// ============================================================
// 掲載の出どころと同期時刻（2026-10-21）。
//
// 売り手（CedarProof）が resolver の not_in_catalog を受け取り、vet402 がどこから掲載を読むのか、
// どうすれば載るのかが分からなかった。resolver の not_found と /faq の節は listing-sources.ts から作る。
// ここで固定すること:
//   1. 同期時刻が vercel.json の crons と一致する（片方だけ変えると落ちる）
//   2. 出どころの URL と source が取り込みのコードの定数と一致する
//   3. resolver の not_found が listing_sources と documentation を返し、既存の鍵は変えない
//   4. /faq に節があり、documentation の錨がその節を指し、公開の英文の規則を守る
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LISTING_SOURCES,
  LISTING_SYNC_CRON_PATHS,
  NOT_LISTED_DOC_URL,
  NOT_LISTED_FAQ_ID,
  syncTimesText,
} from "@/lib/observatory/listing-sources";
import { CATALOG_SOURCE, CATALOG_URL } from "@/lib/observatory/catalog-source";
import { MPP_DIRECTORY_SOURCE, MPP_DIRECTORY_URL_DEFAULT } from "@/lib/observatory/mpp-directory";
import { DECLARED_BODY_MAX_BYTES } from "@/lib/observatory/declared-input-rules";
import { REQUEST_SHAPE_HTTP, probeEndpoint, type ProbeTarget } from "@/lib/observatory/l0-probe";
import { declaredRequestBody } from "@/lib/observatory/declared-input";
import { withNotFound } from "@/lib/resolve/lookup";
import { FAQS } from "@/components/site/faq-data";

const ROOT = process.cwd();

/** "0 13 * * *" → "13:00"。分と時が数字の日次 cron だけを読む。 */
function cronToUtc(schedule: string): string | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule.trim());
  if (!m) return null;
  return `${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
}

test("同期時刻は vercel.json の crons と一致する", () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  for (const src of LISTING_SOURCES) {
    const path = LISTING_SYNC_CRON_PATHS[src.source];
    assert.ok(path, `${src.source} に cron の経路が無い`);
    const schedules = vercel.crons.filter((c) => c.path === path).map((c) => c.schedule);
    // 日次でない cron が増えたら、時刻の一覧では言い表せないので落とす。
    for (const sch of schedules) assert.ok(cronToUtc(sch), `${path} の cron "${sch}" は日次の形ではない`);
    const times = schedules.map((sch) => cronToUtc(sch)!).sort();
    assert.deepEqual(times, [...src.sync_times_utc].sort(), `${src.source} の時刻が vercel.json と違う`);
  }
});

test("cron の経路は、その出どころの取り込みを呼ぶ", () => {
  const expected: Record<string, RegExp> = {
    cdp_bazaar: /await syncCatalog\(\)/,
    mpp_directory: /await syncMppDirectory\(\)/,
  };
  for (const src of LISTING_SOURCES) {
    const route = readFileSync(join(ROOT, "src/app", LISTING_SYNC_CRON_PATHS[src.source], "route.ts"), "utf8");
    assert.match(route, expected[src.source], `${LISTING_SYNC_CRON_PATHS[src.source]} が ${src.source} を取り込まない`);
  }
  // syncMppDirectory は syncCatalog に mpp_directory の source を渡す。
  const mpp = readFileSync(join(ROOT, "src/lib/observatory/mpp-directory.ts"), "utf8");
  assert.match(mpp, /syncCatalog\(/);
});

test("出どころの URL と source は取り込みのコードの定数と一致する", () => {
  const bazaar = LISTING_SOURCES.find((s) => s.source === CATALOG_SOURCE);
  assert.ok(bazaar);
  assert.equal(bazaar.url, CATALOG_URL);
  assert.equal(bazaar.url, "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources");
  const mpp = LISTING_SOURCES.find((s) => s.source === MPP_DIRECTORY_SOURCE);
  assert.ok(mpp);
  assert.equal(mpp.url, MPP_DIRECTORY_URL_DEFAULT);
  assert.deepEqual(LISTING_SOURCES.map((s) => s.source).sort(), [CATALOG_SOURCE, MPP_DIRECTORY_SOURCE].sort());
});

test("syncTimesText は時刻を英文で並べる", () => {
  assert.equal(syncTimesText(["01:30"]), "01:30 UTC");
  assert.equal(syncTimesText(["01:00", "13:00"]), "01:00 and 13:00 UTC");
  assert.equal(syncTimesText(["01:00", "07:00", "13:00"]), "01:00, 07:00 and 13:00 UTC");
});

test("not_in_catalog は listing_sources と documentation を返し、既存の鍵と型を保つ", () => {
  const out = withNotFound({ query: { kind: "url", value: "https://cedar.example/x" }, disclaimer: "d" });
  const nf = out.not_found;
  assert.ok(nf);
  assert.equal(nf.reason, "not_in_catalog");
  assert.equal(typeof nf.note, "string");
  assert.equal(nf.next, "https://vet402.com/docs/api#endpoints");
  assert.equal(nf.documentation, NOT_LISTED_DOC_URL);
  assert.equal(nf.documentation, "https://vet402.com/faq#not-listed");
  assert.deepEqual(nf.listing_sources, LISTING_SOURCES);
  for (const s of nf.listing_sources) {
    for (const t of s.sync_times_utc) assert.match(t, /^[0-2][0-9]:[0-5][0-9]$/);
  }
  // 応答の配列を書き換えても正典は変わらない（写しを返す）。
  nf.listing_sources[0].sync_times_utc.push("99:99");
  assert.ok(!LISTING_SOURCES[0].sync_times_utc.includes("99:99"));
  assert.match(nf.note, /no application or fee/);
  assert.match(nf.note, /not a finding/);
});

test("openapi の not_found は新しい鍵を記述する", () => {
  const yaml = readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8");
  assert.ok(yaml.includes("required: [reason, note, next, listing_sources, documentation]"));
  assert.ok(yaml.includes("sync_times_utc:"));
  assert.ok(yaml.includes("example: https://vet402.com/faq#not-listed"));
});

const notListed = () => FAQS.find((f) => f.id === NOT_LISTED_FAQ_ID);

test("/faq に「Why is my endpoint not listed?」があり、documentation の錨がその節を指す", () => {
  const item = notListed();
  assert.ok(item, "FAQ に not-listed の節が無い");
  assert.equal(item.question, "Why is my endpoint not listed?");
  assert.equal(NOT_LISTED_DOC_URL.split("#")[1], item.id);
  const page = readFileSync(join(ROOT, "src/app/faq/page.tsx"), "utf8");
  assert.ok(page.includes("id={item.id}"), "/faq が節に id を付けていない");
});

test("FAQ の節は出どころ・時刻・条件・POST の扱いを書く（値は正典から）", () => {
  const a = notListed()!.answer;
  for (const s of LISTING_SOURCES) {
    assert.ok(a.includes(s.url), `${s.source} の URL が無い`);
    assert.ok(a.includes(syncTimesText(s.sync_times_utc)), `${s.source} の時刻が無い`);
  }
  assert.match(a, /no application to vet402 and no fee/);
  assert.match(a, /declares the Bazaar extension, answers 402, and a payment for it settles through the CDP facilitator/);
  assert.match(a, /can still be left out by CDP/);
  assert.match(a, /The syncs of that catalog start at 01:00 and 13:00 UTC/);
  assert.match(a, /A sync that stops early adds the pages it read and not the rest/);
  assert.match(a, /decided by CDP's index, not by vet402/);
  assert.match(a, /does not read the PayAI discovery list as listings/);
  assert.ok(!/not in that catalog/.test(a), "他の facilitator のルートが CDP に無いとは書かない");
  assert.ok(!/appears on vet402 after the next sync/.test(a), "途中で止まる回を無視した言い方");
  assert.ok(a.includes("sends {} as the body"));
  assert.match(a, /unpaid POST gets 400 or 422 with neither a WWW-Authenticate nor a PAYMENT-REQUIRED header, L0 records it as unverified/);
  assert.match(a, /On a GET route, a 400 or 422 is an L0 fail/);
  assert.match(a, /L1 buys from a route whose latest L0 check passed/);
  assert.match(a, /L1 records no_402/);
  assert.match(a, /same document as the payment terms: the PAYMENT-REQUIRED header when it parses as a payment challenge, and otherwise the response body/);
  assert.ok(a.includes(`${DECLARED_BODY_MAX_BYTES / 1024} KB or less as encoded JSON`));
  assert.match(a, /Otherwise L1 sends \{\}/);
});

test("新しい公開の英文は we/our/us・セミコロン・ダッシュを使わない", () => {
  const texts = [
    notListed()!.answer,
    withNotFound({ query: { kind: "domain", value: "cedar.example" }, disclaimer: "d" }).not_found!.note,
  ];
  for (const t of texts) {
    assert.ok(!/\b(we|our|us)\b/i.test(t), `we/our/us がある: ${t}`);
    assert.ok(!t.includes(";"), `セミコロンがある: ${t}`);
    assert.ok(!/[—–]|--/.test(t), `ダッシュがある: ${t}`);
  }
});

// ---------- FAQ の文が実装と一致することを、実装に当てて確かめる ----------

test("要求の形で弾く HTTP は 400 と 422 だけ", () => {
  assert.deepEqual([...REQUEST_SHAPE_HTTP].sort((x, y) => x - y), [400, 422]);
  assert.equal(DECLARED_BODY_MAX_BYTES, 16 * 1024);
});

const target = (method: string): ProbeTarget => ({
  resourceUrl: "https://cedar.example/v1/run",
  method,
  payTo: null,
  network: "eip155:8453",
  priceAmount: null,
  priceAsset: null,
});
const answer = (status: number, headers: Record<string, string> = {}) => {
  const seen: { body: unknown }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen.push({ body: init?.body ?? null });
    return new Response(JSON.stringify({ error: "bad input" }), { status, headers: { "content-type": "application/json", ...headers } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
};

test("L0: 未払い POST は {} を送り、ヘッダの無い 400/422 は unverified", async () => {
  for (const status of [400, 422]) {
    const a = answer(status);
    const r = await probeEndpoint(target("POST"), { fetchImpl: a.fetchImpl });
    assert.equal(r.verdict, "unverified", `POST ${status}`);
    assert.equal(a.seen[0].body, "{}");
  }
});

test("L0: GET の 400/422 は fail、支払いのヘッダを載せた POST の 400 は unverified にしない", async () => {
  for (const status of [400, 422]) {
    const a = answer(status);
    const r = await probeEndpoint(target("GET"), { fetchImpl: a.fetchImpl });
    assert.equal(r.verdict, "fail", `GET ${status}`);
    assert.equal(a.seen[0].body, null, "GET は本文を送らない");
  }
  const withChallenge = answer(400, { "www-authenticate": 'Payment realm="x"' });
  const r = await probeEndpoint(target("POST"), { fetchImpl: withChallenge.fetchImpl });
  assert.notEqual(r.verdict, "unverified");
});

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const accepts = [
  { scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: `0x${"1".repeat(40)}`, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } },
];
const challenge = (body?: unknown) => ({
  x402Version: 2,
  accepts,
  ...(body === undefined ? {} : { extensions: { bazaar: { info: { input: { type: "http", method: "POST", body } } } } }),
});
const header = (v: unknown) => new Headers({ "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(v)).toString("base64") });

test("L1: 有料 POST の本文は支払い条件と同じ文書から読む（ヘッダが読めれば本文側の宣言は使わない）", () => {
  const declared = { prompt: "hello" };
  // ヘッダが challenge として読めて宣言が無い。本文には宣言がある → {}。
  assert.deepEqual(
    declaredRequestBody({ bodyText: JSON.stringify(challenge(declared)), headers: header(challenge()) }),
    { body: "{}", source: "empty" },
  );
  // ヘッダが無ければ本文の文書を読む。
  assert.equal(declaredRequestBody({ bodyText: JSON.stringify(challenge(declared)), headers: new Headers() }).body, JSON.stringify(declared));
  // 16KB ちょうどは送り、1 バイト超えたら {}。
  const sized = (n: number) => ({ p: "x".repeat(n - JSON.stringify({ p: "" }).length) });
  assert.equal(declaredRequestBody({ bodyText: "", headers: header(challenge(sized(16 * 1024))) }).source, "declared");
  assert.deepEqual(declaredRequestBody({ bodyText: "", headers: header(challenge(sized(16 * 1024 + 1))) }), { body: "{}", source: "empty" });
  // スカラーは {}。
  assert.deepEqual(declaredRequestBody({ bodyText: "", headers: header(challenge("text")) }), { body: "{}", source: "empty" });
});

test("L1 は最新の L0 が pass の行から選び、未払いが 402 でなければ no_402 と書く", () => {
  const src = readFileSync(join(ROOT, "src/lib/observatory/l1-runner.ts"), "utf8");
  assert.match(src, /ORDER BY probed_at DESC LIMIT 1\s*\)\s*lp ON lp\.verdict = 'pass'/);
  assert.match(src, /if \(first\.status !== 402\) \{\s*await record\(\{ status: "no_402"/);
});
