// ============================================================
// x402_l0_probes の raw_response_meta.bodyHead は保存の前に伏せる（2026-11-02 監査 L7）。
// 売り手の応答には資格情報の形の接続文字列が入ることがある。判定は本文全部で行い、記録だけ伏せる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeEndpoint, type ProbeTarget } from "@/lib/observatory/l0-probe";
import { redactCredentials, redactUrls } from "@/lib/observatory/redact";

const STELLAR_SEED = `S${"A".repeat(55)}`;

const target = (): ProbeTarget => ({
  resourceUrl: "https://seller.example/api",
  method: "GET",
  payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
  network: "eip155:8453",
  priceAmount: "3000",
  priceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
});

const respond = (status: number, body: string) =>
  async () => new Response(body, { status, headers: { "content-type": "text/plain" } });

test("redactUrls は資格情報の形の接続文字列を scheme によらず伏せる", () => {
  for (const dsn of [
    "postgres://u:p@h/d",
    "mysql://u:p@h/d",
    "mariadb://u:p@h/d",
    "mongodb://u:p@h/d",
    "mongodb+srv://u:p@h/d",
    "redis://u:p@h:6379",
    "rediss://u:p@h:6379",
    "amqp://u:p@h",
    "amqps://u:p@h",
    "https://key@sentry.example/1",
  ]) {
    assert.equal(redactUrls(`a ${dsn} b`), "a <url> b", dsn);
  }
});

test("redactCredentials は URL と Stellar の seed を伏せ、切らない。他の文字はそのまま", () => {
  const long = "x".repeat(800);
  assert.equal(redactCredentials(`${long} ${STELLAR_SEED} postgres://u:p@h/d {"error":"boom"}`), `${long} <stellar-secret> <url> {"error":"boom"}`);
});

test("L0 の bodyHead に接続文字列も seed も残らない。伏せても 500 文字を超えない", async () => {
  for (const body of [
    `error: connect postgres://admin:hunter2@db.internal:5432/app failed`,
    `Traceback mongodb+srv://root:hunter2@cluster.example/app`,
    `seed ${STELLAR_SEED} leaked`,
    `${"y".repeat(480)} postgres://admin:hunter2@db.internal:5432/app`,
  ]) {
    const result = await probeEndpoint(target(), { fetchImpl: respond(500, body) });
    const head = (result.rawResponseMeta as { bodyHead: string }).bodyHead;
    assert.doesNotMatch(head, /hunter2/, body);
    assert.ok(!head.includes(STELLAR_SEED), body);
    assert.ok(head.length <= 500);
  }
});

test("500 文字の境目にまたがる seed も接続文字列も、先に伏せてから切るので先頭が残らない", async () => {
  for (const [body, leaked] of [
    [`${"y".repeat(450)} ${STELLAR_SEED}`, STELLAR_SEED.slice(0, 30)],
    [`${"y".repeat(450)} postgres://admin:hunter2@db.internal:5432/app`, "postgres://"],
  ] as const) {
    const result = await probeEndpoint(target(), { fetchImpl: respond(500, body) });
    const head = (result.rawResponseMeta as { bodyHead: string }).bodyHead;
    assert.ok(!head.includes(leaked), head.slice(440));
    assert.ok(head.length <= 500);
  }
});

test("圧縮 JSON の続きを飲み込まない。スキームは決め打ちにしない", () => {
  assert.equal(redactUrls(`{"dsn":"postgres://u:p@h/d","next":"keep"}`), `{"dsn":"<url>","next":"keep"}`);
  assert.equal(redactUrls(`<a href='https://h/k'>x</a>`), `<a href='<url>>x</a>`);
  assert.equal(redactUrls("postgres://user:pa'ss@host/db"), "<url>");
  for (const dsn of ["sqlserver://u:p@h", "ftp://u:p@h/f", "clickhouse://u:p@h/d", "SFTP://u:p@h"]) {
    assert.equal(redactUrls(`a ${dsn} b`), "a <url> b", dsn);
  }
  assert.equal(redactUrls("ratio 1:2 and note: //comment"), "ratio 1:2 and note: //comment");
});

test("本文の大きさの記録と判定は伏せる前の本文のまま", async () => {
  const body = `postgres://admin:hunter2@db.internal:5432/app`;
  const result = await probeEndpoint(target(), { fetchImpl: respond(500, body) });
  assert.equal((result.rawResponseMeta as { bodyBytes: number }).bodyBytes, Buffer.byteLength(body));
  assert.equal(result.verdict, "fail");
});

test("本文の形で伏せ字の処理が遅くならない", () => {
  const started = performance.now();
  redactUrls("a.".repeat(32_000));
  assert.ok(performance.now() - started < 200);
});
