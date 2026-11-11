// ============================================================
// 第 1 波 3.8・3.8b・公平-2 の合格試験を、公開ルートの JSON で見る（DB なし。npm test で走る）。
// 合格テストの文: ~/Takeshi_Automation/output/1110/factory/specs_3.7_3.8_9a_3.4.md の 3.8 と 3.8b、
// ~/Takeshi_Automation/output/1110/queue/specs_rest.md の「公平-2」。
//
// 入力は「表の行」だけ（tests/helpers/observatory-fake-db.ts が製品の SQL を見分けて返す）。
// 根と指紋は tests/fixtures/ledger-day-2026-11-08.ts に、Python で別に計算した値を固定した。
// 試験は製品の関数を両側にかけて一致を作らない。期待値は固定の値か、ルートの別の応答である。
// 同じ形を本物の Postgres で通す試験は tests/wave1-38-seal-ledger.pg.test.ts と
// tests/anchors-backfill.pg.test.ts（CI の test:db）。
//
// [fix] はこの変更が無いと落ちる行。[guard] は直す前も緑が正しい、変えてはいけない形。
// ============================================================
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { __setDbForTests } from "@/lib/db/client";
import { settledTier } from "@/lib/observatory/settled-tier";
import { formatSettledReceipt } from "@/lib/observatory/home-example";
import { observatoryFakeDb, type FakeAnchorRow, type FakeObservatoryTables } from "./helpers/observatory-fake-db";
import {
  FILE_1108,
  ROOT_1107,
  ROOT_1108,
  ROW_1,
  ROW_1_FINGERPRINT,
  freshRows,
  sealedAnchors,
} from "./fixtures/ledger-day-2026-11-08";

type Get = (req: NextRequest) => Promise<Response>;

async function entry<T>(path: string): Promise<T> {
  try {
    return (await import(path)) as T;
  } catch (error) {
    assert.fail(`public entry missing: ${path} (${(error as Error).message.split("\n")[0]})`);
  }
}

afterEach(() => {
  __setDbForTests(null);
  mock.timers.reset();
});

/** 公開日 P を決める（Date だけを止める。setTimeout は本物のまま）。 */
function publishAt(iso: string) {
  mock.timers.enable({ apis: ["Date"], now: Date.parse(iso) });
}

