// ============================================================
// 公開 export の末尾 3 列（2026-09-20）— 要求の形と、tx を名指したのは誰か。
//
//   request_body        declared / empty / none / 空（記録なし）
//   request_body_sha256  宣言本文（送ったバイト列そのもの）の SHA-256。本文は出さない
//   settlement_source    seller_claim / vet402_index / 空（tx なし）
//
// 守ること:
//  1. 「記録なし」は空で、false 側の値（empty・none・seller_claim）に倒さない。
//  2. settlement_source は照合器の lateLinkOf と同じ行を選ぶ（取り消した遅延回収は vet402_index と名乗らない）。
//  3. 列の追加は末尾だけ。既存 11 列の名前と順序は変えない。
//  4. 列を足したら openapi・methodology・llms.txt の説明も同じ列名を持つ。
//  5. 10 月上旬の比較（scripts/declared-body-before-after.mjs）は export の CSV だけから数える。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { EXPORT_CSV_COLUMNS, EXPORT_CSV_COLUMNS_SINCE_2026_09_20 } from "@/lib/observatory/export-columns";
import { requestBodyKindOf, requestBodySha256Of, requestBodyRecord, REQUEST_BODY_KINDS } from "@/lib/observatory/request-body";
import { settlementSourceOf, SETTLEMENT_SOURCES } from "@/lib/observatory/settlement-source";
import { lateLinkOf } from "@/lib/observatory/settlement-verifier";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("列: 既存 11 列はそのまま、追加は末尾の 3 列だけ", () => {
  assert.deepEqual(EXPORT_CSV_COLUMNS.slice(0, 11), [
    "attempted_at",
    "resource_key",
    "network",
    "status",
    "amount_units",
    "spent_units",
    "tx_hash",
    "http_status_paid",
    "latency_ms",
    "l2_schema",
    "held_reason",
  ]);
  assert.deepEqual(EXPORT_CSV_COLUMNS.slice(11), ["request_body", "request_body_sha256", "settlement_source"]);
  assert.deepEqual([...EXPORT_CSV_COLUMNS_SINCE_2026_09_20], EXPORT_CSV_COLUMNS.slice(11));
});

test("request_body: 記録が無い行は null（empty にも none にも倒さない）", () => {
  assert.deepEqual([...REQUEST_BODY_KINDS], ["declared", "empty", "none"]);
  assert.equal(requestBodyKindOf({ requestBody: "declared" }), "declared");
  assert.equal(requestBodyKindOf({ requestBody: "empty" }), "empty");
  assert.equal(requestBodyKindOf({ requestBody: "none" }), "none");
  assert.equal(requestBodyKindOf({ phase: "paid" }), null, "2026-09-17 より前の行・GET の旧い行");
  assert.equal(requestBodyKindOf(null), null);
  assert.equal(requestBodyKindOf({ requestBody: "something-else" }), null, "知らない値を分類に混ぜない");
  assert.equal(requestBodyKindOf({ requestBody: true }), null);
});

test("request_body_sha256: 宣言本文を送った行の 64 桁 hex だけ", () => {
  const h = "a".repeat(64);
  assert.equal(requestBodySha256Of({ requestBody: "declared", requestBodySha256: h }), h);
  assert.equal(requestBodySha256Of({ requestBody: "declared" }), null, "2026-09-20 より前の declared 行は記録なし");
  assert.equal(requestBodySha256Of({ requestBody: "empty", requestBodySha256: h }), null, "宣言本文でない行に hash を出さない");
  assert.equal(requestBodySha256Of({ requestBody: "declared", requestBodySha256: "not-a-hash" }), null);
  assert.equal(requestBodySha256Of({ requestBody: "declared", requestBodySha256: h.toUpperCase() }), null, "記録は小文字 hex");
});

