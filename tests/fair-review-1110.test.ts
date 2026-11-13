// ============================================================
// 公平審査 3 項目（PRODUCT 2026-11-09 追記・合格テストは output/1110/queue/specs_rest.md の「公平審査の 3 項目」）。
//   公平-1 自社以外の利用を日付付きで出す
//   公平-2 日次ハッシュと、第三者も書ける訂正台帳（要件 3.8 の 6c）
//   公平-3 署名も支払いも変えないフック、料金の表、Python（3.9）
//
// 2026-11-10 の 4 回目: 独立点検 3 回の NO-SHIP を受けて、文字列の有無ではなく振る舞いで固定する。
// 断言は二種類ある。
//   - 直した振る舞い（直す前のコードで落ちる）: 各 test の名前に [fix] を付ける
//   - 変えてはいけない値（export.csv の列、価格、3 人未満、2 段の和）: [guard] を付ける。直す前も
//     緑が正しい。値を変える変更で落ちることを、変異を当てて確かめた（CHANGELOG に記録）
// DB を使う検証（anchors の GET と day ファイル、訂正の DB 保存）は *.pg.test.ts にある。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";

import { clientUsageLabel, SELF_MONITOR_CLIENT } from "@/lib/api/client-usage";
import { getPlanLimit } from "@/lib/api/auth";
import { BILLING_PLANS } from "@/lib/billing/plans";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import { PUBLIC_USAGE_MIN_OWNERS } from "@/lib/api/decision-usage";
import { settledTier } from "@/lib/observatory/settled-tier";
import { FILE_1108, ROOT_1107, ROOT_1108, sealedAnchors } from "./fixtures/ledger-day-2026-11-08";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// Anvil の既定の鍵（公開の試験用。資金は無い）。
const THIRD_PARTY_PK = "0x59c6995e998f97a5a004497654fba5d805eecdea0bf408aa7e3e0aa7c9d4cf26" as const;
const SELF_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const OTHER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

// 公開の英語の決まり（specs_rest.md「公開の英語」）。識別子のハイフンは残す。
const FORBIDDEN_PUBLIC_ENGLISH = /\b(we|our|us)\b|—|–|;|Key-less|in-house|Append-only|third-party/i;

// ------------------------------------------------------------------
// 公平-1 自社以外の利用
// ------------------------------------------------------------------

test("[fix] 公平-1: /check は decision に入れず check に数える", async () => {
  const { addPublicClientUsageRow, emptyPublicUsageDay } = await import("@/lib/api/client-usage-public");
  let slot = emptyPublicUsageDay("2026-11-09");
  slot = addPublicClientUsageRow(slot, "other", "rest:check", 4);
  slot = addPublicClientUsageRow(slot, "other", "decision", 2);
  assert.equal(slot.decision, 2, "decision は /resources/{id}/decision だけ");
  assert.equal((slot as { check?: number }).check, 4, "/check は別の入口として数える");
});

test("[fix] 公平-1: 固定した行の集計（self・kizuna-・observatory・SDK・MCP・UA 無し・第三者）", async () => {
  const { addPublicClientUsageRow, emptyPublicUsageDay } = await import("@/lib/api/client-usage-public");
  const rows: [string, string, number][] = [
    [SELF_MONITOR_CLIENT, "decision", 50],
    ["kizuna-grant-figures/1", "resolve", 40],
    ["vet402-observatory-l1", "decision", 30],
    ["vet402-sdk/0.7.2", "decision", 10],
    ["vet402-sdk/0.7.2", "rest:check", 3],
    ["vet402-mcp/0.3.1", "resolve", 6],
    ["vet402-mcp/0.3.1", "mcp:check_x402_seller", 2],
    ["other", "mcp:initialize", 5],
    ["other", "decision", 7],
    ["other", "rest:check", 1],
    ["browser", "resolve", 9],
  ];
  let slot = emptyPublicUsageDay("2026-11-09");
  for (const [client, route, n] of rows) slot = addPublicClientUsageRow(slot, client, route, n);
  assert.deepEqual(slot, {
    day: "2026-11-09",
    decision: 7,
    check: 1,
    resolve: 9,
    mcp: 8,
    sdk: 13,
    otherRoutes: 5,
  });
  const total = slot.decision + slot.check + slot.resolve + slot.mcp + slot.sdk + slot.otherRoutes;
  assert.equal(total, 43, "自社の 120 件（self-monitor・kizuna-・observatory）は 1 件も入らない");
});

