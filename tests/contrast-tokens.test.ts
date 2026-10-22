// ============================================================
// Vouch — 文字色トークンの静的コントラスト関門。
//
// 2026-08-12: 本番の「実描画ピクセル」計測で AA 不合格が 15件出た。前日に
// 「達成」と報告した直後で、トークン表を目視で追う運用では同じ穴が二度開く
// ことが実証された。成果物（その15件）を直すだけでは同型が必ず戻ってくるので、
// 出した経路そのものに関門を置く。
//
// このテストは実行時のレンダリングを見ない。見るのは「どの Tailwind 文字色
// トークンを、どの地色クラスの上で使ってよいか」という一点だけ。実描画計測
// （Playwright）は重くて CI に載らないが、実際に起きた不合格はすべて
// 「トークンの組み合わせ」の段階で判定できる形をしていた。
//
// 契約:
//   1. src/ に text-zinc-400 は存在しない（白地 2.62:1・zinc-50 上 2.51:1）。
//      文字にも、意味を担うアイコンにも使えない階調。
//   2. bg-zinc-100 のチップ（code / badge）は文字色を明示する。継承すると
//      親の text-zinc-500 が乗って 4.39:1 になり AA を割る。
//   3. 入力欄（input / select / textarea）の枠線は白地 3:1 未満の階調を使わない。
//      2026-08-12 追加。上の2件は「文字」の関門だったが、同じ日に本番実測で
//      入力欄の枠線が 1.48:1（border-zinc-300）で全7箇所落ちていた。WCAG 2.2 の
//      1.4.11 は非テキストにも 3:1 を要求し、枠線が入力欄の唯一の境界表現である
//      以上は免除されない。文字だけ見張っていても同じ穴がもう一方から開く。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts|css)$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

