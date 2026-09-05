// ============================================================
// vet402 — S-6 / KC-B: 署名本文のオリジン束縛と名乗りの統一 (2026-09-05)
//
// 監査の所見（docs/audits/2026-09-05-blockchain-security-audit.md §4）:
// 全 5 面の署名本文に「どのサイトが求めているか」が 1 行も無く、名乗りが
// `Vouch` / `vet402` / `vet402.com` の 3 種に割れていた。本番の実文は
// `Vouch verified payee registration` — サイトのどこにも無い製品名である。
// 同じ本文を出す偽サイトは、ユーザーが署名画面を読んでも見分けられない。
//
// ここで固定する不変条件:
//   1. 5 面すべて 1 行目が `vet402.com — <purpose>`、2 行目が `domain: vet402.com`。
//   2. `domain:` 行の無い本文への署名は、現行形式としても旧形式としても通らない。
//   3. 旧形式は LEGACY_MESSAGE_ACCEPT_UNTIL まで受理し、以後は
//      `legacy_expired`（＝ API 上は signature_message_legacy_expired）で拒否。
//      時計は注入する——「今日は通るが来月落ちる」テストにしない。
//   4. 既存の防御（改行・制御文字の拒否、行数固定）は維持される。
//   5. disputes は reason の先頭 200 字を平文で畳み込む（ブラインド署名の解消）。
//      平文は 1 行に潰し、sha256 は原文全体に対して取る。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  LEGACY_MESSAGE_ACCEPT_UNTIL,
  matchSignatureForm,
  payeeMessage,
  agentPassportMessage,
  observatoryWatchMessage,
  legacyPayeeMessage,
  legacyAgentPassportMessage,
  legacyObservatoryWatchMessage,
} from "@/lib/verify-message";
import { x402AttestationMessage, legacyX402AttestationMessage } from "@/lib/chain/x402-verify";
import { disputeMessage, legacyDisputeMessage } from "@/lib/observatory/disputes";
import { contributionMessage, legacyContributionMessage } from "@/lib/observatory/contributions";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PK);
const WALLET = account.address;
const LOWER = WALLET.toLowerCase();
const ISSUED = "2026-09-05T12:00:00.000Z";
const ENDPOINT_ID = "11111111-2222-4333-8444-555555555555";
const TX = "0x" + "ab".repeat(32);

const BEFORE_DEADLINE = Date.parse("2026-09-20T23:59:59.000Z");
const AFTER_DEADLINE = Date.parse("2026-09-21T00:00:00.000Z");

// ---- 1. 互換期限そのもの ----------------------------------------------------

test("LEGACY_MESSAGE_ACCEPT_UNTIL は 2026-09-21T00:00:00Z（旧形式の受理期限）", () => {
  assert.equal(LEGACY_MESSAGE_ACCEPT_UNTIL, Date.parse("2026-09-21T00:00:00.000Z"));
});

// ---- 2. 5 面の現行実文（スナップショット） ----------------------------------

test("payeeMessage — vet402.com の名乗り・domain 行・10分窓の明示・資金は動かない旨", () => {
  assert.equal(
    payeeMessage(WALLET, "Acme Payments", "https://acme.example/x402", ISSUED),
    [
      "vet402.com — verified payee registration",
      "domain: vet402.com",
      `wallet: ${LOWER}`,
      "name: Acme Payments",
      "url: https://acme.example/x402",
      `issued: ${ISSUED} (valid 10 minutes)`,
      "This signature proves control of the wallet above. It moves no funds and grants no spending approval.",
    ].join("\n"),
  );
});

test("agentPassportMessage — 同じ名乗りと domain 行（対称の双子）", () => {
  assert.equal(
    agentPassportMessage(42n, WALLET, "Acme Agent", undefined, ISSUED),
    [
      "vet402.com — agent passport registration",
      "domain: vet402.com",
      "agentId: 42",
      `wallet: ${LOWER}`,
      "name: Acme Agent",
      `issued: ${ISSUED} (valid 10 minutes)`,
      "This signature proves control of the wallet above. It moves no funds and grants no spending approval.",
    ].join("\n"),
  );
});