function useTables(tables: FakeObservatoryTables) {
  const db = observatoryFakeDb(tables);
  __setDbForTests(db);
  return db;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const req = (path: string) => new NextRequest(`http://localhost${path}`);

async function anchorsBody(days = 30) {
  const { GET } = await entry<{ GET: Get }>("@/app/api/v1/observatory/anchors/route");
  const res = await GET(req(`/api/v1/observatory/anchors?days=${days}`));
  return { res, body: await res.json() };
}

async function dayFile(day: string) {
  const { GET } = await entry<{ GET: Get }>("@/app/api/v1/observatory/anchors/day/route");
  return GET(req(`/api/v1/observatory/anchors/day?day=${day}`));
}

/** start から n 日分の封印（根は表の値として置くだけ。連結は prev_root が前の行の根）。 */
function sealedRun(start: string, n: number): FakeAnchorRow[] {
  const out: FakeAnchorRow[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const root = sha256(`fixture-root-${day}`);
    out.push({ day, root_hash: root, prev_root: prev, entry_count: 0, anchored_tx: null });
    prev = root;
  }
  return out;
}

// ------------------------------------------------------------------
// 6c-1 その日のハッシュが三つ一致する（公開ファイル・保存済みヘッド・鎖の値を別々の読みから）
// ------------------------------------------------------------------

test("[fix] 3.8-6c-1: the anchors JSON checks the day from the file bytes, the stored head and the chain value, against pinned roots", async () => {
  publishAt("2026-11-10T06:00:00Z");
  const db = useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { res, body } = await anchorsBody();
  assert.equal(res.status, 200);
  assert.deepEqual(body.dayVerification, {
    day: "2026-11-08",
    ok: true,
    code: null,
    recomputedRoot: ROOT_1108,
    publishedRoot: ROOT_1108,
    chainRoot: ROOT_1108,
  });
  // 三つは別の読み: その日の L1 行、ledger_anchors の一覧、次に封印した日の prev_root。
  assert.ok(db.reads.some((q) => /FROM x402_l1_purchases pu WHERE pu\.attempted_at >= /.test(q)), "the day's rows are read");
  assert.ok(db.reads.some((q) => /FROM ledger_anchors ORDER BY day DESC LIMIT/.test(q)), "the stored heads are read");
  assert.ok(db.reads.some((q) => /^SELECT day, prev_root FROM ledger_anchors WHERE day > /.test(q)), "the next day's prev_root is read");

  const file = await dayFile("2026-11-08");
  assert.equal(file.status, 200);
  const bytes = await file.text();
  assert.equal(bytes, FILE_1108, "the day file is the pinned canonical JSON, byte for byte");
  assert.equal(sha256(`${ROOT_1107}\n${bytes}`), ROOT_1108, "anyone recomputes the pinned root from the served bytes");
  assert.equal(file.headers.get("x-vet402-day-root"), ROOT_1108);
  assert.equal(file.headers.get("x-vet402-chain-root"), ROOT_1108);
  assert.equal(file.headers.get("x-vet402-prev-root"), ROOT_1107);
  assert.equal(file.headers.get("x-vet402-day-verification"), "ok");
  assert.equal(file.headers.get("x-vet402-license"), "CC-BY-4.0");
});

test("[fix] 3.8-6c-1: one byte changed in the day's rows fails the check and the file no longer recomputes to the root", async () => {
  publishAt("2026-11-10T06:00:00Z");
  const rows = freshRows();
  rows[0].tx_hash = rows[0].tx_hash!.slice(0, -1) + "c";
  useTables({ l1: rows, ledger_anchors: sealedAnchors() });
  const { body } = await anchorsBody();
  assert.equal(body.dayVerification.ok, false);
  assert.equal(body.dayVerification.code, "payload_does_not_match_head");
  assert.notEqual(body.dayVerification.recomputedRoot, ROOT_1108);
  const file = await dayFile("2026-11-08");
  const bytes = await file.text();
  assert.equal(bytes.length, FILE_1108.length);
  assert.notEqual(bytes, FILE_1108);
  assert.notEqual(sha256(`${ROOT_1107}\n${bytes}`), ROOT_1108);
  assert.equal(file.headers.get("x-vet402-day-verification"), "payload_does_not_match_head");
});

test("[fix] 3.8-6c-1: a stored head that differs from the file fails even when the chain still holds the old root", async () => {
  publishAt("2026-11-10T06:00:00Z");
  const anchors = sealedAnchors();
  anchors[1].root_hash = "c".repeat(64);
  useTables({ l1: freshRows(), ledger_anchors: anchors });
  const { body } = await anchorsBody();
  assert.equal(body.dayVerification.ok, false);
  assert.equal(body.dayVerification.code, "payload_does_not_match_head");
  assert.equal(body.dayVerification.recomputedRoot, ROOT_1108);
  assert.equal(body.dayVerification.publishedRoot, "c".repeat(64));
});

test("[fix] 3.8-6c-1: a chain value that differs from the head fails even when the file and the head agree", async () => {
  publishAt("2026-11-10T06:00:00Z");
  const anchors = sealedAnchors();
  anchors[2].prev_root = "d".repeat(64);
  useTables({ l1: freshRows(), ledger_anchors: anchors });
  const { body } = await anchorsBody();
  assert.equal(body.dayVerification.ok, false);
  assert.equal(body.dayVerification.code, "head_does_not_match_chain");
  assert.equal(body.dayVerification.publishedRoot, ROOT_1108);
  assert.equal(body.dayVerification.chainRoot, "d".repeat(64));
  const file = await dayFile("2026-11-08");
  assert.equal(file.headers.get("x-vet402-day-verification"), "head_does_not_match_chain");
});

// ------------------------------------------------------------------
// 6c-2 ヘッドの遅れと、止まった日（入力は公開日 P と anchors の GET の本文）
// ------------------------------------------------------------------

test("[fix] 3.8-6c-2: a head on the day before publication answers 200 with no missing day", async () => {
  publishAt("2026-11-10T06:00:00Z");
  useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { res, body } = await anchorsBody();
  assert.equal(res.status, 200);
  assert.deepEqual(
    { ok: body.headFreshness.ok, headDay: body.headFreshness.headDay, lagDays: body.headFreshness.lagDays, published: body.headFreshness.publishedUtcDay },
    { ok: true, headDay: "2026-11-09", lagDays: 1, published: "2026-11-10" },
  );
  assert.deepEqual(body.missingHeadDays, []);
  assert.equal(body.error, undefined);
});

test("[fix] 3.8-6c-2: a head on the publication day itself is not a 200", async () => {
  publishAt("2026-11-09T23:00:00Z");
  useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { res, body } = await anchorsBody();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(body.error, "anchors_head_stale");
  assert.equal(body.headFreshness.code, "head_not_before_published");
  assert.equal(body.headFreshness.headDay, "2026-11-09");
});

test("[fix] 3.8-6c-2: a head 3 days old is not a 200 and the days from the head to yesterday are no_head_for_day", async () => {
  publishAt("2026-11-12T06:00:00Z");
  useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { res, body } = await anchorsBody();
  assert.equal(res.status, 503);
  assert.equal(body.error, "anchors_head_stale");
  assert.equal(body.headFreshness.code, "head_too_stale");
  assert.equal(body.headFreshness.lagDays, 3);
  assert.deepEqual(body.missingHeadDays, [
    { day: "2026-11-10", status: "no_head_for_day" },
    { day: "2026-11-11", status: "no_head_for_day" },
  ]);
  assert.deepEqual(body.anchors.map((a: { day: string }) => a.day), ["2026-11-09", "2026-11-08", "2026-11-07"], "no root is made for the missing days");
});

test("[fix] 3.8-6c-2: a head 2 days old still answers 200 and names yesterday as no_head_for_day", async () => {
  publishAt("2026-11-11T06:00:00Z");
  useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { res, body } = await anchorsBody();
  assert.equal(res.status, 200);
  assert.equal(body.headFreshness.lagDays, 2);
  assert.deepEqual(body.missingHeadDays, [{ day: "2026-11-10", status: "no_head_for_day" }]);
});

// ------------------------------------------------------------------
// 6c-3 止まった日（Tempo の日を含む）に偽のヘッドを刻まない
// ------------------------------------------------------------------

test("[fix] 3.8-6c-3: a day the daily job stopped (a halted Tempo day included) is named from the stored rows and never sealed later", async () => {
  publishAt("2026-11-10T06:00:00Z");
  // 11/08 は封印していない。止まった日の集合は表の行だけから決まる（環境変数や試験の一覧は渡さない）。
  const anchors = sealedAnchors().filter((a) => a.day !== "2026-11-08");
  anchors[1].prev_root = ROOT_1107;
  const db = useTables({ l1: freshRows(), ledger_anchors: anchors });
  const { res, body } = await anchorsBody();
  assert.equal(res.status, 200);
  assert.deepEqual(body.missingHeadDays, [{ day: "2026-11-08", status: "no_head_for_day" }]);
  assert.deepEqual(body.chainContinuity.gaps, ["2026-11-08"]);
  assert.equal(body.chainContinuity.intact, false);
  assert.ok(!body.anchors.some((a: { day: string }) => a.day === "2026-11-08"));

  const file = await dayFile("2026-11-08");
  assert.equal(file.status, 404);
  assert.deepEqual(await file.json(), { day: "2026-11-08", status: "no_head_for_day", error: "no_head_for_day" });

  const { anchorDay } = await entry<{ anchorDay: (d: string) => Promise<unknown> }>("@/lib/observatory/anchors");
  await assert.rejects(anchorDay("2026-11-08"), /穴は埋めない/);
  assert.equal(db.writes.length, 0, "no root is written for the stopped day");
  assert.equal(db.tables.ledger_anchors.length, 2);
});

// ------------------------------------------------------------------
// probe402 の数（要件 3.8 の最後の箇条）。それぞれを別の断言で、公開 JSON に対して拒む。
// ------------------------------------------------------------------

test("[fix] probe402: a head stopped on 2026-11-04 is refused by the public anchors JSON", async () => {
  publishAt("2026-11-08T03:00:00Z");
  useTables({ l1: [], ledger_anchors: sealedRun("2026-11-01", 4) });
  const { res, body } = await anchorsBody();
  assert.equal(body.headFreshness.headDay, "2026-11-04");
  assert.equal(res.status, 503);
  assert.equal(body.error, "anchors_head_stale");
  assert.equal(body.headFreshness.code, "head_too_stale");
  assert.equal(body.headFreshness.lagDays, 4);
});

test("[fix] probe402: a last anchor run on 2026-11-05 is refused by the public anchors JSON", async () => {
  publishAt("2026-11-08T03:00:00Z");
  useTables({ l1: [], ledger_anchors: sealedRun("2026-11-01", 5) });
  const { res, body } = await anchorsBody();
  assert.equal(body.headFreshness.headDay, "2026-11-05");
  assert.equal(res.status, 503);
  assert.equal(body.headFreshness.code, "head_too_stale");
  assert.equal(body.headFreshness.lagDays, 3);
});

test("[fix] probe402: the hole on 2026-11-05 to 07 is named no_head_for_day in the public JSON and never filled", async () => {
  publishAt("2026-11-09T03:00:00Z");
  const run = sealedRun("2026-11-01", 4);
  const head = { day: "2026-11-08", root_hash: sha256("fixture-root-2026-11-08"), prev_root: run[3].root_hash, entry_count: 0, anchored_tx: null };
  const db = useTables({ l1: [], ledger_anchors: [...run, head] });
  const { res, body } = await anchorsBody();
  assert.equal(res.status, 200);
  const hole = ["2026-11-05", "2026-11-06", "2026-11-07"];
  assert.deepEqual(body.missingHeadDays, hole.map((day) => ({ day, status: "no_head_for_day" })));
  assert.deepEqual(body.chainContinuity.gaps, hole);
  const { anchorDay } = await entry<{ anchorDay: (d: string) => Promise<unknown> }>("@/lib/observatory/anchors");
  for (const day of hole) await assert.rejects(anchorDay(day), /穴は埋めない/);
  assert.equal(db.writes.length, 0);
});

test("[guard] probe402: 79 sealed against 76 published does not happen, every sealed day is a published head", async () => {
  publishAt("2026-11-10T03:00:00Z");
  const sealed = sealedRun("2026-08-23", 79);
  assert.equal(sealed[78].day, "2026-11-09");
  useTables({ l1: [], ledger_anchors: sealed });
  const { res, body } = await anchorsBody(366);
  assert.equal(res.status, 200);
  assert.equal(body.anchors.length, 79);
  assert.deepEqual(new Set(body.anchors.map((a: { day: string }) => a.day)), new Set(sealed.map((a) => a.day)));
  assert.equal(body.anchors[0].day, "2026-11-09");
});

test("[guard] probe402: 1,036,753 objects and 8,133.3 MB are not figures of the public anchors JSON", async () => {
  publishAt("2026-11-10T06:00:00Z");
  useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { body } = await anchorsBody();
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /1,?036,?753/);
  assert.doesNotMatch(text, /8,?133\.3/);
  assert.doesNotMatch(text, /"(objects|objectCount|bytes|megabytes|sizeMb)"/i);
});

