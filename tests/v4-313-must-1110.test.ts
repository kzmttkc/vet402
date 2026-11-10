// 3.13 Must（11/10 S1-2 物差し、11/13 F4 判定初版）— specs_rest.md 準拠（2026-11-10）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { NextRequest } from "next/server";

import { buildGate2Report } from "@/lib/gate2/report";
import * as yardstickModule from "@/lib/v4/delivery-hit-rate-yardstick";
import {
  DELIVERY_HIT_RATE_YARDSTICK_PATH,
  applyMinSampleChange,
  loadDeliveryHitRateYardstick,
  validateDeliveryHitRateYardstick,
  validateMinSampleChangelog,
} from "@/lib/v4/delivery-hit-rate-yardstick";
import {
  F4_TRAINING_SNAPSHOT_SOURCE,
  loadNamedBuyerTrainingRowsUpToSnapshot,
} from "@/lib/v4/f4-training-snapshot";
import { partitionLedgerByTimeSplit, type LedgerTimeSplitRow } from "@/lib/v4/ledger-time-split";
import {
  NAMED_BUYER_SCOPE_PHRASE_EN,
  NAMED_BUYER_SCOPE_PHRASE_JA,
  buildNamedBuyerDeliveryForecast,
  buildNamedBuyerDeliveryForecastFromPinnedSnapshot,
  trainingRowsOnOrBeforeSnapshot,
} from "@/lib/v4/named-buyer-delivery-forecast";
import { assertPublicEnglishSurface } from "@/lib/v4/public-english";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** 合格仕様の字面（定数 import だけにしない） */
const F4_V1_JA_SCOPE_LITERAL = "名乗る買い手の場合";

/**
 * 787daa46 の blob にある最初の changelog 行（rr2・rr3 が残せと言った行）。その行を公開したコミットより
 * 前の時刻を持つのはこの行だけで、中身が一字でも違えば例外にしない。
 */
const GRANDFATHERED_FIRST_FIXED_AT_ROW = {
  changedAt: "2026-11-10T11:58:00.000Z",
  previous: "2026-11-10T06:00:00.000Z",
  next: "2026-11-10T12:00:00.000Z",
};

const FORBIDDEN_HIT_RATE_MARKETING = [
  "93.9%",
  "96.45%",
  "93.9",
  "96.45",
  "0.0597",
  "0.0355",
  "0.0348",
  "5300",
  "5,300",
];

/*
 * git の時刻。push-main.sh は push の前に必ず origin/main へ rebase する。rebase は枝の全コミットの
 * committer 時刻を rebase した瞬間に書き換え、author 時刻は残す（2026-11-11 に実測。e7605fb7 を
 * origin/main に rebase すると committer は全部 2026-11-10T21:30:04Z になった）。だから「その値を
 * 公開したコミットの時刻」は author 時刻で取る。結果を読むコミットの時刻は、author と committer の
 * 早い方を取る（物差しに不利な側）。
 */
function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

type YardstickRev = {
  sha: string;
  at: number;
  atIso: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: Record<string, any>;
};

let yardstickHistoryMemo: YardstickRev[] | null = null;

/**
 * 物差し JSON を、それを触った全コミットで読む（古い順）。作業ツリーが HEAD と違うときは、
 * 未コミットの版を「いま」の時刻で末尾に足す（未コミットの値は、いま以降にしか公開されない）。
 */
function yardstickHistory(): YardstickRev[] {
  if (yardstickHistoryMemo) return yardstickHistoryMemo;
  const lines = git(["log", "--reverse", "--format=%H%x09%aI", "--", DELIVERY_HIT_RATE_YARDSTICK_PATH])
    .split("\n")
    .filter(Boolean);
  assert.ok(lines.length >= 1, "yardstick file must exist in git history");
  const revs: YardstickRev[] = [];
  for (const line of lines) {
    const [sha, iso] = line.split("\t") as [string, string];
    let blob: string;
    try {
      blob = git(["show", `${sha}:${DELIVERY_HIT_RATE_YARDSTICK_PATH}`]);
    } catch {
      continue; // このコミットで消えた版。読める版だけを並べる
    }
    revs.push({ sha, at: new Date(iso).getTime(), atIso: new Date(iso).toISOString(), doc: JSON.parse(blob) });
  }
  const working = JSON.parse(read(DELIVERY_HIT_RATE_YARDSTICK_PATH));
  const last = revs[revs.length - 1];
  if (!last || !isDeepStrictEqual(last.doc, working)) {
    const now = Date.now();
    revs.push({ sha: "WORKTREE", at: now, atIso: new Date(now).toISOString(), doc: working });
  }
  yardstickHistoryMemo = revs;
  return revs;
}