test("[fix] 公平-1: 公開の note は decision と check を分け、公開の英語の決まりに従う", async () => {
  const { PUBLIC_API_USAGE_NOTE } = await import("@/lib/api/client-usage-public");
  assert.match(PUBLIC_API_USAGE_NOTE, /check counts GET \/api\/v1\/check, a separate entry point, so it is not part of decision/);
  assert.match(PUBLIC_API_USAGE_NOTE, /not added to l1\.attempts/);
  assert.match(PUBLIC_API_USAGE_NOTE, /may not send that User-Agent and then appear as other/);
  assert.doesNotMatch(PUBLIC_API_USAGE_NOTE, FORBIDDEN_PUBLIC_ENGLISH);
});

test("[guard] 公平-1: 自社の UA は self-monitor、第三者の UA は other / browser", () => {
  assert.equal(clientUsageLabel("vet402-surface-consistency-canary/1.0"), SELF_MONITOR_CLIENT);
  assert.equal(clientUsageLabel("kizuna-grant-figures/1"), SELF_MONITOR_CLIENT);
  assert.equal(clientUsageLabel("node"), "other");
  assert.equal(clientUsageLabel(null), "other");
  assert.equal(clientUsageLabel("Mozilla/5.0"), "browser");
  assert.equal(clientUsageLabel("vet402-sdk/0.7.2"), "vet402-sdk/0.7.2");
});

// main にもある公開の読み（readPublishedMonthlyDecisionUsage）を通して見る。main で読み込みに失敗して赤くなる形にしない。
// 規則は main と同じなので、直す前も緑が正しい。PUBLIC_USAGE_MIN_OWNERS を 2 に下げる変異で赤になる。
test("[guard] 公平-1: 月次は 3 人未満なら件数を出さない（公開の読みの戻りで見る）", async () => {
  const { readPublishedMonthlyDecisionUsage, parseMonthlyUsageQuery } = await import("@/lib/api/decision-usage");
  const { __setDbForTests } = await import("@/lib/db/client");
  assert.equal(PUBLIC_USAGE_MIN_OWNERS, 3);
  const stored = [
    { relation: "external", owners: 2, calls: 500 },
    { relation: "related", owners: 3, calls: 120 },
  ];
  __setDbForTests({ execute: async () => stored.map((r) => ({ ...r })) });
  try {
    const query = parseMonthlyUsageQuery("eip155:42220", "2026-10");
    assert.ok(query.ok, JSON.stringify(query));
    if (!query.ok) return;
    const published = await readPublishedMonthlyDecisionUsage(query, new Date("2026-11-10T00:00:00Z"));
    assert.ok(published, "the frozen month is readable");
    const external = published.relations.find((r) => r.owner_relation === "external");
    const related = published.relations.find((r) => r.owner_relation === "related");
    assert.deepEqual(external, { owner_relation: "external", owners: "<3" }, "two owners publish no call count");
    assert.equal("calls" in (external ?? {}), false);
    assert.deepEqual(related, { owner_relation: "related", owners: 3, calls: 120 });
    assert.ok(!JSON.stringify(published).includes("500"), "the two owner count of 500 is not in the public value");
  } finally {
    __setDbForTests(null);
  }
});