// 訂正の HTTP に使う鍵（Anvil の既定の公開試験鍵。資金は無い）。
const THIRD_PARTY_PK = "0x59c6995e998f97a5a004497654fba5d805eecdea0bf408aa7e3e0aa7c9d4cf26" as const;
const SELF_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

async function withCorrectionsEnv<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["LEDGER_CORRECTION_SELF_TOKEN", "LEDGER_CORRECTION_SELF_PUBKEY", "LEDGER_CORRECTION_THIRD_PARTY_PUBKEY"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.LEDGER_CORRECTION_SELF_TOKEN = "tok-self-test";
  process.env.LEDGER_CORRECTION_SELF_PUBKEY = privateKeyToAccount(SELF_PK).address;
  process.env.LEDGER_CORRECTION_THIRD_PARTY_PUBKEY = `${privateKeyToAccount(THIRD_PARTY_PK).address},${privateKeyToAccount(SELF_PK).address}`;
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

type CorrectionsRoute = { GET: Get; POST: Get };
type StoreModule = {
  memoryLedgerCorrectionStore: (seed?: unknown[]) => { rows: readonly Record<string, unknown>[] };
  setLedgerCorrectionStoreForTests: (s: unknown) => void;
};

const postCorrection = (body: unknown, token?: string) =>
  new NextRequest("http://localhost/api/v1/observatory/ledger-corrections", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });

