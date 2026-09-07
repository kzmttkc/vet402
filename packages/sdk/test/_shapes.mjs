// ============================================================
// **外から来る値の「壊れた形」の表。** 1 つの配列を、外部入力の面ごとのテストが全部回す。
//
// なぜ要るか（2026-09-07 第三者監査・金が動く欠陥 6 件の共通点）:
//   /decision 本文が `null`・`degraded` が文字列 `"true"`・402 の額が `"1e4"`・policy が NaN——
//   全部「値の**型・形**が想定と違う」族だった。それまでの 235 本のテストは、正しい形の入力しか
//   与えていなかった。欠陥ごとにテストを 1 本ずつ足しても、次の面の次の形は見ていない。
//   だから表を 1 つ持ち、**面 × 形の全組み合わせ**を機械的に回す。表に行を足せば全面に効く。
//
// 使う側（`boundary-shapes.test.mjs` 各パッケージ）は、面ごとに読むフィールドを列挙し、
// この表の各行をそのフィールドへ差し込んで、**署名器が 0 回**であること（金の欄）、または
// **壊れた値が署名に漏れない**こと（金でない欄）を assert する。
//
// 行は実在の出所を持つものから並べる。`from` は「どこから来うるか」:
//   json  … JSON.parse が作れる（サーバ・402・subgraph の応答として実際に届く）
//   js    … JSON では作れないが、呼び手のコード（policy・引数）からは来る（NaN・Infinity・undefined）
// `1e400` は JSON.parse が **Infinity** に読む——JSON 経由でも Infinity は届く（huge-number 行）。
// ============================================================

/** 「キーそのものが無い」を表す印。`undefined` を代入するのとは別の形（JSON.stringify で消える／消えない）。 */
export const ABSENT = Symbol("absent");

const ROWS = [
  { id: "null", from: "json", value: null },
  { id: "undefined", from: "js", value: undefined },
  { id: "absent", from: "json", value: ABSENT },
  { id: "empty-array", from: "json", value: [] },
  { id: "array-of-null", from: "json", value: [null] },
  { id: "empty-object", from: "json", value: {} },
  { id: "number", from: "json", value: 20000 },
  { id: "zero", from: "json", value: 0 },
  { id: "negative", from: "json", value: -1 },
  { id: "fraction", from: "json", value: 0.5 },
  { id: "huge-number", from: "json", value: 1e400 /* JSON.parse("1e400") === Infinity */ },
  { id: "nan", from: "js", value: NaN },
  { id: "string-true", from: "json", value: "true" },
  { id: "string-false", from: "json", value: "false" },
  { id: "hex-string", from: "json", value: "0x10" },
  { id: "exp-string", from: "json", value: "1e4" },
  { id: "empty-string", from: "json", value: "" },
  { id: "padded-string", from: "json", value: " 20000 " },
  { id: "huge-string", from: "json", value: "99999999999999999999999999999999" },
  { id: "boolean-true", from: "json", value: true },
  { id: "boolean-false", from: "json", value: false },
  { id: "string-null", from: "json", value: "null" },
];

/** 壊れた形の表。**この配列を短くする変異はテストで殺す**（`test-mutations.mjs`）。 */
export const BROKEN_SHAPES = Object.freeze(ROWS.map((r) => Object.freeze(r)));

/** 表に必ず居なければならない行。監査が実物で見つけた 4 形＋ JSON が作れる境界値。 */
export const REQUIRED_SHAPE_IDS = Object.freeze([
  "null", "absent", "empty-array", "array-of-null", "empty-object", "number", "zero", "negative",
  "huge-number", "nan", "string-true", "hex-string", "exp-string", "empty-string", "padded-string", "huge-string",
]);

/** ネストのキーを "a.b.c" で指す。`value === ABSENT` ならキーを消す。途中のオブジェクトは複製する（元を汚さない）。 */
export function withShape(base, path, value) {
  const keys = path.split(".");
  const clone = (v) => (Array.isArray(v) ? v.map(clone) : v !== null && typeof v === "object" ? { ...v } : v);
  const out = clone(base);
  let cur = out;
  for (let i = 0; i < keys.length - 1; i += 1) {
    cur[keys[i]] = clone(cur[keys[i]]);
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (value === ABSENT) delete cur[last];
  else cur[last] = value;
  return out;
}

/** テスト名に出す短い表記（`undefined` と Infinity/NaN は JSON.stringify が落とすので自前で）。 */
export function showShape(row) {
  if (row.value === ABSENT) return "<absent>";
  if (row.value === undefined) return "undefined";
  if (typeof row.value === "number" && !Number.isFinite(row.value)) return String(row.value);
  return JSON.stringify(row.value);
}
