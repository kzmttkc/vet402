// ============================================================
// resource_id の別名の表（2026-09-29 監査 7 周目・高: URL の書き方しだいで BLOCK を素通りする）。
//
// SDK の payOrRefuse（凍結中）は resource_id = sha256("<METHOD> <生の URL>")。サーバの正規形と表記が
// 違うと /decision が 404 → SDK は「カタログ外」として受取人スコアで決めていた。別名の作り方
// （canonical.ts resourceUrlVariants / resourceIdAliases）をここの表で固定する。
// 揺れ: 末尾スラッシュ・ホストの大文字小文字・既定ポート・クエリの並び（＋掲載の生 URL）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalUrl, resourceId, resourceIdAliases, resourceUrlVariants } from "@/lib/ids/canonical";
import { aliasRowsFor } from "@/lib/resolve/aliases";

/** SDK の computeResourceId と同じ式（packages/sdk/src/pay-or-refuse.ts・凍結中なので写しで固定する）。 */
const sdkId = (method: string, url: string) => createHash("sha256").update(`${method} ${url}`, "utf8").digest("hex");

type Row = { listed: string; method: string; spellings: string[]; notAliases?: string[] };

/** 揺れの表。spellings の生の書き方を SDK が渡すと、正規の出品に届かなければならない。 */
const VARIANT_TABLE: Row[] = [
  {
    listed: "https://api.exa.ai/search",
    method: "POST",
    spellings: [
      "https://api.exa.ai/search/", // 末尾スラッシュ（監査の実例）
      "https://API.EXA.AI/search", // ホストの大文字
      "https://api.exa.ai:443/search", // 既定ポート
      "https://API.EXA.AI:443/search/", // 全部の組み合わせ
      "HTTPS://api.exa.ai/search", // スキームの大文字
      "https://api.exa.ai/search?", // 末尾の ?（空のクエリ）
      "https://api.exa.ai/search#", // 末尾の #（空の断片）
      "https://api.exa.ai/search//", // 末尾の //
      "https://api.exa.ai/search/?", // 末尾スラッシュ＋?
      "HTTPS://api.exa.ai/search/", // 末尾スラッシュ＋スキームの大文字
    ],
    notAliases: [
      // 持たない（方法論の「知られた制限」）: 掲載の書き方以外の大文字小文字の混在。MCP は /resolve で防ぐ
      "https://Api.Exa.ai/search",
      "https://api.exa.ai/SEARCH", // パスの大文字小文字は別の資源
      "http://api.exa.ai:80/search", // :80 は http の既定。http は正規形を持たない（掲載にならない）
      "https://api.exa.ai:8443/search", // 既定でないポートは別の資源
    ],
  },
  {
    listed: "https://e.example/x?a=1&b=2&c=3",
    method: "GET",
    spellings: [
      "https://e.example/x?b=2&a=1&c=3", // クエリの並び
      "https://e.example/x?c=3&b=2&a=1",
      "https://E.EXAMPLE:443/x/?c=3&a=1&b=2", // 並び＋末尾スラッシュ＋大文字＋既定ポート
    ],
  },
  {
    listed: "https://Root.Example/", // 掲載の生の書き方（混ざった大文字）とルートのスラッシュ
    method: "GET",
    spellings: ["https://root.example/", "https://Root.Example", "https://Root.Example/", "https://ROOT.EXAMPLE:443/"],
  },
  {
    listed: "https://port.example:8443/v1/q",
    method: "GET",
    spellings: ["https://port.example:8443/v1/q/", "https://PORT.EXAMPLE:8443/v1/q"],
    notAliases: ["https://port.example/v1/q", "https://port.example:443/v1/q"],
  },
];

for (const row of VARIANT_TABLE) {
  test(`別名: ${row.method} ${row.listed} の揺れは正規の出品に届く`, () => {
    const canonicalId = resourceId(row.method, row.listed);
    const aliases = new Set(resourceIdAliases(row.method, row.listed));
    for (const s of row.spellings) {
      const raw = sdkId(row.method, s);
      // 揺れの id が正規の id と同じなら別名は要らない（それも届く）
      assert.ok(raw === canonicalId || aliases.has(raw), `${s} は別名に無い`);
    }
    for (const s of row.notAliases ?? []) {
      assert.equal(aliases.has(sdkId(row.method, s)), false, `${s} は別の資源なのに別名にされた`);
    }
    assert.equal(aliases.has(canonicalId), false, "正規の id は別名に入れない");
  });
}