/**
 * 今の値が、どのコミットから変わらずに続いているか。新しい方から遡り、条件が崩れる直前の版を返す。
 * 行を書き換えたら、その行は書き換えたコミットで公開されたことになる。行を足すだけなら前の行は動かない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function publishedSince(holds: (doc: Record<string, any>) => boolean): YardstickRev {
  const revs = yardstickHistory();
  let since: YardstickRev | null = null;
  for (let i = revs.length - 1; i >= 0; i--) {
    if (!holds(revs[i]!.doc)) break;
    since = revs[i]!;
  }
  assert.ok(since, "the current value must be present in the newest version");
  return since;
}

/** origin/main に出た物差しの版のうち、いちばん新しいもの。origin/main が無い複製では null。 */
function newestYardstickOnOriginMain(): YardstickRev | null {
  try {
    git(["rev-parse", "--verify", "-q", "origin/main"]);
  } catch {
    return null;
  }
  const revs = yardstickHistory().filter((r) => r.sha !== "WORKTREE");
  for (let i = revs.length - 1; i >= 0; i--) {
    try {
      git(["merge-base", "--is-ancestor", revs[i]!.sha, "origin/main"]);
      return revs[i]!;
    } catch {
      // origin/main に無いコミット
    }
  }
  return null;
}

function isGrandfatheredFirstRow(index: number, row: { changedAt: string; previous: string; next: string }): boolean {
  return (
    index === 0 &&
    row.changedAt === GRANDFATHERED_FIRST_FIXED_AT_ROW.changedAt &&
    row.previous === GRANDFATHERED_FIRST_FIXED_AT_ROW.previous &&
    row.next === GRANDFATHERED_FIRST_FIXED_AT_ROW.next
  );
}

/*
 * S1-3 の結果を読むコードの見つけ方。件名ではなく、コミットの差分の中身で探す（git log -G）。
 * 語は V4 と要件の呼び名と、それをコードに書いたときの形（S1-3、S1_3、repurchaseResults、
 * repurchase_results、REPURCHASE_RESULTS、randomRepurchase、無作為の買い直し、買い直しの結果）。
 * 既存の公平な買い直し（retest）や、試験の番号 S13、「無作為 15 社」は拾わない。
 * 物差し自身の 2 ファイルと 3.13 の試験 2 本は、物差しの言葉として S1-3 を書くので外す。外した 2 ファイルが
 * 台帳を読まないことは、下の「外したファイルは台帳も DB も読まない」が import で固定する。
 * 見るのはこのリポだけ。S1-3 の購入を ~/vet402-solana の remeasure に足すかは要件で要確認のまま。
 */
const S1_3_RESULTS_READ_ERE = [
  "(^|[^0-9A-Za-z])[Ss]1[-_]3([^0-9]|$)",
  "[Rr]e-?[Pp]urchase[ _-]?[Rr]esult",
  "REPURCHASE_RESULT",
  "[Rr]andom(ized)?[ _-]?[Rr]e-?[Pp]urchase",
  "RANDOM(IZED)?_REPURCHASE",
  "買い直しの結果",
  "無作為に買い直",
  "無作為の買い直",
].join("|");

const S1_3_SCAN_PATHS = ["src", "scripts", "packages", "tests", "contracts"];
const S1_3_SCAN_EXCLUDED_FILES = [
  "src/lib/v4/delivery-hit-rate-yardstick.ts",
  "src/app/api/v1/v4/delivery-hit-rate-yardstick/route.ts",
  "tests/v4-313-must-1110.test.ts",
  "tests/v4-313-f4-ja-scope-literal.test.ts",
];

type ResultsReadCommit = { sha: string; at: number; atIso: string; subject: string };

let s13CommitsMemo: ResultsReadCommit[] | null = null;

