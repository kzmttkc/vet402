// ============================================================
// docs/claims.yaml を読む。制限した YAML サブセット専用の自前パーサ。
//
// 依存を足さないために自前にした（js-yaml は eslint の推移依存でしかなく、
// それに寄りかかるとゲートが他人の依存グラフで死ぬ）。
// 受け付ける形は登録簿が実際に使う分だけ:
//   top:
//     - key: value
//       nested:
//         key: value
//   スカラは "二重引用符" / '単一引用符' / 素の1行 / null。
// これ以上の YAML を書きたくなったら、登録簿の設計を疑うこと。
// ============================================================

export type Check = { url: string; assert: string };

export type Claim = {
  id: string;
  surface: string;
  quote: string;
  means: string;
  check: Check | null;
  why_unverifiable?: string;
  verified_at: string;
};

export type AllowPhrase = { phrase: string; why: string };

export type Registry = { claims: Claim[]; allow_phrases: AllowPhrase[] };

type Raw = Record<string, unknown>;

function scalar(raw: string): string | null {
  const v = raw.trim();
  if (v === "null" || v === "~" || v === "") return null;
  if (/^"(?:[^"\\]|\\.)*"$/.test(v)) return JSON.parse(v) as string;
  if (/^'(?:[^']|'')*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function parseDocument(text: string): Record<string, Raw[]> {
  const doc: Record<string, Raw[]> = {};
  let section: Raw[] | null = null;
  let item: Raw | null = null;
  let nestedKey: string | null = null;
  let nestedIndent = 0;

  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      const m = /^([A-Za-z_][\w-]*):\s*$/.exec(body);
      if (!m) throw new Error(`claims.yaml:${n + 1}: expected a top-level "key:" but got ${JSON.stringify(body)}`);
      section = [];
      doc[m[1]] = section;
      item = null;
      nestedKey = null;
      continue;
    }

    if (!section) throw new Error(`claims.yaml:${n + 1}: content before any top-level key`);

    if (body.startsWith("- ")) {
      const m = /^-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
      if (!m) throw new Error(`claims.yaml:${n + 1}: list item must start with "- key: value"`);
      item = {};
      section.push(item);
      nestedKey = null;
      item[m[1]] = scalar(m[2]);
      continue;
    }

    if (!item) throw new Error(`claims.yaml:${n + 1}: key outside of a list item`);

    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
    if (!m) throw new Error(`claims.yaml:${n + 1}: expected "key: value" but got ${JSON.stringify(body)}`);
    const [, key, rest] = m;

    if (nestedKey && indent > nestedIndent) {
      (item[nestedKey] as Raw)[key] = scalar(rest);
      continue;
    }

    nestedKey = null;
    if (rest.trim() === "") {
      item[key] = {};
      nestedKey = key;
      nestedIndent = indent;
      continue;
    }
    item[key] = scalar(rest);
  }
  return doc;
}

function str(item: Raw, key: string, where: string): string {
  const v = item[key];
  if (typeof v !== "string") throw new Error(`claims.yaml: ${where} is missing "${key}"`);
  return v;
}

export function parseRegistry(text: string): Registry {
  const doc = parseDocument(text);

  const claims: Claim[] = (doc.claims ?? []).map((raw, i) => {
    const where = typeof raw.id === "string" ? `claim "${raw.id}"` : `claim #${i + 1}`;
    const rawCheck = raw.check;
    let check: Check | null = null;
    if (rawCheck !== null && rawCheck !== undefined) {
      if (typeof rawCheck !== "object") throw new Error(`claims.yaml: ${where} has a non-map check`);
      const c = rawCheck as Raw;
      check = { url: str(c, "url", `${where}.check`), assert: str(c, "assert", `${where}.check`) };
    }
    const claim: Claim = {
      id: str(raw, "id", where),
      surface: str(raw, "surface", where),
      quote: str(raw, "quote", where),
      means: str(raw, "means", where),
      check,
      verified_at: str(raw, "verified_at", where),
    };
    if (typeof raw.why_unverifiable === "string") claim.why_unverifiable = raw.why_unverifiable;
    return claim;
  });

  const allow_phrases: AllowPhrase[] = (doc.allow_phrases ?? []).map((raw, i) => ({
    phrase: str(raw, "phrase", `allow_phrase #${i + 1}`),
    why: str(raw, "why", `allow_phrase #${i + 1}`),
  }));

  return { claims, allow_phrases };
}
