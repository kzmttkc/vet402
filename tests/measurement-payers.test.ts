// 公開の測定 payer 一覧（kzmttkc/vet402#43）と、backfill が test を残すこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEASUREMENT_PAYERS,
  isMeasurementPayer,
  nextMeasurementWashFlag,
} from "@/lib/settlements/measurement-payers";
import { reclassifyMeasurementPayers } from "@/lib/settlements/reclassify-measurement";

const ROOT = process.cwd();
const CROSS = "eip155:8453:0x8d2a47cbd262e1bc5ee0645c81899f9896957d37";
const MIZAN = "eip155:8453:0xe3badbd4f38214b9eae528a1a5398f6678f63fb3";
const NODE_A = "eip155:8453:0x7dd81398fac7de0bf843bfd874cbea68face17d2";
const NODE_B = "eip155:8453:0xc533bf5268a2f64adde58dce380651f70aa92d7a";

test("一覧は Crosspeel と Mizan だけ。汎用 node の2住所は無い", () => {
  assert.deepEqual(
    MEASUREMENT_PAYERS.map((p) => p.payerId),
    [CROSS, MIZAN],
  );
  for (const p of MEASUREMENT_PAYERS) {
    assert.equal(p.chain, "eip155:8453");
    assert.equal(p.addedOn, "2026-10-24");
    assert.ok(p.sourceUrl.startsWith("https://"));
    assert.ok(p.sourceQuote.length > 20);
    assert.ok(p.basis.includes("kzmttkc/vet402 issue 43"));
  }
  assert.equal(MEASUREMENT_PAYERS[0].name, "Crosspeel");
  assert.equal(MEASUREMENT_PAYERS[0].sourceUrl, "https://crosspeel.com/method");
  assert.match(MEASUREMENT_PAYERS[0].sourceQuote, /measures how many of them hold/);
  assert.equal(MEASUREMENT_PAYERS[1].name, "Mizan");
  assert.equal(MEASUREMENT_PAYERS[1].sourceUrl, "https://mizan-bazar.higgsfield.app");
  assert.match(MEASUREMENT_PAYERS[1].sourceQuote, /measurement errors have been found/);
  assert.equal(isMeasurementPayer(NODE_A), false);
  assert.equal(isMeasurementPayer(NODE_B), false);
  assert.equal(isMeasurementPayer("eip155:8453:0x8D2A47CBD262E1BC5EE0645C81899F9896957D37"), true);
});

test("nextMeasurementWashFlag: 一覧の外は動かさない。test は test のまま。それ以外は measurement", () => {
  assert.equal(nextMeasurementWashFlag("none", NODE_A), "none");
  assert.equal(nextMeasurementWashFlag("circular", NODE_B), "circular");
  assert.equal(nextMeasurementWashFlag("self_deal", "eip155:1:0xabc"), "self_deal");
  assert.equal(nextMeasurementWashFlag("none", CROSS), "measurement");
  assert.equal(nextMeasurementWashFlag("circular", MIZAN), "measurement");
  assert.equal(nextMeasurementWashFlag("self_deal", CROSS), "measurement");
  assert.equal(nextMeasurementWashFlag("measurement", CROSS), "measurement");
  assert.equal(nextMeasurementWashFlag("test", CROSS), "test");
  assert.equal(nextMeasurementWashFlag("test", MIZAN), "test");
});

test("索引の EVM 経路は classifyWash に measurementPayers を渡す", () => {
  const src = readFileSync(join(ROOT, "src/lib/settlements/index-evm.ts"), "utf8");
  assert.match(src, /measurementPayers:\s*classifier\.measurementPayers/);
});

test("backfill は既定が dry-run。apply だけが test 以外を measurement に書く", async () => {
  const queries: string[] = [];
  const db = {
    execute: async (query: unknown) => {
      queries.push(sqlText(query));
      const text = queries[queries.length - 1];
      if (text.includes("GROUP BY wash_flag") && text.includes("FROM settlements")) {
        return [
          { wash_flag: "none", rows: 2, payments: 2 },
          { wash_flag: "test", rows: 1, payments: 1 },
        ];
      }
      if (text.includes("GROUP BY wash_flag")) {
        return [{ wash_flag: "none", rows: 1, payments: 4 }];
      }
      if (text.includes("FROM settlement_daily") && text.includes("AS payments")) {
        return [{ rows: 1, payments: 4 }];
      }
      if (text.includes("UPDATE settlements")) return [{ n: 2 }];
      if (text.includes("count(*)")) return [{ n: 2 }];
      return [{ n: 1 }];
    },
  };
  const dry = await reclassifyMeasurementPayers(db, { apply: false });
  assert.equal(dry.apply, false);
  assert.equal(dry.settlementsToMove, 2);
  assert.equal(dry.dailyPaymentsToMove, 4);
  assert.equal(dry.settlementsMoved, 0);
  assert.equal(queries.some((q) => q.includes("UPDATE") || q.includes("DELETE")), false);
  assert.equal(dry.settlementsByFlag.test.rows, 1);
  assert.equal(dry.settlementsByFlag.none.rows, 2);

  queries.length = 0;
  const applied = await reclassifyMeasurementPayers(db, { apply: true });
  assert.equal(applied.settlementsMoved, 2);
  const update = queries.find((q) => q.includes("UPDATE settlements"));
  assert.ok(update);
  assert.match(update, /wash_flag = 'measurement'/);
  assert.match(update, /wash_flag <> 'test'/);
  assert.match(update, /wash_flag <> 'measurement'/);
  assert.match(update, /0x8d2a47cbd262e1bc5ee0645c81899f9896957d37/);
  assert.match(update, /0xe3badbd4f38214b9eae528a1a5398f6678f63fb3/);
  const daily = queries.find((q) => q.includes("DELETE FROM settlement_daily"));
  assert.ok(daily);
  assert.match(daily, /'measurement'/);
  assert.match(daily, /wash_flag <> 'test'/);
});

test("新しい公開文に we / our / us、セミコロン、ダッシュ、Kite、BlockRun が無い", () => {
  const page = readFileSync(join(ROOT, "src/app/observatory/methodology/page.tsx"), "utf8");
  const start = page.indexOf('id="measurement-payers"');
  const end = page.indexOf('sec-no">9.', start);
  const section = page.slice(start, end);
  const corrections = readFileSync(join(ROOT, "src/app/corrections/page.tsx"), "utf8");
  // Find this entry by its subject, not its date: 2026-10-24 has more than one correction.
  const entryStart = corrections.indexOf('subject: "Counting other measurement services as real buyers"');
  const entryEnd = corrections.indexOf('date: "2026-10-21"', entryStart);
  const entry = corrections.slice(entryStart, entryEnd);
  const bits = [
    ...MEASUREMENT_PAYERS.flatMap((p) => [p.basis, p.sourceQuote, p.name]),
    section,
    entry,
  ];
  for (const s of bits) {
    assert.equal(/\b(we|our|us)\b/i.test(s), false, s.slice(0, 180));
    assert.equal(/[;—–]|--/.test(s), false, s.slice(0, 180));
    assert.equal(/Kite|BlockRun/i.test(s), false);
  }
});

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  const out: string[] = [];
  const walk = (chunk: unknown) => {
    if (typeof chunk === "string") out.push(chunk);
    else if (Array.isArray(chunk)) chunk.forEach(walk);
    else if (chunk && typeof chunk === "object" && "value" in chunk) walk((chunk as { value: unknown }).value);
    else if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      walk((chunk as { queryChunks: unknown }).queryChunks);
    }
  };
  chunks.forEach(walk);
  return out.join("");
}
