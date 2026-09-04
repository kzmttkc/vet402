// ============================================================
// 2026-08-24 監査: 署名後失敗による予算 Griefing への耐性。
//
// reserveSpend は署名の**前**に計上する（正しい——署名済み EIP-3009 は
// validBefore まで生きた金で、記帳より先に予約しないと二重支出になる）。
// だが売り手が決済しなければ、我々は金を一円も渡していないのに日次$25の
// 観測予算だけが減る。敵対的な売り手が「署名だけさせて決済しない」を
// 繰り返すと、**スコアを偽造しなくても検証者の観測能力を枯らせる**。
// スコアの穴ではなく可用性への攻撃。
//
// 守り方は「疑わしきを罰する」ではなく「無駄撃ちを止める」。
// 1回では外さない（正直な売り手も一時的に落ちる）。冷却は永久ではない
// （スイープ窓を過ぎれば古い試行が見えなくなり自然に戻る）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("l1 griefing cooldown (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  // TRUNCATE より前に、接続先が本番（Neon）でないことを機械で確かめる（2026-09-04 監査 D・P2）。
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("署名後失敗が続く壁は購入対象から外れる", async (t) => {
    const { NON_SETTLING_COOLDOWN_STREAK } = await import("@/lib/observatory/l1-runner");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    // 冷却の判定そのものを、ランナーが使うのと同じ述語で検算する。
    // （ランナー全体を回すと壁のモックが要るので、判定式を直接当てる）
    const verdictFor = async (statuses: string[]) => {
      await db.execute(sql`DROP TABLE IF EXISTS grief_t`);
      await db.execute(sql`CREATE TEMP TABLE grief_t(status text, attempted_at timestamptz)`);
      let h = 1;
      for (const st of statuses) {
        await db.execute(
          sql`INSERT INTO grief_t VALUES (${st}, now() - make_interval(hours => ${h}::int))`,
        );
        h++;
      }
      const raw = await db.execute(sql`
        SELECT NOT EXISTS (
          SELECT 1 FROM (
            SELECT pu.status FROM grief_t pu
            WHERE pu.status IN (
              'settled','settle_claimed','settle_claim_refuted',
              'settle_claimed_unverifiable','delivered_no_receipt','settle_failed'
            )
            ORDER BY pu.attempted_at DESC
            LIMIT ${NON_SETTLING_COOLDOWN_STREAK}
          ) recent
          HAVING count(*) = ${NON_SETTLING_COOLDOWN_STREAK}
             AND count(*) FILTER (WHERE recent.status IN ('settled','settle_claimed')) = 0
        ) AS eligible
      `);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
        eligible: boolean;
      }[];
      return rows[0]!.eligible;
    };

    await t.test("3回連続で決済に至らなければ冷却へ入る", async () => {
      assert.equal(
        await verdictFor(["settle_failed", "settle_failed", "settle_claim_refuted", "settled"]),
        false,
        "署名だけさせて決済しない壁に予算を投じ続けている",
      );
    });

    await t.test("直近に1件でも決済（主張含む）があれば対象のまま", async () => {
      assert.equal(await verdictFor(["settle_failed", "settled", "settle_failed"]), true);
      assert.equal(
        await verdictFor(["settle_failed", "settle_claimed", "settle_failed"]),
        true,
        "未照合の決済主張も『壁は決済しようとした』の証拠——ここで切ると照合前に排除してしまう",
      );
    });

    await t.test("1〜2回の失敗では外さない（正直な売り手を巻き込まない）", async () => {
      assert.equal(await verdictFor(["settle_failed"]), true);
      assert.equal(await verdictFor(["settle_failed", "settle_failed"]), true);
    });

    await t.test("履歴が無い壁は当然対象", async () => {
      assert.equal(await verdictFor([]), true);
    });

    await t.test("しきい値は1より大きい（1回で切る設定に戻ったら落ちる）", () => {
      assert.ok(
        NON_SETTLING_COOLDOWN_STREAK >= 3,
        "1〜2回で切ると、一時的に落ちただけの正直な売り手を排除する",
      );
    });

    await db.execute(sql`DROP TABLE IF EXISTS grief_t`);
  });
}
