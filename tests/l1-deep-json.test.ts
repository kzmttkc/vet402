// ============================================================
// 深く入れ子にした 402（2026-11-02 資金経路の監査 M-1・L-1）。DB なしの部分。
//
// 守ること:
//  1. 深さの上限を超えた JSON は読めない 402 として扱う（ヘッダーでも本文でも）。上限以内は今までどおり読む。
//  2. 台帳へ書く前の掃除（pgSafeJson・購入の証拠）は、どんな深さでも例外を出さない。超えた部分は印に置き換える。
//  3. 掃除で変えたら changed が立つ（台帳に印が残る）。
//  4. 書き込みが落ちても、売り手の文字列を外した最小の行を残す。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonTextDepthExceeds, MAX_SELLER_JSON_DEPTH } from "@/lib/observatory/json-depth";
import { parseChallenge, BASE_USDC } from "@/lib/observatory/x402-payer";
import { insertRecordOrMinimal, pgSafeJson, pgSafeJsonChanged } from "@/lib/observatory/l1-runner";
import { x402ChallengeEvidence, capPurchaseEvidence } from "@/lib/observatory/purchase-evidence";

const deepText = (n: number) => `${"[".repeat(n)}${"]".repeat(n)}`;
const deepValue = (n: number): unknown => JSON.parse(deepText(n));
const challengeText = (extra: string) =>
  `{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:8453","amount":"1000","asset":"${BASE_USDC}","payTo":"0x${"11".repeat(20)}","extra":${extra}}]}`;

test("jsonTextDepthExceeds: 文字列の中の括弧は数えない・閉じれば減る・ちょうどは通す", () => {
  assert.equal(jsonTextDepthExceeds(deepText(5), 5), false);
  assert.equal(jsonTextDepthExceeds(deepText(6), 5), true);
  assert.equal(jsonTextDepthExceeds(`{"a":"${"[".repeat(100)}"}`, 5), false);
  assert.equal(jsonTextDepthExceeds(`{"a":"\\"[[[[[[[[[["}`, 5), false);
  assert.equal(jsonTextDepthExceeds(`[[1],[2],[3],[4],[5],[6],[7]]`, 2), false);
  assert.equal(jsonTextDepthExceeds(`{"a":{"b":{"c":1}}}`, 2), true);
  assert.equal(jsonTextDepthExceeds("not json", 2), false);
});

test("parseChallenge: 深さの上限を超えた本文とヘッダーは読めない 402", () => {
  const ok = parseChallenge({ bodyText: challengeText(`{"name":"USD Coin","version":"2"}`), headers: new Headers() });
  assert.ok(ok);
  for (const depth of [MAX_SELLER_JSON_DEPTH + 1, 3000, 5000, 100_000]) {
    const body = challengeText(deepText(depth));
    assert.equal(parseChallenge({ bodyText: body, headers: new Headers() }), null, `body ${depth}`);
    const header = Buffer.from(body, "utf8").toString("base64");
    assert.equal(parseChallenge({ bodyText: "", headers: new Headers({ "PAYMENT-REQUIRED": header }) }), null, `header ${depth}`);
  }
  // 上限ちょうど（文書の外側 3 段ぶんを引く）は読める。
  const atLimit = parseChallenge({ bodyText: challengeText(deepText(MAX_SELLER_JSON_DEPTH - 3)), headers: new Headers() });
  assert.ok(atLimit);
  // ヘッダーが深くても本文が読めれば本文で読む（今までの「ヘッダーが読めなければ本文」と同じ）。
  const header = Buffer.from(challengeText(deepText(3000)), "utf8").toString("base64");
  assert.ok(parseChallenge({ bodyText: challengeText("{}"), headers: new Headers({ "PAYMENT-REQUIRED": header }) }));
});

test("pgSafeJson: どんな深さでも落ちず、超えた部分を印に置き換えて changed を立てる", () => {
  for (const depth of [100, 3000, 5000, 200_000]) {
    const v = { keep: "a", deep: deepValue(depth) };
    const r = pgSafeJsonChanged(v);
    assert.equal(r.changed, true, `depth ${depth}`);
    assert.equal((r.value as { keep: string }).keep, "a");
    assert.doesNotThrow(() => JSON.stringify(r.value));
    assert.ok(JSON.stringify(r.value).length < 2000, "the kept value is small");
    assert.doesNotThrow(() => pgSafeJson(v));
  }
  const shallow = pgSafeJsonChanged({ a: [{ b: "x" }], d: 1, n: null });
  assert.equal(shallow.changed, false);
  assert.deepEqual(shallow.value, { a: [{ b: "x" }], d: 1, n: null });
  const nul = pgSafeJsonChanged({ a: "x\u0000y" });
  assert.equal(nul.changed, true);
  assert.deepEqual(nul.value, { a: "xy" });
});

test("購入の証拠: 深い本文でも列が印だけにならない", () => {
  const headers = new Headers({
    "PAYMENT-REQUIRED": Buffer.from(challengeText("{}"), "utf8").toString("base64"),
  });
  // ヘッダーで読めた 402 の本文が深い形。文書はヘッダーのものが残る。
  const ev = x402ChallengeEvidence({ httpStatus: 402, headers, bodyText: deepText(3000) });
  assert.equal(ev.source, "header");
  assert.doesNotThrow(() => capPurchaseEvidence(ev, "document"));
  // 本文だけの深い 402（読めない）。本文の文字列が残り、source は null。
  const ev2 = x402ChallengeEvidence({ httpStatus: 402, headers: new Headers(), bodyText: challengeText(deepText(3000)) });
  assert.equal(ev2.source, null);
  const capped = capPurchaseEvidence(ev2, "bodyText");
  assert.equal(capped.httpStatus, 402);
  // 組み立てる側に深い値が来ても例外にせず、残りの列を残す（支払いペイロードに売り手の extra が写る形）。
  const built = capPurchaseEvidence({ v: 1, keep: "yes", accepted: { extra: deepValue(5000) } }, "accepted");
  assert.equal(built.keep, "yes");
  assert.doesNotThrow(() => JSON.stringify(built));
});

test("insertRecordOrMinimal: 1 回目の書き込みが落ちたら売り手の文字列を外した行を書く", async () => {
  const writes: Record<string, unknown>[] = [];
  let failNext = true;
  const db = {
    insert() {
      return {
        values: async (v: Record<string, unknown>) => {
          if (failNext) {
            failNext = false;
            throw new Error("22P05 unsupported Unicode escape sequence");
          }
          writes.push(v);
        },
      };
    },
  };
  await insertRecordOrMinimal(db as never, { endpointId: "e", status: "price_mismatch", payer: "p", payTo: "x\u0000", rawResponseMeta: { a: "seller text" } }, { selection: "census" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, "price_mismatch");
  assert.equal(writes[0].endpointId, "e");
  assert.equal("payTo" in writes[0], false);
  assert.deepEqual(writes[0].rawResponseMeta, { selection: "census", phase: "record", reason: "record_write_failed" });
  // 2 回目も落ちたら投げる（DB 障害を握りつぶさない）。
  const dead = { insert: () => ({ values: async () => { throw new Error("down"); } }) };
  await assert.rejects(insertRecordOrMinimal(dead as never, { endpointId: "e", status: "x", payer: "p" }, null));
});
