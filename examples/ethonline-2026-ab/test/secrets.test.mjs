// 厳守3「秘密を出力に出さない。混入しないことを固定するテストを書く」
import test from "node:test";
import assert from "node:assert/strict";
import { findSecrets, assertNoSecrets, SECRET_ENV_NAMES, PUBLIC_HEX_ALLOWLIST } from "../src/secrets.mjs";

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

// ---- 2026-09-06: 「64桁hex は全部秘密」をやめる。ただし弱めない。 ----
// 形だけでは txHash と秘密鍵を区別できない。区別できるのは**その値そのもの**なので、
// **公開済みだと人が確かめて明示的に載せた値だけ**を許し、それ以外の 64桁hex は今まで通り止める。

test("公開済みの決済 txHash は秘密ではない（許可リストに載っている値だけ）", () => {
  for (const entry of PUBLIC_HEX_ALLOWLIST) {
    assert.deepEqual(findSecrets(`txHash ${entry.value}`, {}), [], entry.value);
  }
});

test("許可リストの各項目は『どこで公開されているか』を持つ（黙って値を増やせない）", () => {
  assert.ok(PUBLIC_HEX_ALLOWLIST.length > 0);
  for (const entry of PUBLIC_HEX_ALLOWLIST) {
    assert.match(entry.value, /^0x[0-9a-fA-F]{64}$/);
    assert.match(entry.provenance, /^https?:\/\//);
    assert.ok(entry.why.length > 0);
  }
});

test("許可リストに無い 64桁hex は今まで通り秘密として止める", () => {
  const notListed = "0x" + "9f".repeat(32);
  const hits = findSecrets(`key=${notListed}`, {});
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "private-key-like");
});

test("txHash という語を添えても許可されない（文脈の偽装で素通りさせない）", () => {
  const notListed = "0x" + "7c".repeat(32);
  for (const framing of [
    `txHash: ${notListed}`,
    `transaction hash ${notListed}`,
    `https://basescan.org/tx/${notListed}`,
    `[\`0x7c7c…7c7c\`](https://basescan.org/tx/${notListed})`,
  ]) {
    assert.equal(findSecrets(framing, {}).length, 1, framing);
  }
});

test("許可リストの値でも、実際の秘密環境変数と一致するなら止める（許可リストが穴にならない）", () => {
  const entry = PUBLIC_HEX_ALLOWLIST[0];
  const env = { DEMO_PAYER_PRIVATE_KEY: entry.value };
  const hits = findSecrets(`x ${entry.value} y`, env);
  assert.ok(hits.length >= 1, "環境変数の実値と一致したのに素通りした");
  assert.ok(hits.some((h) => h.name === "DEMO_PAYER_PRIVATE_KEY"));
});

test("見張る環境変数名にデモ支払い鍵が入っている（examples/ethonline-2026-demo が実際に使う名前）", () => {
  assert.ok(SECRET_ENV_NAMES.includes("DEMO_PAYER_PRIVATE_KEY"));
});
