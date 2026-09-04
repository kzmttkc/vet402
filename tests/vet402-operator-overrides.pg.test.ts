// ============================================================
// vet402 2026-08-14 — the operator-override transparency log, against Postgres.
//
// The EF/Vitalik blocker: a GLOBAL operator blacklist must leave a public,
// append-only, reasoned trace — and a CUSTOMER's own list must NOT (it is their
// private management right). These two properties are the whole point of the
// feature, so they are pinned against a real database and skip without one.
//
// Isolated in its own schema so it never races the other .pg tests.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { __setDbForTests } from "@/lib/db/client";
import {
  recordOperatorOverride,
  listOperatorOverrides,
} from "@/lib/db/operator-overrides";
import { removeGlobalBlacklistEntry } from "@/lib/db/customer-lists";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://takeshi@localhost:5432/vet402_scoring_test";

let sql: ReturnType<typeof postgres> | null = null;
let reachable = false;

before(async () => {
  try {
    // TRUNCATE より前に、接続先が本番（Neon）でないことを機械で確かめる（2026-09-04 監査 D・P2）。
    assertTestDatabaseIsNotProduction(URL);
    sql = postgres(URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
    await sql`select 1`;
    reachable = true;
  } catch {
    reachable = false;
    if (sql) {
      await sql.end({ timeout: 1 }).catch(() => {});
      sql = null;
    }
    return;
  }
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await sql`CREATE SCHEMA IF NOT EXISTS vet402_ops`;
  await sql`SET search_path TO vet402_ops`;
  await sql`DROP TABLE IF EXISTS operator_overrides`;
  await sql`CREATE TABLE operator_overrides (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    wallet text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    created_at timestamptz DEFAULT now()
  )`;
  await sql`DROP TABLE IF EXISTS customer_lists`;
  await sql`CREATE TABLE customer_lists (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    api_key_id uuid,
    wallet text NOT NULL,
    list_type text NOT NULL,
    created_at timestamptz DEFAULT now()
  )`;
  __setDbForTests(drizzle(sql, { schema }));
});

after(async () => {
  __setDbForTests(null);
  if (sql) {
    await sql.end({ timeout: 5 }).catch(() => {});
    sql = null;
  }
});

test("a recorded global override is publicly listable with address, action and reason", async (t) => {
  if (!reachable) return t.skip("no Postgres (set TEST_DATABASE_URL)");
  await sql!`TRUNCATE operator_overrides`;
  await recordOperatorOverride({
    wallet: "0x00000000000000000000000000000000000000AA",
    action: "blacklist_added",
    reason: "sanctioned mixer per OFAC listing 2026-08-01",
  });
  const log = await listOperatorOverrides();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.wallet, "0x00000000000000000000000000000000000000aa");
  assert.equal(log[0]!.action, "blacklist_added");
  assert.match(log[0]!.reason, /OFAC/);
});

test("the log is append-only and newest-first", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await sql!`TRUNCATE operator_overrides`;
  await recordOperatorOverride({ wallet: "0x01", action: "blacklist_added", reason: "first" });
  await new Promise((r) => setTimeout(r, 5));
  await recordOperatorOverride({ wallet: "0x02", action: "blacklist_added", reason: "second" });
  const log = await listOperatorOverrides();
  assert.equal(log.length, 2, "both entries retained — nothing overwrites");
  assert.equal(log[0]!.reason, "second", "newest first");
});

// ---- 中-3A: the WITHDRAWAL path the ToS promised now has an implementation ----

const GLOBAL = "0x00000000000000000000000000000000000000bb";

test("removing a GLOBAL blacklist deletes the row AND records blacklist_removed with its reason", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await sql!`TRUNCATE operator_overrides`;
  await sql!`TRUNCATE customer_lists`;
  // A standing global blacklist entry (apiKeyId NULL = operator-wide).
  await sql!`INSERT INTO customer_lists (api_key_id, wallet, list_type)
    VALUES (NULL, ${GLOBAL}, 'blacklist')`;

  const { removed } = await removeGlobalBlacklistEntry({
    wallet: GLOBAL,
    reason: "OFAC delisting confirmed 2026-08-14",
  });
  assert.equal(removed, true, "the standing global entry was removed");

  const rows = await sql!`SELECT count(*)::int AS n FROM customer_lists
    WHERE lower(wallet) = ${GLOBAL} AND api_key_id IS NULL AND list_type = 'blacklist'`;
  assert.equal(rows[0]!.n, 0, "the enforcement row is gone");

  const log = await listOperatorOverrides();
  const removal = log.find((e) => e.action === "blacklist_removed");
  assert.ok(removal, "the withdrawal is on the PUBLIC log");
  assert.equal(removal!.wallet, GLOBAL);
  assert.match(removal!.reason, /OFAC delisting/);
});

test("removing a wallet that was NOT globally blacklisted logs nothing (no phantom withdrawal)", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await sql!`TRUNCATE operator_overrides`;
  await sql!`TRUNCATE customer_lists`;
  // A CUSTOMER-scoped blacklist (api_key_id set) must NOT be touched or logged
  // by the global removal — it is that customer's private management right.
  await sql!`INSERT INTO customer_lists (api_key_id, wallet, list_type)
    VALUES (gen_random_uuid(), ${GLOBAL}, 'blacklist')`;

  const { removed } = await removeGlobalBlacklistEntry({ wallet: GLOBAL, reason: "n/a" });
  assert.equal(removed, false, "there was no GLOBAL entry to remove");

  const log = await listOperatorOverrides();
  assert.equal(log.length, 0, "a transparency log must never carry a removal that did not happen");

  const stillThere = await sql!`SELECT count(*)::int AS n FROM customer_lists
    WHERE lower(wallet) = ${GLOBAL} AND api_key_id IS NOT NULL`;
  assert.equal(stillThere[0]!.n, 1, "the customer-scoped entry is untouched");
});

test("a missing table degrades to an empty public log, never throws", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await sql!`DROP TABLE IF EXISTS operator_overrides`;
  const log = await listOperatorOverrides();
  assert.deepEqual(log, []);
  // recording into a missing table must also not throw (deploy-ordering)
  await recordOperatorOverride({ wallet: "0x03", action: "blacklist_added", reason: "x" });
  // restore for isolation hygiene
  await sql!`CREATE TABLE operator_overrides (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY, wallet text NOT NULL, action text NOT NULL,
    reason text NOT NULL, created_at timestamptz DEFAULT now())`;
});