test("[guard] 公平-1: DB が無いとき publicApiUsage は空で、利用者数の欄を作らない", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { readPublicClientUsage } = await import("@/lib/api/client-usage-public");
    const usage = await readPublicClientUsage(new Date("2026-11-10T12:00:00.000Z"));
    assert.equal(usage.retrievedAt, "2026-11-10T12:00:00.000Z");
    assert.deepEqual(usage.byDay, []);
    assert.equal("userCount" in usage, false);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

// ------------------------------------------------------------------
// 公平-2 日次ハッシュ（6c-1・6c-2）
// ------------------------------------------------------------------

// 3 つの値は別々に置く: ファイル（公開のバイト列）、公開ヘッドの行、次の日の prevRoot（鎖の値）。
// 根は製品のコードを使わずに Python の hashlib で計算し、tests/fixtures/ledger-day-2026-11-08.ts に固定した。
// 同じ関数を両側にかけて一致を作らない。ルートを通す同じ確認は tests/wave1-38-public-json-1111.test.ts。
function sealedFixture() {
  const file = Buffer.from(FILE_1108, "utf8");
  const head = { day: "2026-11-08", rootHash: ROOT_1108, prevRoot: ROOT_1107 };
  const nextDayPrevRoot = sealedAnchors().find((a) => a.day === "2026-11-09")!.prev_root!;
  return { file, head, nextDayPrevRoot };
}

test("[fix] 公平-2 6c-1: ファイル・公開ヘッド・鎖の値が一致して初めて ok", async () => {
  const { verifyPublishedDayTriple } = await import("@/lib/observatory/ledger-day-verify");
  const { file, head, nextDayPrevRoot } = sealedFixture();
  const r = verifyPublishedDayTriple({ day: head.day, payloadBytes: file, publishedHead: head, chainRoot: nextDayPrevRoot });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.recomputedRoot, ROOT_1108);
  assert.equal(r.chainRoot, ROOT_1108);
});

test("[fix] 公平-2 6c-1: ファイルを 1 バイト変えると落ちる", async () => {
  const { verifyPublishedDayTriple } = await import("@/lib/observatory/ledger-day-verify");
  const { file, head, nextDayPrevRoot } = sealedFixture();
  const tampered = Buffer.from(file);
  tampered[20] = tampered[20] ^ 1;
  const r = verifyPublishedDayTriple({ day: head.day, payloadBytes: tampered, publishedHead: head, chainRoot: nextDayPrevRoot });
  assert.equal(r.ok, false);
  assert.equal(r.code, "payload_does_not_match_head");
});

test("[fix] 公平-2 6c-1: 公開ヘッドと鎖の値が違えば、ファイルが合っていても落ちる", async () => {
  const { verifyPublishedDayTriple } = await import("@/lib/observatory/ledger-day-verify");
  const { file, head } = sealedFixture();
  const r = verifyPublishedDayTriple({ day: head.day, payloadBytes: file, publishedHead: head, chainRoot: "f".repeat(64) });
  assert.equal(r.ok, false);
  assert.equal(r.code, "head_does_not_match_chain");
});

test("[fix] 公平-2 6c-1: 鎖の値・公開ヘッド・ファイルのどれかが無ければ ok にしない", async () => {
  const { verifyPublishedDayTriple } = await import("@/lib/observatory/ledger-day-verify");
  const { file, head, nextDayPrevRoot } = sealedFixture();
  const noChain = verifyPublishedDayTriple({ day: head.day, payloadBytes: file, publishedHead: head, chainRoot: null });
  assert.equal(noChain.ok, false);
  assert.equal(noChain.code, "no_chain_root");
  const noHead = verifyPublishedDayTriple({ day: head.day, payloadBytes: file, publishedHead: null, chainRoot: nextDayPrevRoot });
  assert.equal(noHead.code, "no_published_head");
  const noFile = verifyPublishedDayTriple({ day: head.day, payloadBytes: null, publishedHead: head, chainRoot: nextDayPrevRoot });
  assert.equal(noFile.code, "no_payload");
  const otherDay = verifyPublishedDayTriple({
    day: "2026-11-07",
    payloadBytes: file,
    publishedHead: head,
    chainRoot: nextDayPrevRoot,
  });
  assert.equal(otherDay.code, "head_day_mismatch");
});