test("requestBodyRecord: ランナーが行に残す形——POST は source、宣言本文には送ったバイト列の SHA-256、POST 以外は none", () => {
  const body = JSON.stringify({ wallet: "0x01", n: [1, 2] });
  const sha = createHash("sha256").update(body, "utf8").digest("hex");
  assert.deepEqual(requestBodyRecord({ body, source: "declared" }), { requestBody: "declared", requestBodySha256: sha });
  assert.deepEqual(requestBodyRecord({ body: "{}", source: "empty" }), { requestBody: "empty" });
  assert.deepEqual(requestBodyRecord(null), { requestBody: "none" });
  // 記録したものを export の分類がそのまま読める。
  assert.equal(requestBodyKindOf(requestBodyRecord(null)), "none");
  assert.equal(requestBodySha256Of(requestBodyRecord({ body, source: "declared" })), sha);
});

test("ランナーは requestBodyRecord を行に書く（手書きの別形を持たない）", () => {
  const src = read("src/lib/observatory/l1-runner.ts");
  assert.ok(src.includes("...requestBodyRecord(paidRequestBody)"), "rawResponseMeta に requestBodyRecord を展開する");
  assert.ok(!/requestBody:\s*paidRequestBody\.source/.test(src), "旧い手書きの形が残っていない");
});

test("settlement_source: tx を名指したのが売り手か vet402 の索引か——照合器の lateLinkOf と同じ行を選ぶ", () => {
  assert.deepEqual([...SETTLEMENT_SOURCES], ["seller_claim", "vet402_index"]);
  const TX = `0x${"1".repeat(64)}`;
  const OTHER = `0x${"2".repeat(64)}`;
  const cases: { name: string; txHash: string | null; late: unknown; want: string | null }[] = [
    { name: "tx なし", txHash: null, late: null, want: null },
    { name: "売り手のレシート", txHash: TX, late: null, want: "seller_claim" },
    { name: "遅延回収（2026-09-19 以降・txHash 付き）", txHash: TX, late: { source: "settlements_index", txHash: TX }, want: "vet402_index" },
    { name: "遅延回収（大文字小文字の差）", txHash: TX.toUpperCase().replace("0X", "0x"), late: { txHash: TX }, want: "vet402_index" },
    { name: "遅延回収（旧い行・txHash の記録なし）", txHash: TX, late: { source: "settlements_index" }, want: "vet402_index" },
    { name: "取り消し後に売り手の原文へ戻った行", txHash: OTHER, late: { txHash: TX, rejectedTxHashes: [TX] }, want: "seller_claim" },
    { name: "取り消し後で tx なし", txHash: null, late: { txHash: TX, rejectedTxHashes: [TX] }, want: null },
    { name: "jsonb が文字列で来ても同じ", txHash: TX, late: JSON.stringify({ txHash: TX }), want: "vet402_index" },
    { name: "lateSettlement が object でない", txHash: TX, late: [], want: "seller_claim" },
  ];
  for (const c of cases) {
    assert.equal(settlementSourceOf({ txHash: c.txHash, lateSettlement: c.late }), c.want, c.name);
    if (c.txHash !== null) {
      const verifierSaysLate = lateLinkOf({ tx_hash: c.txHash, late_settlement: c.late }) !== null;
      assert.equal(verifierSaysLate, c.want === "vet402_index", `lateLinkOf と一致: ${c.name}`);
    }
  }
});

test("列の説明: 足した列は openapi・methodology・llms.txt のどれにも名前で出る", () => {
  const surfaces = [
    "docs/openapi.yaml",
    "public/llms.txt",
    "src/app/observatory/methodology/page.tsx",
  ];
  for (const file of surfaces) {
    const text = read(file);
    for (const col of EXPORT_CSV_COLUMNS_SINCE_2026_09_20) {
      assert.ok(text.includes(col), `${file} が列 ${col} を説明していない`);
    }
  }
  // 「空セル」が何を指すかは openapi と methodology で逐語に揃える（レビュー N2: 片方だけ 1 種類欠けていた）。
  const BLANK_MEANS = "rows before 2026-09-17, bodiless requests before 2026-09-20, and rows that ended before a paid request went out";
  for (const file of ["docs/openapi.yaml", "src/app/observatory/methodology/page.tsx"]) {
    assert.ok(read(file).replace(/\s+/g, " ").includes(BLANK_MEANS), `${file} の空セルの列挙が食い違っている`);
  }
  // held_reason はもう末尾の列ではない。「最後の列」と書いた文が残っていないこと。
  assert.ok(!/last column,?\s*<code>held_reason/.test(read("src/app/observatory/methodology/page.tsx")));
  assert.ok(!read("src/app/corrections/page.tsx").includes("held_reason column at the end of"));
});