test("observatoryWatchMessage — 名乗りを vet402.com へ統一（旧: vet402 observatory …）", () => {
  assert.equal(
    observatoryWatchMessage(WALLET, "key_123"),
    [
      "vet402.com — observatory watch registration",
      "domain: vet402.com",
      `wallet: ${LOWER}`,
      "apiKey: key_123",
      "This signature authorizes delisting notifications for endpoints paying the wallet above. It moves no funds.",
    ].join("\n"),
  );
});

test("x402AttestationMessage — 署名の結果（公開スコアに算入）を本文に書く", () => {
  assert.equal(
    x402AttestationMessage(WALLET, TX),
    [
      "vet402.com — x402 settlement attestation",
      "domain: vet402.com",
      `wallet: ${LOWER}`,
      `tx: ${TX}`,
      "Effect: this settlement will be counted toward the public score of the wallet above on vet402.com.",
      "This signature moves no funds.",
    ].join("\n"),
  );
});

test("contributionMessage — コロン区切りの塊から人間可読の改行区切りへ", () => {
  assert.equal(
    contributionMessage({
      endpointId: ENDPOINT_ID,
      verdict: "pass",
      httpStatus: 402,
      latencyMs: 120,
      issued: ISSUED,
    }),
    [
      "vet402.com — external observation",
      "domain: vet402.com",
      `endpoint: ${ENDPOINT_ID}`,
      "verdict: pass",
      "http status: 402",
      "latency: 120 ms",
      `issued: ${ISSUED} (valid 10 minutes)`,
      "Recorded in the public ledger. Not counted in the published verdict (v0).",
    ].join("\n"),
  );
});

test("contributionMessage — 未報告の status / latency も決定的な 1 語で表す", () => {
  const msg = contributionMessage({
    endpointId: ENDPOINT_ID,
    verdict: "unverified",
    httpStatus: null,
    latencyMs: null,
    issued: ISSUED,
  });
  assert.ok(msg.includes("\nhttp status: not reported\n"));
  assert.ok(msg.includes("\nlatency: not reported\n"));
});

test("disputeMessage — 主張の先頭 200 字が平文で読め、sha256 は原文全体", () => {
  const reason = "Your probe hit our maintenance window.";
  assert.equal(
    disputeMessage({ endpointId: ENDPOINT_ID, subject: "l0", reason, issued: ISSUED }),
    [
      "vet402.com — measurement dispute",
      "domain: vet402.com",
      `endpoint: ${ENDPOINT_ID}`,
      "subject: l0",
      `reason (first 200 chars): ${reason}`,
      `reason sha256: ${createHash("sha256").update(reason, "utf8").digest("hex")}`,
      `issued: ${ISSUED} (valid 10 minutes)`,
      "Filing this will trigger a re-measurement whose result is published, including if it confirms the original verdict.",
    ].join("\n"),
  );
});

test("disputeMessage — 200 字で切り、sha256 は切る前の原文に対して取る", () => {
  const reason = "x".repeat(500);
  const msg = disputeMessage({ endpointId: ENDPOINT_ID, subject: "l0", reason, issued: ISSUED });
  assert.ok(msg.includes(`reason (first 200 chars): ${"x".repeat(200)}\n`));
  assert.equal(msg.includes("x".repeat(201)), false);
  assert.ok(msg.includes(`reason sha256: ${createHash("sha256").update(reason, "utf8").digest("hex")}`));
});

// ---- 3. 行数固定は保たれる（改行注入の防御は本文が伸びても効く） --------------

test("reason の改行・制御文字は 1 行に潰され、行を偽造できない", () => {
  const reason = "line one\nissued: 1999-01-01T00:00:00.000Z\r\ndomain: evil.example";
  const msg = disputeMessage({ endpointId: ENDPOINT_ID, subject: "l0", reason, issued: ISSUED });
  // 固定 8 行のまま——reason が何行に見えても署名対象の構造は動かない。
  assert.equal(msg.split("\n").length, 8);
  const reasonLine = msg.split("\n").find((l) => l.startsWith("reason (first 200 chars): "))!;
  // 制御文字（C0/C1）が 1 文字も残らない——潰した結果が「見えない改行」でもない。
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(reasonLine), false);
  // 偽の issued 行 / domain 行が独立した行として現れない。
  assert.equal(msg.split("\n").filter((l) => l.startsWith("issued: ")).length, 1);
  assert.equal(msg.split("\n").filter((l) => l.startsWith("domain: ")).length, 1);
});

