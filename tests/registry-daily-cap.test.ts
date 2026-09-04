// ============================================================
// 2026-09-04 金の経路監査 P1-4: Registry を ON にする前の必須修正。
//
// この経路はガスを使う。本番は REGISTRY_WRITES_ENABLED=false のままで、
// 台帳には 14 行の failed だけが残っている（原因は「validator は request を
// 自己開始できない」という別の設計欠陥）。ON にする前に、金の側の穴を塞ぐ。
//
//  (a) 日次上限が read-then-write だった。countWritesToday() を読んでから
//      INSERT するので、逐次発火でも「読んだ後・書く前」に別の書き込みが入れば
//      上限を越える。reserveSpend と同じ手——**上限判定と INSERT を同一文**に。
//  (b) publishValidation は request と response の 2 本を続けて出すが、1 本目の
//      レシートを待っていなかった。同じ鍵から 2 本が同時に飛ぶと nonce が
//      衝突し、しかも response が request より先に採掘され得る（レジストリの
//      仕様順序が壊れる）。
//  (c) hasRegistryWriteForHash が failed の行まで duplicate 扱いにしていた。
//      一度失敗した測定は二度と書けない——失敗の原因が直っても、である。
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __setDbForTests } from "@/lib/db/client";
import { buildValidationRecord, publishValidation } from "@/lib/chain/registry";

const RECORD_INPUT = {
  endpointId: "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a",
  agentId: 42n,
  level: "l1" as const,
  verdict: "pass" as const,
  evidenceUri: "https://vet402.com/observatory/e/5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a",
};

afterEach(() => {
  __setDbForTests(null);
  delete process.env.REGISTRY_WRITES_ENABLED;
  delete process.env.REGISTRY_DAILY_MAX_WRITES;
});

/** 同一文の verdict 行（id と当日件数）を返す偽 DB。 */
function fakeDb(verdict: { id: string | null; n: number }) {
  const statements: string[] = [];
  const updates: unknown[] = [];
  return {
    statements,
    updates,
    async execute(query: { toSQL?: () => { sql: string } } | unknown) {
      const sqlText = (query as { toSQL?: () => { sql: string } })?.toSQL?.().sql ?? "";
      statements.push(sqlText);
      return { rows: [verdict] };
    },
    update() {
      return {
        set(v: unknown) {
          updates.push(v);
          return { where: async () => undefined };
        },
      };
    },
  };
}

function fakeWallet(calls: { functionName: string }[]) {
  return {
    account: { address: "0x1111111111111111111111111111111111111111" },
    chain: { id: 8453 },
    async writeContract(req: { functionName: string }) {
      calls.push({ functionName: req.functionName });
      return `0xtx${calls.length}`;
    },
  } as never;
}

test("日次上限は INSERT と同一文で判定される（読んでから書かない）", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  const db = fakeDb({ id: null, n: 200 });
  __setDbForTests(db as never);
  const calls: { functionName: string }[] = [];
  const out = await publishValidation({
    record: buildValidationRecord(RECORD_INPUT),
    walletClient: fakeWallet(calls),
    currentMaxFeeWei: 1n,
    waitForReceipt: async () => undefined,
  });
  assert.equal(out.status, "daily_cap");
  assert.equal(calls.length, 0, "上限に達しているのにチェーンを呼んでいる");
  const source = readFileSync(join(process.cwd(), "src", "lib", "chain", "registry.ts"), "utf8");
  const statement =
    [...source.matchAll(/db\.execute\(sql`([\s\S]*?)`\)/g)]
      .map((m) => m[1])
      .find((s) => /INSERT INTO registry_writes/i.test(s)) ?? "";
  assert.match(statement, /INSERT INTO registry_writes/i, "同一文の INSERT が見つからない");
  assert.match(statement, /count\(\*\)/i, "上限判定が INSERT と同じ文に無い");
  assert.match(statement, /registry_writes\.status = 'failed'/, "failed を再試行可能にしていない");
});

test("上限に達していなければ書ける", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  __setDbForTests(fakeDb({ id: "row1", n: 3 }) as never);
  const calls: { functionName: string }[] = [];
  const out = await publishValidation({
    record: buildValidationRecord(RECORD_INPUT),
    walletClient: fakeWallet(calls),
    currentMaxFeeWei: 1n,
    waitForReceipt: async () => undefined,
  });
  assert.equal(out.status, "submitted");
});

test("id が返らず上限にも達していなければ duplicate", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  __setDbForTests(fakeDb({ id: null, n: 3 }) as never);
  const calls: { functionName: string }[] = [];
  const out = await publishValidation({
    record: buildValidationRecord(RECORD_INPUT),
    walletClient: fakeWallet(calls),
    currentMaxFeeWei: 1n,
    waitForReceipt: async () => undefined,
  });
  assert.equal(out.status, "duplicate");
  assert.equal(calls.length, 0);
});

test("1 本目（validationRequest）のレシートを待ってから 2 本目を出す", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  __setDbForTests(fakeDb({ id: "row1", n: 0 }) as never);
  const order: string[] = [];
  let sends = 0;
  const wallet = {
    account: { address: "0x1111111111111111111111111111111111111111" },
    chain: { id: 8453 },
    async writeContract(req: { functionName: string }) {
      sends++;
      order.push(`send:${req.functionName}`);
      return `0xtx${sends}`;
    },
  } as never;
  const out = await publishValidation({
    record: buildValidationRecord(RECORD_INPUT),
    walletClient: wallet,
    currentMaxFeeWei: 1n,
    waitForReceipt: async (hash) => {
      order.push(`wait:${hash}`);
    },
  });
  assert.equal(out.status, "submitted");
  assert.deepEqual(order, [
    "send:validationRequest",
    "wait:0xtx1",
    "send:validationResponse",
    "wait:0xtx2",
  ]);
});

test("1 本目が revert したら 2 本目は出さない", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  const db = fakeDb({ id: "row1", n: 0 });
  __setDbForTests(db as never);
  const calls: { functionName: string }[] = [];
  const out = await publishValidation({
    record: buildValidationRecord(RECORD_INPUT),
    walletClient: fakeWallet(calls),
    currentMaxFeeWei: 1n,
    waitForReceipt: async () => {
      throw new Error("reverted");
    },
  });
  assert.equal(out.status, "failed");
  assert.deepEqual(
    calls.map((c) => c.functionName),
    ["validationRequest"],
    "1 本目が確定していないのに 2 本目を出している",
  );
  assert.equal((db.updates[0] as { status: string }).status, "failed");
});
