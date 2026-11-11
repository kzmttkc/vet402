// ============================================================
// 台帳の訂正の保存は Postgres に追記だけ（2026-11-10 公平審査 3.8 の 6c）。
//
// 以前の版はプロセスのメモリと手元の JSONL で、Vercel では書けず、再起動で消えた。
// 固定すること:
//   1. POST した行は DB に残り、別の読み手（新しい store）から同じ順で読める
//   2. 2 行目を足しても 1 行目は変わらない
//   3. 本番の SQL（scripts/sql/2026-11-10-ledger-corrections.sql）を当てた表は UPDATE と DELETE を拒む
//   4. GET は third_party の署名を、DB から読んだ行だけで確かめ直す
//   5. 行を指す訂正の指紋は台帳から取り、公開ファイルの同じ行で再計算できる（2026-11-11 6c-4）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("ledger corrections store (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const THIRD_PARTY_PK = "0x59c6995e998f97a5a004497654fba5d805eecdea0bf408aa7e3e0aa7c9d4cf26" as const;

  test("ledger corrections: Postgres に追記だけで残る", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { dbLedgerCorrectionStore } = await import("@/lib/observatory/ledger-corrections-store");
    const { ledgerCorrectionSignMessage } = await import("@/lib/observatory/ledger-corrections-public");
    const { GET, POST } = await import("@/app/api/v1/observatory/ledger-corrections/route");
    const db = getDb()!;
    // 本番と同じ SQL で表とトリガを作る（drizzle の push はトリガを作らない）。
    await db.execute(sql.raw("DROP TABLE IF EXISTS ledger_corrections CASCADE"));
    await db.execute(sql.raw(readFileSync(join(__dirname, "..", "scripts/sql/2026-11-10-ledger-corrections.sql"), "utf8")));

    const account = privateKeyToAccount(THIRD_PARTY_PK);
    process.env.LEDGER_CORRECTION_SELF_TOKEN = "tok-pg";
    process.env.LEDGER_CORRECTION_THIRD_PARTY_PUBKEY = account.address;
    process.env.LEDGER_CORRECTION_SELF_PUBKEY = "";
    const req = (body: unknown, token?: string) =>
      new NextRequest("http://localhost/api/v1/observatory/ledger-corrections", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });

    await t.test("POST した 2 行が、新しい読み手から同じ順で読め、1 行目は変わらない", async () => {
      assert.equal((await POST(req({ kind: "self", citedDay: "2026-11-01", note: "first" }, "tok-pg"))).status, 201);
      const before = await dbLedgerCorrectionStore()!.list();
      const note = "outsider second";
      const signature = await account.signMessage({ message: ledgerCorrectionSignMessage({ citedDay: "2026-11-02", note }) });
      const r = await POST(req({ kind: "third_party", citedDay: "2026-11-02", note, signerAddress: account.address, signature }));
      assert.equal(r.status, 201);
      const after = await dbLedgerCorrectionStore()!.list();
      assert.equal(after.length, 2);
      assert.deepEqual(after[0], before[0]);
      assert.equal(after[1].kind, "third_party");
      assert.equal(after[1].signature, signature);
    });

    await t.test("表は UPDATE と DELETE を拒む", async () => {
      const refused = (e: unknown) => /append-only/.test(String((e as { cause?: unknown }).cause ?? e));
      await assert.rejects(() => db.execute(sql`UPDATE ledger_corrections SET note = 'rewritten'`), refused);
      await assert.rejects(() => db.execute(sql`DELETE FROM ledger_corrections`), refused);
      const rows = await dbLedgerCorrectionStore()!.list();
      assert.equal(rows.length, 2);
    });

    await t.test("GET は DB の行だけで third_party の署名を確かめ直す", async () => {
      const res = await GET(new NextRequest("http://localhost/api/v1/observatory/ledger-corrections"));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.counts, { self: 1, third_party: 1 });
      const third = body.corrections.find((c: { kind: string }) => c.kind === "third_party");
      assert.equal(third.signatureValid, true);
      assert.match(third.signedMessage, /cited_day: 2026-11-02/);
    });

    await t.test("行を指す訂正は、その行の指紋を Postgres の台帳から取り、公開ファイルの同じ行で誰でも再計算できる", async () => {
      const { createHash } = await import("node:crypto");
      const { GET: dayGet } = await import("@/app/api/v1/observatory/anchors/day/route");
      await db.execute(sql`TRUNCATE ip_rate_limits`);
      const rowsOf = <T>(raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
      const eid = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, method, network)
          VALUES ('correction-cite.example/api', 'https://correction-cite.example/api', 'GET', 'eip155:8453')
          RETURNING id::text AS id
        `),
      )[0].id;
      const pid = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO x402_l1_purchases (endpoint_id, status, network, tx_hash, http_status_paid, spent_units, attempted_at)
          VALUES (${eid}::uuid, 'settled', 'eip155:8453', ${`0x${"ef".repeat(32)}`}, 200, '10000', '2026-11-02T09:00:00Z'::timestamptz)
          RETURNING id::text AS id
        `),
      )[0].id;
      try {
        const note = "delivered body was empty";
        const signature = await account.signMessage({
          message: ledgerCorrectionSignMessage({ citedDay: "2026-11-02", citedRowId: pid, note }),
        });
        const posted = await POST(
          req({ kind: "third_party", citedDay: "2026-11-02", citedRowId: pid, note, signerAddress: account.address, signature, priorRowSha256: "0".repeat(64) }),
        );
        assert.equal(posted.status, 201);
        const missing = await POST(req({ kind: "self", citedDay: "2026-11-02", citedRowId: "00000000-0000-4000-8000-000000000000", note: "x" }, "tok-pg"));
        assert.equal(missing.status, 400);
        assert.equal((await missing.json()).error, "cited_row_not_found");

        const body = await (await GET(new NextRequest("http://localhost/api/v1/observatory/ledger-corrections"))).json();
        const cited = body.corrections.find((c: { citedRowId?: string }) => c.citedRowId === pid);
        assert.ok(cited, "the correction names the cited row");
        assert.equal(cited.signatureValid, true);
        assert.notEqual(cited.priorRowSha256, "0".repeat(64), "the writer's fingerprint is not used");
        // その日を封印して、公開ファイルを /anchors/day から読む。第三者はこのバイト列だけで再計算する。
        const { anchorDay } = await import("@/lib/observatory/anchors");
        await db.execute(sql`TRUNCATE ledger_anchors`);
        await anchorDay("2026-11-02");
        const fileRes = await dayGet(new NextRequest("http://localhost/api/v1/observatory/anchors/day?day=2026-11-02"));
        assert.equal(fileRes.status, 200);
        const row = (JSON.parse(await fileRes.text()) as { rows: { id: string }[] }).rows.find((r) => r.id === pid);
        assert.ok(row, "the cited row is in the day file");
        assert.equal(createHash("sha256").update(JSON.stringify(row)).digest("hex"), cited.priorRowSha256);
        const still = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases WHERE id = ${pid}::uuid`))[0].n;
        assert.equal(still, 1, "the cited row stays in the ledger");
        await assert.rejects(
          () => db.execute(sql`INSERT INTO ledger_corrections (id, kind, cited_day, cited_row_id, note) VALUES ('pair', 'self', '2026-11-02', ${pid}, 'no prior')`),
          (e: unknown) => /ledger_corrections_row_prior_pair/.test(String((e as { cause?: unknown }).cause ?? e)),
        );
      } finally {
        await db.execute(sql`TRUNCATE ledger_anchors`);
        await db.execute(sql`DELETE FROM x402_l1_purchases WHERE id = ${pid}::uuid`);
        await db.execute(sql`DELETE FROM x402_endpoints WHERE id = ${eid}::uuid`);
      }
    });

    await db.execute(sql.raw("DROP TABLE IF EXISTS ledger_corrections CASCADE"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS ledger_corrections_append_only()"));
    for (const k of ["LEDGER_CORRECTION_SELF_TOKEN", "LEDGER_CORRECTION_THIRD_PARTY_PUBKEY", "LEDGER_CORRECTION_SELF_PUBKEY"]) {
      delete process.env[k];
    }
  });
}
