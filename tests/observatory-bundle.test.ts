// 再計算バンドルの検証器と、export 見出しの禁止列。--fetch は叩かない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import {
  DAY_REQUEST_GAP_MS,
  assertExportHeaderSafe,
  dayIndexJson,
  headerLineOf,
  retryAfterMs,
  writeBundleSidecars,
} from "../scripts/observatory-bundle";

function dayRoot(prevRoot: string | null, bytes: Buffer): string {
  return createHash("sha256").update(prevRoot ?? "genesis").update("\n").update(bytes).digest("hex");
}

test("見出しの禁止列は拒否し、既定の 19 列とデータ行の偶然の文字列は通す", () => {
  assert.throws(() => assertExportHeaderSafe("attempted_at,challenge_402"), /challenge_402/);
  assert.throws(() => assertExportHeaderSafe("payment_payload"), /payment_payload/);
  assert.throws(() => assertExportHeaderSafe("caller_hash,status"), /caller_hash/);
  assert.throws(() => assertExportHeaderSafe("attempted_at,raw_response_meta"), /raw_/);
  assert.doesNotThrow(() => assertExportHeaderSafe(EXPORT_CSV_COLUMNS.join(",")));
  const safeBody = Buffer.from("attempted_at,resource_key\n2026-01-01T00:00:00Z,challenge_402\n");
  assert.doesNotThrow(() => assertExportHeaderSafe(headerLineOf(safeBody)));
  const badBody = Buffer.from("\uFEFFattempted_at,raw_note\r\n1,2\n");
  assert.throws(() => assertExportHeaderSafe(headerLineOf(badBody)), /raw_/);
});

test("429 の Retry-After は秒数、日付、欠測をミリ秒にする", () => {
  assert.equal(DAY_REQUEST_GAP_MS, 7_000);
  assert.equal(retryAfterMs(null), 7_000);
  assert.equal(retryAfterMs("12"), 12_000);
  assert.equal(retryAfterMs("0"), 0);
  const now = Date.parse("2026-11-24T00:00:00Z");
  assert.equal(retryAfterMs("Tue, 24 Nov 2026 00:00:07 GMT", now), 7_000);
});

function writeSynthetic(dir: string, breakSealed: boolean): void {
  const b1 = Buffer.from('{"day":"2026-01-01","rows":[]}', "utf8");
  const b2 = Buffer.from('{"day":"2026-01-02","rows":[1]}', "utf8");
  const b2bad = Buffer.from('{"day":"2026-01-02","rows":[1,1]}', "utf8");
  const b3 = Buffer.from('{"day":"2026-01-03","rows":[9]}', "utf8");
  const sealed3 = Buffer.from('{"day":"2026-01-03","rows":["sealed-not-kept"]}', "utf8");
  const r1 = dayRoot(null, b1);
  const r2 = dayRoot(r1, b2);
  const r3 = dayRoot(r2, sealed3);
  mkdirSync(join(dir, "days"), { recursive: true });
  writeFileSync(join(dir, "days", "2026-01-01.json"), b1);
  writeFileSync(join(dir, "days", "2026-01-02.json"), breakSealed ? b2bad : b2);
  writeFileSync(join(dir, "days", "2026-01-03.json"), b3);
  writeFileSync(
    join(dir, "anchors.json"),
    `${JSON.stringify({
      anchors: [
        { day: "2026-01-03", rootHash: r3, prevRoot: r2 },
        { day: "2026-01-02", rootHash: r2, prevRoot: r1 },
        { day: "2026-01-01", rootHash: r1, prevRoot: null },
      ],
    })}\n`,
  );
  writeFileSync(
    join(dir, "days", "index.json"),
    dayIndexJson([
      { day: "2026-01-01", source: "sealed", verification: "ok" },
      { day: "2026-01-02", source: "sealed", verification: "ok" },
      { day: "2026-01-03", source: "current", verification: "payload_does_not_match_head" },
    ]),
  );
  writeFileSync(join(dir, "export.csv"), `${EXPORT_CSV_COLUMNS.join(",")}\n`);
  writeBundleSidecars(dir);
}

function runVerify(dir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["verify.mjs"], { cwd: dir, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("合成バンドル: 封印 2 日は再計算と連結が通り、current の 1 日は drift で終了 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-bundle-"));
  try {
    writeSynthetic(dir, false);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    assert.equal(readme.includes(";"), false);
    assert.equal(readme.includes("\u2014"), false);
    assert.equal(readme.includes("\u2013"), false);
    assert.doesNotMatch(readme, /\b(we|our|us)\b/i);
    assert.match(readme, /CC BY 4\.0/);
    assert.match(readme, /LICENSE-DATA/);
    assert.match(readme, /sealed before 2026-11-23 and changed later/);
    assert.match(readme, /do not recompute/);
    assert.match(readme, /sealed bytes were not kept/);
    assert.match(readme, /sha256\(\(prevRoot or "genesis"\) \+ "\\n" \+ day file bytes\)/);
    for (const column of EXPORT_CSV_COLUMNS) assert.match(readme, new RegExp("`" + column + "`"));
    const verify = readFileSync(join(dir, "verify.mjs"), "utf8");
    assert.doesNotMatch(verify, /from ["'](?!node:)/);
    const result = runVerify(dir);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      [
        "2026-01-01 ok",
        "2026-01-02 ok",
        "2026-01-03 drift (source=current)",
        "summary ok=2 drift=1 fail=0",
        "",
      ].join("\n"),
    );
    assert.equal(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("封印日のバイトが root と違うと FAIL で終了 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-bundle-"));
  try {
    writeSynthetic(dir, true);
    const result = runVerify(dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^2026-01-01 ok$/m);
    assert.match(result.stdout, /^2026-01-02 FAIL$/m);
    assert.match(result.stdout, /^2026-01-03 drift \(source=current\)$/m);
    assert.match(result.stdout, /^summary ok=1 drift=1 fail=1$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
