// ============================================================
// 応答を返した「後」に走る処理は、サーバーレスの凍結で置き去りになる（2026-09-08）。
//
// 実測 1（本番 health_snapshots・19:10:37 JST）:
//   scoring=ok cached; payee=degraded cached: payee_verdict_degraded,native_drain,usdc_drain
// 同じ劣化を admin deep で見たときの payee.latencyMs は **59,957ms**。
// その経路の宣言された上限は PROBE_DEADLINE_MS 24,000ms。
// しかも 59,957ms が出たのは withDeadline の **成功側**（degraded + unavailable 一覧）で、
// 期限の setTimeout は一度も発火していない。壁時計だけが 60 秒進んだ。
//
// 実測 2（手元・SIGSTOP/SIGCONT で凍結を再現。scratchpad/freeze-test2.mjs）:
//   期限 24,000ms・仕事 5,000ms のプロセスを t=1s で 55 秒凍結 →
//   RESULT: {"branch":"success","value":"degraded+unavailable","latencyMs":56012}
// 本番の観測とまったく同じ形が出る。setTimeout は凍結中に進まないので、
// **壁時計の期限は凍結に対して無力**（src/lib/util/deadline.ts の注記を見よ）。
//
// 一次資料（Vercel docs 2026-09-03 版）:
//   - waitUntil は「Extends the lifetime of the request handler」——
//     渡さない promise の生存期間は延びない
//   - attachDatabasePool は「idle pool clients are properly released
//     **before functions suspend**」——Fluid でもインスタンスは suspend する
//   - Next.js 15.1+ では waitUntil ではなく next/server の after() を使う
//
// このファイルが固定するのは 3 つ:
//   1. after-response ヘルパは request 文脈の外でも落ちない（テスト・スクリプト）
//   2. /api/health の snapshot 書き込みと payee probe の裏側リフレッシュが、
//      素の fire-and-forget ではなく after() の生存期間に載っている
//   3. 公開面（本文・HTTP コード）は一切変えない
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runAfterResponse,
  keepAliveUntilSettled,
  setAfterResponseSchedulerForTest,
  type AfterResponseScheduler,
} from "@/lib/util/after-response";
import { runPayeeProbe, resetPayeeProbeCache } from "@/lib/scoring/payee-probe";

afterEach(() => {
  setAfterResponseSchedulerForTest(null);
});

// ------------------------------------------------------------
// 1. ヘルパそのもの
// ------------------------------------------------------------