test("別名は全部、正規形が完全に同じになる書き方だけ（別の資源へ写らない）", () => {
  for (const row of VARIANT_TABLE) {
    const c = canonicalUrl(row.listed)!.url;
    for (const v of resourceUrlVariants(row.listed)) assert.equal(canonicalUrl(v)?.url, c, v);
  }
});

test("method も別名に入る: POST の揺れは GET の出品に届かない", () => {
  const get = new Set(resourceIdAliases("GET", "https://api.exa.ai/search"));
  assert.equal(get.has(sdkId("POST", "https://api.exa.ai/search/")), false);
  assert.equal(new Set(resourceIdAliases("post", "https://api.exa.ai/search")).has(sdkId("POST", "https://api.exa.ai/search/")), true);
});

test("別々の出品の別名は衝突しない（同じホストの隣の出品を含む）", () => {
  const listings = [
    ["POST", "https://api.exa.ai/search"],
    ["POST", "https://api.exa.ai/contents"],
    ["GET", "https://api.exa.ai/search"],
    ["GET", "https://e.example/x?a=1&b=2&c=3"],
    ["GET", "https://e.example/x?a=1&b=2"],
    ["GET", "https://root.example"],
  ] as const;
  const owner = new Map<string, string>();
  for (const [m, u] of listings) {
    const id = resourceId(m, u);
    for (const a of [id, ...resourceIdAliases(m, u)]) {
      const prev = owner.get(a);
      assert.ok(prev === undefined || prev === id, `${m} ${u} の別名が別の出品と衝突`);
      owner.set(a, id);
    }
  }
});

test("クエリの名前が上限を超えたら全順列にしない（正規の順と掲載の順だけ）", () => {
  const listed = "https://q.example/x?e=5&d=4&c=3&b=2&a=1";
  const vs = resourceUrlVariants(listed);
  assert.ok(vs.length < 40, `順列で膨らんでいる: ${vs.length}`);
  assert.ok(vs.includes(listed), "掲載の生 URL そのものは持つ");
  assert.ok(vs.includes("https://q.example/x/?e=5&d=4&c=3&b=2&a=1"));
});

test("癖はクエリのある URL にも 1 つずつ重なる（// はクエリの前・? は重ねない）", () => {
  const listed = "https://e.example/x?a=1&b=2";
  const aliases = new Set(resourceIdAliases("GET", listed));
  for (const s of ["HTTPS://e.example/x?b=2&a=1", "https://e.example/x//?a=1&b=2", "https://e.example/x?a=1&b=2#"]) assert.ok(aliases.has(sdkId("GET", s)), s);
});

test("可変のクエリの値は別名にしない（掲載に書かれた値そのもの以外）——知られた制限", () => {
  const listed = "https://s.example/x?sig=abc&q=1";
  assert.equal(resourceIdAliases("GET", listed).includes(sdkId("GET", "https://s.example/x?sig=zzz&q=1")), false);
});

test("掲載の生 URL の可変クエリ（sig 等）はそのまま別名になる（正規形では外れる）", () => {
  const listed = "https://s.example/x?sig=abc&q=1";
  assert.ok(resourceIdAliases("GET", listed).includes(sdkId("GET", listed)));
});

test("aliasRowsFor: 保存されている id が今の規則と違う行からは別名を作らない", () => {
  const good = { resource_id: resourceId("POST", "https://api.exa.ai/search"), method: "POST", resource_url: "https://api.exa.ai/search" };
  const stale = { resource_id: "f".repeat(64), method: "GET", resource_url: "https://stale.example/x" };
  const out = aliasRowsFor([good, stale]);
  assert.equal(out.skipped, 1);
  assert.ok(out.rows.length > 0);
  assert.ok(out.rows.every((r) => r.resourceId === good.resource_id));
  assert.ok(out.rows.some((r) => r.aliasId === sdkId("POST", "https://api.exa.ai/search/")));
  // method が NULL の掲載は GET（catalog-sync と同じ既定）
  const nullMethod = aliasRowsFor([{ resource_id: resourceId("GET", "https://n.example/x"), method: null, resource_url: "https://n.example/x" }]);
  assert.ok(nullMethod.rows.some((r) => r.aliasId === sdkId("GET", "https://n.example/x/")));
});
