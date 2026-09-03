// ============================================================
// 公開面のコピーから「事実の断定」を機械的に拾う。
//
// 2026-08-13〜09-02 の事故（LP が "probed daily" と書き、同じサイトの
// /observatory/state が 18.8% を出していた）は、散文の主張を誰も機械で
// 数えていなかったから 20 日間残った。ここは数える側。
//
// 対象は英語の公開コピーだけ。コード識別子（Promise.all / rows.every）、
// コメント（日本語の監査メモを含む）、import、className などの
// 非散文属性は取り除いてから語を探す。
// ============================================================

export type Term = { name: string; pattern: RegExp };

/** 断定語。2026-08-13 の事故で問題になった語の族。 */
export const ASSERTIVE_TERMS: Term[] = [
  { name: "daily", pattern: /\bdaily\b/i },
  { name: "every", pattern: /\bevery\b/i },
  { name: "all", pattern: /\ball\b/i },
  { name: "always", pattern: /\balways\b/i },
  { name: "never", pattern: /\bnever\b/i },
  { name: "100%", pattern: /100\s*%/ },
  { name: "continuously", pattern: /\bcontinuous(ly)?\b/i },
  { name: "real time", pattern: /\breal[\s-]?time\b/i },
  { name: "instantly", pattern: /\binstant(ly)?\b/i },
  { name: "no one else", pattern: /\bno one else\b/i },
  { name: "only", pattern: /\bonly\b/i },
];

/** 値が散文でない属性／プロパティ。値ごと空白に潰す。 */
const NON_PROSE_KEYS = [
  "className",
  "class",
  "href",
  "src",
  "srcSet",
  "id",
  "key",
  "htmlFor",
  "rel",
  "target",
  "type",
  "viewBox",
  "preserveAspectRatio",
  "fill",
  "stroke",
  "strokeWidth",
  "strokeLinecap",
  "xmlns",
  "d",
  "points",
  "transform",
  "style",
  "dateTime",
  "role",
  "scope",
  "colSpan",
  "rowSpan",
  "tabIndex",
  "width",
  "height",
  "loading",
  "decoding",
  "referrerPolicy",
  "crossOrigin",
  "slug",
  "path",
  "as",
  "sizes",
  "itemProp",
  "itemType",
  "property",
  "charSet",
  // コードサンプルを載せるキー（docs/api の JSON 例など）。散文ではない。
  "code",
  "request",
  "response",
  "curl",
  "snippet",
  "sample",
  "example",
];

export type Assertion = {
  file: string;
  line: number;
  /** 一致した断定語の名前 */
  term: string;
  /** 断定語を含む文（空白を1個に正規化した原文。実体参照は原文のまま） */
  text: string;
};

/** 同じ長さの空白で潰す（行番号を保つため改行だけ残す）。 */
function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/**
 * コメントを空白に潰す。文字列リテラルの中の `//`（URL）は潰さない。
 * JSX のコメントは中身だけ潰し、波括弧は残す（JSX テキストの切れ目になる）。
 */
export function stripComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let quote: '"' | "'" | "`" | null = null;

  while (i < n) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    i++;
  }
  return out.join("");
}

/** import 行を潰す（`import { allChains } from "@/lib/all-chains-daily"` を拾わないため）。 */
function stripImports(src: string): string {
  return src
    .split("\n")
    .map((l) => (/^\s*(import\b|export\s+\*|\}\s+from\s)/.test(l) ? blank(l) : l))
    .join("\n");
}

/** className="break-all sr-only" のような非散文の値を潰す。 */
function stripNonProseValues(src: string): string {
  const re = new RegExp(
    `\\b(?:${NON_PROSE_KEYS.join("|")})\\s*[=:]\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,
    "g",
  );
  return src.replace(re, (m, value: string) => m.slice(0, m.length - value.length) + blank(value));
}

/** `<code>` / `<pre>` の中身を潰す。コード例は主張ではない。 */
function stripCodeElements(src: string): string {
  return src.replace(/<(code|pre)\b[^>]*>([\s\S]*?)<\/\1>/g, (m, tag: string, inner: string) =>
    m.slice(0, m.length - inner.length - `</${tag}>`.length) + blank(inner) + `</${tag}>`,
  );
}

function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === "\n") line++;
  return line;
}

type Candidate = { text: string; index: number };

/**
 * コードにしか現れない形。`}` を開き括りとして扱う代償に紛れ込む
 * `} if (all.length) {` のような断片をここで落とす。
 */
const CODE_SHAPED = /=>|===|!==|&&|\|\||\?\?|\.\w+\(|\)\s*[;,)]|\b(const|let|var|return|function|await|async|typeof|import|export)\b/;

/**
 * JSX のテキストノード。
 * 開きは `>`（タグの終わり）と `}`（式の終わり）、閉じは `<` と `{`。
 * `}` を開きに含めないと `<p>…{" "}続きの文</p>` の後半が丸ごと落ちる。
 */
function jsxTextNodes(src: string): Candidate[] {
  const out: Candidate[] = [];
  const re = /[>}]([^<>{}]+)[<{]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (!CODE_SHAPED.test(m[1])) out.push({ text: m[1], index: m.index + 1 });
    re.lastIndex = m.index + m[0].length - 1; // 閉じ記号を次の開きとして残す
  }
  return out;
}

/** 文字列リテラル（metadata の description など、散文がここに入る）。 */
function stringLiterals(src: string): Candidate[] {
  const out: Candidate[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const start = i + 1;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === c) break;
        i++;
      }
      out.push({ text: src.slice(start, i), index: start });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * 公開面のソース1本から、断定語を含む文を返す。
 * 1文に複数の断定語があれば語ごとに1件返す（登録簿の quote 1本で全部覆える）。
 */
export function extractAssertions(source: string, file: string): Assertion[] {
  const cleaned = stripCodeElements(stripNonProseValues(stripImports(stripComments(source))));
  const candidates = [...jsxTextNodes(cleaned), ...stringLiterals(cleaned)];

  const seen = new Set<string>();
  const out: Assertion[] = [];
  for (const cand of candidates) {
    const text = cand.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    // 単語1個は文ではない（<option>All</option> のようなフィルタ見出し）。
    // 2語からは残す。"probed daily" のような短い断定を落としてはならない。
    if (!text.includes(" ")) continue;
    for (const term of ASSERTIVE_TERMS) {
      if (!term.pattern.test(text)) continue;
      const line = lineAt(cleaned, cand.index);
      const dedupe = `${line} ${term.name} ${text}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ file, line, term: term.name, text });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.term.localeCompare(b.term));
}