test("非正規の name / url / issued は現行形式でも従来どおり拒否される", () => {
  assert.throws(() => payeeMessage(WALLET, "Acme\nwallet: 0xEVIL"));
  assert.throws(() => payeeMessage(WALLET, "Acme", "https://a.example\ndomain: evil.example"));
  assert.throws(() => payeeMessage(WALLET, "Acme", undefined, "garbage"));
  assert.throws(() => agentPassportMessage(1n, WALLET, "Acme\ndomain: evil.example"));
});

// ---- 4. 全面の共通不変条件 --------------------------------------------------

const CURRENT_MESSAGES: Record<string, string> = {
  payee: payeeMessage(WALLET, "Acme", undefined, ISSUED),
  agent: agentPassportMessage(1n, WALLET, "Acme", undefined, ISSUED),
  watch: observatoryWatchMessage(WALLET, "key_1"),
  x402: x402AttestationMessage(WALLET, TX),
  contribution: contributionMessage({
    endpointId: ENDPOINT_ID,
    verdict: "pass",
    httpStatus: 200,
    latencyMs: 1,
    issued: ISSUED,
  }),
  dispute: disputeMessage({ endpointId: ENDPOINT_ID, subject: "l0", reason: "r", issued: ISSUED }),
};

test("5 面すべてが 1 行目 `vet402.com — …` と 2 行目 `domain: vet402.com` を持つ", () => {
  for (const [surface, message] of Object.entries(CURRENT_MESSAGES)) {
    const lines = message.split("\n");
    assert.ok(lines[0]!.startsWith("vet402.com — "), `${surface}: 1 行目が名乗りでない: ${lines[0]}`);
    assert.equal(lines[1], "domain: vet402.com", `${surface}: 2 行目が domain 行でない`);
  }
});

test("issued を含む面は 10 分窓を本文で明示する", () => {
  for (const surface of ["payee", "agent", "contribution", "dispute"] as const) {
    const line = CURRENT_MESSAGES[surface]!.split("\n").find((l) => l.startsWith("issued: "))!;
    assert.ok(line.endsWith(" (valid 10 minutes)"), `${surface}: 有効期限が本文に無い`);
  }
});

// ---- 5. 旧形式のスナップショット（凍結） ------------------------------------

test("旧形式ビルダーは 2026-09-05 以前の実文をそのまま再現する", () => {
  assert.equal(
    legacyPayeeMessage(WALLET, "Acme Payments", "https://acme.example/x402", ISSUED),
    [
      "Vouch verified payee registration",
      `wallet: ${LOWER}`,
      "name: Acme Payments",
      "url: https://acme.example/x402",
      `issued: ${ISSUED}`,
      "This signature only proves control of the wallet above.",
    ].join("\n"),
  );
  assert.equal(
    legacyAgentPassportMessage(42n, WALLET, "Acme Agent"),
    [
      "Vouch agent passport registration",
      "agentId: 42",
      `wallet: ${LOWER}`,
      "name: Acme Agent",
      "This signature only proves control of the wallet above.",
    ].join("\n"),
  );
  assert.equal(
    legacyObservatoryWatchMessage(WALLET, "key_123"),
    [
      "vet402 observatory watch registration",
      `wallet: ${LOWER}`,
      "apiKey: key_123",
      "This signature authorizes delisting notifications for endpoints paying the wallet above.",
    ].join("\n"),
  );
  assert.equal(
    legacyX402AttestationMessage(WALLET, TX),
    [
      "Vouch x402 settlement attestation",
      `wallet: ${LOWER}`,
      `tx: ${TX}`,
      "This signature only proves control of the wallet above for this settlement.",
    ].join("\n"),
  );
  assert.equal(
    legacyContributionMessage({
      endpointId: ENDPOINT_ID,
      verdict: "pass",
      httpStatus: 402,
      latencyMs: 120,
      issued: ISSUED,
    }),
    `vet402:contribution:v1:${ENDPOINT_ID}:pass:402:120:${ISSUED}`,
  );
  assert.equal(
    legacyDisputeMessage({ endpointId: ENDPOINT_ID, subject: "l0", reason: "r", issued: ISSUED }),
    `vet402:dispute:v1:${ENDPOINT_ID}:l0:${createHash("sha256").update("r", "utf8").digest("hex")}:${ISSUED}`,
  );
});