function s13ResultsReadCommits(): ResultsReadCommit[] {
  if (s13CommitsMemo) return s13CommitsMemo;
  const out = git([
    "log",
    `-G${S1_3_RESULTS_READ_ERE}`,
    "--format=%H%x09%aI%x09%cI%x09%s",
    "--",
    ...S1_3_SCAN_PATHS,
    ...S1_3_SCAN_EXCLUDED_FILES.map((p) => `:(exclude)${p}`),
  ]);
  s13CommitsMemo = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, aIso, cIso, subject] = line.split("\t") as [string, string, string, string];
      const at = Math.min(new Date(aIso).getTime(), new Date(cIso).getTime());
      return { sha, at, atIso: new Date(at).toISOString(), subject };
    });
  return s13CommitsMemo;
}

function importSpecifiers(rel: string): string[] {
  return [...read(rel).matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]!).sort();
}

test("3.13-S1-2: 物差し JSON が存在し fixedAt と minSample と時間分割がある", () => {
  const doc = loadDeliveryHitRateYardstick();
  assert.equal(typeof doc.fixedAt, "string");
  assert.ok(doc.fixedAt.endsWith("Z"));
  assert.equal(typeof doc.documentFirstCommittedAt, "string");
  assert.equal(typeof doc.minSample, "number");
  assert.equal(typeof doc.minSampleInitial, "number");
  assert.ok(doc.minSample > 0);
  assert.match(doc.minSampleRationale, /S1-2/);
  assert.equal(typeof doc.timeSplit.trainEndUtcDate, "string");
  assert.equal(typeof doc.timeSplit.evalStartUtcDate, "string");
  assert.ok(doc.timeSplit.evalStartUtcDate > doc.timeSplit.trainEndUtcDate);
  validateDeliveryHitRateYardstick(doc);
});

test("3.13-S1-2: documentFirstCommittedAt は物差しを足したコミットの author 時刻", () => {
  const doc = loadDeliveryHitRateYardstick();
  const added = git(["log", "--diff-filter=A", "--format=%aI", "--", DELIVERY_HIT_RATE_YARDSTICK_PATH])
    .split("\n")
    .filter(Boolean);
  assert.equal(added.length, 1, "the yardstick file is added once and never re-added");
  assert.equal(new Date(doc.documentFirstCommittedAt).toISOString(), new Date(added[0]!).toISOString());
  assert.equal(yardstickHistory()[0]!.atIso, new Date(added[0]!).toISOString());
});

test("3.13-S1-2: 測り方（最初の最小件数と学ぶ・試す日付）は初出のコミットから一度も動いていない", () => {
  const revs = yardstickHistory();
  const first = revs[0]!.doc;
  const doc = loadDeliveryHitRateYardstick();
  assert.equal(doc.minSampleInitial, first.minSampleInitial ?? first.minSample);
  for (const rev of revs) {
    assert.equal(
      rev.doc.minSampleInitial ?? rev.doc.minSample,
      doc.minSampleInitial,
      `minSampleInitial moved at ${rev.sha} (${rev.atIso}). Change minSample through minSampleChangelog instead`,
    );
    assert.equal(rev.doc.timeSplit?.trainEndUtcDate, doc.timeSplit.trainEndUtcDate, `trainEndUtcDate moved at ${rev.sha}`);
    assert.equal(rev.doc.timeSplit?.evalStartUtcDate, doc.timeSplit.evalStartUtcDate, `evalStartUtcDate moved at ${rev.sha}`);
  }
});

test("3.13-S1-2: minSample を変えたコミットは、同じコミットで changelog に変えたことを出している", () => {
  const revs = yardstickHistory();
  for (let i = 1; i < revs.length; i++) {
    const before = revs[i - 1]!;
    const after = revs[i]!;
    const beforeRows: unknown[] = before.doc.minSampleChangelog ?? [];
    const afterRows: { changedAt: string; previous: number; next: number }[] = after.doc.minSampleChangelog ?? [];
    assert.ok(
      isDeepStrictEqual(afterRows.slice(0, beforeRows.length), beforeRows),
      `minSampleChangelog rows were rewritten or removed at ${after.sha}. Only append`,
    );
    if (before.doc.minSample !== after.doc.minSample) {
      const added = afterRows.slice(beforeRows.length);
      const row = added.find((r) => r.previous === before.doc.minSample && r.next === after.doc.minSample);
      assert.ok(row, `minSample ${before.doc.minSample} -> ${after.doc.minSample} at ${after.sha} has no changelog row`);
      assert.ok(
        new Date(row.changedAt).getTime() >= after.at,
        `minSampleChangelog changedAt ${row.changedAt} precedes the commit ${after.sha} (${after.atIso}) that published it`,
      );
    }
  }
  for (const row of loadDeliveryHitRateYardstick().minSampleChangelog) {
    assert.ok(new Date(row.changedAt).getTime() <= Date.now(), `minSampleChangelog changedAt ${row.changedAt} is in the future`);
  }
});

