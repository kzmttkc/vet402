// 2026-10-24: 記録頁の異議節に support@、/corrections、次の L0 の目安。
// 時刻は l0ProbeScheduleLabel()（vercel.json）から。頁のソースに時刻の文字を直書きしない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { l0ScheduleSentence, recordPageDisputeText, recordRemeasureSentence } from "../src/lib/observatory/dispute-ack";
import { l0ProbeScheduleLabel } from "../src/lib/observatory/l0-schedule";

const page = readFileSync("src/app/observatory/e/[id]/page.tsx", "utf8");

function disputeSlice(source: string): string {
  const start = source.indexOf("Dispute this record");
  const end = source.indexOf("<RecordSubscribe", start);
  assert.ok(start > 0 && end > start, "異議節の位置");
  return source.slice(start, end);
}

test("記録頁の異議節に support@vet402.com と /corrections と測り直しの文がある", () => {
  const slice = disputeSlice(page);
  assert.match(slice, /SUPPORT_EMAIL/);
  assert.match(slice, /SUPPORT_MAILTO/);
  assert.match(slice, /href="\/corrections"/);
  assert.match(slice, /recordPageDisputeText\(l0ProbeScheduleLabel\(\), disputeReprobe\)/);
  assert.doesNotMatch(slice, /formDisputeListingSentence\(/);
  assert.doesNotMatch(slice, /recordRemeasureSentence\(/);
});

test("測り直しの目安は予定時刻そのもので、列に乗らない出品は乗らないと言う", () => {
  const label = l0ProbeScheduleLabel();
  assert.match(label, /\d{2}:\d{2} UTC/);
  assert.equal(recordRemeasureSentence(label, "queued"), l0ScheduleSentence(label));
  assert.match(recordRemeasureSentence(label, "queued"), new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const reprobe of ["not_active", "path_template"] as const) {
    const sentence = recordRemeasureSentence(label, reprobe);
    assert.match(sentence, new RegExp(`The scheduled L0 run is at ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(sentence, /This listing is not on that run\./);
    assert.doesNotMatch(sentence, /can measure the listing first/);
  }
  assert.doesNotMatch(page, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("記録頁の予定時刻は、掲載中でも掲載落ちでも1回だけ", () => {
  const label = l0ProbeScheduleLabel();
  const needle = `The scheduled L0 run is at ${label}`;
  for (const reprobe of ["queued", "not_active", "path_template"] as const) {
    const text = recordPageDisputeText(label, reprobe);
    assert.equal(text.split(needle).length - 1, 1, reprobe);
  }
});