// ---- 6. 受理と失効（時計は注入する） ----------------------------------------

test("現行形式の署名は期限の前後どちらでも current として通る", async () => {
  const current = payeeMessage(WALLET, "Acme", undefined, ISSUED);
  const signature = await account.signMessage({ message: current });
  for (const now of [BEFORE_DEADLINE, AFTER_DEADLINE]) {
    assert.deepEqual(
      await matchSignatureForm({
        address: WALLET,
        signature,
        current,
        legacy: legacyPayeeMessage(WALLET, "Acme", undefined, ISSUED),
        now,
      }),
      { matched: "current" },
    );
  }
});

test("旧形式の署名は期限内は legacy として受理される", async () => {
  const legacy = legacyPayeeMessage(WALLET, "Acme", undefined, ISSUED);
  const signature = await account.signMessage({ message: legacy });
  assert.deepEqual(
    await matchSignatureForm({
      address: WALLET,
      signature,
      current: payeeMessage(WALLET, "Acme", undefined, ISSUED),
      legacy,
      now: BEFORE_DEADLINE,
    }),
    { matched: "legacy" },
  );
});

test("旧形式の署名は期限後 legacy_expired（無言の mismatch にしない）", async () => {
  const legacy = legacyPayeeMessage(WALLET, "Acme", undefined, ISSUED);
  const signature = await account.signMessage({ message: legacy });
  assert.deepEqual(
    await matchSignatureForm({
      address: WALLET,
      signature,
      current: payeeMessage(WALLET, "Acme", undefined, ISSUED),
      legacy,
      now: AFTER_DEADLINE,
    }),
    { matched: "legacy_expired" },
  );
});

test("domain 行の無い自作本文への署名は現行でも旧形式でも通らない", async () => {
  const current = payeeMessage(WALLET, "Acme", undefined, ISSUED);
  const forged = current
    .split("\n")
    .filter((l) => l !== "domain: vet402.com")
    .join("\n");
  const signature = await account.signMessage({ message: forged });
  assert.deepEqual(
    await matchSignatureForm({
      address: WALLET,
      signature,
      current,
      legacy: legacyPayeeMessage(WALLET, "Acme", undefined, ISSUED),
      now: BEFORE_DEADLINE,
    }),
    { matched: "none" },
  );
});

test("署名が無い・壊れている場合は none（fail-closed）", async () => {
  const current = payeeMessage(WALLET, "Acme", undefined, ISSUED);
  const legacy = legacyPayeeMessage(WALLET, "Acme", undefined, ISSUED);
  for (const signature of [undefined, null, "", "0xdeadbeef"]) {
    assert.deepEqual(
      await matchSignatureForm({ address: WALLET, signature, current, legacy, now: BEFORE_DEADLINE }),
      { matched: "none" },
    );
  }
});

test("他人の鍵の署名は通らない（面が変わっても所有証明であることは変わらない）", async () => {
  const other = privateKeyToAccount(`0x${"7".repeat(64)}`);
  const current = payeeMessage(WALLET, "Acme", undefined, ISSUED);
  const signature = await other.signMessage({ message: current });
  assert.deepEqual(
    await matchSignatureForm({
      address: WALLET,
      signature,
      current,
      legacy: legacyPayeeMessage(WALLET, "Acme", undefined, ISSUED),
      now: BEFORE_DEADLINE,
    }),
    { matched: "none" },
  );
});