test("3.13-S1-2: fixedAt と changelog の各行は、今の形で公開したコミット以降で、いまより前", (t) => {
  const doc = loadDeliveryHitRateYardstick();
  const raw = JSON.parse(read(DELIVERY_HIT_RATE_YARDSTICK_PATH)) as Record<string, unknown>;
  assert.equal("repurchaseResultsReadNotBefore" in raw, false);
  assert.notEqual(doc.fixedAt, doc.fixedAtInitial);
  assert.ok(doc.fixedAtChangelog.length >= 1, "fixedAt move must be published in fixedAtChangelog");
  doc.fixedAtChangelog.forEach((row, i) => {
    const since = publishedSince((d) => isDeepStrictEqual(d.fixedAtChangelog?.[i], row));
    if (isGrandfatheredFirstRow(i, row)) {
      t.diagnostic(`fixedAtChangelog[0] is the 787daa46 row kept as written (published since ${since.atIso})`);
      return;
    }
    assert.ok(
      new Date(row.changedAt).getTime() >= since.at,
      `fixedAtChangelog[${i}].changedAt ${row.changedAt} precedes ${since.sha} (${since.atIso}) that published the row`,
    );
    assert.ok(
      new Date(row.next).getTime() >= since.at,
      `fixedAtChangelog[${i}].next ${row.next} precedes ${since.sha} (${since.atIso}) that published the row`,
    );
  });
  const fixed = new Date(doc.fixedAt).getTime();
  const fixedSince = publishedSince((d) => d.fixedAt === doc.fixedAt);
  assert.ok(fixed >= fixedSince.at, `fixedAt ${doc.fixedAt} precedes ${fixedSince.sha} (${fixedSince.atIso}) that wrote it`);
  assert.ok(fixed <= Date.now(), `fixedAt ${doc.fixedAt} is later than now`);
  assert.ok(fixed >= new Date(doc.documentFirstCommittedAt).getTime());
});

test("3.13-S1-2: origin/main に出た changelog の行は、消さず書き換えず、後ろに足すだけ", (t) => {
  const published = newestYardstickOnOriginMain();
  if (!published) {
    t.diagnostic("the yardstick is not on origin/main yet, so no row is public");
    return;
  }
  const doc = loadDeliveryHitRateYardstick();
  t.diagnostic(`newest public version ${published.sha} ${published.atIso}`);
  assert.equal(doc.fixedAtInitial, published.doc.fixedAtInitial);
  assert.equal(doc.minSampleInitial, published.doc.minSampleInitial);
  for (const key of ["fixedAtChangelog", "minSampleChangelog"] as const) {
    const before: unknown[] = published.doc[key] ?? [];
    assert.ok(
      isDeepStrictEqual(doc[key].slice(0, before.length), before),
      `${key} rows already on origin/main were rewritten or removed`,
    );
  }
});

test("3.13-S1-2: S1-3 の結果を読むコードが git に現れる前に、物差しが固まっている", (t) => {
  const doc = loadDeliveryHitRateYardstick();
  const fixed = new Date(doc.fixedAt).getTime();
  const firstAt = yardstickHistory()[0]!.at;
  const reads = s13ResultsReadCommits();
  if (reads.length === 0) {
    t.diagnostic("no commit in this repository reads S1-3 results yet (git log -G over src scripts packages tests contracts)");
    assert.ok(firstAt <= fixed && fixed <= Date.now());
    return;
  }
  const earliest = reads.reduce((a, b) => (b.at < a.at ? b : a));
  t.diagnostic(`earliest S1-3 results read ${earliest.sha} ${earliest.atIso} ${earliest.subject}`);
  assert.ok(
    fixed < earliest.at,
    `fixedAt ${doc.fixedAt} must precede the first S1-3 results read ${earliest.sha} at ${earliest.atIso} (${earliest.subject})`,
  );
  assert.ok(firstAt < earliest.at, `the yardstick must be committed before ${earliest.sha} at ${earliest.atIso}`);
});