// className 文字列の中身だけを見る。日本語の由来コメントに書かれたトークン名を
// 違反として拾ってしまうと、なぜ直したのかを書けなくなる。
function classAttrs(source: string): { line: number; value: string }[] {
  const out: { line: number; value: string }[] = [];
  const re = /className\s*[:=]\s*(?:\{?\s*)?(["'`])([\s\S]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ line: source.slice(0, m.index).split("\n").length, value: m[2] });
  }
  return out;
}

test("text-zinc-400 は src/ のどの className にも存在しない（白地 2.62:1）", () => {
  const hits: string[] = [];
  for (const f of FILES) {
    for (const a of classAttrs(f.text)) {
      if (/\btext-zinc-400\b/.test(a.value)) hits.push(`${f.path}:${a.line}`);
    }
  }
  assert.deepEqual(hits, [], `text-zinc-400 (#A1A1AA) は白地 2.62:1 で AA 不合格。text-zinc-500 (4.83:1) を使う: ${hits.join(", ")}`);
});

test("bg-zinc-100 のチップは文字色を明示する（継承した zinc-500 は 4.39:1）", () => {
  const hits: string[] = [];
  for (const f of FILES) {
    for (const a of classAttrs(f.text)) {
      if (!/\bbg-zinc-100\b/.test(a.value)) continue;
      // 文字を持たない帯（プログレスバー等）は対象外。px/py の内側寸法を持つ
      // ものだけがテキストチップ。
      if (!/\bp[xy]?-/.test(a.value)) continue;
      if (!/\btext-zinc-(600|700|800|900)\b/.test(a.value)) hits.push(`${f.path}:${a.line}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `bg-zinc-100 (#F4F4F5) の上では text-zinc-500 が 4.39:1 で AA を割る。チップ側に text-zinc-700 (9.50:1) を明示する: ${hits.join(", ")}`,
  );
});

// 白地で 3:1 を満たさない枠線トークン。実測値は 2026-08-12 の計算による。
//   zinc-200 1.24 / zinc-300 1.48 / zinc-400 2.56 / brand-mist 2.78
// zinc は 400 と 500 の間に階調が無いので、3:1 を満たす最も薄い neutral は
// zinc-500 (#71717A・4.83:1)。紺なら brand-lift (#55688c・5.61:1) 以上。
//
// 接頭辞を実行時に連結しているのは、Tailwind v4 の自動ソース検出がこのテスト
// ファイルまで走査するため。禁止トークンを完全な形（接頭辞＋色名が地続きの文字列）
// で書くと、**どこからも使っていないのに本番CSSにその規則が焼き込まれる**。
// 2026-08-12 のデプロイで実際に4本が配信CSSへ出ていたのを確認している。死んだ規則が
// 増えるだけでなく、配信CSSを grep して使用実態を調べる時に嘘をつく（この関門が
// 禁止しているはずのトークンが、配信物の中には存在する、という状態になる）。
// 連結すればクラス候補として抽出可能な文字列がソースに存在しなくなる。
// 同じ理由で、下の説明文にも禁止トークンを地続きでは書かない。
const WEAK_BORDER_COLORS = [
  "white",
  "transparent",
  "zinc-50",
  "zinc-100",
  "zinc-200",
  "zinc-300",
  "zinc-400",
  "brand-mist",
];
const WEAK_BORDERS = WEAK_BORDER_COLORS.map((c) => `border-${c}`);

/**
 * `<input>` / `<select>` / `<textarea>` の開始タグ本体を切り出す。
 *
 * 単純な `<input[^>]*>` では取れない。`onChange={(event) => setWallet(...)}` の
 * アロー関数に `>` が含まれていて、そこでタグが終わったことにされてしまうため
 * （lists / lookup の入力欄はすべてこの形をしている＝関門が素通りになる）。
 * 波括弧の深さと文字列リテラルを見ながら、深さ0の `>` まで進む。
 */
function controlTags(source: string): { line: number; index: number; body: string; tag: string }[] {
  const out: { line: number; index: number; body: string; tag: string }[] = [];
  const open = /<(input|select|textarea)(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(source)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({
      tag: m[1],
      index: m.index,
      line: source.slice(0, m.index).split("\n").length,
      body: source.slice(m.index, i),
    });
  }
  return out;
}

function classValuesBefore(source: string, index: number): string[] {
  const out: string[] = [];
  const re = /className\s*[:=]\s*(?:\{?\s*)?(["'`])([\s\S]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m.index >= index) break;
    out.push(m[2]);
  }
  return out;
}

/** Resting background token (no variant prefix). The last one in the class string wins. */
function restingBg(value: string): string | null {
  const tokens = value.split(/\s+/).filter((t) => t.startsWith("bg-"));
  return tokens.length > 0 ? tokens[tokens.length - 1] : null;
}

/** brand-deep is #233456. A slash sets the opacity percent. No slash is 100. */
function navyOpacityOfBg(token: string): number | null {
  const m = /^bg-(?:brand-deep|\[#233456\])(?:\/(\d+))?$/.exec(token);
  if (!m) return null;
  return m[1] === undefined ? 100 : Number(m[1]);
}

function groundNavyOpacity(body: string, ancestors: readonly string[]): number | null {
  const own = restingBg(body);
  if (own && !own.startsWith("bg-transparent")) return navyOpacityOfBg(own);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const bg = restingBg(ancestors[i]);
    if (!bg || bg.startsWith("bg-transparent")) continue;
    return navyOpacityOfBg(bg);
  }
  return null;
}

function borderWhiteOpacity(body: string): number | null {
  let found: number | null = null;
  for (const t of body.split(/\s+/)) {
    if (t.includes(":")) continue;
    const m = /^border-white(?:\/(\d+))?$/.exec(t);
    if (m) found = m[1] === undefined ? 100 : Number(m[1]);
  }
  return found;
}

/**
 * The white-border exception is only a field whose text is white, whose resting
 * border is white at 40% opacity or more, on a navy ground (#233456, brand-deep)
 * that is itself at 40% opacity or more. text-white alone does not qualify.
 */
function whiteBorderOnNavy(body: string, ancestors: readonly string[]): boolean {
  const hasWhiteText = body.split(/\s+/).some((t) => t === "text-white" || /^text-white\/\d+$/.test(t));
  if (!hasWhiteText) return false;
  const border = borderWhiteOpacity(body);
  if (border === null || border < 40) return false;
  const ground = groundNavyOpacity(body, ancestors);
  return ground !== null && ground >= 40;
}

test("入力欄の枠線に白地3:1未満のトークンを使わない（WCAG 1.4.11）", () => {
  const hits: string[] = [];
  for (const f of FILES) {
    for (const t of controlTags(f.text)) {
      for (const token of WEAK_BORDERS) {
        // `focus:border-zinc-300` のような variant 付きは休止時の境界表現では
        // ないので対象外にする（直前が `:` なら variant）。
        const re = new RegExp(`(?<![\\w:-])${token}(?![\\w-])`);
        if (!re.test(t.body)) continue;
        // 白文字かつ枠の白が 40% 以上で、地が紺（#233456 / brand-deep）の 40% 以上のときだけ通す。
        // 40% の白を不透明な #233456 に乗せると 3.34:1。text-white だけでは通さない。
        if (token === `border-${"white"}` && whiteBorderOnNavy(t.body, classValuesBefore(f.text, t.index))) continue;
        hits.push(`${f.path}:${t.line} <${t.tag}> ${token}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    `入力欄の枠線が白地 3:1 未満。border-zinc-500 (#71717A・4.83:1) 以上、または brand-lift (#55688c・5.61:1) 以上を使う: ${hits.join(", ")}`,
  );
});

test("白枠の例外は紺地かつ白の不透明度 40% 以上のときだけ", () => {
  const navy = "bg-brand-deep text-white";
  const field = "border border-white/40 bg-transparent text-white";
  assert.equal(whiteBorderOnNavy(field, [navy]), true);
  assert.equal(whiteBorderOnNavy("border border-white text-white", ["bg-[#233456]"]), true);
  assert.equal(whiteBorderOnNavy(field, ["bg-brand-deep/40"]), true);
  assert.equal(whiteBorderOnNavy(field, ["bg-brand-deep/39"]), false, "navy below 40% is not the measured ground");
  assert.equal(whiteBorderOnNavy("border border-white/39 text-white", [navy]), false, "white below 40% misses 3:1");
  assert.equal(whiteBorderOnNavy(field, ["bg-paper"]), false, "text-white on paper is not enough");
  assert.equal(whiteBorderOnNavy(field, []), false, "no navy ancestor");
  assert.equal(whiteBorderOnNavy("border border-white/40 bg-white text-white", [navy]), false, "the field's own ground wins");
});