test("[fix] 公平-2 6c-2: ヘッドの翌日から公開日の前日までと、鎖の途中の穴を no_head_for_day と書く", async () => {
  const { missingHeadDays } = await import("@/lib/observatory/ledger-head-freshness");
  // probe402 の形: ヘッドが 11/04、公開が 11/08。11/05〜11/07 は封印済みでもヘッドに無い。
  const anchors = [{ day: "2026-11-04" }, { day: "2026-11-02" }, { day: "2026-11-01" }];
  assert.deepEqual(missingHeadDays("2026-11-08", anchors), [
    { day: "2026-11-03", status: "no_head_for_day" },
    { day: "2026-11-05", status: "no_head_for_day" },
    { day: "2026-11-06", status: "no_head_for_day" },
    { day: "2026-11-07", status: "no_head_for_day" },
  ]);
  assert.deepEqual(missingHeadDays("2026-11-08", [{ day: "2026-11-07" }, { day: "2026-11-06" }]), []);
  assert.deepEqual(missingHeadDays("2026-11-08", []), [{ day: "2026-11-07", status: "no_head_for_day" }]);
});

test("[guard] 公平-2 6c-2: ヘッドは公開日の前日以前、遅れ 3 日で不合格", async () => {
  const { evaluateHeadFreshness } = await import("@/lib/observatory/ledger-head-freshness");
  assert.equal(evaluateHeadFreshness("2026-11-10", "2026-11-09").ok, true);
  assert.equal(evaluateHeadFreshness("2026-11-10", "2026-11-08").ok, true);
  assert.equal(evaluateHeadFreshness("2026-11-10", "2026-11-10").ok, false);
  assert.equal(evaluateHeadFreshness("2026-11-10", "2026-11-07").ok, false);
  assert.equal(evaluateHeadFreshness("2026-11-10", null).ok, false);
});

test("[fix] 公平-2 6c-2: anchors の GET はヘッドが無いとき 200 を返さず、昨日を no_head_for_day と書く", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { GET } = await import("@/app/api/v1/observatory/anchors/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/observatory/anchors"));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.error, "anchors_head_stale");
    assert.equal(body.headFreshness.ok, false);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    assert.deepEqual(body.missingHeadDays, [{ day: yesterday, status: "no_head_for_day" }]);
    assert.equal(body.license, "CC-BY-4.0");
    assert.match(body.cite, /KIZUNA Creation/);
    assert.equal(typeof body.retrievedAt, "string");
    assert.doesNotMatch(body.recompute, FORBIDDEN_PUBLIC_ENGLISH);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("[fix] 公平-2 6c-2: 日次ジョブは欠けた日を後から埋めない（anchorThrough は to の 1 日だけ）", async () => {
  const { anchorThrough } = await import("@/lib/observatory/anchors");
  // DB に触る前の形の確認だけ（埋める版は 2 引数目の maxBackfillDays を持っていた）。
  assert.equal(anchorThrough.length, 1);
  const src = read("src/lib/observatory/anchors.ts");
  assert.doesNotMatch(src, /missingDaysBetween\(from, to, have\)/, "欠けた日を列挙して埋める処理が残っている");
});

// ------------------------------------------------------------------
// 公平-2 訂正台帳
// ------------------------------------------------------------------

async function signedThirdParty(pk: `0x${string}`, citedDay: string, note: string) {
  const { ledgerCorrectionSignMessage } = await import("@/lib/observatory/ledger-corrections-public");
  const account = privateKeyToAccount(pk);
  const signature = await account.signMessage({ message: ledgerCorrectionSignMessage({ citedDay, note }) });
  return { kind: "third_party" as const, citedDay, note, signerAddress: account.address, signature };
}

const authFor = () => ({
  selfAddresses: [privateKeyToAccount(SELF_PK).address],
  thirdPartyAddresses: [privateKeyToAccount(THIRD_PARTY_PK).address, privateKeyToAccount(SELF_PK).address],
});