test("3.13-S1-2: S1-3 の網は S1-3 の書き方を拾い、既存の買い直しと試験番号 S13 は拾わない", () => {
  const re = new RegExp(S1_3_RESULTS_READ_ERE);
  for (const hit of [
    "import { readS1_3Rows } from './s1_3'",
    "// S1-3 batch",
    "export async function loadRepurchaseResults() {",
    "SELECT * FROM repurchase_results",
    "const REPURCHASE_RESULTS_TABLE = 'v4_s13';",
    "randomRepurchase(listings)",
    "RANDOMIZED_REPURCHASE_DAILY_USD",
    "// 前回の結果ごとに無作為に買い直す",
    "// 買い直しの結果を読む",
  ]) {
    assert.ok(re.test(hit), `S1-3 net must catch: ${hit}`);
  }
  for (const miss of [
    'id: "S13",',
    "// 監査は名指しされた売り手の立場で無作為 15 社を一次証拠で検証し",
    "They may be re-purchased once every",
    "公平な買い直し（retest・2026-09-28）",
    "S1-30 and S1-31",
  ]) {
    assert.equal(re.test(miss), false, `S1-3 net must not catch: ${miss}`);
  }
});

test("3.13-S1-2: 物差しは結果読取の境界の時刻を自分で宣言しない", () => {
  assert.equal("REPURCHASE_RESULTS_READ_NOT_BEFORE" in yardstickModule, false);
  for (const name of Object.keys(yardstickModule)) {
    assert.doesNotMatch(name, /NOT_BEFORE|NotBefore|Boundary/, `export ${name} declares a boundary`);
  }
  const doc = loadDeliveryHitRateYardstick();
  assert.throws(
    () => validateDeliveryHitRateYardstick({ ...doc, repurchaseResultsReadNotBefore: "2026-11-11T00:00:00.000Z" } as typeof doc),
    /must not self-declare/,
  );
});

