#!/usr/bin/env tsx
// ============================================================
// docs/claims.yaml の check を本番 API に当てて、偽になった主張を報告する。
//
//   npm run claims:canary
//
// 読み取りのみ（GET だけ・キーの要らない面だけ）。落ちた主張があれば exit 1。
//
// なぜ在るか: 2026-08-13 の LP は「probed daily」と書き、2026-08-20 に
// /observatory/state が同じサイトへ 18.8% を出した。矛盾は 20 日間公開され、
// 6 回の監査がどれも気づかなかった。テスト（tests/claims-registry.test.ts）は
// 「未登録の断定が入るのを止める」役で、こちらは「登録した主張が本番の実測と
// まだ一致しているか」を見る役。片方だけでは 8/13 は止まらない。
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegistry } from "../src/lib/claims/yaml";
import { runClaimChecks } from "../src/lib/claims/canary";

const TIMEOUT_MS = 30_000;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { accept: "application/json", "user-agent": "vet402-claims-canary" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON (${res.headers.get("content-type") ?? "no content-type"}, ${text.length} bytes)`);
  }
}

async function main() {
  const registry = parseRegistry(readFileSync(join(process.cwd(), "docs/claims.yaml"), "utf8"));
  const report = await runClaimChecks(registry.claims, fetchJson);

  const unverifiable = registry.claims.filter((c) => c.check === null).length;
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `${report.ok ? "✔" : "✖"} claims-canary: ${report.checked - report.failed.length}/${report.checked} checks true, ` +
      `${report.failed.length} false, ${unverifiable} registered with check: null (${registry.claims.length} claims total).`,
  );
  // --verbose: 通った主張も 1 行ずつ出す（監査で全項目を貼るとき用）。
  // JSON の形は変えない — 下流はそちらだけ読む。
  if (process.argv.includes("--verbose")) {
    for (const c of registry.claims) {
      if (c.check === null) continue;
      const bad = report.failed.find((f) => f.id === c.id);
      console.log(`  ${bad ? "✖" : "✔"} ${c.id} — ${c.check.assert} @ ${c.check.url}`);
    }
  }

  if (!report.ok) {
    for (const f of report.failed) {
      console.log(`  ✖ ${f.id}: expected ${f.expected}, actual ${JSON.stringify(f.actual)} — ${JSON.stringify(f.quote)}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`claims-canary failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
});