test("[fix] 公平-2 訂正: 悪い署名・許可の無い署名者・自社の鍵の third_party は落ちる", async () => {
  const { prepareLedgerCorrection } = await import("@/lib/observatory/ledger-corrections-public");
  const good = await signedThirdParty(THIRD_PARTY_PK, "2026-11-01", "row 12 status is wrong");
  assert.equal((await prepareLedgerCorrection(good, authFor())).ok, true);

  const badSig = { ...good, note: "row 12 status is right" }; // 署名は元の note に対するもの
  const r1 = await prepareLedgerCorrection(badSig, authFor());
  assert.deepEqual(r1, { ok: false, error: "invalid_signature" });

  const garbage = { ...good, signature: `0x${"11".repeat(65)}` };
  assert.deepEqual(await prepareLedgerCorrection(garbage, authFor()), { ok: false, error: "invalid_signature" });

  const notAllowed = await signedThirdParty(OTHER_PK, "2026-11-01", "x");
  assert.deepEqual(await prepareLedgerCorrection(notAllowed, authFor()), {
    ok: false,
    error: "third_party_signer_not_allowed",
  });

  // 自社のアドレスは、誤って許可の一覧に入っていても third_party を書けない。
  const selfAsThird = await signedThirdParty(SELF_PK, "2026-11-01", "x");
  assert.deepEqual(await prepareLedgerCorrection(selfAsThird, authFor()), {
    ok: false,
    error: "self_key_cannot_write_third_party",
  });
});

test("[fix] 公平-2 訂正: 公開の行だけから署名を確かめ直せる", async () => {
  const { prepareLedgerCorrection, reverifyLedgerCorrectionRow } = await import("@/lib/observatory/ledger-corrections-public");
  const r = await prepareLedgerCorrection(await signedThirdParty(THIRD_PARTY_PK, "2026-11-01", "late settle"), authFor());
  assert.ok(r.ok);
  if (!r.ok) return;
  const row = JSON.parse(JSON.stringify(r.entry));
  assert.equal(await reverifyLedgerCorrectionRow(row), true);
  assert.equal(await reverifyLedgerCorrectionRow({ ...row, note: "edited later" }), false);
  assert.equal(await reverifyLedgerCorrectionRow({ ...row, citedDay: "2026-11-02" }), false);
});

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

const post = (body: unknown, token?: string) =>
  new NextRequest("http://localhost/api/v1/observatory/ledger-corrections", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });

test("[fix] 公平-2 訂正 HTTP: 空と違うトークンの self は 403、自社鍵の third_party は 403、追記は残り GET で確かめ直す", async () => {
  const { GET, POST } = await import("@/app/api/v1/observatory/ledger-corrections/route");
  const { memoryLedgerCorrectionStore, setLedgerCorrectionStoreForTests } = await import(
    "@/lib/observatory/ledger-corrections-store"
  );
  const store = memoryLedgerCorrectionStore();
  setLedgerCorrectionStoreForTests(store);
  try {
    await withCorrectionsEnv(async () => {
      const selfBody = { kind: "self", citedDay: "2026-11-01", note: "our own fix" };
      assert.equal((await POST(post(selfBody))).status, 403, "トークン無し");
      assert.equal((await POST(post(selfBody, "wrong"))).status, 403, "違うトークン");
      const okSelf = await POST(post(selfBody, "tok-self-test"));
      assert.equal(okSelf.status, 201);

      const selfAsThird = await signedThirdParty(SELF_PK, "2026-11-01", "pretend outsider");
      const blocked = await POST(post(selfAsThird));
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).error, "self_key_cannot_write_third_party");

      const forged = { ...(await signedThirdParty(THIRD_PARTY_PK, "2026-11-01", "a")), note: "b" };
      assert.equal((await POST(post(forged))).status, 403);

      const third = await signedThirdParty(THIRD_PARTY_PK, "2026-11-02", "outsider fix");
      assert.equal((await POST(post(third))).status, 201);

      // 追記だけ: 2 行が順に残り、最初の行は変わらない。
      assert.equal(store.rows.length, 2);
      assert.equal(store.rows[0].kind, "self");
      assert.equal(store.rows[0].note, "our own fix");

      const res = await GET(new NextRequest("http://localhost/api/v1/observatory/ledger-corrections"));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.counts, { self: 1, third_party: 1 });
      const t = body.corrections.find((c: { kind: string }) => c.kind === "third_party");
      assert.equal(t.signatureValid, true);
      assert.equal(t.signerAddress, privateKeyToAccount(THIRD_PARTY_PK).address.toLowerCase());
      assert.equal(body.license, "CC-BY-4.0");
      assert.match(body.cite, /KIZUNA Creation/);
      assert.doesNotMatch(body.verify, FORBIDDEN_PUBLIC_ENGLISH);

      // 保存した行が後から書き換えられたら、GET はその行を有効と言わない。
      (store.rows as unknown as { note: string }[])[1].note = "edited after signing";
      const again = await (await GET(new NextRequest("http://localhost/api/v1/observatory/ledger-corrections"))).json();
      assert.equal(again.corrections.find((c: { kind: string }) => c.kind === "third_party").signatureValid, false);
    });
  } finally {
    setLedgerCorrectionStoreForTests(null);
  }
});