test("3.13-S1-2: S1-3 の網から外した物差しの 2 ファイルは台帳も DB も読まない", () => {
  assert.deepEqual(importSpecifiers("src/lib/v4/delivery-hit-rate-yardstick.ts"), ["node:fs", "node:path"]);
  assert.deepEqual(importSpecifiers("src/app/api/v1/v4/delivery-hit-rate-yardstick/route.ts"), [
    "@/lib/api/client-ip",
    "@/lib/api/ip-rate-limit",
    "@/lib/api/public-read-robots",
    "@/lib/v4/delivery-hit-rate-yardstick",
    "next/server",
  ]);
  const lib = read("src/lib/v4/delivery-hit-rate-yardstick.ts");
  assert.equal(lib.match(/readFileSync\(/g)?.length, 1);
  assert.match(lib, /readFileSync\(join\(ROOT, DELIVERY_HIT_RATE_YARDSTICK_PATH\), "utf8"\)/);
});

test("3.13-S1-2: 台帳の時間分割が学習と評価に分かれる", () => {
  const doc = loadDeliveryHitRateYardstick();
  assert.equal(typeof doc.minSampleInitial, "number");
  assert.equal(doc.minSample, doc.minSampleInitial);
  const rows: LedgerTimeSplitRow[] = [
    { attemptedAt: "2026-10-07T23:59:59.000Z", delivered: true },
    { attemptedAt: "2026-10-08T12:00:00.000Z", delivered: true },
    { attemptedAt: "2026-10-09T00:00:00.000Z", delivered: false },
    { attemptedAt: "2026-11-01T00:00:00.000Z", delivered: true },
  ];
  const { train, eval: evalRows } = partitionLedgerByTimeSplit(rows, doc.timeSplit);
  assert.equal(train.length, 2);
  assert.equal(evalRows.length, 2);
  assert.ok(train.every((r) => r.attemptedAt.slice(0, 10) <= doc.timeSplit.trainEndUtcDate));
  assert.ok(evalRows.every((r) => r.attemptedAt.slice(0, 10) >= doc.timeSplit.evalStartUtcDate));
});

test("3.13-S1-2: buildGate2Report の judgementA/C を的中率欄に混ぜない（gate2 は PMF）", () => {
  const yardstickSrc = read("src/lib/v4/delivery-hit-rate-yardstick.ts");
  const gate2Src = read("src/lib/gate2/report.ts");
  assert.match(yardstickSrc, /validateMinSampleChangelog/);
  assert.match(yardstickSrc, /validateFixedAtChangelog/);
  assert.doesNotMatch(yardstickSrc, /buildGate2Report/);
  assert.doesNotMatch(gate2Src, /delivery-hit-rate-yardstick/);
  assert.doesNotMatch(gate2Src, /judgementA.*hitRate|hitRate.*judgementA/);
  assert.doesNotMatch(gate2Src, /judgementC[\s\S]*deliveryRate/);
});

test("3.13-S1-2: gate2 judgementB に purpose だけ足して PMF 週次表を完了にしない", () => {
  const gate2Src = read("src/lib/gate2/report.ts");
  assert.doesNotMatch(gate2Src, /pmf_weekly_external_api_usage/);
  assert.match(gate2Src, /judgementB:\s*\{\s*rows:/);
});

test("3.13-S1-2: 公開 API の物差しに V4 宣伝禁止数を載せない", async () => {
  const { GET } = await import("@/app/api/v1/v4/delivery-hit-rate-yardstick/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/v4/delivery-hit-rate-yardstick"));
  assert.equal(res.status, 200);
  const json = await res.json();
  const doc = loadDeliveryHitRateYardstick();
  assert.equal(json.minSample, doc.minSample, "the published yardstick carries the minimum sample number");
  assert.equal(json.minSampleInitial, doc.minSampleInitial);
  assert.deepEqual(json.minSampleChangelog, doc.minSampleChangelog, "a minSample change is published with the yardstick");
  assert.deepEqual(json.fixedAtChangelog, doc.fixedAtChangelog, "a fixedAt move is published with the yardstick");
  assert.equal(json.fixedAt, doc.fixedAt);
  assert.deepEqual(json.timeSplit, doc.timeSplit);
  const body = JSON.stringify(json);
  for (const bad of FORBIDDEN_HIT_RATE_MARKETING) {
    assert.equal(body.includes(bad), false, `yardstick API must not include marketing figure ${bad}`);
  }
  assert.equal(body.includes("evalRowCountLowerBoundConfirmOnly"), false);
  assert.equal(body.includes("instrumentation"), false);
});

test("3.13-S1-2: minSample の変更は changelog に残す", () => {
  const doc = loadDeliveryHitRateYardstick();
  validateMinSampleChangelog(doc);
  for (const entry of doc.minSampleChangelog) {
    assert.equal(typeof entry.changedAt, "string");
    assert.equal(typeof entry.previous, "number");
    assert.equal(typeof entry.next, "number");
    assert.notEqual(entry.previous, entry.next);
  }
  const bumped = { ...doc, minSample: doc.minSampleInitial + 1, minSampleChangelog: [] as typeof doc.minSampleChangelog };
  assert.throws(() => validateMinSampleChangelog(bumped), /without a published changelog/);
  const withLog = applyMinSampleChange(doc, doc.minSampleInitial + 1, "2026-11-10T13:00:00.000Z", "test");
  assert.doesNotThrow(() => validateMinSampleChangelog(withLog));
});

test("3.13-F4: 日本語の名乗る買い手限定句が無い予測は不可", () => {
  const rows = trainingRowsOnOrBeforeSnapshot(
    [{ attemptedAt: "2026-11-08T00:00:00.000Z", resourceKey: "host/a", delivered: true }],
    "2026-11-09",
  );
  const out = buildNamedBuyerDeliveryForecast({
    snapshotDate: "2026-11-09",
    resourceKey: "host/a",
    trainingRows: rows,
  });
  assert.ok(out.text.startsWith(`${NAMED_BUYER_SCOPE_PHRASE_JA}。`));
  const englishOnly = out.text.replace(`${NAMED_BUYER_SCOPE_PHRASE_JA}。`, "");
  assert.equal(englishOnly.includes(NAMED_BUYER_SCOPE_PHRASE_JA), false);
  assert.ok(englishOnly.includes(NAMED_BUYER_SCOPE_PHRASE_EN));
});

test("3.13-F4: 予測文に名乗る買い手の限定句がある", () => {
  const rows = trainingRowsOnOrBeforeSnapshot(
    [
      { attemptedAt: "2026-11-08T00:00:00.000Z", resourceKey: "host/a", delivered: true },
      { attemptedAt: "2026-11-10T00:00:00.000Z", resourceKey: "host/a", delivered: false },
    ],
    "2026-11-09",
  );
  assert.equal(rows.length, 1);
  const out = buildNamedBuyerDeliveryForecast({
    snapshotDate: "2026-11-09",
    resourceKey: "host/a",
    trainingRows: rows,
  });
  assert.ok(out.text.includes(NAMED_BUYER_SCOPE_PHRASE_JA), "forecast must include Japanese scope phrase");
  assert.ok(out.text.includes(NAMED_BUYER_SCOPE_PHRASE_EN));
  assert.equal(out.snapshotDate, "2026-11-09");
  assert.equal(out.trainingSnapshotSource, F4_TRAINING_SNAPSHOT_SOURCE);
  assertPublicEnglishSurface(out.text.replace(`${NAMED_BUYER_SCOPE_PHRASE_JA}。`, ""));
});

test("3.13-F4: スナップショット日より後の行を学習に混ぜない", () => {
  const all = [
    { attemptedAt: "2026-11-08T00:00:00.000Z", resourceKey: "host/a", delivered: true },
    { attemptedAt: "2026-11-10T00:00:00.000Z", resourceKey: "host/a", delivered: false },
  ];
  assert.throws(
    () =>
      buildNamedBuyerDeliveryForecast({
        snapshotDate: "2026-11-09",
        resourceKey: "host/a",
        trainingRows: all,
      }),
    /after snapshot/i,
  );
  const routeSrc = read("src/app/api/v1/v4/named-buyer-delivery-forecast/route.ts");
  assert.doesNotMatch(routeSrc, /buildNamedBuyerDeliveryForecastFromFixture|f4-named-buyer-training-fixture/);
  const pinned = loadNamedBuyerTrainingRowsUpToSnapshot("2026-10-19");
  assert.ok(pinned.length >= 1);
  assert.ok(pinned.every((r) => r.attemptedAt.slice(0, 10) <= "2026-10-19"));
});

test("3.13-F4: decidePayer の別名にしない", () => {
  const src = read("src/lib/v4/named-buyer-delivery-forecast.ts");
  assert.doesNotMatch(src, /decidePayer|buildDecision/);
  assert.doesNotMatch(src, /f4-named-buyer-training-fixture/);
});

test("3.13-F4: V4 宣伝禁止の正解率を予測の的中率として書かない", () => {
  const rows = trainingRowsOnOrBeforeSnapshot(
    [{ attemptedAt: "2026-11-08T00:00:00.000Z", resourceKey: "host/a", delivered: true }],
    "2026-11-09",
  );
  const out = buildNamedBuyerDeliveryForecast({
    snapshotDate: "2026-11-09",
    resourceKey: "host/a",
    trainingRows: rows,
  });
  assert.ok(
    out.text.includes(F4_V1_JA_SCOPE_LITERAL),
    "F4 v1 forecast must include the Japanese scope phrase, not English-only scope",
  );
  const serialized = JSON.stringify(out);
  for (const bad of FORBIDDEN_HIT_RATE_MARKETING) {
    assert.equal(serialized.includes(bad), false);
  }
});

test("3.13-F4: 公開 forecast API が scope と snapshotDate を返す", async () => {
  const { GET } = await import("@/app/api/v1/v4/named-buyer-delivery-forecast/route");
  const resourceKey = "agent402.tools/api/skill/domain-intel";
  const res = await GET(
    new NextRequest(
      `http://localhost/api/v1/v4/named-buyer-delivery-forecast?snapshotDate=2026-10-19&resourceKey=${encodeURIComponent(resourceKey)}`,
    ),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.snapshotDate, "2026-10-19");
  assert.equal(body.trainingSnapshotSource, F4_TRAINING_SNAPSHOT_SOURCE);
  assert.ok(String(body.text).includes(F4_V1_JA_SCOPE_LITERAL), "the public forecast text carries 名乗る買い手の場合");
  assert.ok(String(body.text).includes(NAMED_BUYER_SCOPE_PHRASE_EN));
  assert.ok(String(body.text).includes("Snapshot date 2026-10-19"), "the snapshot date sits next to the forecast");
  assert.equal(body.trainCount, 1);
  const before = await GET(
    new NextRequest(
      `http://localhost/api/v1/v4/named-buyer-delivery-forecast?snapshotDate=2026-10-18&resourceKey=${encodeURIComponent(resourceKey)}`,
    ),
  );
  assert.equal(before.status, 200);
  const beforeBody = await before.json();
  assert.equal(beforeBody.snapshotDate, "2026-10-18");
  assert.equal(beforeBody.trainCount, 0, "the 2026-10-19 row must not train the 2026-10-18 forecast");
  assert.ok(String(beforeBody.text).includes(F4_V1_JA_SCOPE_LITERAL));
  assert.equal(body.deliveryRate, null);
  assert.equal(String(body.text).includes("100.0%"), false);
  assert.match(String(body.text), /below minSample 100/);
});

test("3.13-F4: Stellar 日次スナップショットから学習行を読む", () => {
  const out = buildNamedBuyerDeliveryForecastFromPinnedSnapshot(
    "2026-10-19",
    "agent402.tools/api/skill/domain-intel",
  );
  assert.equal(out.trainCount, 1);
  assert.equal(out.trainDelivered, 1);
  assert.equal(out.deliveryRate, null);
  assert.equal(out.text.includes("100.0%"), false);
  assert.match(out.text, /below minSample/);
});

test("3.13-F4: minSample 未満では deliveryRate を公開しない", () => {
  const doc = loadDeliveryHitRateYardstick();
  const rows = Array.from({ length: doc.minSample - 1 }, (_, i) => ({
    attemptedAt: `2026-11-0${(i % 8) + 1}T00:00:00.000Z`,
    resourceKey: "host/b",
    delivered: i % 2 === 0,
  }));
  const out = buildNamedBuyerDeliveryForecast({
    snapshotDate: "2026-11-09",
    resourceKey: "host/b",
    trainingRows: rows,
  });
  assert.equal(out.trainCount, doc.minSample - 1);
  assert.equal(out.deliveryRate, null);
  assert.match(out.text, /below minSample/);
  assert.doesNotMatch(out.text, /Estimated delivery rate \d/);
});

test("3.13: 正典パスがリポに存在する", () => {
  read(DELIVERY_HIT_RATE_YARDSTICK_PATH);
  read("src/lib/v4/f4-training-snapshot.ts");
  const forecastSrc = read("src/lib/v4/named-buyer-delivery-forecast.ts");
  assert.match(forecastSrc, /buildNamedBuyerDeliveryForecastFromPinnedSnapshot/);
  assert.match(forecastSrc, /f4-training-snapshot/);
  const draft = read("content/drafts/v4-methodology-rewrite-1116.md");
  assert.ok(draft.includes("approval"));
  assert.match(draft, /not for publication/);
  const methodology = read("src/app/observatory/methodology/page.tsx");
  for (const s of ["v4-methodology-rewrite-1116", "delivery-hit-rate-yardstick", "named-buyer-delivery-forecast"]) {
    assert.equal(methodology.includes(s), false, `the live methodology page must not carry ${s} before approval`);
  }
  for (const para of draft.split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("Status:"))) {
    assertPublicEnglishSurface(para);
  }
});

