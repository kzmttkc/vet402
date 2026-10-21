// D-01 / D-03: 宣言が変わった公開 fail と、7 日以内の異議を L0 の先頭に置く。
// 時刻は vercel.json の l0-probe から出す。文面に we/our/us とセミコロンとダッシュを置かない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";

import { toCaip2 } from "@/lib/observatory/chains";
import {
  FORM_DISPUTE_NEW_PROBE,
  FORM_DISPUTE_RECORD_STAYS,
  formDisputeAck,
  formDisputeListingSentence,
  formDisputeNotQueuedSentence,
  formDisputeOperatorLine,
  formDisputeQueueSentence,
  formDisputeQueueSummary,
  formDisputeReprobeOf,
} from "@/lib/observatory/dispute-ack";
import { REPROBE_MIN_INTERVAL_MS } from "@/lib/observatory/l0-rule-change-reprobe";
import { formatDailyUtcCron, l0ProbeCronSchedules, l0ProbeScheduleLabel } from "@/lib/observatory/l0-schedule";
import {
  CAIP2_SLUG_KEYS,
  PRIORITY_DOMAIN_INTERVAL_MS,
  declarationDrifted,
  REACH_FAILURE_REASONS,
  interleaveByDomain,
  isReachFailureRow,
  publishedFailDrifted,
  reprobePrioritySql,
  ENDPOINT_LEASE_TTL_SECONDS,
  PRIORITY_REQUEST_TOTAL_MS,
  TOTAL_LIMIT_EXCEEDED,
  endpointLeaseName,
  fillPriorityByDomain,
  makeRequestGuard,
  withTotalLimit,
  runWithDomainInterval,
} from "@/lib/observatory/reprobe-priority";
import {
  DISPUTE_PRIORITY_DAYS,
  PRIORITY_CLASS,
  PRIORITY_MIN_PROBE_AGE_MINUTES,
  PRIORITY_PER_DOMAIN,
  REPROBE_PRIORITY_LIMIT,
} from "@/lib/observatory/reprobe-priority-const";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("toCaip2 のスラグは優先 SQL の CASE と同じ集合", () => {
  const src = read("src/lib/observatory/chains.ts");
  const fn = src.slice(src.indexOf("export function toCaip2"), src.indexOf("export function isTestnet"));
  const keys = [...fn.matchAll(/key === "([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...CAIP2_SLUG_KEYS].sort(), keys);
  for (const key of CAIP2_SLUG_KEYS) assert.equal(toCaip2(key), toCaip2(key.toUpperCase()));
});

test("declarationDrifted: 比べた宣言と今のカタログの不一致だけを拾う", () => {
  const catalog = {
    method: "GET",
    priceAmount: "20000",
    priceAsset: "0xusdc",
    payTo: "0xpay",
    network: "base",
  };
  const declared = { amount: "20000", asset: "0xusdc", payTo: "0xpay", network: "eip155:8453" };
  assert.equal(declarationDrifted({ probeMethod: "GET", declared, catalog }), false, "網のスラグと CAIP-2 は同じ");
  assert.equal(
    declarationDrifted({ probeMethod: "GET", declared: { ...declared, amount: "10000" }, catalog }),
    true,
    "価格が変わった",
  );
  assert.equal(
    declarationDrifted({ probeMethod: "GET", declared: { ...declared, asset: "0xother" }, catalog }),
    true,
  );
  assert.equal(
    declarationDrifted({ probeMethod: "GET", declared: { ...declared, payTo: "0xnew" }, catalog }),
    true,
  );
  assert.equal(
    declarationDrifted({ probeMethod: "GET", declared: { ...declared, network: "eip155:137" }, catalog }),
    true,
  );
  assert.equal(
    declarationDrifted({ probeMethod: "POST", declared, catalog }),
    true,
    "method が変わった",
  );
  assert.equal(
    declarationDrifted({ probeMethod: "GET", declared: null, catalog: { ...catalog, method: null } }),
    false,
    "未宣言は GET で測る。declared が無ければ価格は推測しない",
  );
  assert.equal(
    declarationDrifted({ probeMethod: "GET", declared: null, catalog: { ...catalog, method: "" } }),
    false,
    "空の method も未宣言",
  );
  assert.equal(
    declarationDrifted({ probeMethod: "POST", declared: null, catalog: { ...catalog, method: "GET" } }),
    true,
  );
});

test("優先 SQL は宣言 5 項目と、署名付きとフォームの異議と、7 日窓を持つ", () => {
  const dialect = new PgDialect();
  const withForm = dialect.sqlToQuery(reprobePrioritySql(REPROBE_PRIORITY_LIMIT, true));
  const signedOnly = dialect.sqlToQuery(reprobePrioritySql(REPROBE_PRIORITY_LIMIT, false));
  const text = withForm.sql;
  for (const field of ["e.price_amount", "e.price_asset", "e.pay_to", "e.network", "e.method"]) {
    assert.ok(text.includes(field), field);
  }
  assert.match(text, /record_subscriptions/);
  assert.match(text, /disputes/);
  assert.match(text, /kind = 'dispute'/);
  assert.match(text, /raw_response_meta \? 'declared'/);
  assert.equal(withForm.params.includes(DISPUTE_PRIORITY_DAYS), true);
  assert.equal(withForm.params.includes(REPROBE_PRIORITY_LIMIT), true);
  assert.doesNotMatch(signedOnly.sql, /record_subscriptions/);
  assert.match(signedOnly.sql, /disputes/);
});

test("登録ドメインで交互に並べる。同じドメインの中の順は保つ", () => {
  const out = interleaveByDomain(
    [
      { id: "a1", host: "a.example.com" },
      { id: "a2", host: "b.example.com" },
      { id: "b1", host: "other.test" },
    ],
    (row) => row.host.split(".").slice(-2).join("."),
  );
  assert.deepEqual(out.map((row) => row.id), ["a1", "b1", "a2"]);
});

test("同じ登録ドメインは開始間隔を空け、別ドメインは待たない", async () => {
  const starts: string[] = [];
  let release: () => void = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const parallel = runWithDomainInterval(["a.example.com", "b.test"], {
    concurrency: 2,
    intervalMs: 500,
    domainOf: (host) => host,
    run: async (host) => {
      starts.push(host);
      started++;
      if (started === 2) release();
      await both;
    },
  });
  await both;
  assert.deepEqual(starts.sort(), ["a.example.com", "b.test"]);
  await parallel;

  const times: number[] = [];
  await runWithDomainInterval(["one", "two"], {
    concurrency: 2,
    intervalMs: 60,
    domainOf: () => "same.example",
    run: async () => {
      times.push(Date.now());
    },
  });
  assert.ok(times[1]! - times[0]! >= 50, `gap ${times[1]! - times[0]!}`);
});

test("ドメイン間隔は旧規則の測り直しの下限と同じ", () => {
  assert.equal(PRIORITY_DOMAIN_INTERVAL_MS, REPROBE_MIN_INTERVAL_MS);
  assert.ok(PRIORITY_DOMAIN_INTERVAL_MS >= 1000);
});

test("L0 の表示時刻は vercel.json の l0-probe そのもの", () => {
  const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const fromFile = vercel.crons.filter((row) => row.path === "/api/cron/l0-probe").map((row) => row.schedule);
  assert.deepEqual(l0ProbeCronSchedules(), fromFile);
  assert.deepEqual(l0ProbeCronSchedules(vercel.crons), fromFile);
  assert.equal(formatDailyUtcCron("30 10 * * *"), "10:30 UTC");
  assert.equal(formatDailyUtcCron("0 13 * * 3"), "0 13 * * 3");
  assert.equal(l0ProbeScheduleLabel(), fromFile.map(formatDailyUtcCron).join(", "));
  assert.doesNotMatch(read("src/lib/observatory/dispute-ack.ts"), /10:30/);
  assert.doesNotMatch(read("src/lib/observatory/l0-schedule.ts"), /10:30/);
});

const BANNED = (text: string, label: string) => {
  assert.doesNotMatch(text, /\b(we|our|us)\b/i, label);
  assert.equal(text.includes(";"), false, label);
  assert.equal(text.includes("\u2014"), false, label);
  assert.equal(text.includes("\u2013"), false, label);
  assert.equal(text.includes(" -- "), false, label);
};

test("フォーム異議の確認文は、列に入る出品にだけ優先の列を言い、上限・窓・時刻を事実どおりに書く", () => {
  const label = l0ProbeScheduleLabel();
  const queued = formDisputeAck(label, "queued");
  assert.ok(queued.includes(label));
  assert.ok(queued.includes(`up to ${REPROBE_PRIORITY_LIMIT} priority listings, at most ${PRIORITY_PER_DOMAIN} from one site`));
  assert.ok(queued.includes("L0 runs probe that list before their ordinary queue, one run at a time."));
  assert.ok(queued.includes(`within ${DISPUTE_PRIORITY_DAYS} days leaves the list`));
  assert.ok(queued.includes(`past ${PRIORITY_MIN_PROBE_AGE_MINUTES} minutes`));
  assert.ok(queued.includes("disputes fill the places left"), "公開 fail が先で、異議は残りの枠");
  assert.ok(queued.includes("unfilled path parameter is not put on that list"));
  assert.ok(queued.includes(FORM_DISPUTE_RECORD_STAYS));
  assert.ok(queued.includes(FORM_DISPUTE_NEW_PROBE), "プローブ行は測ったときだけ");
  assert.doesNotMatch(queued, /next L0 run/, "次の実行で必ず、とは言わない（50 件・60 分・7 日）");
  assert.doesNotMatch(queued, /A new probe is added/, "測る前にプローブが足されるとは言わない");

  for (const reprobe of ["not_active", "path_template"] as const) {
    const ack = formDisputeAck(label, reprobe);
    assert.doesNotMatch(ack, /priority list/, reprobe);
    assert.ok(!ack.includes(FORM_DISPUTE_NEW_PROBE), reprobe);
    assert.ok(ack.includes("does not put it on the re-probe list"), reprobe);
    assert.ok(ack.includes(FORM_DISPUTE_RECORD_STAYS), reprobe);
    assert.equal(formDisputeListingSentence(label, reprobe), `${formDisputeNotQueuedSentence(reprobe)} ${FORM_DISPUTE_RECORD_STAYS}`);
    BANNED(ack, reprobe);
    BANNED(formDisputeOperatorLine(reprobe, label), `operator ${reprobe}`);
    assert.ok(formDisputeOperatorLine(reprobe, label).includes(formDisputeNotQueuedSentence(reprobe)), "運営者向けも同じ事実");
  }
  assert.match(formDisputeNotQueuedSentence("not_active"), /not active in the catalog/);
  assert.match(formDisputeNotQueuedSentence("path_template"), /unfilled path parameter/);
  for (const text of [queued, formDisputeQueueSentence(label), formDisputeQueueSummary(label), formDisputeOperatorLine("queued", label)]) {
    BANNED(text, text.slice(0, 40));
  }
  assert.ok(formDisputeOperatorLine("queued", label).includes(formDisputeQueueSentence(label)), "運営者向けは公開の文と同じ事実");
  assert.doesNotMatch(formDisputeOperatorLine("queued", label), /is on the L0 priority list/, "列に入ったとは言い切らない（60 分）");
  const summary = formDisputeQueueSummary(label);
  for (const fact of [
    `up to ${REPROBE_PRIORITY_LIMIT} a run and ${PRIORITY_PER_DOMAIN} from one site`,
    "probes before its ordinary queue",
    "unfilled path parameter is not put on that list",
    `past ${PRIORITY_MIN_PROBE_AGE_MINUTES} minutes waits for a later run`,
    `within ${DISPUTE_PRIORITY_DAYS} days leaves the list`,
    label,
  ]) {
    assert.ok(summary.includes(fact), `トップの短い文に ${fact}`);
  }
  assert.equal(formDisputeQueueSentence("10:30 UTC").includes("10:30 UTC"), true);
});

test("列に入るかの判定は優先 SQL の WHERE と同じ（active・パステンプレート以外）", () => {
  assert.equal(formDisputeReprobeOf({ status: "active", pathTemplate: false }), "queued");
  assert.equal(formDisputeReprobeOf({ status: "delisted", pathTemplate: false }), "not_active");
  assert.equal(formDisputeReprobeOf({ status: "delisted", pathTemplate: true }), "not_active");
  assert.equal(formDisputeReprobeOf({ status: "active", pathTemplate: true }), "path_template");
  const text = new PgDialect().sqlToQuery(reprobePrioritySql(REPROBE_PRIORITY_LIMIT, true)).sql;
  assert.match(text, /e\.status = 'active'/);
  assert.ok(text.includes("split_part(e.resource_url, '?', 1) !~*"), "notPathTemplateSql");
});

test("優先 SQL: 組の順（宣言ずれ → 旧規則 → 異議）、異議は最新プローブより後だけ、直近に測った出品は外す", () => {
  const q = new PgDialect().sqlToQuery(reprobePrioritySql(REPROBE_PRIORITY_LIMIT, true));
  assert.deepEqual(PRIORITY_CLASS, { declarationDrift: 0, ruleChange: 1, dispute: 2 });
  const orderBy = q.sql.slice(q.sql.lastIndexOf("ORDER BY"));
  assert.match(orderBy, /^ORDER BY priority_class ASC/, "組が並びの最初の鍵");
  assert.match(q.sql, /u\.created_at > latest\.probed_at/, "同時刻は測り済み（< ではなく >）");
  assert.match(q.sql, /min\(u\.created_at\)/, "送り直しで異議の時刻が先へ動かない");
  assert.match(q.sql, /WHEN rc\.rule_change_reprobe\s+AND NOT \(e\.last_seen_at > now\(\)/, "旧規則の公開 fail も declared 無しで入る（c1 の窓の外）");
  assert.match(q.sql, /WHERE host_rank <= \$\d+/, "組をまたいで 1 ホストの上限");
  assert.match(q.sql, /PARTITION BY lower\(split_part\(split_part\(cand\.resource_url, ':\/\/', 2\), '\/', 1\)\)\s+ORDER BY cand\.priority_class ASC/, "ホストの順位は組をまたぐ");
  assert.ok(q.params.includes(PRIORITY_PER_DOMAIN));
  assert.match(q.sql, /latest\.probed_at < now\(\) - make_interval\(mins => /);
  assert.ok(q.params.includes(PRIORITY_MIN_PROBE_AGE_MINUTES));
});

test("probe-runner は優先の段を、fail-closed のリースの下で、普通の列より前に終える（配線が外れたら落ちる）", () => {
  const src = read("src/lib/observatory/probe-runner.ts");
  const body = src.slice(src.indexOf("export async function runL0ProbeBatch"));
  const select = body.indexOf("await selectReprobePriority(db, priorityCap, true)");
  const lease = body.indexOf("await acquireLeaseFailClosed(PRIORITY_LEASE_NAME, PRIORITY_LEASE_TTL_SECONDS)");
  const rest = body.indexOf("LIMIT ${restLimit}");
  const exclude = body.indexOf("${excludePriority}");
  const recent = body.indexOf("${recentlyProbed}");
  const runPriority = body.indexOf("await runWithDomainInterval(orderedPriority, {");
  const release = body.indexOf("await releasePriority();", runPriority);
  const runRest = body.indexOf("await Promise.all(", runPriority);
  for (const [name, at] of Object.entries({ select, lease, rest, exclude, recent, runPriority, release, runRest })) {
    assert.ok(at > 0, `${name} が runL0ProbeBatch に無い`);
  }
  assert.ok(lease < select, "リースを取ってから選ぶ");
  assert.ok(select < rest, "優先を選んでから残りの枠を決める");
  assert.ok(runPriority < release && release < runRest, "優先の段を終えてリースを返してから普通の列");
  assert.doesNotMatch(body, /runPriorityFirst/, "優先と普通の列を同じプールに入れない");
  assert.match(body, /const restLimit = Math\.max\(0, limit - priority\.length\)/);
  assert.match(body, /if \(priorityLease\?\.acquired\)/, "取れたと確かめられたときだけ優先分を選ぶ");
  assert.doesNotMatch(body, /await acquireLease\(/, "例外で取れた扱いになる acquireLease は使わない");
  assert.match(body, /const priorityCap = Math\.min\(REPROBE_PRIORITY_LIMIT, limit\)/);
  // 要求の直前の関門: probeOne の先頭で、probeEndpoint より前。
  const one = body.slice(body.indexOf("async function probeOne"));
  const guard = one.indexOf("gate = await claimBeforeRequest(c.id);");
  const request = one.indexOf("const request = probeEndpoint(");
  assert.ok(guard > 0 && guard < request, "要求の直前に関門を通す");
  assert.match(one, /finally \{\s+if \(!keepLease\) await gate\.release\(\);/, "行を書いたあとに出品のリースを返す");
  assert.match(body, /acquireLeaseFailClosed\(endpointLeaseName\(id\), ENDPOINT_LEASE_TTL_SECONDS\)/, "出品のリースは fail-closed");
  assert.match(body, /probed_at > now\(\) - make_interval\(mins => \$\{PRIORITY_MIN_PROBE_AGE_MINUTES\}\)/);
});

test("要求の直前の関門: 始め済みと、出品のリースが取れない id を飛ばす", async () => {
  const held = new Set(["h"]);
  const released: string[] = [];
  const guard = makeRequestGuard({
    claim: async (id) => (held.has(id) ? null : async () => void released.push(id)),
  });
  const a = await guard("a");
  assert.equal(a.skip, false);
  assert.deepEqual(await guard("a"), { skip: true, reason: "started" }, "同じ実行で 2 回目");
  assert.deepEqual(await guard("h"), { skip: true, reason: "busy" }, "別の実行がリースを持つ");
  if (!a.skip) await a.release();
  assert.deepEqual(released, ["a"]);
  const [x, y] = await Promise.all([guard("b"), guard("b")]);
  assert.deepEqual([x.skip, y.skip].sort(), [false, true], "並行の 2 本が同じ id を通さない");
  assert.equal(endpointLeaseName("ABC-1"), "l0:endpoint:abc-1");
  assert.ok(ENDPOINT_LEASE_TTL_SECONDS * 1000 > PRIORITY_REQUEST_TOTAL_MS, "リースは要求の上限より長い");
});

test("probeOne: リースの後の直近行の SELECT・要求・書き込みは 1 つの try/finally。例外はその 1 件だけ飛ばす", () => {
  const src = read("src/lib/observatory/probe-runner.ts");
  const one = src.slice(src.indexOf("async function probeOne"), src.indexOf("// 2 段で流す"));
  const gate = one.indexOf("gate = await claimBeforeRequest(c.id);");
  const tryAt = one.indexOf("try {", one.indexOf("let keepLease = false;"));
  const recent = one.indexOf("if (checkRecent && (await probedRecently(c.id)))");
  const request = one.indexOf("const request = probeEndpoint(");
  const caught = one.indexOf("summary.itemErrors++;", request);
  const fin = one.indexOf("if (!keepLease) await gate.release();");
  for (const [name, at] of Object.entries({ gate, tryAt, recent, request, caught, fin })) assert.ok(at > 0, name);
  assert.ok(gate < tryAt && tryAt < recent && recent < request && request < caught && caught < fin, "順: リース → try → 直近行 → 要求 → catch → finally で返す");
  assert.match(src, /const checkRecent = tier !== "all";/);
});

test("withTotalLimit: 上限を超えた要求は打ち切りの印を返し、間に合えば結果を返す", async () => {
  const never = new Promise<string>(() => {});
  const t0 = Date.now();
  assert.equal(await withTotalLimit(never, 30), TOTAL_LIMIT_EXCEEDED);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await withTotalLimit(Promise.resolve("ok"), 1000), "ok");
  assert.ok(PRIORITY_REQUEST_TOTAL_MS <= 10_500, "優先の 1 件は本文まで含めて 10 秒台");
  const body = read("src/lib/observatory/probe-runner.ts");
  assert.match(body, /if \(stage === "priority"\) \{[\s\S]*?await withTotalLimit\(request, priorityRequestLimitMs\)/);
  assert.match(body, /run: \(c\) => probeOne\(c, "priority"\)/);
});

test("優先は組をまたいで 1 登録ドメイン 5 件・全体 50 件まで。落ちた分は次の頁で埋める", async () => {
  assert.equal(PRIORITY_PER_DOMAIN, 5);
  // 先頭 300 行が 1 つの登録ドメイン（40 ホスト × 5 件を超える形）で、他のドメインはその後ろ。
  const rows = [
    ...Array.from({ length: 300 }, (_, i) => ({ id: `shop-${i}`, d: "shop.example" })),
    ...Array.from({ length: 60 }, (_, i) => ({ id: `other-${i}`, d: `o${i}.test` })),
  ];
  const pages: number[] = [];
  const out = await fillPriorityByDomain(
    async (offset, size) => (pages.push(offset), rows.slice(offset, offset + size)),
    { perDomain: PRIORITY_PER_DOMAIN, limit: REPROBE_PRIORITY_LIMIT, pageSize: 100, maxPages: 10, domainOf: (r) => r.d },
  );
  assert.equal(out.length, REPROBE_PRIORITY_LIMIT);
  assert.deepEqual(out.slice(0, 5).map((r) => r.id), ["shop-0", "shop-1", "shop-2", "shop-3", "shop-4"]);
  assert.equal(out.filter((r) => r.d === "shop.example").length, 5);
  assert.equal(out[5]!.id, "other-0", "1 つのドメインが先頭を埋めても、他のドメインが入る");
  assert.deepEqual(pages, [0, 100, 200, 300], "埋まるまで次の頁を読む");
  const short = await fillPriorityByDomain(async (offset) => (offset === 0 ? rows.slice(0, 3) : []), {
    perDomain: 5,
    limit: 50,
    pageSize: 100,
    maxPages: 10,
    domainOf: (r) => r.d,
  });
  assert.equal(short.length, 3, "頁が足りなくなったら止める");
  const sql = new PgDialect().sqlToQuery(reprobePrioritySql(10, true, 200));
  assert.match(sql.sql, /LIMIT \$\d+\s+OFFSET \$\d+\s*$/);
  assert.ok(sql.params.includes(200));
});

test("組 0: 優先の測り直しがタイムアウトしても、その前の比べた行で宣言ずれを見続ける", () => {
  const catalog = { method: "GET", priceAmount: "20000", priceAsset: "0xusdc", payTo: "0xpay", network: "eip155:8453" };
  const mismatch = {
    verdict: "fail",
    method: "GET",
    failReason: "price_mismatch",
    rawResponseMeta: { status: 402, declared: { amount: "10000", asset: "0xusdc", payTo: "0xpay", network: "eip155:8453" } },
  };
  const reach = (reason: string) => ({ verdict: "fail", method: "GET", failReason: reason, rawResponseMeta: { error: reason } });
  assert.equal(publishedFailDrifted([mismatch, mismatch], catalog), true);
  for (const reason of REACH_FAILURE_REASONS) {
    assert.equal(isReachFailureRow(reach(reason)), true, reason);
    assert.equal(publishedFailDrifted([reach(reason), mismatch, mismatch], catalog), true, `${reason} の行を足しても優先に残る`);
  }
  assert.equal(publishedFailDrifted([reach("timeout"), reach("dns"), mismatch], catalog), false, "公開 fail が到達失敗だけなら組 0 ではない");
  assert.equal(publishedFailDrifted([{ ...mismatch, verdict: "pass" }, mismatch], catalog), false, "公開 fail でない");
  assert.equal(
    publishedFailDrifted([mismatch, mismatch], { ...catalog, priceAmount: "10000" }),
    false,
    "宣言が今のカタログと同じ",
  );
  const q = new PgDialect().sqlToQuery(reprobePrioritySql(REPROBE_PRIORITY_LIMIT, true));
  assert.match(q.sql, /WHERE NOT \(r\.fail_reason IN \(\$\d+, \$\d+, \$\d+\) AND NOT coalesce\(r\.raw_response_meta \? 'declared', false\)\)/);
  for (const reason of REACH_FAILURE_REASONS) assert.ok(q.params.includes(reason), reason);
  assert.match(q.sql, /cmp\.raw_response_meta->'declared'/, "比べるのは cmp（到達失敗を飛ばした行）");
  assert.doesNotMatch(q.sql, /latest\.raw_response_meta->'declared'/);
});

test("送り直しの異議は、未測定のあいだ created_at を進めない", () => {
  const src = read("src/lib/observatory/record-subscriptions.ts");
  const at = src.indexOf('if (value.kind === "dispute")');
  const block = src.slice(at, src.indexOf("// notify:", at));
  assert.match(block, /WHEN record_subscriptions\.created_at > now\(\) - make_interval\(days => \$\{DISPUTE_PRIORITY_DAYS\}\)/);
  assert.match(block, /p\.probed_at >= record_subscriptions\.created_at/);
  assert.match(block, /THEN record_subscriptions\.created_at/);
  assert.doesNotMatch(block, /createdAt: sql`now\(\)`/);
});

test("送信後の文と記録頁は、その出品の判定で文を選ぶ", () => {
  const route = read("src/app/api/v1/observatory/endpoints/[id]/subscribe/route.ts");
  const form = read("src/components/site/RecordSubscribe.tsx");
  const page = read("src/app/observatory/e/[id]/page.tsx");
  assert.match(route, /formDisputeAck\(l0ProbeScheduleLabel\(\), result\.reprobe/);
  assert.match(route, /reprobe: result\.reprobe/);
  assert.match(form, /formDisputeAck\(l0ProbeScheduleLabel\(\), disputeReprobe\)/);
  assert.match(page, /formDisputeReprobeOf\(\{ status: endpoint\.status, pathTemplate: isPathTemplate\(endpoint\.resourceUrl\) \}\)/);
  assert.match(page, /formDisputeListingSentence\(l0ProbeScheduleLabel\(\), disputeReprobe\)/);
  assert.match(page, /disputeReprobe=\{disputeReprobe\}/);
  const home = read("src/app/page.tsx");
  assert.match(home, /which runs one fresh L0 probe of the/);
  assert.match(home, /formDisputeQueueSummary\(l0ProbeScheduleLabel\(\)\)/);
  assert.doesNotMatch(home, /cannot by itself produce a pass/, "1 回の pass は公開判定になる（publishedVerdict）");
  assert.match(home.replace(/\s+/g, " "), /One failing probe does not publish a fail, and one passing probe becomes the published verdict until the next probe\./);
  assert.match(read("src/app/legal/terms/page.tsx"), /We do not promise a/);
});