test("列の説明: request_query が列になったら、methodology の「列に無い」の 1 文は残せない", () => {
  // 2026-09-21 の宣言クエリ（declared-input.ts）はラベルを raw_response_meta にだけ残し、
  // export には列が無い。methodology §2 はそれを読者に向けて書いている。
  // ところが上のテストは「足した列が名前で出ているか」しか見ないので、`request_query` を
  // 列に足した日も、**この文が `request_query` という名前を含んでいるおかげで緑のまま**通り、
  // 公開面が嘘になる（登録すれば緑と同じ穴）。列が増えた側からこの文を赤くする。
  const NOT_A_COLUMN = "is not among the columns of the ledger export";
  const methodology = read("src/app/observatory/methodology/page.tsx").replace(/\s+/g, " ");
  const hasQueryColumn = (EXPORT_CSV_COLUMNS as readonly string[]).includes("request_query");
  if (hasQueryColumn) {
    assert.ok(
      !methodology.includes(NOT_A_COLUMN),
      "export に request_query 列が入った。methodology の「列に無い」の文を、列の説明に書き替えること",
    );
  } else {
    assert.ok(methodology.includes(NOT_A_COLUMN), "列が無いあいだ、methodology はそう書いていること");
  }
});

// ------------------------------------------------------------
// B: 公開 export だけを入力にした前後比較
// ------------------------------------------------------------
const SCRIPT = join(ROOT, "scripts/declared-body-before-after.mjs");
const HEADER = EXPORT_CSV_COLUMNS.join(",");
type Row = { at: string; key: string; status: string; http: number | ""; shape?: string; held?: string; tx?: string; src?: string };
const line = (r: Row) =>
  [r.at, r.key, "eip155:8453", r.status, "1000", "1000", r.tx ?? "", r.http, "120", "", r.held ?? "", r.shape ?? "", "", r.src ?? ""].join(",");
function runScript(csv: string, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "vet402-before-after-"));
  const file = join(dir, "ledger.csv");
  writeFileSync(file, csv);
  return spawnSync(process.execPath, [SCRIPT, "--file", file, "--json", ...extra], { encoding: "utf8" });
}

