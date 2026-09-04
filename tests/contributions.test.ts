// ============================================================
// 許可不要L0コントリビューション v0（Phase 3.3）。
// 固定する性質:
//  - 既定OFF: フラグ無しでは 403 相当の拒否・署名検証すら走らない
//  - 署名は実検証（viemの実鍵で署名した正のケースが通り、改竄が落ちる）
//  - 保存されるのは正規化メッセージの原文ごと（後から検証可能）
//  - 公開 verdict へ混ぜない、はAPIの note とモジュール設計で明示
//  - リプレイ不可: `issued` 必須・鮮度窓の外は signature_expired・
//    同一メッセージの再送は replayed（2026-08-22 監査残件）
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { __setDbForTests } from "@/lib/db/client";
import {
  contributionMessage,
  submitContribution,
} from "@/lib/observatory/contributions";

const ENDPOINT_ID = "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a";
const ACCOUNT = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

/**
 * insert を記録し、select（リプレイ照会）は `existing` に入れた message と
 * 一致したときだけ1行返す最小フェイク。
 */
function insertCapturingDb(rows: unknown[], existing: string[] = []) {
  return {
    select() {
      return {
        from() {
          return {
            where(condition: unknown) {
              // drizzle の eq() は内部構造なので値の突合はしない。
              // 「同じ message が既に台帳にあるか」を existing の有無で代表させる。
              void condition;
              return { limit: async () => (existing.length > 0 ? [{ id: "dup" }] : []) };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(v: unknown) {
          rows.push(v);
          return { returning: async () => [{ id: "c1", ...(v as object) }] };
        },
      };
    },
  };
}

const ISSUED = () => new Date().toISOString();

afterEach(() => {
  __setDbForTests(null);
  delete process.env.CONTRIBUTIONS_ENABLED;
});

test("既定OFF → contributions_disabled", async () => {
  const result = await submitContribution({
    endpointId: ENDPOINT_ID,
    verdict: "pass",
    httpStatus: 402,
    latencyMs: 120,
    issued: ISSUED(),
    address: ACCOUNT.address,
    signature: "0xdead",
  });
  assert.deepEqual(result, { ok: false, reason: "contributions_disabled" });
});

test("実鍵で署名した正のケースが通り、原文メッセージごと保存される", async () => {
  process.env.CONTRIBUTIONS_ENABLED = "true";
  const rows: { message?: string; submitter?: string }[] = [];
  __setDbForTests(insertCapturingDb(rows));
  const issued = ISSUED();
  const message = contributionMessage({
    endpointId: ENDPOINT_ID,
    verdict: "pass",
    httpStatus: 402,
    latencyMs: 120,
    issued,
  });
  const signature = await ACCOUNT.signMessage({ message });
  const result = await submitContribution({
    endpointId: ENDPOINT_ID,
    verdict: "pass",
    httpStatus: 402,
    latencyMs: 120,
    issued,
    address: ACCOUNT.address,
    signature,
  });
  assert.equal(result.ok, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, message);
  assert.equal(rows[0].submitter, ACCOUNT.address.toLowerCase());
});

test("内容を1箇所でも変えた署名は invalid_signature・保存されない", async () => {
  process.env.CONTRIBUTIONS_ENABLED = "true";
  const rows: unknown[] = [];
  __setDbForTests(insertCapturingDb(rows));
  const issued = ISSUED();
  const signature = await ACCOUNT.signMessage({
    message: contributionMessage({
      endpointId: ENDPOINT_ID,
      verdict: "pass",
      httpStatus: 402,
      latencyMs: 120,
      issued,
    }),
  });
  const tampered = await submitContribution({
    endpointId: ENDPOINT_ID,
    verdict: "fail", // 署名時と異なる
    httpStatus: 402,
    latencyMs: 120,
    issued,
    address: ACCOUNT.address,
    signature,
  });
  assert.deepEqual(tampered, { ok: false, reason: "invalid_signature" });
  assert.equal(rows.length, 0);
});

test("不正入力（UUIDでない・未知verdict・変なアドレス）は署名検証前に拒否", async () => {
  process.env.CONTRIBUTIONS_ENABLED = "true";
  __setDbForTests(insertCapturingDb([]));
  for (const bad of [
    { endpointId: "../../etc", verdict: "pass", address: ACCOUNT.address },
    { endpointId: ENDPOINT_ID, verdict: "great", address: ACCOUNT.address },
    { endpointId: ENDPOINT_ID, verdict: "pass", address: "not-an-address" },
  ]) {
    const result = await submitContribution({
      ...bad,
      httpStatus: null,
      latencyMs: null,
      issued: ISSUED(),
      signature: "0xdead",
    });
    assert.deepEqual(result, { ok: false, reason: "invalid_input" });
  }
});

// ---- リプレイ防止（2026-08-22 監査残件） ----------------------------------

test("issued が無い/形が違うものは署名検証より前に invalid_input", async () => {
  process.env.CONTRIBUTIONS_ENABLED = "true";
  const rows: unknown[] = [];
  __setDbForTests(insertCapturingDb(rows));
  for (const issued of ["", "2026", "2026-08-22T12:00:00Z", "2026-08-22T12:00:00.000Z\nwallet: 0x0"]) {
    const result = await submitContribution({
      endpointId: ENDPOINT_ID,
      verdict: "pass",
      httpStatus: 402,
      latencyMs: 120,
      issued,
      address: ACCOUNT.address,
      signature: "0xdead",
    });
    assert.deepEqual(result, { ok: false, reason: "invalid_input" }, `issued=${JSON.stringify(issued)}`);
  }
  assert.equal(rows.length, 0);
});

test("鮮度窓の外（古い署名も未来の署名も）は signature_expired・保存されない", async () => {
  process.env.CONTRIBUTIONS_ENABLED = "true";
  const rows: unknown[] = [];
  __setDbForTests(insertCapturingDb(rows));
  for (const offsetMs of [-11 * 60_000, 11 * 60_000]) {
    const issued = new Date(Date.now() + offsetMs).toISOString();
    const message = contributionMessage({
      endpointId: ENDPOINT_ID,
      verdict: "pass",
      httpStatus: 402,
      latencyMs: 120,
      issued,
    });
    const signature = await ACCOUNT.signMessage({ message });
    const result = await submitContribution({
      endpointId: ENDPOINT_ID,
      verdict: "pass",
      httpStatus: 402,
      latencyMs: 120,
      issued,
      address: ACCOUNT.address,
      signature,
    });
    assert.deepEqual(result, { ok: false, reason: "signature_expired" });
  }
  assert.equal(rows.length, 0);
});

test("窓の内側でも同一メッセージの再送は replayed・二重保存しない", async () => {
  process.env.CONTRIBUTIONS_ENABLED = "true";
  const rows: unknown[] = [];
  const issued = ISSUED();
  const message = contributionMessage({
    endpointId: ENDPOINT_ID,
    verdict: "pass",
    httpStatus: 402,
    latencyMs: 120,
    issued,
  });
  const signature = await ACCOUNT.signMessage({ message });
  // 1回目は既存行なし、2回目は同じ message が既に台帳にある状態を再現する。
  __setDbForTests(insertCapturingDb(rows, [message]));
  const result = await submitContribution({
    endpointId: ENDPOINT_ID,
    verdict: "pass",
    httpStatus: 402,
    latencyMs: 120,
    issued,
    address: ACCOUNT.address,
    signature,
  });
  assert.deepEqual(result, { ok: false, reason: "replayed" });
  assert.equal(rows.length, 0);
});

// 2026-09-05 (S-6/E-c): コロン区切りの単一行から改行区切りの人間可読へ。
// `issued` が畳み込まれているという v1 からの不変条件は変わらない——
// 変わったのは「署名画面で読めるか」だけ。実文の凍結は
// tests/signature-domain-binding.test.ts が持つ。
test("メッセージは人間可読な改行区切りで、issued が畳み込まれている", async () => {
  const issued = "2026-08-22T12:00:00.000Z";
  const message = contributionMessage({
    endpointId: ENDPOINT_ID,
    verdict: "pass",
    httpStatus: 402,
    latencyMs: 120,
    issued,
  });
  const lines = message.split("\n");
  assert.equal(lines[0], "vet402.com — external observation");
  assert.equal(lines[1], "domain: vet402.com");
  assert.ok(lines.includes(`endpoint: ${ENDPOINT_ID}`));
  assert.ok(lines.includes("verdict: pass"));
  assert.ok(lines.includes("http status: 402"));
  assert.ok(lines.includes("latency: 120 ms"));
  assert.ok(lines.includes(`issued: ${issued} (valid 10 minutes)`));
});