test("[fix] 公平-2 訂正 HTTP: 保存先が無ければ受け付けたふりをせず 503、self のトークン未設定なら self は閉じる", async () => {
  const { GET, POST } = await import("@/app/api/v1/observatory/ledger-corrections/route");
  const prevDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await withCorrectionsEnv(async () => {
      const third = await signedThirdParty(THIRD_PARTY_PK, "2026-11-02", "outsider fix");
      assert.equal((await POST(post(third))).status, 503);
      assert.equal((await GET(new NextRequest("http://localhost/api/v1/observatory/ledger-corrections"))).status, 503);
      delete process.env.LEDGER_CORRECTION_SELF_TOKEN;
      const r = await POST(post({ kind: "self", citedDay: "2026-11-01", note: "x" }, ""));
      assert.equal(r.status, 403);
      assert.equal((await r.json()).error, "self_writes_closed");
    });
  } finally {
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
  }
});

// ------------------------------------------------------------------
// 公平-2 settled の 2 段
// ------------------------------------------------------------------

test("[guard] 公平-2: settled の 2 段は別の数で、和が settled、弱い段の tx は強い段の一覧に無い", () => {
  const rows = [
    { tx: "0xa1", status: "settled", settlementVerified: true, authNonce: "0x" + "1".repeat(64), network: "eip155:8453" },
    { tx: "0xa2", status: "settled", settlementVerified: true, authNonce: "0x" + "2".repeat(64), network: "eip155:137" },
    { tx: "0xb1", status: "settled", settlementVerified: true, authNonce: null, network: "eip155:8453" },
    { tx: "0xb2", status: "settled", settlementVerified: true, authNonce: "0x" + "3".repeat(64), network: "stellar:pubnet" },
    { tx: "0xb3", status: "settled", settlementVerified: null, authNonce: "0x" + "4".repeat(64), network: "eip155:8453" },
    { tx: "0xc1", status: "settle_failed", settlementVerified: null, authNonce: null, network: "eip155:8453" },
  ];
  const strong = rows.filter((r) => settledTier(r) === "nonce_bound").map((r) => r.tx);
  const weak = rows.filter((r) => settledTier(r) === "amount_payee_only").map((r) => r.tx);
  const settled = rows.filter((r) => r.status === "settled").length;
  assert.deepEqual(strong, ["0xa1", "0xa2"]);
  assert.deepEqual(weak, ["0xb1", "0xb2", "0xb3"]);
  assert.equal(strong.length + weak.length, settled);
  for (const tx of weak) assert.equal(strong.includes(tx), false, `${tx} が強い段に混ざっている`);
  const reader = read("src/lib/observatory/reader.ts");
  assert.match(reader, /settledNonceBound: Number\(l1List\[0\]\.settled_nonce_bound/);
  assert.match(reader, /settledAmountPayeeOnly: Number\(l1List\[0\]\.settled_amount_payee_only/);
});

test("[guard] 公平-2: export.csv の列は凍結のまま（19 列・順番）", () => {
  assert.deepEqual([...EXPORT_CSV_COLUMNS], [
    "attempted_at", "resource_key", "network", "status", "amount_units", "spent_units", "tx_hash",
    "http_status_paid", "latency_ms", "l2_schema", "held_reason", "request_body", "request_body_sha256",
    "settlement_source", "request_query", "request_query_sha256", "confirmed_units", "purchase_id", "l2_reading",
  ]);
});

// ------------------------------------------------------------------
// 公平-3 フック・料金の表・Python
// ------------------------------------------------------------------

test("[guard] 公平-3: フックのモジュールは署名と送金の関数を import しない", () => {
  const src = read("packages/sdk/src/vet402-read-hook.ts");
  for (const name of ["signX402Payment", "executeX402Payment", "payOrRefuse", "createChainPayment", "SpendGuard"]) {
    assert.doesNotMatch(src, new RegExp(name), name);
  }
});

const ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  payTo: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  amount: "1000",
  maxTimeoutSeconds: 60,
};

async function payingFetch(counter: { sign: number }): Promise<typeof fetch> {
  const { signX402Payment } = await import("../packages/sdk/src/x402-pay.js");
  const account = privateKeyToAccount(THIRD_PARTY_PK);
  return (async () => {
    counter.sign++;
    await signX402Payment({
      account,
      accept: ACCEPT,
      authorization: {
        from: account.address,
        to: ACCEPT.payTo,
        value: "1000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"11".repeat(32)}`,
      },
      chainId: 8453,
    } as Parameters<typeof signX402Payment>[0]);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
}

test("[guard] 公平-3 3.9-1: フックの有無で署名の回数は同じ（1 回）", async () => {
  const { createVet402ReadHook, getVet402ReadSnapshot } = await import("../packages/sdk/src/vet402-read-hook.js");
  const bare = { sign: 0 };
  await (await payingFetch(bare))("https://example.test/paid");
  const hooked = { sign: 0 };
  const wrapped = createVet402ReadHook({
    readBeforePay: async () => ({ deliveredRatePct: 80, vet402Unreachable: false }),
  })(await payingFetch(hooked));
  await wrapped("https://example.test/paid");
  assert.equal(bare.sign, 1);
  assert.equal(hooked.sign, bare.sign);
  assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: 80, vet402Unreachable: false });
});

test("[guard] 公平-3 3.9-2: vet402 に届かない（読みが投げる）ときも支払いは通り、記録は空", async () => {
  const { createVet402ReadHook, getVet402ReadSnapshot } = await import("../packages/sdk/src/vet402-read-hook.js");
  const counter = { sign: 0 };
  const wrapped = createVet402ReadHook({
    readBeforePay: async () => {
      throw new Error("ECONNREFUSED");
    },
  })(await payingFetch(counter));
  const res = await wrapped("https://example.test/paid");
  assert.equal(res.ok, true);
  assert.equal(counter.sign, 1);
  assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: null, vet402Unreachable: true });
});