test("B: 同じ endpoint の有料 200 率を、宣言本文の導入前後で export だけから数える", () => {
  const rows: Row[] = [
    // a.example: 前 0/2 → 後（declared）2/3
    { at: "2026-09-10T00:00:00Z", key: "a.example/x", status: "settle_failed", http: 400, held: "unsettled_4xx" },
    { at: "2026-09-11T00:00:00Z", key: "a.example/x", status: "settled", http: 422, held: "settled_4xx", tx: "0x1", src: "seller_claim" },
    { at: "2026-09-17T01:00:00Z", key: "a.example/x", status: "settled", http: 200, shape: "declared", tx: "0x2", src: "seller_claim" },
    { at: "2026-09-18T01:00:00Z", key: "a.example/x", status: "settled", http: 200, shape: "declared", tx: "0x3", src: "seller_claim" },
    { at: "2026-09-19T01:00:00Z", key: "a.example/x", status: "settle_failed", http: 400, shape: "declared", held: "unsettled_4xx" },
    // b.example: 後にしか行が無い → 前後の対にならない
    { at: "2026-09-18T02:00:00Z", key: "b.example/y", status: "settled", http: 200, shape: "declared", tx: "0x4", src: "seller_claim" },
    // c.example: 宣言なし（empty）の対照。前 1/1 → 後 0/1
    { at: "2026-09-10T03:00:00Z", key: "c.example/z", status: "settled", http: 200, tx: "0x5", src: "seller_claim" },
    { at: "2026-09-18T03:00:00Z", key: "c.example/z", status: "settle_failed", http: 400, shape: "empty", held: "unsettled_4xx" },
    // d.example: 本文なし（GET）の対照。前 1/1 → 後 1/1
    { at: "2026-09-10T04:00:00Z", key: "d.example/g", status: "settled", http: 200, tx: "0x6", src: "seller_claim" },
    { at: "2026-09-18T04:00:00Z", key: "d.example/g", status: "settled", http: 200, shape: "none", tx: "0x7", src: "seller_claim" },
    // 我々の資金切れの行は前後どちらの分母にも入れない
    { at: "2026-09-14T00:00:00Z", key: "a.example/x", status: "settle_failed", http: 402, held: "payer_unfunded" },
    // 有料の要求を出していない行（署名前に終わった）は分母に入れない
    { at: "2026-09-12T00:00:00Z", key: "a.example/x", status: "no_eligible_accept", http: "" },
  ];
  const res = runScript([HEADER, ...rows.map(line)].join("\n") + "\n");
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.cutover, "2026-09-17T01:00:00Z", "切替時刻は export の最初の declared 行から導く");
  assert.deepEqual(out.declared.paired, { endpoints: 1, before: { paid: 2, http2xx: 0 }, after: { paid: 3, http2xx: 2 } });
  assert.equal(out.declared.endpointsWithoutBefore, 1);
  assert.deepEqual(out.comparison.paired, { endpoints: 2, before: { paid: 2, http2xx: 2 }, after: { paid: 2, http2xx: 1 } });
  // 対照のうち「宣言の無い POST（empty）」だけを取り出した組。GET（d.example）は入らない。
  assert.deepEqual(out.emptyBody.paired, { endpoints: 1, before: { paid: 1, http2xx: 1 }, after: { paid: 1, http2xx: 0 } });
  assert.equal(out.excluded.payerUnfunded, 1);
  assert.equal(out.excluded.noPaidRequest, 1);
});

test("B: request_body 列の無い旧い export・declared が 1 行も無い export は数えずに止まる（0% と書かない）", () => {
  const old = "attempted_at,resource_key,network,status,amount_units,spent_units,tx_hash,http_status_paid,latency_ms,l2_schema,held_reason\n";
  const r1 = runScript(old);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /request_body/);
  const r2 = runScript(HEADER + "\n" + line({ at: "2026-09-10T00:00:00Z", key: "a.example/x", status: "settled", http: 200, tx: "0x1" }) + "\n");
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /declared/);
});

test("B（レビュー C1）: 切替後だけの CSV は数えずに止まる——『前 0% → 後 100%』を刷らない", () => {
  // 独立レビューの実測そのまま: 4 行・全行 2026-09-19。以前は empty の 2 行が「前」に入り 0/2 → 2/2 と出た。
  const rows: Row[] = [
    { at: "2026-09-19T01:00:00Z", key: "a.example/x", status: "settle_failed", http: 400, shape: "empty", held: "unsettled_4xx" },
    { at: "2026-09-19T02:00:00Z", key: "a.example/x", status: "settle_failed", http: 400, shape: "empty", held: "unsettled_4xx" },
    { at: "2026-09-19T03:00:00Z", key: "a.example/x", status: "settled", http: 200, shape: "declared", tx: "0x1", src: "seller_claim" },
    { at: "2026-09-19T04:00:00Z", key: "a.example/x", status: "settled", http: 200, shape: "declared", tx: "0x2", src: "seller_claim" },
  ];
  for (const extra of [[], ["--json"]] as string[][]) {
    const dir = mkdtempSync(join(tmpdir(), "vet402-before-after-"));
    const file = join(dir, "ledger.csv");
    writeFileSync(file, [HEADER, ...rows.map(line)].join("\n") + "\n");
    const res = spawnSync(process.execPath, [SCRIPT, "--file", file, ...extra], { encoding: "utf8" });
    assert.equal(res.status, 2, res.stdout);
    assert.equal(res.stdout, "", "率を 1 つも刷らない");
    assert.match(res.stderr, /starts after the declared body shipped/);
    assert.match(res.stderr, /--days/);
  }
});