async function signThirdParty(pk: `0x${string}`, input: { citedDay: string; citedRowId?: string; note: string }) {
  const { ledgerCorrectionSignMessage } = await entry<{ ledgerCorrectionSignMessage: (i: unknown) => string }>(
    "@/lib/observatory/ledger-corrections-public",
  );
  const account = privateKeyToAccount(pk);
  const signature = await account.signMessage({ message: ledgerCorrectionSignMessage(input) });
  return { kind: "third_party" as const, ...input, signerAddress: account.address, signature };
}

test("[fix] probe402: five corrections all by the operator count as self 5 and third_party 0, and the operator key cannot add a third party row", async () => {
  const { GET, POST } = await entry<CorrectionsRoute>("@/app/api/v1/observatory/ledger-corrections/route");
  const { memoryLedgerCorrectionStore, setLedgerCorrectionStoreForTests } = await entry<StoreModule>(
    "@/lib/observatory/ledger-corrections-store",
  );
  const seed = Array.from({ length: 5 }, (_, i) => ({
    id: `self-${i}`,
    kind: "self",
    citedDay: "2026-11-0" + (i + 1),
    note: `operator fix ${i}`,
    createdAt: `2026-11-0${i + 1}T00:00:00.000Z`,
  }));
  const store = memoryLedgerCorrectionStore(seed);
  setLedgerCorrectionStoreForTests(store);
  try {
    await withCorrectionsEnv(async () => {
      const body = await (await GET(req("/api/v1/observatory/ledger-corrections"))).json();
      assert.deepEqual(body.counts, { self: 5, third_party: 0 });
      assert.equal(body.corrections.filter((c: { kind: string }) => c.kind === "third_party").length, 0);
      const pose = await POST(postCorrection(await signThirdParty(SELF_PK, { citedDay: "2026-11-05", note: "posing as outsider" })));
      assert.equal(pose.status, 403);
      assert.equal(store.rows.length, 5);
    });
  } finally {
    setLedgerCorrectionStoreForTests(null);
  }
});

