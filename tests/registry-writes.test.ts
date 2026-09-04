// ============================================================
// ERC-8004 Validation Registry 書込（Phase 1.3）。
// 金（ガス）が動く経路なので、性質は l1-runner と同じ向きで固定する:
//  - フラグOFFが既定で、その間はDBにもチェーンにも一切触れない
//  - requestHash は決定的（同じ測定 → 同じ hash → 台帳一意制約が冪等性）
//  - ガス上限超過では書かない
//  - 重複 hash はチェーン呼び出しゼロ
//  - 送信時は request → response の2呼び出しで、台帳が submitted になる
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";
import {
  buildValidationRecord,
  publishValidation,
  isRegistryWritesEnabled,
} from "@/lib/chain/registry";

const RECORD_INPUT = {
  endpointId: "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a",
  agentId: 42n,
  level: "l1" as const,
  verdict: "pass" as const,
  evidenceUri: "https://vet402.com/observatory/e/5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a",
};

function fakeWallet(calls: { functionName: string; args: unknown[] }[]) {
  return {
    account: { address: "0x1111111111111111111111111111111111111111" },
    chain: { id: 8453 },
    async writeContract(req: { functionName: string; args: unknown[] }) {
      calls.push({ functionName: req.functionName, args: req.args });
      return `0xtx${calls.length}`;
    },
  } as never;
}

function fakeDb(opts: { insertReturns: { id: string | null; n?: number }[] }) {
  const updates: unknown[] = [];
  return {
    updates,
    async execute() {
      return { rows: opts.insertReturns };
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

afterEach(() => {
  __setDbForTests(null);
  delete process.env.REGISTRY_WRITES_ENABLED;
  delete process.env.REGISTRY_MAX_FEE_GWEI;
});

test("既定はOFF——flagが無ければ disabled・DBもチェーンも触らない", async () => {
  assert.equal(isRegistryWritesEnabled(), false);
  const calls: never[] = [];
  const out = await publishValidation({
    record: buildValidationRecord(RECORD_INPUT),
    walletClient: fakeWallet(calls),
    currentMaxFeeWei: 1n,
    waitForReceipt: async () => undefined,
  });
  assert.deepEqual(out, { status: "disabled" });
  assert.equal(calls.length, 0);
});

test("requestHash は決定的・verdict→response は pass=100 / fail=0", () => {
  const a = buildValidationRecord(RECORD_INPUT);
  const b = buildValidationRecord(RECORD_INPUT);
  assert.equal(a.requestHash, b.requestHash);
  assert.match(a.requestHash, /^0x[0-9a-f]{64}$/);
  assert.equal(a.response, 100);
  const fail = buildValidationRecord({ ...RECORD_INPUT, verdict: "fail" });
  assert.equal(fail.response, 0);
  assert.notEqual(fail.requestHash, a.requestHash);
});

test("ガス上限超過では書かない（サーキットブレーカ）", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  __setDbForTests(fakeDb({ insertReturns: [{ id: "x", n: 0 }] }));
  const calls: never[] = [];
  const out = await publishValidation({
    record: buildValidationRecord(RECORD_INPUT),
    walletClient: fakeWallet(calls),
    currentMaxFeeWei: 2_000_000_000n, // 2 gwei > 既定0.5
    waitForReceipt: async () => undefined,
  });
  assert.equal(out.status, "gas_over_cap");
  assert.equal(calls.length, 0);
});

test("重複 requestHash → duplicate・チェーン呼び出しゼロ", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  __setDbForTests(fakeDb({ insertReturns: [{ id: null, n: 0 }] })); // 同一文ゲートが id を返さない = 既存行
  const calls: { functionName: string; args: unknown[] }[] = [];
  const out = await publishValidation({
    record: buildValidationRecord(RECORD_INPUT),
    walletClient: fakeWallet(calls),
    currentMaxFeeWei: 1n,
    waitForReceipt: async () => undefined,
  });
  assert.deepEqual(out, { status: "duplicate" });
  assert.equal(calls.length, 0);
});

test("送信は request → response の順の2トランザクション・台帳は submitted", async () => {
  process.env.REGISTRY_WRITES_ENABLED = "true";
  const db = fakeDb({ insertReturns: [{ id: "row1", n: 0 }] });
  __setDbForTests(db);
  const calls: { functionName: string; args: unknown[] }[] = [];
  const record = buildValidationRecord(RECORD_INPUT);
  const out = await publishValidation({
    record,
    walletClient: fakeWallet(calls),
    currentMaxFeeWei: 1n,
    waitForReceipt: async () => undefined,
  });
  assert.equal(out.status, "submitted");
  assert.deepEqual(
    calls.map((c) => c.functionName),
    ["validationRequest", "validationResponse"],
  );
  assert.equal(calls[0].args[1], 42n, "agentId");
  assert.equal(calls[1].args[0], record.requestHash);
  assert.equal(calls[1].args[1], 100);
  assert.equal(calls[1].args[4], "vet402:l1");
  assert.deepEqual(db.updates, [{ status: "submitted", txHash: "0xtx2" }]);
});
