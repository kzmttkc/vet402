// 厳守3「秘密を出力に出さない。混入しないことを固定するテストを書く」
import test from "node:test";
import assert from "node:assert/strict";
import { findSecrets, assertNoSecrets, SECRET_ENV_NAMES } from "../src/secrets.mjs";

test("見張る環境変数名に、鍵として実在する3種が入っている", () => {
  for (const n of ["GRAPH_API_KEY", "VOUCH_API_KEY", "ANTHROPIC_API_KEY"]) {
    assert.ok(SECRET_ENV_NAMES.includes(n), n);
  }
});

test("環境変数の『値』が本文に出たら検出する（名前ではなく値）", () => {
  const env = { GRAPH_API_KEY: "abcdef0123456789abcdef0123456789" };
  const hits = findSecrets(`gateway.thegraph.com/api/${env.GRAPH_API_KEY}/subgraphs`, env);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "GRAPH_API_KEY");
});

test("環境変数名そのものは秘密ではない（$GRAPH_API_KEY と書くのは正しい書き方）", () => {
  assert.deepEqual(findSecrets("use $GRAPH_API_KEY here", { GRAPH_API_KEY: "abcdef0123456789abcdef0123456789" }), []);
});

test("短すぎる値は照合しない（'1' や 'true' で全文が秘密になる誤検知を防ぐ）", () => {
  assert.deepEqual(findSecrets("everything is true", { VOUCH_API_KEY: "true" }), []);
});

test("環境変数に無くても、形で分かる秘密は検出する（秘密鍵・sk- 鍵）", () => {
  const pk = "0x" + "a1".repeat(32);
  assert.equal(findSecrets(`key=${pk}`, {}).length, 1);
  assert.equal(findSecrets("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", {}).length, 1);
});

test("40桁のウォレットアドレスは秘密ではない（フィクスチャが全部落ちる）", () => {
  assert.deepEqual(findSecrets("0x36038e1d712c5e39f35952164ec58ec2b96caee7", {}), []);
});

test("assertNoSecrets はオブジェクトを丸ごと走査して投げる", () => {
  const env = { VOUCH_API_KEY: "vk_live_0123456789abcdef" };
  assert.throws(
    () => assertNoSecrets({ meta: { nested: [{ prompt: `x ${env.VOUCH_API_KEY} y` }] } }, env),
    /VOUCH_API_KEY/,
  );
});

test("assertNoSecrets は秘密が無ければ何もしない", () => {
  assertNoSecrets({ a: "hello", b: [1, 2, null], c: { d: "0x36038e1d712c5e39f35952164ec58ec2b96caee7" } }, {});
});

test("投げるメッセージに秘密の値そのものを載せない", () => {
  const env = { VOUCH_API_KEY: "vk_live_0123456789abcdef" };
  try {
    assertNoSecrets({ p: env.VOUCH_API_KEY }, env);
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(e.message.includes("vk_live_0123456789abcdef"), false);
    assert.ok(e.message.includes("VOUCH_API_KEY"));
  }
});
