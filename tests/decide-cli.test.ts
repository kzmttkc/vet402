// fixtures/decide は tests/decision-rules.test.ts の decidePayer / decidePayee 入力。
// now は同じファイルの鮮度基準 T（2026-09-02）を ISO 文字列にしたもの。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECISION_RULES_VERSION, decidePayee, decidePayer, type PayerOptions } from "@/lib/decision/rules";
import type { BuyerFacts, SellerFacts } from "@/lib/decision/types";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "fixtures", "decide");

type Fixture = {
  role: "payer" | "payee";
  facts: SellerFacts | BuyerFacts;
  now?: string;
  callerDialect?: PayerOptions["callerDialect"];
  allowWithoutL1?: boolean;
  operatorBlacklist?: boolean;
  dataDepth?: PayerOptions["dataDepth"];
  l1NotCounted?: PayerOptions["l1NotCounted"];
  l0UnverifiedCause?: string | null;
  l1Timeline?: PayerOptions["l1Timeline"];
  l2ConformNoRequiredKeys?: boolean;
};

function direct(input: Fixture): { recommendation: string; reason_codes: string[]; rulesVersion: string } {
  if (input.role === "payer") {
    const options: PayerOptions = {};
    if (input.now !== undefined) options.now = new Date(input.now);
    if (input.callerDialect !== undefined) options.callerDialect = input.callerDialect;
    if (input.allowWithoutL1 !== undefined) options.allowWithoutL1 = input.allowWithoutL1;
    if (input.operatorBlacklist !== undefined) options.operatorBlacklist = input.operatorBlacklist;
    if (input.dataDepth !== undefined) options.dataDepth = input.dataDepth;
    if (input.l1NotCounted !== undefined) options.l1NotCounted = input.l1NotCounted;
    if (input.l0UnverifiedCause !== undefined) options.l0UnverifiedCause = input.l0UnverifiedCause;
    if (input.l1Timeline !== undefined) options.l1Timeline = input.l1Timeline;
    if (input.l2ConformNoRequiredKeys !== undefined) options.l2ConformNoRequiredKeys = input.l2ConformNoRequiredKeys;
    return { ...decidePayer(input.facts as SellerFacts, options), rulesVersion: DECISION_RULES_VERSION };
  }
  if (!input.now) throw new Error("payee fixture requires now");
  return {
    ...decidePayee(input.facts as BuyerFacts, {
      now: new Date(input.now),
      ...(input.operatorBlacklist !== undefined ? { operatorBlacklist: input.operatorBlacklist } : {}),
    }),
    rulesVersion: DECISION_RULES_VERSION,
  };
}

const files = readdirSync(FIXTURES).filter((name) => name.endsWith(".json")).sort();

test("ALLOW / WARN / BLOCK を含む", () => {
  const seen = new Set(files.map((name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))).map((input: Fixture) => direct(input).recommendation));
  assert.deepEqual([...seen].sort(), ["ALLOW", "BLOCK", "WARN"]);
});

for (const name of files) {
  test(`decide-cli ${name}`, () => {
    const raw = readFileSync(join(FIXTURES, name), "utf8");
    const input = JSON.parse(raw) as Fixture;
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "decide-cli.ts")], {
      cwd: ROOT,
      input: raw,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), direct(input));
  });
}