test("B（レビュー C1）: 『前』は記録の無い行だけ——記録のある行は、最初の declared 行より早くても『後』", () => {
  const rows: Row[] = [
    // 窓は出荷日より前から始まる（止まらない）
    { at: "2026-09-10T00:00:00Z", key: "a.example/x", status: "settle_failed", http: 400, held: "unsettled_4xx" },
    // この CSV の最初の declared 行（09-19）より早い empty / none の行。記録がある＝出荷後の行。
    { at: "2026-09-18T00:00:00Z", key: "a.example/x", status: "settle_failed", http: 400, shape: "empty", held: "unsettled_4xx" },
    { at: "2026-09-10T00:00:00Z", key: "e.example/p", status: "settled", http: 200, tx: "0x9", src: "seller_claim" },
    { at: "2026-09-18T00:00:00Z", key: "e.example/p", status: "settle_failed", http: 400, shape: "empty", held: "unsettled_4xx" },
    { at: "2026-09-19T00:00:00Z", key: "a.example/x", status: "settled", http: 200, shape: "declared", tx: "0x1", src: "seller_claim" },
    // 出荷日以降の記録なしの行（2026-09-20 より前の GET）も「前」ではない。本番の CSV では、最初の declared 行の
    // 57 秒前から同じバッチの GET が 18 行並んでいる（2026-09-20 実測）。f.example は「前」が無いので対にならない。
    { at: "2026-09-17T00:00:04Z", key: "f.example/g", status: "settled", http: 200, tx: "0xa", src: "seller_claim" },
    { at: "2026-09-18T05:00:00Z", key: "f.example/g", status: "settled", http: 200, tx: "0xb", src: "seller_claim" },
  ];
  const res = runScript([HEADER, ...rows.map(line)].join("\n") + "\n");
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.comparison.endpointsWithoutBefore, 1, "f.example の 2 行はどちらも『後』");
  // a.example: 前は 09-10 の 1 行だけ。09-18 の empty は「前」に入らず、declared でもないので外れる。
  assert.deepEqual(out.declared.paired, { endpoints: 1, before: { paid: 1, http2xx: 0 }, after: { paid: 1, http2xx: 1 } });
  assert.equal(out.excluded.declaredSetOtherBodyAfterShip, 1);
  // e.example: 09-18 の empty は「後」。以前の規則（at < cutover）なら前 2 行・後 0 行で対にならなかった。
  assert.deepEqual(out.comparison.paired, { endpoints: 1, before: { paid: 1, http2xx: 1 }, after: { paid: 1, http2xx: 0 } });
  assert.deepEqual(out.emptyBody.paired, { endpoints: 1, before: { paid: 1, http2xx: 1 }, after: { paid: 1, http2xx: 0 } });
});

test("B（再レビュー W1）: attempted_at が ISO の日時でない行が 1 つでもあれば数えずに止まる——C1 の関門を素通りさせない", () => {
  // 再レビューの実測: 切替後だけの CSV の先頭に attempted_at が空の行を足すと、最古の行が "" になって
  // 「出荷日より後に始まる CSV」の関門が false で抜け、exit 0 で before 0/1 → after 1/1 を刷った。
  const after: Row[] = [
    { at: "2026-09-19T03:00:00Z", key: "a.example/x", status: "settled", http: 200, shape: "declared", tx: "0x1", src: "seller_claim" },
  ];
  for (const bad of ["", "yesterday", "2026-09-10", "2026-09-10 00:00:00"]) {
    const rows: Row[] = [{ at: bad, key: "a.example/x", status: "settle_failed", http: 400, held: "unsettled_4xx" }, ...after];
    const res = runScript([HEADER, ...rows.map(line)].join("\n") + "\n");
    assert.equal(res.status, 2, `attempted_at=${JSON.stringify(bad)}: ${res.stdout}`);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /has no attempted_at/);
    assert.match(res.stderr, /not an export\.csv/);
  }
});

