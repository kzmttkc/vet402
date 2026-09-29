// ============================================================
// 2026-09-29 敵対的監査 4 周目（障害対応）: L1 の「こちら側の失敗」を売り手の失敗として
// 記録しない・未署名の予約を DB 不通で取り残さない、の純関数と非 DB 部分。
// DB を使う配線は l1-kill-switch.pg.test.ts / l1-reservation-resolution.pg.test.ts /
// observatory-l1-orphan-sweep.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { paidTransportFailureSide, releaseUnsignedReservation, transportErrorCode } from "@/lib/observatory/l1-runner";

const wrapped = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

test("transportErrorCode: undici の cause の中まで見る", () => {
  assert.equal(transportErrorCode(wrapped("EMFILE")), "EMFILE");
  assert.equal(transportErrorCode(Object.assign(new Error("x"), { code: "ENOBUFS" })), "ENOBUFS");
  assert.equal(transportErrorCode(new Error("no code")), null);
  assert.equal(transportErrorCode(null), null);
  assert.equal(transportErrorCode("string error"), null);
});

test("paidTransportFailureSide: 機械の中にしか原因が無い errno だけが vet402 側", () => {
  for (const code of ["EMFILE", "ENFILE", "ENOBUFS", "ENOMEM"]) {
    assert.equal(paidTransportFailureSide(wrapped(code)), "vet402", code);
  }
});

test("paidTransportFailureSide: 売り手が起こせる形は seller_or_path（W-4: 観測を台帳から消せる道を作らない）", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "ENETDOWN", "EADDRNOTAVAIL"]) {
    assert.equal(paidTransportFailureSide(wrapped(code)), "seller_or_path", code);
  }
  assert.equal(paidTransportFailureSide(new DOMException("aborted", "AbortError")), "seller_or_path", "タイムアウトは売り手の遅さ");
  assert.equal(paidTransportFailureSide(new Error("unsafe outbound target (unsafe_host): x")), "seller_or_path");
  assert.equal(paidTransportFailureSide(null), "seller_or_path");
});

test("releaseUnsignedReservation: DB が投げ続けても投げ返さず false（行は孤児掃除へ）", async () => {
  let calls = 0;
  const db = {
    update: () => {
      calls++;
      throw new Error("connect ECONNREFUSED");
    },
  } as unknown as Parameters<typeof releaseUnsignedReservation>[0];
  const ok = await releaseUnsignedReservation(db, "00000000-0000-0000-0000-000000000000", { status: "halted", rawResponseMeta: {} }, [0, 1, 1]);
  assert.equal(ok, false);
  assert.equal(calls, 3, "決めた回数だけ試す");
});

test("releaseUnsignedReservation: 一時的な失敗は再試行で戻す", async () => {
  let calls = 0;
  const chain = { set: () => chain, where: async () => undefined };
  const db = {
    update: () => {
      calls++;
      if (calls === 1) throw new Error("connection terminated");
      return chain;
    },
  } as unknown as Parameters<typeof releaseUnsignedReservation>[0];
  assert.equal(await releaseUnsignedReservation(db, "00000000-0000-0000-0000-000000000000", { status: "halted", rawResponseMeta: {} }, [0, 1]), true);
  assert.equal(calls, 2);
});
