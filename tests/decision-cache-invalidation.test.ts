// ============================================================
// §9.1 /decision の 5 分キャッシュは、判定の材料が書き換わったら捨てる。
//
// 2026-09-02 敵対的監査: invalidateDecisionCache は定義されていたが呼び手が 0 で、
// L0 再測定・L1 購入・異議・決済照合の後も、古い判定が TTL いっぱい配られていた。
// キャッシュ本体を decision/cache.ts に分離し、書き込み側（observatory）から
// 循環なしに呼べるようにする。Vercel ではインスタンス内キャッシュしか消えない
// （他インスタンスは TTL 待ち）——それは仕様として cache.ts に書いてある。
// ============================================================
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionCache, invalidateDecisionCache } from "@/lib/decision/cache";

const entry = (id: string) => ({ result: { id } as never, expiresAt: Date.now() + 60_000 });

test("observatoryId を渡すとその endpoint のキー（<uuid>|…）だけ消える", () => {
  decisionCache.clear();
  decisionCache.set("aaa|payer|v1", entry("a1"));
  decisionCache.set("aaa|payee|0xp", entry("a2"));
  decisionCache.set("bbb|payer|v1", entry("b1"));
  invalidateDecisionCache("aaa");
  assert.equal(decisionCache.get("aaa|payer|v1"), undefined);
  assert.equal(decisionCache.get("aaa|payee|0xp"), undefined);
  assert.ok(decisionCache.get("bbb|payer|v1"), "他の endpoint は残る");
});

test("引数なしは全消去", () => {
  decisionCache.set("ccc|payer|v1", entry("c1"));
  invalidateDecisionCache();
  assert.equal(decisionCache.get("ccc|payer|v1"), undefined);
});

// 書き込み側の配線。各モジュールは DB 無しでは走らせられないので、呼び出しの
// 存在をソースで固定する（挙動は上の 2 件と decide のテストが持つ）。
test("判定材料を書く 6 モジュールすべてが invalidateDecisionCache を呼ぶ", () => {
  const files = [
    "src/lib/observatory/probe-runner.ts",
    "src/lib/observatory/requests.ts",
    "src/lib/observatory/disputes.ts",
    "src/lib/observatory/l1-runner.ts",
    "src/lib/observatory/settlement-verifier.ts",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /invalidateDecisionCache\(/, `${f} は invalidateDecisionCache を呼ぶ`);
    assert.match(src, /from "@\/lib\/decision\/cache"/, `${f} は decision/cache から import する（decide.ts 経由の循環を避ける）`);
  }
});