// ------------------------------------------------------------------
// 6c-4 訂正は台帳の行を指し、その行の指紋は台帳から取る。第三者は公開ファイルで再計算できる。
// ------------------------------------------------------------------

test("[fix] 3.8-6c-4: a third party correction cites a ledger row, the prior fingerprint comes from the ledger, and anyone recomputes it from the day file", async () => {
  publishAt("2026-11-10T06:00:00Z");
  const db = useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { GET, POST } = await entry<CorrectionsRoute>("@/app/api/v1/observatory/ledger-corrections/route");
  const { memoryLedgerCorrectionStore, setLedgerCorrectionStoreForTests } = await entry<StoreModule>(
    "@/lib/observatory/ledger-corrections-store",
  );
  const store = memoryLedgerCorrectionStore();
  setLedgerCorrectionStoreForTests(store);
  try {
    await withCorrectionsEnv(async () => {
      const signed = await signThirdParty(THIRD_PARTY_PK, { citedDay: "2026-11-08", citedRowId: ROW_1.id, note: "delivered body was empty" });
      // 書き手が指紋を送っても使わない。
      const res = await POST(postCorrection({ ...signed, priorRowSha256: "0".repeat(64) }));
      assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));

      const body = await (await GET(req("/api/v1/observatory/ledger-corrections"))).json();
      assert.deepEqual(body.counts, { self: 0, third_party: 1 });
      const row = body.corrections[0];
      assert.equal(row.kind, "third_party");
      assert.equal(row.citedRowId, ROW_1.id);
      assert.equal(row.priorRowSha256, ROW_1_FINGERPRINT, "the prior is the pinned fingerprint of the ledger row");
      assert.equal(row.signatureValid, true);
      assert.match(row.signedMessage, new RegExp(`cited_row: ${ROW_1.id}`));

      // 第三者の再計算: 公開ファイルを読み、同じ id の行に sha256(JSON.stringify(row)) をかける。
      const file = await (await dayFile("2026-11-08")).text();
      const cited = (JSON.parse(file) as { rows: { id: string }[] }).rows.find((r) => r.id === ROW_1.id);
      assert.ok(cited, "the cited row is still in the day file");
      assert.equal(sha256(JSON.stringify(cited)), row.priorRowSha256);
      // 元の行は残り、台帳には書いていない。
      assert.deepEqual(db.tables.l1[0], ROW_1);
      assert.equal(db.writes.length, 0);
    });
  } finally {
    setLedgerCorrectionStoreForTests(null);
  }
});

test("[fix] 3.8-6c-4: a self correction that cites a ledger row also takes its prior from the ledger", async () => {
  publishAt("2026-11-10T06:00:00Z");
  useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { POST } = await entry<CorrectionsRoute>("@/app/api/v1/observatory/ledger-corrections/route");
  const { memoryLedgerCorrectionStore, setLedgerCorrectionStoreForTests } = await entry<StoreModule>(
    "@/lib/observatory/ledger-corrections-store",
  );
  const store = memoryLedgerCorrectionStore();
  setLedgerCorrectionStoreForTests(store);
  try {
    await withCorrectionsEnv(async () => {
      const res = await POST(postCorrection({ kind: "self", citedDay: "2026-11-08", citedRowId: ROW_1.id, note: "late settle" }, "tok-self-test"));
      assert.equal(res.status, 201);
      assert.equal(store.rows.length, 1);
      assert.equal(store.rows[0].kind, "self");
      assert.equal(store.rows[0].priorRowSha256, ROW_1_FINGERPRINT);
    });
  } finally {
    setLedgerCorrectionStoreForTests(null);
  }
});

