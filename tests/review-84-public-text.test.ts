// ============================================================
// 2026-10-21 独立レビュー NO-SHIP 84 の公開文を、文言を戻すと赤になる形で固定する。
//
// 主張台帳の抽出器は llms.txt の引用符の外と、方法論 §9 の新しい段落（断定語なし）を
// 見ない。床の件数も "probed daily" を戻しても緑のままになる。ここはそこを直接見る。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { publishedVerdict } from "@/lib/observatory/l0-probe";
import { PAID_ATTEMPT_STATUSES, UNVERIFIED_REACH_REASONS, unverifiedBreakdownPart } from "@/lib/observatory/reader";
import { OBSERVATORY_VOCABULARY } from "@/lib/observatory/vocabulary";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const squash = (src: string) => src.replace(/&apos;/g, "'").replace(/\s+/g, " ");

const UNVERIFIED =
  "unverified means vet402 does not have grounds to publish either pass or fail yet. It is not a failure and is never counted as one: it is an entry not yet reached by the rolling schedule, an entry whose failing probe has not met the publication gate, an entry recorded as path_template, or the remainder after the three above. The remainder includes a latest reason of rate_limited, tls, request_shape, or unsafe_target. It also includes a latest reason of method_undeclared, for which no request was sent before 2026-09-02, and body_over_cap, for which a 402 came back and the body was not read to the end. A listing that declares no HTTP method, or a method other than GET, POST, HEAD, or DELETE, is measured with GET, and two consecutive failures of that probe can be published as fail.";

test("llms.txt の観測所の文は probed daily を含まず、メソッド・fail・pct・未プローブを実装どおりに書く", () => {
  const llms = read("public/llms.txt");
  const line = llms.split("\n").find((l) => l.includes("https://vet402.com/observatory: the L0 register"));
  assert.ok(line, "観測所の行が無い");
  assert.equal(/\bprobed daily\b/i.test(line), false);
  assert.match(line, /GET, POST, HEAD, or DELETE/);
  assert.match(line, /GET when the listing declares no method or a method outside that set/);
  assert.match(line, /Two failures in a row on that probe can be published as fail/);
  assert.match(line, /pct is null when activeEndpoints is 0/);
  assert.match(line, /L1 column sits between the verdict and Last probed/);
  assert.match(line, /A row that has not been probed shows no probe time/);
});

// 2026-10-30（設計 v5 第1段）: Bazaar は 01:00・13:00 の 2 回から、約 2 時間おき（00:05〜22:05 UTC の 12 回）に続きから読む形へ。
test("Freshness のカタログ再取得は Bazaar が約 2 時間おき（00:05〜22:05 UTC）、MPP directory が 01:30 UTC の 1 回", () => {
  const llms = read("public/llms.txt");
  const section = llms.slice(llms.indexOf("## Freshness"), llms.indexOf("## Legal"));
  const line = section.split("\n").find((l) => l.startsWith("- Catalog sync"));
  assert.ok(line, "Catalog sync の行が無い");
  assert.match(line, /00:05 UTC/);
  assert.match(line, /22:05 UTC/);
  assert.match(line, /roughly two hours apart/);
  assert.match(line, /continues from the page where the previous run stopped/);
  assert.match(line, /A Bazaar listing is not marked delisted at present/);
  assert.equal(/Both runs refetch the Bazaar catalog|01:00 UTC and 13:00 UTC/.test(line), false);
  assert.match(line, /The MPP directory is fetched once a day, at 01:30 UTC/);
  assert.match(line, /not judged delisted until the next complete 01:30 UTC fetch/);
  assert.equal(/not judged delisted until the next 01:30 UTC fetch/.test(line), false);
});