test("[guard] 公平-3: 既定のフックは observatory state を読む", async () => {
  // 既定の読みは node:http(s) だけを使い、大域 fetch（支払いのラッパーかもしれない）を通らない。
  const { createVet402ReadHook, getVet402ReadSnapshot } = await import("../packages/sdk/src/vet402-read-hook.js");
  const { createServer } = await import("node:http");
  let stateReads = 0;
  const server = createServer((req, res) => {
    if (req.url === "/api/v1/observatory/state") {
      stateReads++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ deliveredOfAttemptsPct: 72.5 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const prior = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = (async () => {
    globalFetchCalls++;
    throw new Error("global fetch must not be used for the observatory read");
  }) as typeof fetch;
  try {
    const counter = { sign: 0 };
    const wrapped = createVet402ReadHook({ observatoryApiBase: `http://127.0.0.1:${port}/api/v1` })(
      await payingFetch(counter),
    );
    await wrapped("https://example.test/paid");
    assert.equal(stateReads, 1);
    assert.equal(globalFetchCalls, 0);
    assert.equal(counter.sign, 1);
    assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: 72.5, vet402Unreachable: false });
  } finally {
    globalThis.fetch = prior;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("[guard] 公平-3 3.9-3: 料金の数は BILLING_PLANS と getPlanLimit で一致し、価格は 0 / 49 / 199", () => {
  assert.equal(BILLING_PLANS.free.monthlyUsd, 0);
  assert.equal(BILLING_PLANS.pro.monthlyUsd, 49);
  assert.equal(BILLING_PLANS.scale.monthlyUsd, 199);
  for (const id of ["free", "pro", "scale"] as const) {
    assert.equal(BILLING_PLANS[id].monthlyLimit, getPlanLimit(id), `${id} の表の回数が getPlanLimit と違う`);
  }
  assert.equal(getPlanLimit("free"), 1_000);
  assert.equal(getPlanLimit("pro"), 50_000);
  assert.equal(getPlanLimit("scale"), 500_000);
});

test("[fix] 公平-3 3.9-3: ホームの料金の表はメモの付録の見出しを持ち込まず、強制していない特典を書かない", async () => {
  const page = read("src/app/page.tsx");
  assert.match(page, /<PricingSection className=\{s\.section\} titleId="home-pricing" \/>/);
  assert.match(page, /^import \{ PricingSection \} from "@\/components\/site\/PricingSection";$/m, "the home page imports the pricing section");
  const mainOpen = page.indexOf("<main");
  const mainClose = page.indexOf("</main>");
  const at = page.indexOf('<PricingSection className={s.section} titleId="home-pricing" />');
  assert.ok(mainOpen >= 0 && mainOpen < at && at < mainClose, "the pricing section renders inside the home page <main>");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PricingSection } = await import("@/components/site/PricingSection");
  const home = renderToStaticMarkup(PricingSection({ titleId: "home-pricing" }));
  assert.doesNotMatch(home, /Access tiers|>A\.</, "メモの付録の見出しがホームに出ている");
  assert.match(home, /id="home-pricing"/);
  assert.match(home, /aria-labelledby="home-pricing"/);
  assert.doesNotMatch(home, /score history|priority support|highest rate limit/);
  for (const n of ["1,000", "50,000", "500,000", "$49", "$199"]) assert.ok(home.includes(n), `${n} が表に無い`);
  const memo = renderToStaticMarkup(PricingSection({ number: "A.", title: "Access tiers" }));
  assert.match(memo, /A\./);
  assert.match(memo, /Access tiers/);
});

test("[fix] 公平-3 3.9-4: Python README は公開の英語の決まりに従い、見本の字下げは 4 文字", () => {
  const readme = read("packages/python-sdk/README.md");
  assert.doesNotMatch(readme, FORBIDDEN_PUBLIC_ENGLISH);
  assert.doesNotMatch(readme, / \. /, "ダッシュを消した跡の ' . ' が残っている");
  const blocks = [...readme.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 4);
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      const indent = /^( *)\S/.exec(line)?.[1].length ?? 0;
      assert.equal(indent % 4, 0, `字下げが 4 の倍数でない行: ${JSON.stringify(line)}`);
    }
  }
  assert.match(readme, /get_resource_decision/);
  assert.match(readme, /Not yet published to PyPI/);
  const client = read("packages/python-sdk/src/vet402/client.py");
  assert.match(client, /def get_resource_decision\(/);
  assert.doesNotMatch(client, /sign_typed_data|signTypedData|private_key/i);
});

test("[fix] 公開の英語: この波で足した文に we / our / us、ダッシュ、セミコロン、Key-less などが無い", () => {
  const docs = read("src/app/docs/api/page.tsx");
  for (const path of ["/api/v1/observatory/ledger-corrections", "/api/v1/observatory/anchors/day"]) {
    const i = docs.indexOf(`path: "${path}"`);
    assert.ok(i > 0, path);
    const note = /note: "([^"]*)"/.exec(docs.slice(i))![1];
    assert.doesNotMatch(note, FORBIDDEN_PUBLIC_ENGLISH, path);
  }
  const spec = read("docs/openapi.yaml");
  const lc = spec.slice(spec.indexOf("  /api/v1/observatory/ledger-corrections:"), spec.indexOf("  /api/mcp:"));
  assert.doesNotMatch(lc, FORBIDDEN_PUBLIC_ENGLISH);
});
