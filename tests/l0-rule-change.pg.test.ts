// ============================================================
// 旧規則の公開 fail の測り直し（2026-09-29 監査 6 周目）——DB を通す部分。
//
// 守ること:
//  1. SQL 版（legacyRuleFailKindSql / needsRuleChangeReprobeSql）が JS 版と同じ行を拾う。
//  2. 一度きりの実行: 掲載中の対象だけに 1 出品 1 要求。同じ登録ドメインへの要求の開始は 1 秒以上あく。
//     最新のプローブが新しい出品は叩かない。公開判定が変わった出品だけ、プローブ行と訂正ログ
//     （reason=reverify・after.trigger=rule_change_reprobe）が両方残る。変わらなければ訂正ログは書かない。
//  3. 再実行は続きから（測り直して片付いた出品は対象から外れる）。
//  4. cron の C1 は旧規則の公開 fail を未測定より先に測り、公開判定が変われば訂正ログに残す。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l0-rule-change.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l0 rule change reprobe (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const envelope = (amount: string) =>
    Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", amount, asset: "0xusdc", payTo: "0xpay", maxTimeoutSeconds: 60 }],
      }),
    ).toString("base64");

  const LONG_V1_HEAD = `{"x402Version":1,"error":"X-PAYMENT header is required","accepts":[{"scheme":"exact","description":"${"d".repeat(480)}`.slice(0, 500);

  async function setup() {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = <T,>(raw: unknown) => [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];
    await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, correction_log`);
    const endpoint = async (key: string, url: string, method: string, status = "active") =>
      rows<{ id: string }>(
        await db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset, status, first_seen_at)
          VALUES (${key}, ${url}, ${method}, 'eip155:8453', '0xpay', '1000', '0xusdc', ${status}, now() - interval '20 days')
          RETURNING id::text AS id`),
      )[0].id;
    const probe = async (
      id: string,
      hoursAgo: number,
      p: { verdict?: string; method: string; status: number | null; reason: string | null; meta: Record<string, unknown> },
    ) =>
      db.execute(sql`
        INSERT INTO x402_l0_probes (endpoint_id, probed_at, method, verdict, http_status, fail_reason, raw_response_meta)
        VALUES (${id}::uuid, now() - make_interval(hours => ${hoursAgo}), ${p.method}, ${p.verdict ?? "fail"}, ${p.status}, ${p.reason},
                ${JSON.stringify(p.meta)}::jsonb)`);
    return { db, sql, rows, endpoint, probe };
  }

  test("SQL 版と JS 版が同じ行を旧規則の fail と見る", async () => {
    const { db, sql, rows, endpoint, probe } = await setup();
    const { legacyRuleFailKind, legacyRuleFailKindSql } = await import("@/lib/observatory/l0-rule-change");
    const id = await endpoint("k", "https://x.parity.test/a", "POST");
    const cases: { verdict?: string; method: string; status: number | null; reason: string | null; meta: Record<string, unknown> }[] = [
      { method: "POST", status: 400, reason: "no_402", meta: { status: 400, bodyHead: "{}" } },
      { method: "post", status: 422, reason: "no_402", meta: { status: 422 } },
      { method: "POST", status: 400, reason: "no_402", meta: { status: 400, bodyBytes: 2 } },
      { method: "GET", status: 400, reason: "no_402", meta: { status: 400 } },
      { method: "GET", status: 402, reason: "price_mismatch", meta: { status: 402 } },
      { method: "GET", status: 402, reason: "metadata_mismatch", meta: { status: 402, bodyBytes: 9, declared: {}, offered: [] } },
      { method: "GET", status: 402, reason: "accepts_invalid", meta: { status: 402, bodyHead: LONG_V1_HEAD } },
      { method: "GET", status: 402, reason: "accepts_invalid", meta: { status: 402, bodyHead: LONG_V1_HEAD, bodyBytes: 5000 } },
      { method: "GET", status: 402, reason: "accepts_invalid", meta: { status: 402, bodyHead: "<html>" } },
      { verdict: "unverified", method: "POST", status: 400, reason: "request_shape", meta: { status: 400, bodyBytes: 2 } },
      { verdict: "pass", method: "GET", status: 402, reason: null, meta: { status: 402, bodyBytes: 9 } },
      { method: "GET", status: null, reason: "timeout", meta: { error: "timeout" } },
    ];
    for (const [i, c] of cases.entries()) await probe(id, 100 + i, c);
    const got = rows<{ verdict: string; fail_reason: string | null; method: string; http_status: number | null; raw_response_meta: Record<string, unknown>; kind: string | null }>(
      await db.execute(sql`SELECT p.verdict, p.fail_reason, p.method, p.http_status, p.raw_response_meta, ${legacyRuleFailKindSql("p")} AS kind
                            FROM x402_l0_probes p ORDER BY p.probed_at DESC`),
    );
    assert.equal(got.length, cases.length);
    for (const g of got) {
      const js = legacyRuleFailKind({ verdict: g.verdict, failReason: g.fail_reason, method: g.method, httpStatus: g.http_status, rawResponseMeta: g.raw_response_meta });
      assert.equal(g.kind, js, `${g.method} ${g.http_status} ${g.fail_reason}`);
    }
    assert.deepEqual(
      got.map((g) => g.kind).filter(Boolean),
      ["post_400_422_no_402", "post_400_422_no_402", "mismatch_values_unrecorded", "accepts_invalid_body_cut"],
    );
  });

  test("一度きりの実行: 対象だけに 1 要求、同じドメインは 1 秒以上あけ、公開判定が変わった出品だけ訂正ログを書く", async () => {
    const { db, sql, rows, endpoint, probe } = await setup();
    const { selectRuleChangeTargets, startRuleChangeReprobe } = await import("@/lib/observatory/l0-rule-change-reprobe");
    const legacyPost = { method: "POST", status: 400, reason: "no_402", meta: { status: 400, bodyHead: '{"error":"missing field"}' } };
    const legacyMismatch = { method: "GET", status: 402, reason: "price_mismatch", meta: { status: 402, bodyHead: "" } };

    const a = await endpoint("a", "https://api.alpha.test/post", "POST"); // POST 400 → request_shape → fail→unverified
    await probe(a, 30, legacyPost);
    await probe(a, 50, legacyPost);
    const beta = [] as string[]; // 同じ登録ドメインの 3 出品。今も不一致 → fail のまま（訂正ログなし）
    for (const sub of ["x", "y", "z"]) {
      const id = await endpoint(`b-${sub}`, `https://${sub}.beta.test/price`, "GET");
      await probe(id, 30, legacyMismatch);
      await probe(id, 50, legacyMismatch);
      beta.push(id);
    }
    const f = await endpoint("f", "https://api.gamma.test/v1", "GET"); // 4,000 バイトで切った疑い → 今は pass
    await probe(f, 30, { method: "GET", status: 402, reason: "accepts_invalid", meta: { status: 402, bodyHead: LONG_V1_HEAD } });
    await probe(f, 50, { method: "GET", status: 402, reason: "accepts_invalid", meta: { status: 402, bodyHead: LONG_V1_HEAD } });
    const c = await endpoint("c", "https://api.current.test/v1", "GET"); // 今の規則の fail 2 回 → 対象外
    await probe(c, 30, { method: "GET", status: 404, reason: "no_402", meta: { status: 404, bodyBytes: 3 } });
    await probe(c, 50, { method: "GET", status: 404, reason: "no_402", meta: { status: 404, bodyBytes: 3 } });
    const d = await endpoint("d", "https://api.recent.test/post", "POST"); // 対象だが 1 時間前に測った → 叩かない
    await probe(d, 1, legacyPost);
    await probe(d, 50, legacyPost);
    const del = await endpoint("del", "https://api.delisted.test/post", "POST", "delisted"); // 掲載終了 → 対象外
    await probe(del, 30, legacyPost);
    await probe(del, 50, legacyPost);
    const single = await endpoint("s", "https://api.single.test/post", "POST"); // 1 回の fail は公開されていない → 対象外
    await probe(single, 30, legacyPost);

    const targets = await selectRuleChangeTargets(100);
    assert.deepEqual(new Set(targets.map((t) => t.id)), new Set([a, ...beta, f, d]));

    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      const host = new URL(url).hostname;
      if (host === "api.alpha.test") return new Response('{"error":"missing field"}', { status: 400, headers: { "content-type": "application/json" } });
      if (host.endsWith("beta.test")) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": envelope("2000") } });
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": envelope("1000") } });
    };
    const starts: [string, number][] = [];
    const run = startRuleChangeReprobe({
      targets,
      concurrency: 8,
      intervalMs: 1000,
      maxMinutes: 1,
      minAgeHours: 6,
      fetchImpl,
      onRequestStart: (domain, at) => starts.push([domain, at]),
    });
    const s = await run.done;

    assert.deepEqual(seen.sort(), ["https://api.alpha.test/post", "https://api.gamma.test/v1", "https://x.beta.test/price", "https://y.beta.test/price", "https://z.beta.test/price"]);
    const betaStarts = starts.filter(([dom]) => dom === "beta.test").map(([, at]) => at).sort((x, y) => x - y);
    assert.equal(betaStarts.length, 3);
    for (let i = 1; i < betaStarts.length; i++) assert.ok(betaStarts[i] - betaStarts[i - 1] >= 1000, `beta.test spacing ${betaStarts[i] - betaStarts[i - 1]}ms`);
    assert.equal(s.probed, 5);
    assert.equal(s.corrected, 2);
    assert.equal(s.skippedRecent, 1);
    assert.equal(s.stillRestingOnLegacyRow, 3, "beta.* は新しい行が今の規則の fail、2 行目がまだ旧規則");
    assert.deepEqual(s.transitions, { "fail->unverified": 1, "fail->fail": 3, "fail->pass": 1 });
    assert.equal(s.stoppedBy, "done");

    const corrections = rows<{ subject_id: string; reason: string; level: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
      await db.execute(sql`SELECT subject_id, reason, level, before, after FROM correction_log ORDER BY subject_id`),
    );
    assert.deepEqual(corrections.map((r) => r.subject_id).sort(), [a, f].sort());
    const ca = corrections.find((r) => r.subject_id === a)!;
    assert.equal(ca.reason, "reverify");
    assert.equal(ca.level, "l0");
    assert.deepEqual(ca.before, { publishedVerdict: "fail", legacyRuleRows: ["post_400_422_no_402"] });
    assert.equal(ca.after.publishedVerdict, "unverified");
    assert.equal(ca.after.failReason, "request_shape");
    assert.equal(ca.after.trigger, "rule_change_reprobe");
    const cf = corrections.find((r) => r.subject_id === f)!;
    assert.deepEqual([cf.before.publishedVerdict, cf.after.publishedVerdict], ["fail", "pass"]);

    const newRows = rows<{ endpoint_id: string; verdict: string; fail_reason: string | null; trigger: string; by: string; declared: unknown }>(
      await db.execute(sql`SELECT endpoint_id::text AS endpoint_id, verdict, fail_reason, raw_response_meta->>'trigger' AS trigger,
                                  raw_response_meta->>'reprobeBy' AS by, raw_response_meta->'declared' AS declared
                           FROM x402_l0_probes WHERE raw_response_meta ? 'trigger'`),
    );
    assert.equal(newRows.length, 5);
    assert.ok(newRows.every((r) => r.trigger === "rule_change_reprobe" && r.by === "script"));
    assert.ok(newRows.filter((r) => beta.includes(r.endpoint_id)).every((r) => r.fail_reason === "price_mismatch" && r.declared !== null), "不一致は比べた値つきで記録");

    // 再実行＝続きから: 片付いた a・f は外れ、beta.*（2 行目が旧規則）と d は残る。beta.* は今測ったばかりなので叩かない。
    const again = await selectRuleChangeTargets(100);
    assert.deepEqual(new Set(again.map((t) => t.id)), new Set([...beta, d]));
    seen.length = 0;
    const s2 = await startRuleChangeReprobe({ targets: again, concurrency: 8, intervalMs: 1000, maxMinutes: 1, minAgeHours: 6, fetchImpl }).done;
    assert.equal(seen.length, 0);
    assert.equal(s2.skippedRecent, 4);
  });

  test("stop(): 新しい要求を出さずに終わり、残りは not_started に数える", async () => {
    const { endpoint, probe } = await setup();
    const { selectRuleChangeTargets, startRuleChangeReprobe } = await import("@/lib/observatory/l0-rule-change-reprobe");
    const legacyPost = { method: "POST", status: 400, reason: "no_402", meta: { status: 400 } };
    for (const n of [1, 2, 3, 4]) {
      const id = await endpoint(`s${n}`, `https://h${n}.stop.test/p`, "POST");
      await probe(id, 30, legacyPost);
      await probe(id, 50, legacyPost);
    }
    const targets = await selectRuleChangeTargets(100);
    let requests = 0;
    const run = startRuleChangeReprobe({
      targets,
      concurrency: 4,
      intervalMs: 1000,
      maxMinutes: 1,
      minAgeHours: 6,
      fetchImpl: async () => {
        requests++;
        run.stop();
        return new Response("{}", { status: 400 });
      },
    });
    const s = await run.done;
    assert.equal(s.stoppedBy, "signal");
    assert.equal(requests, 1, "同じドメインの 2 件目は 1 秒待つので、その間に止まる");
    assert.equal(s.probed + s.notStarted, 4);
  });

  test("cron C1: 旧規則の公開 fail を未測定より先に測り、公開判定が変われば訂正ログに残す", async () => {
    const { db, sql, rows, endpoint, probe } = await setup();
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const never = await endpoint("never", "https://api.never.test/x", "GET"); // 未測定（従来は先頭の組）
    const legacy = await endpoint("legacy", "https://api.legacy.test/post", "POST");
    await probe(legacy, 30, { method: "POST", status: 422, reason: "no_402", meta: { status: 422 } });
    await probe(legacy, 50, { method: "POST", status: 422, reason: "no_402", meta: { status: 422 } });
    const seen: string[] = [];
    const summary = await runL0ProbeBatch({
      tier: "c1",
      limit: 1,
      concurrency: 1,
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response('{"error":"bad input"}', { status: 422, headers: { "content-type": "application/json" } });
      },
    });
    assert.deepEqual(seen, ["https://api.legacy.test/post"]);
    assert.equal(summary.ruleChangeReprobed, 1);
    assert.equal(summary.ruleChangeCorrected, 1);
    const log = rows<{ subject_id: string; reason: string; after: Record<string, unknown> }>(
      await db.execute(sql`SELECT subject_id, reason, after FROM correction_log`),
    );
    assert.equal(log.length, 1);
    assert.equal(log[0].subject_id, legacy);
    assert.equal(log[0].reason, "reverify");
    assert.equal(log[0].after.publishedVerdict, "unverified");
    const by = rows<{ by: string }>(await db.execute(sql`SELECT raw_response_meta->>'reprobeBy' AS by FROM x402_l0_probes WHERE raw_response_meta ? 'trigger'`));
    assert.deepEqual(by.map((r) => r.by), ["cron_c1"]);

    // 次の実行は通常どおり（旧規則の出品は片付いたので、未測定が先）。訂正ログは増えない。
    seen.length = 0;
    const s2 = await runL0ProbeBatch({ tier: "c1", limit: 1, concurrency: 1, fetchImpl: async (url) => (seen.push(url), new Response("{}", { status: 404 })) });
    assert.deepEqual(seen, ["https://api.never.test/x"]);
    assert.equal(s2.ruleChangeReprobed, 0);
    assert.equal(rows(await db.execute(sql`SELECT 1 FROM correction_log`)).length, 1);
    void never;
  });

  test("cron C1: 1 回の実行で優先するのは 1 ホスト RULE_CHANGE_PRIORITY_PER_HOST 件まで、ホストを交互に並べる", async () => {
    const { endpoint, probe } = await setup();
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { RULE_CHANGE_PRIORITY_PER_HOST } = await import("@/lib/observatory/l0-rule-change");
    const legacyPost = { method: "POST", status: 400, reason: "no_402", meta: { status: 400 } };
    for (let i = 0; i < RULE_CHANGE_PRIORITY_PER_HOST + 3; i++) {
      const id = await endpoint(`big-${i}`, `https://api.big.test/p${i}`, "POST");
      await probe(id, 30, legacyPost);
      await probe(id, 50, legacyPost);
    }
    const small = await endpoint("small", "https://api.small.test/p", "POST");
    await probe(small, 30, legacyPost);
    await probe(small, 50, legacyPost);
    await endpoint("never", "https://api.never.test/x", "GET");
    const seen: string[] = [];
    await runL0ProbeBatch({
      tier: "c1",
      limit: RULE_CHANGE_PRIORITY_PER_HOST + 2,
      concurrency: 1,
      fetchImpl: async (url) => (seen.push(url), new Response("{}", { status: 400 })),
    });
    const hosts = seen.map((u) => new URL(u).hostname);
    assert.equal(hosts.filter((h) => h === "api.big.test").length, RULE_CHANGE_PRIORITY_PER_HOST, "big は上限まで");
    assert.equal(hosts[0] === "api.small.test" || hosts[1] === "api.small.test", true, "小さいホストが後回しにならない（交互）");
    assert.equal(hosts.at(-1), "api.never.test", "上限を超えた分は通常の並び（未測定が先）へ戻る");
  });
}