test("[fix] 3.8-6c-4: a correction that cites a row not in that day's ledger is refused and nothing is added", async () => {
  publishAt("2026-11-10T06:00:00Z");
  useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { POST } = await entry<CorrectionsRoute>("@/app/api/v1/observatory/ledger-corrections/route");
  const { memoryLedgerCorrectionStore, setLedgerCorrectionStoreForTests } = await entry<StoreModule>(
    "@/lib/observatory/ledger-corrections-store",
  );
  const store = memoryLedgerCorrectionStore();
  setLedgerCorrectionStoreForTests(store);
  try {
    await withCorrectionsEnv(async () => {
      const wrongDay = await signThirdParty(THIRD_PARTY_PK, { citedDay: "2026-11-07", citedRowId: ROW_1.id, note: "x" });
      const r1 = await POST(postCorrection(wrongDay));
      assert.equal(r1.status, 400);
      assert.equal((await r1.json()).error, "cited_row_not_found");
      const unknown = await signThirdParty(THIRD_PARTY_PK, { citedDay: "2026-11-08", citedRowId: "no-such-row", note: "x" });
      assert.equal((await (await POST(postCorrection(unknown))).json()).error, "cited_row_not_found");
      assert.equal(store.rows.length, 0);
    });
  } finally {
    setLedgerCorrectionStoreForTests(null);
  }
});

test("[fix] 3.8-6c-4: the cited row is part of the signed message, so moving the citation breaks the signature", async () => {
  publishAt("2026-11-10T06:00:00Z");
  useTables({ l1: freshRows(), ledger_anchors: sealedAnchors() });
  const { POST } = await entry<CorrectionsRoute>("@/app/api/v1/observatory/ledger-corrections/route");
  const { memoryLedgerCorrectionStore, setLedgerCorrectionStoreForTests } = await entry<StoreModule>(
    "@/lib/observatory/ledger-corrections-store",
  );
  setLedgerCorrectionStoreForTests(memoryLedgerCorrectionStore());
  try {
    await withCorrectionsEnv(async () => {
      const signed = await signThirdParty(THIRD_PARTY_PK, { citedDay: "2026-11-08", citedRowId: ROW_1.id, note: "x" });
      const moved = await POST(postCorrection({ ...signed, citedRowId: "0b9f5a8e-0000-4000-8000-000000000002" }));
      assert.equal(moved.status, 403);
      assert.equal((await moved.json()).error, "invalid_signature");
    });
  } finally {
    setLedgerCorrectionStoreForTests(null);
  }
});

// ------------------------------------------------------------------
// 3.8b 10 鎖それぞれの辿れる tx（ホームと同じ粒度）
// ------------------------------------------------------------------