test("runAfterResponse は request 文脈の外でも投げず、タスクを実行する", async () => {
  // after() は request scope の外で必ず throw する（実測: next 16.3.0 は
  // "`after` was called outside a request scope." を投げる）。テスト・スクリプト・
  // cron 外の呼び出しでヘルスチェックを落とすわけにはいかない。
  let ran = false;
  runAfterResponse(async () => {
    ran = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ran, true, "文脈外のフォールバックでタスクが走っていない");
});

test("runAfterResponse は reject するタスクを飲み込む（unhandled rejection にしない）", async () => {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    runAfterResponse(async () => {
      throw new Error("boom");
    });
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(seen, []);
});

test("keepAliveUntilSettled は既に始まっている仕事を登録するだけで、二度走らせない", async () => {
  let started = 0;
  const work = (async () => {
    started += 1;
    return "done";
  })();
  keepAliveUntilSettled(work);
  assert.equal(await work, "done");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(started, 1, "登録が仕事を再実行している");
});

test("keepAliveUntilSettled は reject する仕事でも unhandled rejection にしない", async () => {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const work = Promise.reject(new Error("boom"));
    keepAliveUntilSettled(work);
    await work.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(seen, []);
});

test("差し替えた scheduler にタスクが渡る（本番では after() がこの位置に来る）", async () => {
  const captured: (() => Promise<void>)[] = [];
  const scheduler: AfterResponseScheduler = (task) => {
    captured.push(task);
  };
  setAfterResponseSchedulerForTest(scheduler);
  let ran = false;
  runAfterResponse(async () => {
    ran = true;
  });
  assert.equal(captured.length, 1, "scheduler へ渡っていない");
  assert.equal(ran, false, "scheduler を通さずに走ってしまっている");
  await captured[0]();
  assert.equal(ran, true);
});

// ------------------------------------------------------------
// 2. 呼び出し側が実際に載っているか（禁止形ゲート）
// ------------------------------------------------------------

test("/api/health は snapshot 書き込みを素の fire-and-forget で撃たない", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/health/route.ts"), "utf8");
  // 禁止形: 行頭の `void recordHealthSnapshotIfDue(` ——応答後に走り、凍結でこぼれる形。
  // （`//` で始まる行は経緯の説明なので対象外。動く形だけを禁じる）
  assert.doesNotMatch(
    route,
    /^\s*void\s+recordHealthSnapshotIfDue\s*\(/m,
    "void で撃つと凍結したインスタンスの中で行が失われる",
  );
  assert.match(route, /runAfterResponse\s*\(/, "after() 経由になっていない");
});

test("応答後へ回した書き込みの中で時刻を読まない（応答の組み立て時間が測定値に混ざる）", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/health/route.ts"), "utf8");
  const deferred = route.slice(route.indexOf("runAfterResponse("));
  assert.doesNotMatch(
    deferred,
    /latencyMs:\s*Date\.now\(\)/,
    "レイテンシは runAfterResponse の外で確定させること",
  );
});

test("payee probe の裏側リフレッシュは after() の生存期間に載る", () => {
  const probe = readFileSync(join(process.cwd(), "src/lib/scoring/payee-probe.ts"), "utf8");
  assert.match(probe, /keepAliveUntilSettled\s*\(/, "SWR の裏側リフレッシュが登録されていない");
});

test("SWR 分岐は裏のリフレッシュを after-response へ登録する（実挙動）", async () => {
  // TTL を 0 にして stale-while-revalidate 分岐へ落とす。scheduler を捕捉役に
  // 差し替え、リフレッシュがそこへ登録されることを見る。
  // 上流は読まない（SKIP_CHAIN_READS）。fetch を投げる実装に差し替えて、
  // このテストがネットワークに触れていないことも同時に固定する。
  process.env.HEALTH_PAYEE_PROBE_TTL_MS = "0";
  process.env.SKIP_CHAIN_READS = "true";
  delete process.env.DATABASE_URL;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`このテストは上流を読まない: ${String(input)}`);
  }) as typeof fetch;
  resetPayeeProbeCache();
  try {
    const first = await runPayeeProbe();
    assert.equal(first.fromCache, false);

    const registered: Promise<unknown>[] = [];
    setAfterResponseSchedulerForTest((task) => {
      registered.push(task());
    });
    const second = await runPayeeProbe();
    assert.equal(second.fromCache, true, "SWR 分岐に入っていない");
    assert.equal(registered.length, 1, "裏側リフレッシュが after-response へ登録されていない");
    await Promise.allSettled(registered);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.HEALTH_PAYEE_PROBE_TTL_MS;
    delete process.env.SKIP_CHAIN_READS;
    resetPayeeProbeCache();
  }
});

// ------------------------------------------------------------
// 3. 公開面を変えていない
// ------------------------------------------------------------

test("公開 /api/health の本文と HTTP コードの形は変わっていない", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/health/route.ts"), "utf8");
  assert.match(
    route,
    /NextResponse\.json\(\s*\{\s*status\s*\}\s*,\s*\{\s*status:\s*httpStatus\s*\}\s*\)/,
  );
});

// ------------------------------------------------------------
// 4. 壁時計の期限が凍結に無力であることを、次に読む人へ残す
// ------------------------------------------------------------

test("withDeadline は「凍結中はタイマーが進まない」ことを明記している", () => {
  const deadline = readFileSync(join(process.cwd(), "src/lib/util/deadline.ts"), "utf8");
  assert.match(deadline, /凍結|suspend/i, "凍結に対する無力さがどこにも書かれていない");
  assert.match(deadline, /59,?957|56,?012/, "実測値が残っていない（規律でなく事例で残す）");
});