test("方法論 §9 の status 列は PAID_ATTEMPT_STATUSES と一致する", () => {
  const src = read("src/app/observatory/methodology/page.tsx");
  const start = src.indexOf("count rows whose");
  assert.ok(start > 0, "status を数える文が無い");
  const end = src.indexOf("l1.attempts", start);
  assert.ok(end > start);
  const codes = [...src.slice(start, end).matchAll(/<code>([a-z0-9_]+)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual(codes, [...PAID_ATTEMPT_STATUSES]);
});

test("方法論 §9 は索引の昇格、request_error でファイルから外れること、366 日の上限を書く", () => {
  const src = read("src/app/observatory/methodology/page.tsx");
  const start = src.indexOf("Purchase rows are ordered");
  const end = src.indexOf("Where a piece of evidence came from");
  assert.ok(start > 0 && end > start);
  const sec = src.slice(start, end);
  assert.match(sec, /settlements index can set the status to <code>settle_claimed<\/code>/);
  assert.match(sec, /<code>delivered_no_receipt<\/code>/);
  assert.match(sec, /<code>settle_failed<\/code>/);
  assert.match(sec, /authorization nonce/);
  assert.match(sec, /next file leaves it out/);
  assert.match(sec, /<code>settlement_backfill<\/code>/);
  assert.match(sec, /not counted in the\s+correction count/);
  assert.equal(sec.includes("its correction row"), false);
  assert.match(sec, /day count from 1 to 366, written without a leading zero/);
  assert.match(sec, /A digit string of 1 to 9 digits/);
  assert.match(sec, /that is not a count from 1 to 366 written without a leading zero answers 308/);
  assert.match(sec, /A longer digit string, and a value that is not a digit\s+string, answers 400/);
  assert.equal(/Any other digit string answers\s+308/.test(sec), false);
  assert.match(sec, /more than\s+366 days before retrieval/);
  assert.equal(src.includes("probing with a guessed method reports false deaths"), false);
  assert.match(src, /the request uses GET/);
  assert.match(src, /read in runs scheduled roughly two hours apart \(00:05 UTC to 22:05 UTC\)/);
  assert.match(src, /A Bazaar listing is not marked delisted at present/);
  assert.match(src, /A later incomplete run does not replace a complete snapshot of that day/);
  assert.equal(src.includes("short day is visible"), false);
  assert.match(src, /The MPP directory is fetched once a day, at 01:30 UTC/);
  assert.match(src, /not judged delisted until the next complete 01:30 UTC fetch/);
});

test("2026-09-05 の harder test の文は残り、撤回の訂正が 1 件足されている", () => {
  const src = read("src/app/corrections/page.tsx");
  assert.equal((src.match(/Naming ourselves is the harder test/g) ?? []).length, 1);
  assert.ok(src.includes('date: "2026-09-05"'));
  assert.ok(src.includes("Describing our purchases as covert when they were never covert"));
  assert.ok(src.includes('date: "2026-10-21"'));
  assert.ok(src.includes("Withdrawing the sentence that called a named purchase the harder test"));
  assert.ok(src.includes("stays in this log unchanged"));
});

test("unverified の定義は 4 面で同じ文で、メソッド無しを測れない unverified とは書かない", () => {
  assert.equal(/\b(we|our|us)\b/.test(UNVERIFIED), false);
  assert.equal(/[;—–]|--/.test(UNVERIFIED), false);
  assert.equal(UNVERIFIED.includes("declare too little"), false);
  assert.equal(UNVERIFIED.includes("could not reach"), false);
  assert.match(UNVERIFIED, /or the remainder after the three above/);
  assert.match(UNVERIFIED, /rate_limited, tls, request_shape, or unsafe_target/);
  assert.match(UNVERIFIED, /method_undeclared, for which no request was sent before 2026-09-02/);
  assert.match(UNVERIFIED, /body_over_cap, for which a 402 came back and the body was not read to the end/);
  const term = OBSERVATORY_VOCABULARY.find((t) => t.term === "unverified");
  assert.equal(term?.definition, UNVERIFIED);
  for (const rel of [
    "src/app/observatory/page.tsx",
    "src/app/observatory/methodology/page.tsx",
    "src/app/playground/playground-client.tsx",
    "src/app/legal/terms/page.tsx",
  ]) {
    const src = squash(read(rel));
    assert.ok(src.includes(UNVERIFIED), `${rel} に unverified の文が無い`);
    assert.equal(src.includes("declare too little"), false, rel);
    assert.equal(src.includes("not enough declared to measure"), false, rel);
    assert.equal(src.includes("does not declare enough"), false, rel);
  }
});

test("プレイグラウンドの公開ゲートは観測所の測定に限り、デモの 1 回を公開 fail と言わない", () => {
  const src = squash(read("src/app/playground/page.tsx"));
  const gate = src.indexOf(
    "On that Observatory measurement, two failures in a row on that probe can be published as fail. Demo probes are not written into the public register.",
  );
  assert.ok(gate > 0);
  assert.equal(src.includes("Two failures in a row on that probe can be published as fail. It reads"), false);
});

test("直した公開文に、名指しされたセミコロンとダッシュが残っていない", () => {
  const obs = read("src/app/observatory/page.tsx");
  assert.equal(obs.includes("re-fetched daily;"), false);
  assert.equal(read("src/app/observatory/methodology/page.tsx").includes("13:00 UTC) \u2014"), false);
  assert.equal(obs.includes("pass</code> \u2014"), false);
  assert.equal(obs.includes("declaration;"), false);
  assert.equal(obs.includes("fail</code> \u2014"), false);
  assert.equal(obs.includes("measurement alone;"), false);
  assert.equal(obs.includes("not opinions \u2014"), false);
  assert.match(obs, /measurement alone\. The L1 cell counts/);
  assert.equal(obs.includes("paid attempts;"), false);
  assert.match(obs, /settled \/ paid attempts\)\. The transaction named/);
  assert.match(
    obs,
    /are defined measurements, not opinions\.\s+A withdrawn row is absent from a complete catalog fetch/,
  );
  const method = read("src/app/observatory/methodology/page.tsx");
  assert.equal(method.includes("our own fetch"), false);
  assert.equal(method.includes("our data"), false);
  assert.equal(method.includes("made \u2014 a gap"), false);
  assert.match(method, /vet402&apos;s own fetch is incomplete/);
  assert.match(method, /delisting judgements are made\. A gap in vet402 data must never read/);
});

test("export.csv は 1 桁から 9 桁の非正規 days を 308、それより長い数字と数字以外を 400 にする", async () => {
  const savedDb = process.env.DATABASE_URL;
  const savedProxy = process.env.PROXY_HEADER_SOURCE;
  delete process.env.DATABASE_URL;
  process.env.PROXY_HEADER_SOURCE = "generic";
  try {
    const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
    const call = (days: string, ip: string) =>
      GET(new NextRequest(`http://localhost/api/v1/observatory/export.csv?days=${days}`, { headers: { "x-real-ip": ip } }));
    const ten = await call("1000000000", "203.0.113.201");
    assert.equal(ten.status, 400);
    assert.deepEqual(await ten.json(), { error: "invalid_days" });
    assert.equal((await call("12a", "203.0.113.202")).status, 400);
    const nine = await call("999999999", "203.0.113.203");
    assert.equal(nine.status, 308);
    assert.match(nine.headers.get("location") ?? "", /\?days=366$/);
    const padded = await call("0366", "203.0.113.204");
    assert.equal(padded.status, 308);
    assert.match(padded.headers.get("location") ?? "", /\?days=366$/);
    const zero = await call("0", "203.0.113.205");
    assert.equal(zero.status, 308);
    assert.match(zero.headers.get("location") ?? "", /\?days=1$/);
    for (const [days, ip] of [
      ["1", "203.0.113.206"],
      ["90", "203.0.113.207"],
      ["366", "203.0.113.208"],
    ] as const) {
      const canonical = await call(days, ip);
      assert.notEqual(canonical.status, 308, days);
      assert.notEqual(canonical.status, 400, days);
      assert.equal(canonical.status, 503, days);
      assert.deepEqual(await canonical.json(), { error: "observatory_unavailable" });
    }
  } finally {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
    else process.env.PROXY_HEADER_SOURCE = savedProxy;
  }
});

type BreakdownRow = { method: string | null; verdicts: readonly string[] | null; reason: string | null };

/** 直し前: method が null で、fail でも path_template でもない unverified を methodUndeclared に剥がす。 */
function legacyUnverifiedPart(row: BreakdownRow): string | null {
  if (row.verdicts === null) return "notYetProbed";
  if (publishedVerdict(row.verdicts) !== "unverified") return null;
  if (row.verdicts[0] === "fail") return "singleFailGateNotMet";
  if (row.reason === "path_template") return "pathTemplate";
  if (row.method === null) return "methodUndeclared";
  return "otherNotReached";
}

test("unverified の内訳は method が null でも別枠にせず、otherNotReached は上の 3 つの残り", () => {
  const rows: BreakdownRow[] = [
    { method: "GET", verdicts: ["pass"], reason: null },
    { method: null, verdicts: ["pass"], reason: null },
    { method: "GET", verdicts: ["fail", "fail"], reason: "no_402" },
    { method: null, verdicts: ["fail", "fail"], reason: "no_402" },
    { method: null, verdicts: null, reason: null },
    { method: "POST", verdicts: null, reason: null },
    { method: null, verdicts: ["fail"], reason: "no_402" },
    { method: "GET", verdicts: ["fail"], reason: "timeout" },
    { method: null, verdicts: ["unverified"], reason: "path_template" },
    { method: "GET", verdicts: ["unverified"], reason: "path_template" },
    { method: null, verdicts: ["unverified"], reason: "method_undeclared" },
    { method: null, verdicts: ["unverified"], reason: null },
    { method: "PUT", verdicts: ["unverified"], reason: null },
  ];
  for (const reason of UNVERIFIED_REACH_REASONS) {
    rows.push({ method: null, verdicts: ["unverified"], reason });
    rows.push({ method: "POST", verdicts: ["unverified"], reason });
  }

  const tally = (partOf: (row: BreakdownRow) => string | null) => {
    const counts = new Map<string, number>();
    let unverified = 0;
    for (const row of rows) {
      const part = partOf(row);
      if (part === null) continue;
      unverified += 1;
      counts.set(part, (counts.get(part) ?? 0) + 1);
    }
    let sum = 0;
    for (const n of counts.values()) sum += n;
    return { counts, unverified, sum };
  };

  const next = tally(unverifiedBreakdownPart);
  const prev = tally(legacyUnverifiedPart);
  assert.equal(next.sum, next.unverified);
  assert.equal(prev.sum, prev.unverified);
  assert.equal(next.sum, prev.sum);

  const rateLimited = { method: null, verdicts: ["unverified"] as const, reason: "rate_limited" };
  assert.equal(legacyUnverifiedPart(rateLimited), "methodUndeclared");
  assert.equal(unverifiedBreakdownPart(rateLimited), "otherNotReached");
  assert.notEqual(unverifiedBreakdownPart(rateLimited), "methodUndeclared");
  assert.deepEqual([...UNVERIFIED_REACH_REASONS], ["rate_limited", "tls", "request_shape", "unsafe_target"]);
  for (const reason of UNVERIFIED_REACH_REASONS) {
    assert.equal(
      unverifiedBreakdownPart({ method: null, verdicts: ["unverified"], reason }),
      "otherNotReached",
      reason,
    );
  }
  assert.equal(
    unverifiedBreakdownPart({ method: null, verdicts: ["unverified"], reason: "body_over_cap" }),
    "otherNotReached",
  );
  assert.equal(
    unverifiedBreakdownPart({ method: "GET", verdicts: ["unverified"], reason: "method_undeclared" }),
    "otherNotReached",
  );

  const sqlFn = read("src/lib/observatory/reader.ts");
  const start = sqlFn.indexOf("export async function getUnverifiedBreakdown");
  const end = sqlFn.indexOf("export async function getEndpointNames");
  const body = sqlFn.slice(start, end);
  assert.ok(start > 0 && end > start);
  const sql = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  assert.equal(sql.includes("method IS NULL"), false);
  assert.equal(sql.includes("method_undeclared"), false);
  assert.equal(sql.includes("e.method"), false);
  assert.match(
    sql,
    /array_agg\(v\.verdict ORDER BY v\.probed_at DESC\)\s+AS verdicts,\s+array_agg\(v\.fail_reason ORDER BY v\.probed_at DESC\)\s+AS reasons/,
  );
  assert.match(sql, /SELECT verdict, fail_reason, probed_at FROM x402_l0_probes p/);
  assert.equal(/array_agg\(v\.verdict\)/.test(sql), false);
  assert.equal(/array_agg\(v\.fail_reason\)/.test(sql), false);

  const page = read("src/app/observatory/methodology/page.tsx");
  assert.equal(page.includes("methodUndeclared"), false);
  assert.equal(page.includes("that declare no HTTP method"), false);
  assert.equal(page.includes("is not a set left unmeasured"), false);
  assert.match(page, /Those four sum to/);
  const bucketStart = page.indexOf("What that bucket is actually made of");
  const bucketEnd = page.indexOf("Those four sum to");
  assert.ok(bucketStart > 0 && bucketEnd > bucketStart);
  const bucket = page.slice(bucketStart, bucketEnd);
  assert.match(bucket, /are the remainder after the three\s+counts above/);
  assert.equal(bucket.includes("could not reach"), false);
  assert.match(bucket, /<code>method_undeclared<\/code>/);
  assert.match(bucket, /no request was\s+sent before 2026-09-02/);
  assert.match(bucket, /<code>body_over_cap<\/code>/);
  assert.match(bucket, /a 402 came back\s+and the body was not read to the end/);
  for (const reason of ["rate_limited", "tls", "request_shape", "unsafe_target"] as const) {
    assert.ok(bucket.includes(`<code>${reason}</code>`), reason);
  }
  const reachList = bucket.slice(bucket.indexOf("The remainder includes"), bucket.indexOf("It also"));
  assert.equal(reachList.includes("method_undeclared"), false);
  assert.equal(reachList.includes("body_over_cap"), false);
});

test("getUnverifiedBreakdown の array_agg は probed_at の新しい順で、ORDER BY を外すと赤になる", () => {
  const sqlFn = read("src/lib/observatory/reader.ts");
  const start = sqlFn.indexOf("export async function getUnverifiedBreakdown");
  const end = sqlFn.indexOf("export async function getEndpointNames");
  const sql = sqlFn.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  assert.match(sql, /array_agg\(v\.verdict ORDER BY v\.probed_at DESC\)/);
  assert.match(sql, /array_agg\(v\.fail_reason ORDER BY v\.probed_at DESC\)/);
  assert.match(sql, /SELECT verdict, fail_reason, probed_at FROM x402_l0_probes p/);
  const broken = sql
    .replaceAll("array_agg(v.verdict ORDER BY v.probed_at DESC)", "array_agg(v.verdict)")
    .replaceAll("array_agg(v.fail_reason ORDER BY v.probed_at DESC)", "array_agg(v.fail_reason)");
  assert.equal(/array_agg\(v\.verdict ORDER BY v\.probed_at DESC\)/.test(broken), false);
  assert.equal(/array_agg\(v\.fail_reason ORDER BY v\.probed_at DESC\)/.test(broken), false);
  assert.equal(sql === broken, false);
});

test("観測所の pass は宣言メソッドではなく、要旨と同じメソッド規則を書く", () => {
  const src = squash(read("src/app/observatory/page.tsx"));
  assert.equal(src.includes("a probe using the declared method received"), false);
  assert.match(src, /<code>pass<\/code> means a probe received HTTP 402/);
  assert.match(src, /GET when the listing declares no method or a method outside that set/);
  assert.match(src, /<code>fail<\/code> means two or more consecutive probes contradicted the catalog declaration/);
});

test("State of x402 の method 行は、null が 4 種以外も含むと書く", () => {
  const src = read("src/app/observatory/state/page.tsx");
  assert.equal(src.includes("Catalog entries declaring no HTTP method (probed with GET)"), false);
  assert.match(src, /No HTTP method, or a method other than GET, POST, HEAD, or DELETE \(the probe uses GET\)/);
});

test("プレイグラウンドの実行中と結果注は、デモの 1 回を公開台帳に書かない", () => {
  const src = squash(read("src/app/playground/playground-client.tsx"));
  assert.equal(src.includes("catalog-declared method"), false);
  assert.match(
    src,
    /The request uses the HTTP method the listing declares when that method is GET, POST, HEAD, or DELETE, and GET when the listing declares no method or a method outside that set\./,
  );
  const note = src.indexOf("Measured in");
  const end = src.indexOf("3. The evidence trail");
  assert.ok(note > 0 && end > note);
  const para = src.slice(note, end);
  assert.ok(para.includes(UNVERIFIED));
  assert.match(para, /This demo is not written into the public register\./);
});

test("未宣言メソッドが主因ではない、の検査は状態の methodUndeclared が 100 未満", () => {
  const src = read("docs/claims.yaml");
  const start = src.indexOf("id: audit_e_method_undeclared_is_not_the_main_cause");
  const end = src.indexOf("\n  - id:", start + 10);
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.match(block, /url: https:\/\/vet402\.com\/api\/v1\/observatory\/state/);
  assert.match(block, /assert: "methodUndeclared < 100"/);
  assert.equal(block.includes("check: null"), false);
  assert.equal(block.includes("到達失敗"), false);
});

test("方法論の Gateway バッチ照合は、fixture の tx・行数・額と署名時刻の定数を節に固定する", () => {
  const src = read("src/app/observatory/methodology/page.tsx");
  const start = src.indexOf('id="gateway-batch"');
  const end = src.indexOf("<h2", start);
  assert.ok(start > 0 && end > start);
  const sec = src.slice(start, end);
  const plain = sec
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\{" "\}/g, " ")
    .replace(/\s+/g, " ");
  assert.doesNotMatch(plain, /\b(we|our|us)\b/i);
  assert.doesNotMatch(plain, /;/);
  assert.doesNotMatch(sec, /—|–|--/);
  assert.doesNotMatch(plain, /\bKite\b|\bBlockRun\b/i);
  assert.doesNotMatch(plain, /, not\b/);
  assert.doesNotMatch(plain, /Circle recommends|\bofficial\b/i);
  assert.match(plain, /The tradeoff is that a buyer does not get a separate transaction for each payment/);
  assert.match(plain, /InsufficientBalance event from GatewayWallet for the buyer and USDC, the amount actually taken is available plus withdrawing/);
  assert.match(plain, /vet402 calls the batch settled when the debit equals the sum/);
  assert.match(plain, /A smaller debit is refuted, because the Gateway API reports a charge that the batch did not take in full/);
  assert.match(plain, /A larger debit stays deferred, because the extra amount may be an authorization of the same buyer that this check has not read yet/);
  assert.match(plain, /treats an authorization as outside a batch when its signature time is later than the block time minus/);
  assert.match(plain, /A seller credit in that batch is a total across buyers/);
  const verify = read("src/lib/observatory/arc-gateway-verify.ts");
  const lead = verify.match(/GATEWAY_VALID_AFTER_LEAD_SECONDS = (\d+)/);
  const skew = verify.match(/GATEWAY_BATCH_CLOCK_SKEW_SECONDS = (\d+)/);
  assert.ok(lead && skew);
  assert.match(plain, new RegExp(`validAfter plus ${lead[1]} seconds`));
  assert.match(plain, new RegExp(`set to the current second minus ${lead[1]}`));
    assert.match(plain, new RegExp(`block time minus ${skew[1]} seconds`));
  const files = ["tests/fixtures/arc-gateway-batch-r2.json", "tests/fixtures/arc-gateway-batch-r3.json"];
  assert.equal(files.length, 2);
  for (const file of files) {
    const fixture = JSON.parse(read(file)) as { txHash: string; buyer: string; expectedDebit: string; publishedRows: number };
    const atomic = BigInt(fixture.expectedDebit);
    const whole = atomic / 1_000_000n;
    const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    const usdc = `${whole}.${frac}`;
    assert.match(sec, new RegExp(fixture.txHash, "i"));
    assert.match(sec, new RegExp(`https://explorer\\.arc\\.io/tx/${fixture.txHash}`, "i"));
    assert.ok(sec.includes(fixture.buyer));
    assert.match(plain, new RegExp(`${usdc} USDC for ${fixture.publishedRows} authorizations`));
    assert.match(plain, new RegExp(`negative ${atomic} in 6-decimal units`));
  }
});
