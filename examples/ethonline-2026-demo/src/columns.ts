/**
 * 2カラムの組版。**動画の圧縮で色は死ぬ**ので、意味は位置と語だけで伝わるようにする。
 * 色は足しても構わないが、外しても同じ情報が残ることを `test/render.test.mjs` が固定する。
 *
 * 幅は 96 桁。80 桁の端末では折り返すが、撮影は 100 桁前後で行うので
 * **96 を超える行を1本も作らない**ことだけを不変条件にする。
 */

/** この画が超えてはいけない桁数。 */
export const MAX_WIDTH = 96;
const INDENT = 1;
export const LEFT_WIDTH = 44;
const GAP = 3;
export const RIGHT_WIDTH = MAX_WIDTH - INDENT - LEFT_WIDTH - GAP; // 48

export function rule(char = "="): string {
  return char.repeat(MAX_WIDTH);
}

/** 全幅の1行。**切り詰めない**——切り詰めると証拠が黙って消える。長い値は {@link wrap} を使う。 */
export function full(text: string): string {
  return " ".repeat(INDENT) + text;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * `label` と `value` の1組。`value` が入らなければ**次の行へ送る**（省略しない）。
 * `value` 自体が幅を超えるとき（CID・URL）は、ラベルだけの行 + 字下げした値にする。
 */
export function field(label: string, value: string, labelWidth: number, width: number): string[] {
  const room = width - labelWidth;
  if (value.length <= room) return [pad(label, labelWidth) + value];
  // ラベル行と値行に割る。値が2行に渡るなら折り返す。
  return [label, ...wrap(value, width - 2).map((line) => "  " + line)];
}

/**
 * 語の切れ目で折る。URL には空白が無いので `/` の直後でも折る——**16 進の途中で切ると
 * 画面から書き写せなくなる**（審査員が自分で引き直せることが提出物の要点）。
 * どちらも無ければそのまま切る（切っても文字は落とさない）。
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = String(text);
  while (rest.length > width) {
    const slice = rest.slice(0, width);
    const space = slice.lastIndexOf(" ");
    const slash = slice.lastIndexOf("/");
    const candidate = space > slash ? space : slash + 1;
    const at = candidate > width * 0.35 ? candidate : width;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

/** 左右を並べる。行数が違えば短い方を空行で埋める。 */
export function twoColumns(left: string[], right: string[]): string[] {
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    out.push((" ".repeat(INDENT) + pad(l, LEFT_WIDTH) + " ".repeat(GAP) + r).trimEnd());
  }
  return out;
}