test("3.13: buildGate2Report の形は維持する", async () => {
  assert.equal(typeof buildGate2Report, "function");
  const gate2Src = read("src/lib/gate2/report.ts");
  assert.match(gate2Src, /judgementA:\s*\{[\s\S]*externalSignups/);
  assert.doesNotMatch(gate2Src, /judgementB:[\s\S]*purpose:/);
});

test("3.13-S1-2: 新規公開英語に hit-rate 複合語を置かない", () => {
  const openapi = read("docs/openapi.yaml");
  const apiPage = read("src/app/docs/api/page.tsx");
  const doc = loadDeliveryHitRateYardstick();
  const yardstickSlice = openapi.slice(
    openapi.indexOf("summary: Pre-registered delivery hit"),
    openapi.indexOf("/api/v1/v4/named-buyer-delivery-forecast"),
  );
  const noteMatch = apiPage.match(/note: "(Pre-registered delivery hit[^"]+)"/);
  assert.ok(noteMatch, "api docs page must describe yardstick note");
  for (const chunk of [yardstickSlice, noteMatch![1]!, doc.minSampleRationale]) {
    assert.equal(/\bhit-rate\b/i.test(chunk), false, "public copy must use hit rate not hit-rate");
    assertPublicEnglishSurface(chunk);
  }
});