/** 10 鎖の固定の tx と、その公開エクスプローラの URL。 */
const PINNED = [
  { label: "Base", network: "eip155:8453", tx: `0x${"11".repeat(32)}`, url: `https://basescan.org/tx/0x${"11".repeat(32)}` },
  { label: "Solana", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", tx: "5".repeat(44) + "K".repeat(44), url: `https://solscan.io/tx/${"5".repeat(44)}${"K".repeat(44)}` },
  { label: "Tempo", network: "eip155:4217", tx: `0x${"13".repeat(32)}`, url: `https://explore.tempo.xyz/tx/0x${"13".repeat(32)}` },
  { label: "XRPL", network: "xrpl:0", tx: "A4".repeat(32), url: `https://livenet.xrpl.org/transactions/${"A4".repeat(32)}` },
  { label: "Celo", network: "eip155:42220", tx: `0x${"15".repeat(32)}`, url: `https://celoscan.io/tx/0x${"15".repeat(32)}` },
  { label: "Arc", network: "eip155:5042", tx: `0x${"16".repeat(32)}`, url: `https://explorer.arc.io/tx/0x${"16".repeat(32)}` },
  { label: "Stellar", network: "stellar:pubnet", tx: "b7".repeat(32), url: `https://stellar.expert/explorer/public/tx/${"b7".repeat(32)}` },
  { label: "BNB Chain", network: "eip155:56", tx: `0x${"18".repeat(32)}`, url: `https://bscscan.com/tx/0x${"18".repeat(32)}` },
  { label: "Arbitrum One", network: "eip155:42161", tx: `0x${"19".repeat(32)}`, url: `https://arbiscan.io/tx/0x${"19".repeat(32)}` },
  { label: "Avalanche C-Chain", network: "eip155:43114", tx: `0x${"1a".repeat(32)}`, url: `https://snowtrace.io/tx/0x${"1a".repeat(32)}` },
] as const;

type SourceRow = { id: string; network: string; tx_hash: string; auth_nonce: string | null; settlement_verified: boolean | null; settlement_source: string | null; tier: string; attempted_at: string };

function candidate(i: number, p: { network: string; tx: string; nonce: boolean; tier?: string; source?: string | null; at?: string }): SourceRow & Record<string, unknown> {
  const tierOf = settledTier({ status: "settled", settlementVerified: p.nonce ? true : null, authNonce: p.nonce ? `0x${"cd".repeat(32)}` : null, network: p.network });
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    attempted_at: p.at ?? `2026-11-09T${String(10 + (i % 10)).padStart(2, "0")}:00:00Z`,
    resource_key: `seller-${i}.example/api`,
    network: p.network,
    spent_units: "10000",
    tx_hash: p.tx,
    http_status_paid: "200",
    endpoint_id: `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    confirmed_units: "10000",
    payload_non_empty: true,
    held_reason: null,
    settlement_source: p.source === undefined ? "seller_claim" : p.source,
    l2_detail: null,
    l2_body_head: null,
    l2_content_type: null,
    l2_schema: "match",
    auth_nonce: p.nonce ? `0x${"cd".repeat(32)}` : null,
    settlement_verified: p.nonce ? true : null,
    tier: p.tier ?? tierOf ?? "amount_payee_only",
    rn: "1",
  };
}

const NONCE_ON: Record<string, boolean> = { XRPL: false, "BNB Chain": false };
const tenChainRows = () => PINNED.map((c, i) => candidate(i + 1, { network: c.network, tx: c.tx, nonce: NONCE_ON[c.label] ?? true }));

type Receipt = Record<string, unknown> & { purchaseId: string; tx: string; txUrl: string | null; settledTier: string };
type TraceBody = {
  chains: { label: string; network: string; nonceBound: Receipt | null; amountPayeeOnly: Receipt | null }[];
  lists: { nonce_bound: Receipt[]; amount_payee_only: Receipt[] };
  traceableCount: number;
  chainsWithoutExample: string[];
  allChainsTraceable: boolean;
  home: { purchaseId: string; listed: boolean } | null;
  moreThanHomeAlone: boolean;
  license: string;
};

async function traceableBody(): Promise<{ status: number; body: TraceBody }> {
  const { GET } = await entry<{ GET: Get }>("@/app/api/v1/observatory/traceable-by-chain/route");
  const res = await GET(req("/api/v1/observatory/traceable-by-chain"));
  return { status: res.status, body: (await res.json()) as TraceBody };
}

const HOME_KEYS = Object.keys(
  formatSettledReceipt(
    { attempted_at: "2026-11-08T12:02:00Z", resource_key: "k.example/x", network: "eip155:8453", tx_hash: `0x${"01".repeat(32)}`, spent_units: "10000", id: "x" },
    { rows: 1, settled: 1, from: "", to: "" },
  )!,
).sort();

test("[fix] 3.8b-2: each of the ten public chains has its pinned tx, in the home receipt fields, with its https explorer link", async () => {
  useTables({ l1: [], ledger_anchors: [], traceableCandidates: tenChainRows() });
  const { status, body } = await traceableBody();
  assert.equal(status, 200);
  assert.deepEqual(body.chains.map((c) => c.label), PINNED.map((c) => c.label));
  for (const pin of PINNED) {
    const chain = body.chains.find((c) => c.label === pin.label);
    assert.ok(chain, `${pin.label} is listed`);
    const r = chain.nonceBound ?? chain.amountPayeeOnly;
    assert.ok(r, `${pin.label} has a traceable example`);
    assert.equal(chain.network, pin.network);
    assert.equal(r.tx, pin.tx, `${pin.label} tx`);
    assert.equal(r.txUrl, pin.url, `${pin.label} explorer link`);
    assert.deepEqual(Object.keys(r).filter((k) => k !== "settledTier").sort(), HOME_KEYS, `${pin.label} has the home receipt fields`);
  }
  assert.deepEqual(body.chainsWithoutExample, []);
  assert.equal(body.allChainsTraceable, true);
  assert.equal(body.traceableCount, 10);
  assert.equal(body.license, "CC-BY-4.0");
});

test("[fix] 3.8b-1: with the home receipt among them, the public examples go past it", async () => {
  const rows = tenChainRows();
  useTables({ l1: [], ledger_anchors: [], traceableCandidates: rows, homeLatest: [rows[0]] });
  const { body } = await traceableBody();
  assert.deepEqual(body.home, { purchaseId: rows[0].id, listed: true });
  assert.equal(body.moreThanHomeAlone, true);
  const others = [...body.lists.nonce_bound, ...body.lists.amount_payee_only].filter((r) => r.purchaseId !== rows[0].id);
  assert.equal(others.length, 9, "nine chains past the home one");
});

test("[fix] 3.8b-1: with only the home row, or no rows, the list never claims more than the home receipt", async () => {
  const rows = tenChainRows();
  useTables({ l1: [], ledger_anchors: [], traceableCandidates: [rows[0]], homeLatest: [rows[0]] });
  const only = (await traceableBody()).body;
  assert.equal(only.traceableCount, 1);
  assert.equal(only.moreThanHomeAlone, false);
  assert.equal(only.allChainsTraceable, false);
  assert.equal(only.chainsWithoutExample.length, 9);

  useTables({ l1: [], ledger_anchors: [], traceableCandidates: [], homeLatest: [] });
  const none = (await traceableBody()).body;
  assert.equal(none.home, null, "no home receipt is made up");
  assert.equal(none.traceableCount, 0);
  assert.equal(none.moreThanHomeAlone, false);
  assert.deepEqual(none.chainsWithoutExample, PINNED.map((c) => c.label));
});

test("[fix] 3.8b-3 and 6a-2: every listed row re-classifies by settledTier into its own list, and the counts add up without overlap", async () => {
  const rows = tenChainRows();
  const baseWeak = candidate(21, { network: "eip155:8453", tx: `0x${"21".repeat(32)}`, nonce: false });
  // SQL の段が強いと言っても、settledTier が弱いと言う行（Stellar）は強い段に入れない。
  const stellarMislabelled = candidate(22, { network: "stellar:pubnet", tx: `${"c8".repeat(32)}`, nonce: true, tier: "nonce_bound", at: "2026-11-09T23:00:00Z" });
  const source = [...rows, baseWeak, stellarMislabelled];
  useTables({ l1: [], ledger_anchors: [], traceableCandidates: source });
  const { body } = await traceableBody();
  const byId = new Map(source.map((r) => [r.id, r]));
  const tierOf = (id: string) => {
    const r = byId.get(id)!;
    return settledTier({ status: "settled", settlementVerified: r.settlement_verified, authNonce: r.auth_nonce, network: r.network });
  };
  for (const r of body.lists.nonce_bound) assert.equal(tierOf(r.purchaseId), "nonce_bound", `${r.tx} in the bound list`);
  for (const r of body.lists.amount_payee_only) assert.equal(tierOf(r.purchaseId), "amount_payee_only", `${r.tx} in the weak list`);
  for (const r of [...body.lists.nonce_bound, ...body.lists.amount_payee_only]) assert.equal(r.settledTier, tierOf(r.purchaseId));
  const strongTx = new Set(body.lists.nonce_bound.map((r) => r.tx));
  for (const r of body.lists.amount_payee_only) assert.equal(strongTx.has(r.tx), false, `${r.tx} is in both lists`);
  assert.ok(!strongTx.has(stellarMislabelled.tx_hash), "a Stellar row labelled bound by SQL is not in the bound list");
  // 数: 二つの一覧の件数の和が、辿れる購入の件数（重なりなし）。
  assert.equal(body.lists.nonce_bound.length, 7);
  assert.equal(body.lists.amount_payee_only.length, 4);
  assert.equal(body.lists.nonce_bound.length + body.lists.amount_payee_only.length, body.traceableCount);
  assert.equal(body.chains.find((c) => c.label === "Base")!.amountPayeeOnly!.tx, baseWeak.tx_hash);
});

test("[fix] 3.8b-4: a Circle Gateway row is never listed, even with the batch tx in tx_hash", async () => {
  const rows = tenChainRows();
  const batch = `0x${"bb".repeat(32)}`;
  const gateway = candidate(31, { network: "eip155:5042", tx: batch, nonce: false, source: "circle_gateway", at: "2026-11-09T23:30:00Z" });
  useTables({ l1: [], ledger_anchors: [], traceableCandidates: [...rows, gateway] });
  const { body } = await traceableBody();
  assert.ok(!JSON.stringify(body).includes(batch), "the batch tx is not a traceable tx");
  assert.equal(body.chains.find((c) => c.label === "Arc")!.nonceBound!.tx, PINNED[5].tx);
});

test("[guard] 3.8b-4: a Gateway row whose payment sits only in the batch tx is not a home grade receipt", () => {
  const row = {
    attempted_at: "2026-11-08T12:02:00Z",
    resource_key: "gw.example/api",
    network: "eip155:5042",
    spent_units: "10000",
    tx_hash: "",
    raw_response_meta: { circleGateway: { batchTx: `0x${"ba".repeat(32)}` } },
    settlement_source: "circle_gateway",
    id: "gw-1",
  };
  assert.equal(formatSettledReceipt(row, { rows: 1, settled: 1, from: "", to: "" }), null);
});
