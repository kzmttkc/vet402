// ============================================================
// 既公開 fail の訂正（2026-09-02 監査 A1・scripts/correct-path-template-fails.ts）。
//
// 対象の判定ロジックだけを DB 無しで固定する: 公開判定が fail（直近 2 プローブが
// fail,fail）かつパステンプレート URL の endpoint だけが訂正対象。
// unverified / pass のもの、テンプレートでないものは触らない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectPathTemplateCorrections,
  correctionPayload,
} from "@/lib/observatory/path-template-correction";

const T = "https://ph.example/v1/entreprise/:siren";
const N = "https://ok.example/v1/quote";

test("公開 fail かつテンプレート URL だけを選ぶ", () => {
  const picked = selectPathTemplateCorrections([
    { id: "a", resourceUrl: T, verdictsNewestFirst: ["fail", "fail"] },
    { id: "b", resourceUrl: T, verdictsNewestFirst: ["fail", "fail", "pass"] },
    { id: "c", resourceUrl: N, verdictsNewestFirst: ["fail", "fail"] },
  ]);
  assert.deepEqual(
    picked.map((r) => r.id),
    ["a", "b"],
  );
});

test("公開判定が fail でないテンプレート URL は対象外（unverified / pass / 単発 fail）", () => {
  const picked = selectPathTemplateCorrections([
    { id: "single", resourceUrl: T, verdictsNewestFirst: ["fail", "pass"] },
    { id: "pass", resourceUrl: T, verdictsNewestFirst: ["pass", "fail"] },
    { id: "unv", resourceUrl: T, verdictsNewestFirst: ["unverified", "fail"] },
    { id: "already", resourceUrl: T, verdictsNewestFirst: ["unverified", "fail", "fail"] },
    { id: "none", resourceUrl: T, verdictsNewestFirst: [] },
  ]);
  assert.deepEqual(picked, []);
});

test("訂正ペイロード: subject=endpoint / level=l0 / fail → unverified / reason=path_template", () => {
  const p = correctionPayload({ id: "a", resourceUrl: T, verdictsNewestFirst: ["fail", "fail"] });
  assert.equal(p.subjectType, "endpoint");
  assert.equal(p.subjectId, "a");
  assert.equal(p.level, "l0");
  assert.equal(p.reason, "path_template");
  assert.deepEqual(p.before, { publishedVerdict: "fail" });
  assert.equal((p.after as { publishedVerdict: string }).publishedVerdict, "unverified");
  assert.equal((p.after as { failReason: string }).failReason, "path_template");
  assert.match((p.after as { note: string }).note, /:siren/);
});
