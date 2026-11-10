/**
 * Pure parser for vet402 dated report markdown (content/reports/*.md).
 * Throws on constructs outside the supported subset so bad edits fail in CI.
 */

export type ReportInline =
  | { kind: "text"; value: string }
  | { kind: "bold"; children: ReportInline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string };

export type ReportBlock =
  | { kind: "paragraph"; inlines: ReportInline[] }
  | { kind: "list"; items: ReportInline[][] }
  | { kind: "table"; headers: string[]; rows: string[][] };

export type ReportSection = {
  kind: "section";
  heading: string;
  blocks: ReportBlock[];
};

export type ReportDocument = {
  title: string;
  preamble: ReportBlock[];
  sections: ReportSection[];
};

const HTTPS_URL = /https:\/\/[^\s]+/;

function throwUnsupported(reason: string, detail: string): never {
  throw new Error(`Unsupported markdown: ${reason} (${detail})`);
}

function assertNoUnsupportedConstructs(line: string): void {
  if (/^#{3,}\s/.test(line)) throwUnsupported("heading depth", line);
  if (/^!\[/.test(line)) throwUnsupported("image", line);
  if (/\[[^\]]+\]\([^)]+\)/.test(line)) throwUnsupported("reference link", line);
  if (/^```/.test(line)) throwUnsupported("fenced code", line);
  if (/^>\s/.test(line)) throwUnsupported("blockquote", line);
  if (/^\d+\.\s/.test(line)) throwUnsupported("ordered list", line);
  if (/^[*+]\s/.test(line)) throwUnsupported("alternate bullet", line);
  if (/<[a-zA-Z][^>]*>/.test(line)) throwUnsupported("HTML", line);
}

function parseInlines(source: string): ReportInline[] {
  const out: ReportInline[] = [];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("**", i)) {
      const end = source.indexOf("**", i + 2);
      if (end === -1) throwUnsupported("unclosed bold", source.slice(i));
      const inner = source.slice(i + 2, end);
      if (inner.includes("**")) throwUnsupported("nested bold", inner);
      out.push({ kind: "bold", children: parseInlines(inner) });
      i = end + 2;
      continue;
    }
    if (source[i] === "`") {
      const end = source.indexOf("`", i + 1);
      if (end === -1) throwUnsupported("unclosed code", source.slice(i));
      out.push({ kind: "code", value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const urlMatch = source.slice(i).match(HTTPS_URL);
    if (urlMatch && urlMatch.index === 0) {
      // 2026-11-10: 文末の句読点（"…/state. CSV" の "."）は URL に含めない。含めるとリンク先が壊れる。
      const href = urlMatch[0].replace(/[.,:!?)]+$/, "");
      out.push({ kind: "link", href });
      i += href.length;
      continue;
    }
    const nextSpecial = (() => {
      const a = source.indexOf("**", i);
      const b = source.indexOf("`", i);
      const c = source.slice(i).search(HTTPS_URL);
      const indices = [a, b, c === -1 ? -1 : i + c].filter((x) => x >= 0);
      return indices.length === 0 ? -1 : Math.min(...indices);
    })();
    const end = nextSpecial === -1 ? source.length : nextSpecial;
    if (end > i) {
      const text = source.slice(i, end);
      if (text.includes("*") && !text.includes("**")) throwUnsupported("italic or stray asterisk", text);
      out.push({ kind: "text", value: text });
      i = end;
      continue;
    }
    throwUnsupported("stuck inline parse", source.slice(i, i + 40));
  }
  return out;
}

function isTableSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) throwUnsupported("table row", line);
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

function parseTable(lines: string[], start: number): { block: ReportBlock; next: number } {
  const headerCells = splitTableRow(lines[start]!);
  assertNoUnsupportedConstructs(lines[start]!);
  for (const cell of headerCells) {
    if (/[*`\[]/.test(cell)) throwUnsupported("inline markup in table cell", cell);
  }
  const sepLine = lines[start + 1];
  if (!sepLine?.trim().startsWith("|")) throwUnsupported("table missing separator", lines[start]!);
  const sepCells = splitTableRow(sepLine);
  if (!isTableSeparatorRow(sepCells) || sepCells.length !== headerCells.length) {
    throwUnsupported("table separator", sepLine);
  }
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i]!.trim().startsWith("|")) {
    assertNoUnsupportedConstructs(lines[i]!);
    const cells = splitTableRow(lines[i]!);
    if (cells.length !== headerCells.length) throwUnsupported("table column count", lines[i]!);
    for (const cell of cells) {
      if (/[*`\[]/.test(cell)) throwUnsupported("inline markup in table cell", cell);
    }
    rows.push(cells);
    i++;
  }
  return { block: { kind: "table", headers: headerCells, rows }, next: i };
}

