// 秘密が1文字も画面に出ないことの単体検査。
// この CLI は撮影で画面に映るので、これが最優先の関門（WINDOW_PLAN §6「撮影で画面に出してはいけないもの」）。
import test from "node:test";
import assert from "node:assert/strict";
import { collectSecrets, makeRedactor, GRAPH_KEY_PLACEHOLDER } from "../src/redact.ts";

test("環境変数に入っている秘密は、出力に現れる前に伏せられる", () => {
  const redact = makeRedactor(collectSecrets({
    GRAPH_API_KEY: "abcdef0123456789abcdef0123456789",
    VOUCH_API_KEY: "vk_live_9f8e7d6c5b4a39281706",
    DEMO_PAYER_PRIVATE_KEY: "0x" + "ab".repeat(32),
  }));
  const text = [
    "https://gateway.thegraph.com/api/abcdef0123456789abcdef0123456789/subgraphs/id/Cb56",
    "Authorization: Bearer vk_live_9f8e7d6c5b4a39281706",
    "key=" + "ab".repeat(32),
  ].join("\n");
  const out = redact(text);
  assert.equal(out.includes("abcdef0123456789abcdef0123456789"), false, "Graph の鍵が残っている");
  assert.equal(out.includes("vk_live_9f8e7d6c5b4a39281706"), false, "vet402 の鍵が残っている");
  assert.equal(out.includes("ab".repeat(32)), false, "秘密鍵が 0x 抜きでも残ってはいけない");
});

test("鍵が環境に無くても、Gateway の URL に載った鍵は伏せられる", () => {
  const redact = makeRedactor(collectSecrets({}));
  const out = redact("POST https://gateway.thegraph.com/api/deadbeefdeadbeefdeadbeef/subgraphs/id/Cb56");
  assert.equal(out.includes("deadbeefdeadbeefdeadbeef"), false);
  assert.match(out, new RegExp(`/api/${GRAPH_KEY_PLACEHOLDER}/subgraphs/`.replace(/[<>]/g, "\\$&")));
});

test("鍵ではない `x402` の経路は伏せない（存在する URL を壊さない）", () => {
  const redact = makeRedactor(collectSecrets({}));
  const url = "https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj";
  assert.equal(redact(url), url);
});

test("短い値は秘密として扱わない（`2` を伏せると出力が壊れる）", () => {
  const redact = makeRedactor(collectSecrets({ VOUCH_API_KEY: "2" }));
  assert.equal(redact("version 2"), "version 2");
});
