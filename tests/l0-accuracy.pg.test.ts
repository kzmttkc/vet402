// §12 の SQL が実際に走り、数え方が定義どおりであることを DB で固定する。
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("l0 accuracy sql (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("l0 accuracy sql", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { fetchL0AccuracyInput, fetchSloSnapshot } = await import("@/lib/scoring/l0-accuracy");
    const { getCoverageWeekly } = await import("@/lib/observatory/coverage-report");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_l0_probes, x402_l1_purchases, settlements, x402_endpoints`);

    const mk = async (key: string) => {
      const raw = await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, canonical_url, resource_id, last_seen_at)
        VALUES (${key}, ${"https://" + key}, 'GET', 'eip155:8453', '0xaa', ${"https://" + key}, ${key}, now())
        RETURNING id::text AS id`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows) as { id: string }[])[0].id;
    };
    const a = await mk("a.example/x"); // 公開 fail → 後で pass（誤 fail）
    const b = await mk("b.example/x"); // 公開 fail のまま
    const c = await mk("c.example/x"); // pass → 次が no_402（誤 pass）
    const d = await mk("d.example/x"); // pass → 次も pass

    const probe = (id: string, verdict: string, reason: string | null, hoursAgo: number) =>
      db.execute(sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict, fail_reason, probed_at, raw_response_meta)
        VALUES (${id}::uuid, 'GET', ${verdict}, ${reason}, now() - make_interval(hours => ${hoursAgo}), '{"client":"vet402-observatory-l0/1.0"}'::jsonb)`);
    await probe(a, "fail", "no_402", 50); await probe(a, "fail", "no_402", 40); await probe(a, "pass", null, 30);
    await probe(b, "fail", "no_402", 50); await probe(b, "fail", "no_402", 40);
    await probe(c, "pass", null, 50); await probe(c, "fail", "no_402", 40);
    await probe(d, "pass", null, 50); await probe(d, "pass", null, 40);

    await t.test("公開 fail 2 件のうち 1 件が pass に覆った／公開 pass 3 件のうち 1 件の次が no_402", async () => {
      const i = await fetchL0AccuracyInput();
      assert.equal(i.publishedFail, 2);
      assert.equal(i.failFlippedToPassWithin7d, 1);
      // 公開 pass = 次のプローブがある pass: c(50h), d(50h) の 2 件（d の 40h と a の 30h は次が無い）
      assert.equal(i.publishedPass, 2);
      assert.equal(i.passFollowedByNo402, 1);
    });

    await t.test("SLO スナップショットと週次カバレッジが走る（測れない項目は null と unmeasured）", async () => {
      const s = await fetchSloSnapshot();
      assert.equal(s.c1_l0_within_36h_pct, 25); // 36h 以内に測ったのは a（30h 前）だけ。40h/50h 前は鮮度切れ
      assert.equal(s.c2_l1_within_48h_pct, null); // 決済帰属が無い
      assert.equal(s.published_failure_evidence_complete_pct, 100);
      assert.ok(s.unmeasured.includes("c2_l1_within_48h_pct"));
      assert.ok(s.unmeasured.includes("decision_p95_ms_cache_hit"));
      const c = await getCoverageWeekly();
      assert.equal(c.listed, 4);
      assert.equal(c.l0_measured, 4);
      assert.equal(c.l0_measured_pct, 100);
      assert.equal(c.l1_measured, 0);
    });
  });
}