function parseBlocks(lines: string[], start: number, end: number): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    assertNoUnsupportedConstructs(line);
    if (trimmed.startsWith("## ")) throwUnsupported("section inside block", line);
    if (trimmed.startsWith("# ")) throwUnsupported("title inside body", line);
    if (trimmed.startsWith("|")) {
      const { block, next } = parseTable(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }
    if (trimmed.startsWith("- ")) {
      const items: ReportInline[][] = [];
      while (i < end) {
        const li = lines[i]!.trim();
        if (!li.startsWith("- ")) break;
        assertNoUnsupportedConstructs(lines[i]!);
        items.push(parseInlines(li.slice(2)));
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const paraLines: string[] = [];
    while (i < end) {
      const raw = lines[i]!;
      const t = raw.trim();
      if (t === "") break;
      if (t.startsWith("## ") || t.startsWith("|") || t.startsWith("- ")) break;
      assertNoUnsupportedConstructs(raw);
      paraLines.push(t);
      i++;
    }
    blocks.push({ kind: "paragraph", inlines: parseInlines(paraLines.join(" ")) });
  }
  return blocks;
}

export function parseReportMarkdown(markdown: string): ReportDocument {
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length > 0 && !normalized.endsWith("\n")) {
    throw new Error("Report markdown must end with a newline");
  }
  const lines = normalized.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const titleLine = lines[i];
  if (!titleLine?.startsWith("# ")) throwUnsupported("missing H1", titleLine ?? "(eof)");
  const title = titleLine.slice(2).trim();
  if (!title) throwUnsupported("empty title", titleLine);
  i++;
  if (i < lines.length && lines[i]!.startsWith("# ")) throwUnsupported("second H1", lines[i]!);

  const preambleEnd = (() => {
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.startsWith("## ")) return j;
    }
    return lines.length;
  })();
  const preamble = parseBlocks(lines, i, preambleEnd);

  const sections: ReportSection[] = [];
  let k = preambleEnd;
  while (k < lines.length) {
    while (k < lines.length && lines[k]!.trim() === "") k++;
    if (k >= lines.length) break;
    const h = lines[k]!;
    if (!h.startsWith("## ")) throwUnsupported("expected section", h);
    const heading = h.slice(3).trim();
    k++;
    const sectionEnd = (() => {
      for (let j = k; j < lines.length; j++) {
        if (lines[j]!.startsWith("## ")) return j;
      }
      return lines.length;
    })();
    sections.push({
      kind: "section",
      heading,
      blocks: parseBlocks(lines, k, sectionEnd),
    });
    k = sectionEnd;
  }

  return { title, preamble, sections };
}

export function reportInlineText(inline: ReportInline): string {
  switch (inline.kind) {
    case "text":
      return inline.value;
    case "bold":
      return inline.children.map(reportInlineText).join("");
    case "code":
      return inline.value;
    case "link":
      return inline.href;
  }
}

export function reportBlockText(block: ReportBlock): string {
  switch (block.kind) {
    case "paragraph":
      return block.inlines.map(reportInlineText).join("");
    case "list":
      return block.items.map((item) => item.map(reportInlineText).join("")).join(" ");
    case "table":
      return [block.headers.join(" "), ...block.rows.map((r) => r.join(" "))].join(" ");
  }
}

export function reportDocumentText(doc: ReportDocument): string {
  const parts = [
    doc.title,
    ...doc.preamble.map(reportBlockText),
    ...doc.sections.flatMap((s) => [s.heading, ...s.blocks.map(reportBlockText)]),
  ];
  return parts.join("\n");
}

/** Sentences from raw report prose (tables and lists included) for content regression tests. */
export function sentencesFromReportMarkdown(markdown: string): string[] {
  const doc = parseReportMarkdown(markdown);
  const plain = reportDocumentText(doc);
  const chunks = plain
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return chunks;
}