test("B（再レビュー N1）: ちょうど 50,000 行の CSV は打ち切りの可能性を stderr に出す（--file では応答ヘッダを見られない）", () => {
  const body: string[] = [line({ at: "2026-09-10T00:00:00Z", key: "a.example/x", status: "settle_failed", http: 400, held: "unsettled_4xx" })];
  const filler = line({ at: "2026-09-18T00:00:00Z", key: "a.example/x", status: "settled", http: 200, shape: "declared", src: "seller_claim" });
  while (body.length < 50_000) body.push(filler);
  const full = runScript([HEADER, ...body].join("\n") + "\n");
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stderr, /exactly 50,000 rows/);
  const short = runScript([HEADER, ...body.slice(0, 49_999)].join("\n") + "\n");
  assert.equal(short.status, 0, short.stderr);
  assert.doesNotMatch(short.stderr, /50,000 rows/);
});

test("B（レビュー W1）: 注記は compute の戻り値にあり、--json と人間向けの出力で同じ文言", () => {
  const rows: Row[] = [
    { at: "2026-09-10T00:00:00Z", key: "a.example/x", status: "settle_failed", http: 400, held: "unsettled_4xx" },
    { at: "2026-09-18T00:00:00Z", key: "a.example/x", status: "settled", http: 200, shape: "declared", tx: "0x1", src: "seller_claim" },
  ];
  const csv = [HEADER, ...rows.map(line)].join("\n") + "\n";
  const json = runScript(csv);
  assert.equal(json.status, 0, json.stderr);
  const notes: string[] = JSON.parse(json.stdout).notes;
  assert.ok(Array.isArray(notes) && notes.length >= 3);
  assert.ok(notes.some((n) => /selected|selection/i.test(n) && /not the effect of declared bodies in general/i.test(n)), "選択バイアス");
  assert.ok(notes.some((n) => /2026-09-17/.test(n) && /row/i.test(n)), "『前』を行ごとには証明できない");
  assert.ok(notes.some((n) => /366 days/.test(n) && /50,000 rows/.test(n)), "窓の上限");
  // 再レビュー: この run で測っていないことを固定文で言わない。上限は上限と書く。応答なしの行の扱いを言う。
  const all = notes.join(" ");
  assert.doesNotMatch(all, /needed a body all along|mostly failed/);
  assert.doesNotMatch(all, /\bmeasures how many\b/);
  assert.match(all, /is at most how many/);
  assert.ok(notes.some((n) => /http_status_paid/.test(n) && /blank/i.test(n) && /timeout|timed out/i.test(n)), "応答なしの行");
  const dir = mkdtempSync(join(tmpdir(), "vet402-before-after-"));
  const file = join(dir, "ledger.csv");
  writeFileSync(file, csv);
  const human = spawnSync(process.execPath, [SCRIPT, "--file", file], { encoding: "utf8" });
  assert.equal(human.status, 0, human.stderr);
  for (const n of notes) assert.ok(human.stdout.includes(n), `人間向けの出力に注記が無い: ${n.slice(0, 60)}…`);
});

test("B: 引用符つきのセル（resource_key にカンマ）を 1 セルとして読む", () => {
  const rows = [
    `2026-09-10T00:00:00Z,"q.example/a?x=1,2",eip155:8453,settled,1000,1000,0x1,200,100,,,,,seller_claim`,
    `2026-09-18T00:00:00Z,"q.example/a?x=1,2",eip155:8453,settled,1000,1000,0x2,200,100,,,declared,,seller_claim`,
  ];
  const res = runScript([HEADER, ...rows].join("\n") + "\n");
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.declared.paired, { endpoints: 1, before: { paid: 1, http2xx: 1 }, after: { paid: 1, http2xx: 1 } });
});

test("B: スクリプトは DB もリポの内部も読まない（読者と同じ材料）", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(!/DATABASE_URL|from\s+["']pg["']|drizzle|@\/lib|\.\.\/src/.test(src));
});
