// openapi の published_verdict は、コードが実際に出す語と一致する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publicProbeWord, type ProbeWord } from "@/lib/observatory/l0-verdict";

function publishedVerdictEnum(yaml: string): string[] {
  const at = yaml.indexOf("L0PublishedVerdict:");
  assert.ok(at > 0, "L0PublishedVerdict");
  const block = yaml.slice(at, yaml.indexOf("ScoreDeprecationNotice:", at));
  const match = block.match(/enum: \[([^\]]+)\]/);
  assert.ok(match, "enum");
  return match[1]!.split(",").map((part) => part.trim());
}

test("L0PublishedVerdict は publicProbeWord の取りうる値と一致する", () => {
  const yaml = readFileSync("docs/openapi.yaml", "utf8");
  const fromSchema = publishedVerdictEnum(yaml).sort();
  const produced = new Set<ProbeWord>();
  const statuses = ["active", "delisted", "paused", null];
  const streaks = [[], ["pass"], ["fail"], ["fail", "fail"], ["pass", "fail"], ["unverified"], ["fail", "pass"]];
  for (const status of statuses) {
    for (const streak of streaks) produced.add(publicProbeWord(status, streak));
  }
  assert.deepEqual([...produced].sort(), fromSchema);
});
