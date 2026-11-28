// ============================================================
// 差分の試験（2026-11-28 依頼 W）: loadSellerFacts の「最新の試行」と「signed / delivered の最終時刻」を
// 1 往復にまとめた SQL が、旧来の 2 本（ORDER BY attempted_at DESC LIMIT 1 と max() FILTER）と同じ値を返す。
// 試行なし・1 行・複数状態・配達が古い・同時刻の行、の各売り手で比べる。
//
// Run: TEST_DATABASE_URL=postgres://localhost/<test db> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/decision-last-attempt-parity.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("decision last attempt parity (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("loadSellerFacts: 1 往復の最新試行・signed・delivered が旧 2 本の SQL と一致する", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { loadSellerFacts, SIGNED_STATUSES } = await import("@/lib/decision/seller-facts");
    const { deliveredPredicate } = await import("@/lib/observatory/delivery");
    const { rowsOf } = await import("@/lib/settlements/upsert");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);

    const SIGNED_LIST = [...SIGNED_STATUSES].map((v) => `'${v.replace(/[^a-z_]/g, "")}'`).join(",");
    const DELIVERED = deliveredPredicate();
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    let seq = 0;
    const mkEndpoint = async () => {
      seq++;
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: `parity${seq}.example/api`,
          resourceUrl: `https://parity${seq}.example/api`,
          network: "eip155:8453",
          method: "GET",
          payTo: `0x${String(seq % 10).repeat(40)}`,
        })
        .returning();
      return ep.id as string;
    };
    const mkPurchase = async (endpointId: string, at: Date, status: string, http: number | null) => {
      seq++;
      await db.insert(schema.x402L1Purchases).values({
        endpointId,
        attemptedAt: at,
        status,
        httpStatusPaid: http,
        payloadNonEmpty: http === 200,
        txHash: status === "settled" ? `0x${seq.toString(16).padStart(64, "0")}` : null,
        network: "eip155:8453",
      });
    };

    // 旧来の 2 本（2026-11-28 以前の seller-facts.ts の逐語）。
    const oldValues = async (id: string) => {
      const a = rowsOf<{ attempted_at: string | null; status: string | null }>(
        await db.execute(sql`
          SELECT attempted_at::text AS attempted_at, status
          FROM x402_l1_purchases WHERE endpoint_id = ${id}::uuid
          ORDER BY attempted_at DESC LIMIT 1
        `),
      );
      const s = rowsOf<{ last_signed: string | null; last_delivered: string | null }>(
        await db.execute(sql`
          SELECT max(attempted_at) FILTER (WHERE status IN (${sql.raw(SIGNED_LIST)}))::text AS last_signed,
                 max(attempted_at) FILTER (WHERE ${sql.raw(DELIVERED)})::text AS last_delivered
          FROM x402_l1_purchases WHERE endpoint_id = ${id}::uuid
        `),
      );
      return {
        attempted_at: a[0]?.attempted_at ?? null,
        status: a[0]?.status ?? null,
        last_signed: s[0]?.last_signed ?? null,
        last_delivered: s[0]?.last_delivered ?? null,
      };
    };

    const executes = t.mock.method(db, "execute");
    const newValues = async (id: string) => {
      const before = executes.mock.callCount();
      const loaded = await loadSellerFacts(id);
      assert.ok(loaded);
      const calls = executes.mock.calls.slice(before);
      const combined = calls.filter((c) => JSON.stringify(c.arguments[0]).includes("LEFT JOIN LATERAL"));
      assert.equal(combined.length, 1, "最新試行と signed / delivered は 1 本の SQL");
      const rows = rowsOf<{ attempted_at: string | null; status: string | null; last_signed: string | null; last_delivered: string | null }>(
        await combined[0]!.result,
      );
      assert.equal(rows.length, 1, "試行が無くても 1 行");
      return { row: rows[0]!, loaded };
    };

    const cases: Array<{ name: string; id: string; tie?: boolean }> = [];

    cases.push({ name: "試行なし", id: await mkEndpoint() });

    const one = await mkEndpoint();
    await mkPurchase(one, daysAgo(2), "settled", 200);
    cases.push({ name: "配達 1 行", id: one });

    const mixed = await mkEndpoint();
    await mkPurchase(mixed, daysAgo(20), "settled", 200);
    await mkPurchase(mixed, daysAgo(10), "settled", 500);
    await mkPurchase(mixed, daysAgo(3), "verify_failed", null);
    await mkPurchase(mixed, daysAgo(1), "skipped_price", null);
    cases.push({ name: "配達が古く、最新は未署名", id: mixed });

    const tie = await mkEndpoint();
    const same = daysAgo(4);
    await mkPurchase(tie, same, "settled", 200);
    await mkPurchase(tie, same, "settled", 200);
    cases.push({ name: "同時刻の 2 行（同じ状態）", id: tie, tie: true });

    for (const c of cases) {
      const old = await oldValues(c.id);
      const { row, loaded } = await newValues(c.id);
      assert.deepEqual(row, old, c.name);
      assert.equal(loaded.lastAttempt.status, old.status, `${c.name}: lastAttempt.status`);
      assert.equal(
        loaded.lastAttempt.at === null ? null : Date.parse(loaded.lastAttempt.at),
        old.attempted_at === null ? null : Date.parse(old.attempted_at.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")),
        `${c.name}: lastAttempt.at`,
      );
    }

    // 同時刻で状態の違う行: 旧来は 2 本が別々の行を返しうる。新しい SQL は attempted_at と status を同じ 1 行から取る。
    const tieMixed = await mkEndpoint();
    const at = daysAgo(6);
    await mkPurchase(tieMixed, at, "settled", 200);
    await mkPurchase(tieMixed, at, "verify_failed", null);
    const { row } = await newValues(tieMixed);
    const pair = rowsOf<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM x402_l1_purchases
        WHERE endpoint_id = ${tieMixed}::uuid AND attempted_at::text = ${row.attempted_at} AND status = ${row.status}
      `),
    );
    assert.equal(pair[0]!.n >= 1, true, "attempted_at と status は実在する 1 行の組");
  });
}
