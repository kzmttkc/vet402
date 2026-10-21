// D-01: c1 の 30 日窓の外にある公開 fail（宣言が変わった）と、フォーム異議を先頭で測る。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/reprobe-priority.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("reprobe priority (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  async function setup() {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const db = getDb()!;
    const rows = <T,>(raw: unknown) => [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];
    await db.execute(sql`
      TRUNCATE record_subscriptions, disputes, x402_l0_probes, x402_endpoints, x402_catalog_snapshots, x402_delisting_events, correction_log, job_leases
    `);
    const endpoint = async (input: {
      key: string;
      url: string;
      price: string;
      network?: string;
      method?: string;
      status?: string;
      seenDaysAgo: number;
      firstDaysAgo?: number;
    }) =>
      rows<{ id: string }>(
        await db.execute(sql`
          INSERT INTO x402_endpoints (
            resource_key, resource_url, method, network, pay_to, price_amount, price_asset, status, last_seen_at, first_seen_at
          ) VALUES (
            ${input.key}, ${input.url}, ${input.method ?? "GET"}, ${input.network ?? "eip155:8453"}, '0xpay',
            ${input.price}, '0xusdc', ${input.status ?? "active"},
            now() - make_interval(days => ${input.seenDaysAgo}),
            now() - make_interval(days => ${input.firstDaysAgo ?? input.seenDaysAgo})
          ) RETURNING id::text AS id`),
      )[0].id;
    const probe = async (id: string, hoursAgo: number, meta: Record<string, unknown>, verdict = "fail") =>
      db.execute(sql`
        INSERT INTO x402_l0_probes (endpoint_id, probed_at, method, verdict, http_status, fail_reason, raw_response_meta)
        VALUES (
          ${id}::uuid, now() - make_interval(secs => ${Math.round(hoursAgo * 3600)}), 'GET', ${verdict}, 402,
          ${verdict === "fail" ? "price_mismatch" : null}, ${JSON.stringify(meta)}::jsonb
        )`);
    const wall = (amount: string) =>
      new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: "eip155:8453", amount, asset: "0xusdc", payTo: "0xpay", maxTimeoutSeconds: 60 }],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    return { db, sql, rows, endpoint, probe, wall, runL0ProbeBatch };
  }

  const declared = (amount: string, network = "eip155:8453") => ({
    declared: { amount, asset: "0xusdc", payTo: "0xpay", network },
    offered: [{ amount, asset: "0xusdc", network, payTo: "0xpay" }],
  });

  test("c1 の外の価格変更 fail を未測定より先に測り、網の表記ゆれだけでは測らない", async () => {
    const { endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const drift = await endpoint({
      key: "drift",
      url: "https://drift.example/why",
      price: "20000",
      seenDaysAgo: 40,
    });
    await probe(drift, 400, declared("10000"));
    await probe(drift, 300, declared("10000"));
    const spelling = await endpoint({
      key: "spell",
      url: "https://spell.example/why",
      price: "1000",
      network: "base",
      seenDaysAgo: 40,
      firstDaysAgo: 50,
    });
    await probe(spelling, 500, declared("1000", "eip155:8453"));
    await probe(spelling, 450, declared("1000", "eip155:8453"));
    await endpoint({ key: "fresh", url: "https://fresh.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });

    const seen: string[] = [];
    await runL0ProbeBatch({
      tier: "c1",
      limit: 1,
      concurrency: 1,
      fetchImpl: async (url) => {
        seen.push(url);
        return wall("20000");
      },
    });
    assert.deepEqual(seen, ["https://drift.example/why"]);

    seen.length = 0;
    await runL0ProbeBatch({
      tier: "c1",
      limit: 2,
      concurrency: 1,
      fetchImpl: async (url) => {
        seen.push(url);
        return wall("1000");
      },
    });
    assert.deepEqual(seen, ["https://fresh.example/why"]);
  });

  test("7 日以内のフォーム異議はプローブが無ければ先頭、過ぎた異議と測り直し済みは外す", async () => {
    const { db, sql, endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const open = await endpoint({
      key: "open",
      url: "https://open.example/why",
      price: "1000",
      seenDaysAgo: 40,
    });
    await probe(open, 100, declared("1000"), "pass");
    await db.execute(sql`
      INSERT INTO record_subscriptions (endpoint_id, email, kind, reason, last_verdict, created_at)
      VALUES (${open}::uuid, 'seller@example.com', 'dispute', 'the price on the 402 matches the catalog now', 'fail', now())
    `);
    const stale = await endpoint({
      key: "stale",
      url: "https://stale.example/why",
      price: "1000",
      seenDaysAgo: 40,
      firstDaysAgo: 41,
    });
    await probe(stale, 200, declared("1000"), "pass");
    await db.execute(sql`
      INSERT INTO record_subscriptions (endpoint_id, email, kind, reason, last_verdict, created_at)
      VALUES (${stale}::uuid, 'seller@example.com', 'dispute', 'this objection is older than the window', 'fail', now() - interval '8 days')
    `);
    const done = await endpoint({
      key: "done",
      url: "https://done.example/why",
      price: "1000",
      seenDaysAgo: 40,
      firstDaysAgo: 42,
    });
    await db.execute(sql`
      INSERT INTO disputes (endpoint_id, subject, reason, signer, message, signature, created_at)
      VALUES (${done}::uuid, 'l0', 'signed', '0xpay', 'msg', 'sig', now() - interval '2 hours')
    `);
    await probe(done, 1, declared("1000"), "pass");
    await endpoint({ key: "fresh", url: "https://fresh.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });

    const seen: string[] = [];
    await runL0ProbeBatch({
      tier: "c1",
      limit: 1,
      concurrency: 1,
      fetchImpl: async (url) => {
        seen.push(url);
        return wall("1000");
      },
    });
    assert.deepEqual(seen, ["https://open.example/why"]);

    seen.length = 0;
    await runL0ProbeBatch({
      tier: "all",
      limit: 3,
      concurrency: 1,
      fetchImpl: async (url) => {
        seen.push(url);
        return wall("1000");
      },
    });
    assert.equal(seen[0], "https://fresh.example/why");
  });

  const formDispute = async (
    db: Awaited<ReturnType<typeof setup>>["db"],
    sql: Awaited<ReturnType<typeof setup>>["sql"],
    id: string,
    hoursAgo: number,
    email = "seller@example.com",
  ) =>
    db.execute(sql`
      INSERT INTO record_subscriptions (endpoint_id, email, kind, reason, last_verdict, created_at)
      VALUES (${id}::uuid, ${email}, 'dispute', 'the 402 matches the catalog now, please re-probe', 'fail',
              now() - make_interval(secs => ${Math.round(hoursAgo * 3600)}))
    `);
  const record = (seen: string[], amount: string, wall: (a: string) => Response) => async (url: string) => {
    seen.push(url);
    return wall(amount);
  };

  test("宣言がずれた公開 fail は、より古い異議より先に枠を取る（異議は残りの枠）", async () => {
    const { db, sql, endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const disputed = await endpoint({ key: "disp", url: "https://disputed.example/why", price: "1000", seenDaysAgo: 40, firstDaysAgo: 60 });
    await probe(disputed, 600, declared("1000"), "pass");
    await formDispute(db, sql, disputed, 120);
    const drift = await endpoint({ key: "drift", url: "https://drift.example/why", price: "20000", seenDaysAgo: 40 });
    await probe(drift, 400, declared("10000"));
    await probe(drift, 300, declared("10000"));

    const seen: string[] = [];
    await runL0ProbeBatch({ tier: "c1", limit: 1, concurrency: 1, fetchImpl: record(seen, "20000", wall) });
    assert.deepEqual(seen, ["https://drift.example/why"]);

    seen.length = 0;
    await runL0ProbeBatch({ tier: "c1", limit: 1, concurrency: 1, fetchImpl: record(seen, "1000", wall) });
    assert.deepEqual(seen, ["https://disputed.example/why"], "公開 fail が済めば異議が枠を使う");
  });

  test("掲載外・パステンプレート・60 分以内に測った出品は、異議があっても優先に入らない", async () => {
    const { db, sql, endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const gone = await endpoint({ key: "gone", url: "https://gone.example/why", price: "1000", status: "delisted", seenDaysAgo: 40 });
    await formDispute(db, sql, gone, 1);
    const tmpl = await endpoint({ key: "tmpl", url: "https://tmpl.example/v1/:id", price: "1000", seenDaysAgo: 40 });
    await formDispute(db, sql, tmpl, 1);
    const recent = await endpoint({ key: "recent", url: "https://recent.example/why", price: "1000", seenDaysAgo: 40 });
    await probe(recent, 0.5, declared("1000"), "pass");
    await formDispute(db, sql, recent, 0.25);
    await endpoint({ key: "fresh", url: "https://fresh.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });

    const seen: string[] = [];
    const summary = await runL0ProbeBatch({ tier: "c1", limit: 10, concurrency: 1, fetchImpl: record(seen, "1000", wall) });
    assert.deepEqual(seen, ["https://fresh.example/why"]);
    assert.equal(summary.probed, 1);
  });

  test("別の実行が優先のリースを持っていれば、この実行は優先分を飛ばして普通の列だけ測る", async () => {
    const { db, sql, rows, endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const drift = await endpoint({ key: "drift", url: "https://drift.example/why", price: "20000", seenDaysAgo: 40 });
    await probe(drift, 400, declared("10000"));
    await probe(drift, 300, declared("10000"));
    await endpoint({ key: "fresh", url: "https://fresh.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });
    const { PRIORITY_LEASE_NAME } = await import("@/lib/observatory/reprobe-priority-const");
    await db.execute(sql`
      INSERT INTO job_leases (name, holder, acquired_at, expires_at)
      VALUES (${PRIORITY_LEASE_NAME}, gen_random_uuid(), now(), now() + interval '5 minutes')
    `);

    const seen: string[] = [];
    await runL0ProbeBatch({ tier: "c1", limit: 1, concurrency: 1, fetchImpl: record(seen, "1000", wall) });
    assert.deepEqual(seen, ["https://fresh.example/why"]);

    await db.execute(sql`DELETE FROM job_leases WHERE name = ${PRIORITY_LEASE_NAME}`);
    seen.length = 0;
    await runL0ProbeBatch({ tier: "c1", limit: 1, concurrency: 1, fetchImpl: record(seen, "20000", wall) });
    assert.deepEqual(seen, ["https://drift.example/why"]);
    const left = rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM job_leases WHERE name = ${PRIORITY_LEASE_NAME}`),
    );
    assert.equal(left[0].n, 0, "終わったらリースを返す");
  });

  test("同じ出品・同じメールの送り直しは、未測定のあいだ created_at を進めない。測った後の送り直しは進める", async () => {
    const { db, sql, rows, endpoint, probe } = await setup();
    const { submitSubscription } = await import("@/lib/observatory/record-subscriptions");
    const id = await endpoint({ key: "resend", url: "https://resend.example/why", price: "1000", seenDaysAgo: 40 });
    await probe(id, 100, declared("1000"), "pass");
    const input = { endpointId: id, email: "seller@example.com", kind: "dispute" as const, reason: "the 402 matches the catalog now, please re-probe" };
    const first = await submitSubscription(input, "198.51.100.7");
    assert.equal(first.ok && first.reprobe, "queued");
    await db.execute(sql`UPDATE record_subscriptions SET created_at = now() - interval '2 days' WHERE endpoint_id = ${id}::uuid`);
    const createdAt = async () =>
      rows<{ age: number }>(
        await db.execute(sql`
          SELECT extract(epoch FROM now() - created_at)::float8 AS age FROM record_subscriptions WHERE endpoint_id = ${id}::uuid`),
      )[0].age;
    const before = await createdAt();
    await submitSubscription({ ...input, reason: "sending it again with more detail about the 402 body" }, "198.51.100.7");
    const after = await createdAt();
    assert.ok(Math.abs(after - before) < 1, `未測定の送り直しで created_at が動いた (${before} -> ${after})`);
    assert.ok(after > 86_400, "2 日前のまま");

    await probe(id, 1, declared("1000"), "pass");
    await submitSubscription({ ...input, reason: "a new objection after the re-probe was added" }, "198.51.100.7");
    assert.ok((await createdAt()) < 60, "測った後の送り直しは新しい異議として now()");
  });

  test("掲載外の出品へのフォーム異議は reprobe = not_active、パステンプレートは path_template", async () => {
    const { endpoint } = await setup();
    const { submitSubscription } = await import("@/lib/observatory/record-subscriptions");
    const gone = await endpoint({ key: "gone", url: "https://gone.example/why", price: "1000", status: "delisted", seenDaysAgo: 40 });
    const tmpl = await endpoint({ key: "tmpl", url: "https://tmpl.example/v1/:id", price: "1000", seenDaysAgo: 40 });
    const reason = "the 402 matches the catalog now, please re-probe";
    const a = await submitSubscription({ endpointId: gone, email: "a@example.com", kind: "dispute", reason }, "198.51.100.8");
    const b = await submitSubscription({ endpointId: tmpl, email: "a@example.com", kind: "dispute", reason }, "198.51.100.8");
    assert.equal(a.ok && a.reprobe, "not_active");
    assert.equal(b.ok && b.reprobe, "path_template");
  });

  test("c1 の窓の外で declared の無い旧規則の公開 fail は、宣言ずれの次・異議の前に入る", async () => {
    const { db, sql, endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const disputed = await endpoint({ key: "disp", url: "https://disputed.example/why", price: "1000", seenDaysAgo: 40, firstDaysAgo: 60 });
    await probe(disputed, 600, declared("1000"), "pass");
    await formDispute(db, sql, disputed, 120);
    const legacy = await endpoint({ key: "legacy", url: "https://legacy.example/why", price: "1000", seenDaysAgo: 40 });
    await probe(legacy, 400, { status: 402 });
    await probe(legacy, 300, { status: 402 });
    await endpoint({ key: "fresh", url: "https://fresh.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });

    const seen: string[] = [];
    await runL0ProbeBatch({ tier: "c1", limit: 2, concurrency: 1, fetchImpl: record(seen, "1000", wall) });
    assert.deepEqual(seen, ["https://legacy.example/why", "https://disputed.example/why"]);
  });

  test("優先の測り直しがタイムアウトしても、宣言ずれの公開 fail は次の回も先頭に残る", async () => {
    const { db, sql, endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const drift = await endpoint({ key: "drift", url: "https://drift.example/why", price: "20000", seenDaysAgo: 40 });
    await probe(drift, 400, declared("10000"));
    await probe(drift, 300, declared("10000"));
    await db.execute(sql`
      INSERT INTO x402_l0_probes (endpoint_id, probed_at, method, verdict, http_status, fail_reason, raw_response_meta)
      VALUES (${drift}::uuid, now() - interval '2 hours', 'GET', 'fail', NULL, 'timeout', '{"error":"timeout"}'::jsonb)`);
    await endpoint({ key: "fresh", url: "https://fresh.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });

    const seen: string[] = [];
    await runL0ProbeBatch({ tier: "c1", limit: 1, concurrency: 1, fetchImpl: record(seen, "20000", wall) });
    assert.deepEqual(seen, ["https://drift.example/why"]);
  });

  test("普通の列も、直近 60 分に測った出品を次の回へ回す", async () => {
    const { endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const recent = await endpoint({ key: "recent", url: "https://recent.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 2 });
    await probe(recent, 0.5, declared("1000"), "fail");
    const older = await endpoint({ key: "older", url: "https://older.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 3 });
    await probe(older, 3, declared("1000"), "pass");

    const seen: string[] = [];
    await runL0ProbeBatch({ tier: "c1", limit: 5, concurrency: 1, fetchImpl: record(seen, "1000", wall) });
    assert.deepEqual(seen, ["https://older.example/why"]);
  });

  test("同じ登録ドメインの普通の列は、そのドメインの優先が測っているあいだ始まらない", async () => {
    const { endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const drift = await endpoint({ key: "drift", url: "https://slow.shop.example/a", price: "20000", seenDaysAgo: 40 });
    await probe(drift, 400, declared("10000"));
    await probe(drift, 300, declared("10000"));
    await endpoint({ key: "normal", url: "https://api.shop.example/b", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });
    const events: { url: string; at: number; kind: "start" | "end" }[] = [];
    await runL0ProbeBatch({
      tier: "c1",
      limit: 5,
      concurrency: 4,
      fetchImpl: async (url) => {
        events.push({ url, at: Date.now(), kind: "start" });
        if (url.includes("slow.shop")) await new Promise((r) => setTimeout(r, 80));
        events.push({ url, at: Date.now(), kind: "end" });
        return wall(url.includes("slow.shop") ? "20000" : "1000");
      },
    });
    const priorityEnd = events.find((e) => e.kind === "end" && e.url.includes("slow.shop"));
    const normalStart = events.find((e) => e.kind === "start" && e.url.includes("api.shop"));
    assert.ok(priorityEnd && normalStart, JSON.stringify(events));
    assert.ok(normalStart.at >= priorityEnd.at, "優先が終わる前に同じドメインの普通の列が始まった");
    assert.equal(events.indexOf(normalStart) > events.indexOf(priorityEnd), true);
  });

  test("要求の直前に、別の実行が書いた直近 60 分の行を見て飛ばす（選定の後に書かれた行）", async () => {
    const { db, sql, endpoint, wall, runL0ProbeBatch } = await setup();
    await endpoint({ key: "a", url: "https://a.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 5 });
    const b = await endpoint({ key: "b", url: "https://b.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 4 });
    const seen: string[] = [];
    const summary = await runL0ProbeBatch({
      tier: "c1",
      limit: 5,
      concurrency: 1,
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.startsWith("https://a.example")) {
          // 重なった別の実行が、b を選定の後に測って行を書いた。
          await db.execute(sql`
            INSERT INTO x402_l0_probes (endpoint_id, probed_at, method, verdict, http_status, fail_reason, raw_response_meta)
            VALUES (${b}::uuid, now(), 'GET', 'fail', NULL, 'timeout', '{"error":"timeout"}'::jsonb)`);
        }
        return wall("1000");
      },
    });
    assert.deepEqual(seen, ["https://a.example/why"]);
    assert.equal(summary.skippedRecent, 1);
  });

  test("重なった 2 本の実行: 1 本目が要求の途中（行はまだ無い）のあいだ、2 本目は同じ出品へ要求を出さない", async () => {
    const { db, sql, rows, endpoint, probe, wall, runL0ProbeBatch } = await setup();
    // c1 の窓の中の宣言ずれ: 1 本目は優先で、リースを取れない 2 本目は普通の列で同じ出品を選ぶ。
    const drift = await endpoint({ key: "drift", url: "https://drift.example/why", price: "20000", seenDaysAgo: 1, firstDaysAgo: 30 });
    await probe(drift, 400, declared("10000"));
    await probe(drift, 300, declared("10000"));
    await endpoint({ key: "fresh", url: "https://fresh.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });

    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const firstSeen: string[] = [];
    let entered: () => void = () => {};
    const bothInside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = runL0ProbeBatch({
      tier: "c1",
      limit: 5,
      concurrency: 2,
      fetchImpl: async (url) => {
        firstSeen.push(url);
        if (firstSeen.length === 1) entered();
        await gate;
        return wall(url.includes("drift") ? "20000" : "1000");
      },
    });
    await bothInside;
    const secondSeen: string[] = [];
    const second = await runL0ProbeBatch({ tier: "c1", limit: 5, concurrency: 2, fetchImpl: record(secondSeen, "1000", wall) });
    assert.ok(firstSeen.includes("https://drift.example/why"), JSON.stringify(firstSeen));
    assert.equal(secondSeen.includes("https://drift.example/why"), false, "1 本目が測っている出品に 2 本目が要求を出した");
    assert.ok(second.skippedBusy >= 1);
    open();
    const done = await first;
    assert.equal(done.probed + done.skippedRecent, 2, "fresh は 2 本目が書いた行を見て飛ばすか、自分で測る");
    assert.equal(secondSeen.filter((u) => u.includes("drift")).length + firstSeen.filter((u) => u.includes("drift")).length, 1);
    const left = rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM job_leases WHERE name LIKE 'l0:endpoint:%'`),
    );
    assert.equal(left[0].n, 0, "行を書いたあとに出品のリースを返す");
  });

  test("優先の段: 本文を送り続ける 1 件は合計の上限で打ち切り、行を書かずに段を進める", async () => {
    const { db, sql, rows, endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const slow = await endpoint({ key: "slow", url: "https://slowbody.example/why", price: "20000", seenDaysAgo: 40 });
    await probe(slow, 400, declared("10000"));
    await probe(slow, 300, declared("10000"));
    await endpoint({ key: "fresh", url: "https://fresh.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });
    const seen: string[] = [];
    const t0 = Date.now();
    const summary = await runL0ProbeBatch({
      tier: "c1",
      limit: 5,
      concurrency: 2,
      timeoutMs: 5_000,
      priorityRequestLimitMs: 200,
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.includes("slowbody")) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          });
          return new Response(body, { status: 402, headers: { "content-type": "application/json" } });
        }
        return wall("1000");
      },
    });
    assert.ok(Date.now() - t0 < 3_000, `段が閉じなかった (${Date.now() - t0} ms)`);
    assert.equal(summary.priorityAbandoned, 1);
    assert.deepEqual(seen, ["https://slowbody.example/why", "https://fresh.example/why"]);
    const n = rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM x402_l0_probes WHERE endpoint_id = ${slow}::uuid`),
    );
    assert.equal(n[0].n, 2, "打ち切った 1 件は行を書かない");
  });

  test("1 登録ドメインが先頭を埋めても、5 件で切った分を次の頁で埋め、他のドメインの公開 fail が入る", async () => {
    const { db, endpoint, probe } = await setup();
    const { selectReprobePriority } = await import("@/lib/observatory/reprobe-priority");
    for (let i = 0; i < 8; i++) {
      const id = await endpoint({ key: `shop-${i}`, url: `https://h${i}.shop.example/why`, price: "20000", seenDaysAgo: 40 });
      await probe(id, 500 - i, declared("10000"));
      await probe(id, 450 - i, declared("10000"));
    }
    const other = await endpoint({ key: "other", url: "https://other.test/why", price: "20000", seenDaysAgo: 40 });
    await probe(other, 200, declared("10000"));
    await probe(other, 100, declared("10000"));
    const picked = await selectReprobePriority(db, 50, true, 3);
    const urls = picked.map((c) => c.resourceUrl);
    assert.equal(urls.filter((u) => u.endsWith(".shop.example/why")).length, 5, JSON.stringify(urls));
    assert.ok(urls.includes("https://other.test/why"), "5 件で切った後ろのドメインが入らない");
  });

  test("リースの後の直近行の SELECT が投げても、その 1 件だけ飛ばし、リース行を残さず、段と普通の列は続ける", async () => {
    const { db, sql, rows, endpoint, probe, wall, runL0ProbeBatch } = await setup();
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const broken = await endpoint({ key: "broken", url: "https://broken.example/why", price: "20000", seenDaysAgo: 40 });
    await probe(broken, 400, declared("10000"));
    await probe(broken, 300, declared("10000"));
    const other = await endpoint({ key: "other", url: "https://other.example/why", price: "20000", seenDaysAgo: 40, firstDaysAgo: 41 });
    await probe(other, 400, declared("10000"));
    await probe(other, 300, declared("10000"));
    await endpoint({ key: "fresh", url: "https://fresh.example/why", price: "1000", seenDaysAgo: 1, firstDaysAgo: 1 });

    const dialect = new PgDialect();
    const original = db.execute.bind(db);
    (db as { execute: unknown }).execute = async (query: Parameters<typeof db.execute>[0]) => {
      const q = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
      if (q.sql.includes("AS hit FROM x402_l0_probes") && q.params.includes(broken)) {
        throw new Error("connection reset while reading recent probes");
      }
      return original(query);
    };
    const seen: string[] = [];
    let summary;
    try {
      summary = await runL0ProbeBatch({ tier: "c1", limit: 5, concurrency: 1, fetchImpl: record(seen, "20000", wall) });
    } finally {
      (db as { execute: unknown }).execute = original;
    }
    assert.equal(summary.itemErrors, 1);
    assert.equal(seen.includes("https://broken.example/why"), false, "投げた 1 件は要求を出さない");
    assert.ok(seen.includes("https://other.example/why"), "優先の段は続く");
    assert.ok(seen.includes("https://fresh.example/why"), "普通の列も走る");
    const left = rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM job_leases WHERE name LIKE 'l0:endpoint:%'`),
    );
    assert.equal(left[0].n, 0, "例外でも出品のリースを返す");
  });
}
