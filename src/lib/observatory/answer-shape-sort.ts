// ============================================================
// 答えの形をしていない有料の 2xx を、影の記録の中だけで仕分ける（2026-10-19・段S1）。
//
// 公開はしない。status・L2・/sellers・export・判定 API は変えない。raw_response_meta.answerShapeSort に残すだけ。
// 規則は 2026-09-15〜10-15 の 68 件を人が仕分けた理由（vet402 42・正当 17・売り手 4・判断できない 5）から取る。
// キーワードは下の定数だけ。本文の「rate limit」等では決めない（answer-shape.ts と同じく、言葉だけの規則は誤検出が多かった）。
//
// 決め方（先に当たったもの。vet402 の誤りと示せない限り seller_suspect にしない。迷ったら unknown）:
//   vet402_input    requestQuery が refused（宣言したクエリを送らなかった記録）。
//                   型の名前・空文字・"0"・example などの見本を送った。本文が欠けていると名指す項目が
//                   schema の fields にあり、その項目を送っていない。宣言の必須を送っていない。
//                   送った値が宣言の型に合わない。例と同じ値を送り、本文が入力の落ち度を名指す。
//   valid_answer    必須は送ってあり、空の配列・空の結果が宣言の出力の型と矛盾しない。業務上の「no」
//                   （ok:false かつ changed:false 等。success:false に障害の語があるものは除く）。
//                   宣言どおり送った HTML で、script src の枠でも、title が 5xx でもないもの。
//   seller_suspect  入力を宣言どおり、見本でない値で送り、本文が入力の落ち度を名指さない error_object / error_flag。
//   unknown         入力の落ち度の語があるが vet402 の誤りと示せない。サイト枠。5xx。障害。材料が足りない。
// ============================================================

import type { AnswerShape } from "./answer-shape";

/** 仕分けの語。ここ以外にキーワードを置かない。1社の書式や特定の枠組みの印は置かない。 */
export const ANSWER_SHAPE_SORT_WORDS = {
  /** 本文が入力の落ち度を名指す語。missing_agentId・field_required・validationErrors のように、語の一部でも当たる。 */
  inputFault: ["missing", "required", "invalid", "validation"],
  /** success:false の本文にある、業務上の no ではない障害の語。 */
  outage: ["internal server error", "timeout"],
} as const;

/** 送った値が型の名前や見本そのもの。空文字と "0" を含む。 */
const PLACEHOLDER_VALUES = new Set(["string", "number", "integer", "boolean", "example", "placeholder", "0"]);

export type AnswerShapeSort = "vet402_input" | "valid_answer" | "seller_suspect" | "unknown";

export type AnswerShapeSortField = {
  name: string;
  in: "query" | "body";
  type?: string | null;
  /** 宣言の例。null は「例が無い」（比べない）。 */
  example?: unknown;
};

/** sortAnswerShape の入力。declaredInput が null のときは required と bodyType だけで「宣言どおりか」を見る。 */
export type AnswerShapeSortRow = {
  answerShape: AnswerShape | null;
  bodyHead: string;
  /** "declared" だけが、宣言のクエリを送った記録。null は記録が無い（送っていない）。 */
  requestQuery: "declared" | "empty" | "refused" | null;
  requestBody: "declared" | "empty" | "none" | null;
  /** 出品の declared_input。無い行は null。 */
  declaredInput: { query: "declared" | "empty" | "refused"; body: "declared" | "empty" } | null;
  /** 宣言の必須項目（クエリ名と本文のフィールド名）。 */
  required: { query: string[]; body: string[] };
  /** 本文の宣言の型。"string" は生の CSV/HTML/JSON で、{} は宣言どおりではない。 */
  bodyType?: string | null;
  /** 宣言の出力の型（schema の example.type）。無いときは null＝矛盾のしようが無い。 */
  outputType?: string | null;
  /** 宣言の型・例。sentQuery / sentBody と比べる。無ければ本文の語だけで「値が違う」を見る。 */
  fields?: AnswerShapeSortField[];
  sentQuery?: Record<string, string> | null;
  sentBody?: unknown;
};

const ERROR_KEY = /^(error|errors|err|error_message|errormessage)$/i;
const FLAG_KEY = /^(ok|success|status|changed|settled)$/i;

function lower(body: string): string {
  return body.toLowerCase();
}

function hasWord(body: string, words: readonly string[]): boolean {
  const t = lower(body);
  return words.some((w) => t.includes(w));
}

function expectsQuery(row: AnswerShapeSortRow): boolean {
  // refused は「売り手が宣言したクエリを、vet402 が送らなかった」という行の記録そのもの。
  if (row.requestQuery === "refused") return true;
  const q = row.declaredInput?.query;
  if (q === "declared" || q === "refused") return true;
  return row.required.query.length > 0;
}

function expectsBody(row: AnswerShapeSortRow): boolean {
  if (row.declaredInput?.body === "declared") return true;
  return row.required.body.length > 0 || row.bodyType === "string";
}

/** 宣言された入力を、その行は送っていない。refused だけで送っていない。 */
function inputNotSent(row: AnswerShapeSortRow): boolean {
  if (row.requestQuery === "refused") return true;
  const queryMiss = expectsQuery(row) && row.requestQuery !== "declared";
  const bodyMiss = expectsBody(row) && row.requestBody !== "declared";
  return queryMiss || bodyMiss;
}

function readSent(row: AnswerShapeSortRow, field: AnswerShapeSortField): unknown {
  if (field.in === "query") {
    if (!row.sentQuery || !Object.prototype.hasOwnProperty.call(row.sentQuery, field.name)) return undefined;
    return row.sentQuery[field.name];
  }
  const body = row.sentBody;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(rec, field.name)) return undefined;
    return rec[field.name];
  }
  return undefined;
}

/** 送った値が宣言の例と等しいか。等しいことは売り手が悪い根拠にしない（呼び手は vet402 の見本として扱う）。 */
function sameValue(sent: unknown, example: unknown): boolean {
  if (sent === example) return true;
  if (typeof example === "number" && typeof sent === "string" && sent.trim() !== "" && Number(sent) === example) return true;
  if (typeof example === "boolean" && (sent === "true" || sent === "false")) return sent === String(example);
  if (typeof example === "string" && (typeof sent === "number" || typeof sent === "boolean")) return String(sent) === example;
  return false;
}

function isPlaceholderValue(sent: unknown): boolean {
  if (typeof sent === "number") return sent === 0;
  if (typeof sent !== "string") return false;
  const t = sent.trim().toLowerCase();
  return t === "" || PLACEHOLDER_VALUES.has(t);
}

function sentValues(row: AnswerShapeSortRow): unknown[] {
  const out: unknown[] = [];
  if (row.sentQuery) out.push(...Object.values(row.sentQuery));
  const body = row.sentBody;
  if (typeof body === "string" || typeof body === "number" || typeof body === "boolean") out.push(body);
  else if (Array.isArray(body)) out.push(...body);
  else if (typeof body === "object" && body !== null) out.push(...Object.values(body as Record<string, unknown>));
  return out;
}

function sentPlaceholder(row: AnswerShapeSortRow): boolean {
  return sentValues(row).some(isPlaceholderValue);
}

function matchesType(sent: unknown, type: string): boolean {
  const t = type.toLowerCase();
  if (t === "string") return typeof sent === "string" || typeof sent === "number" || typeof sent === "boolean";
  if (t === "number" || t === "integer") {
    const n = typeof sent === "number" ? sent : typeof sent === "string" && sent.trim() !== "" ? Number(sent) : NaN;
    if (!Number.isFinite(n)) return false;
    return t === "number" || Number.isInteger(n);
  }
  if (t === "boolean") return typeof sent === "boolean" || sent === "true" || sent === "false";
  if (t === "array") return Array.isArray(sent);
  if (t === "object") return typeof sent === "object" && sent !== null && !Array.isArray(sent);
  return true;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 本文が、その項目名を欠けているものとして挙げている。語の境界で見る（requestedUrl の required には当たらない）。 */
function bodyNamesField(body: string, name: string): boolean {
  const n = name.toLowerCase();
  if (n.length < 2) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeReg(n)}(?:[^a-z0-9]|$)`).test(lower(body));
}

/** 本文が入力の落ち度を名指し、その項目が schema の fields にあり、送っていない。 */
function namedFieldNotSent(row: AnswerShapeSortRow): boolean {
  if (!hasWord(row.bodyHead, ANSWER_SHAPE_SORT_WORDS.inputFault)) return false;
  for (const field of row.fields ?? []) {
    if (!bodyNamesField(row.bodyHead, field.name)) continue;
    const sent = readSent(row, field);
    if (sent === undefined || sent === null) return true;
  }
  return false;
}

/** 送った値が宣言の型に合わない。例と違うだけでは合わないことにしない。 */
function typeMismatch(row: AnswerShapeSortRow): boolean {
  for (const field of row.fields ?? []) {
    if (!field.type) continue;
    const sent = readSent(row, field);
    if (sent === undefined || sent === null) continue;
    if (!matchesType(sent, field.type)) return true;
  }
  return false;
}

/** 送った値が宣言の例そのもの。売り手が悪い根拠には使わない。 */
function sentEqualsExample(row: AnswerShapeSortRow): boolean {
  for (const field of row.fields ?? []) {
    if (field.example === undefined || field.example === null) continue;
    const sent = readSent(row, field);
    if (sent === undefined) continue;
    if (sameValue(sent, field.example)) return true;
  }
  return false;
}

function emptyConsistent(row: AnswerShapeSortRow): boolean {
  let value: unknown;
  try {
    value = JSON.parse(row.bodyHead);
  } catch {
    return false;
  }
  const out = row.outputType ?? null;
  const scalar = out === "string" || out === "number" || out === "integer" || out === "boolean";
  if (scalar) return false;
  if (Array.isArray(value)) return out === null || out === "array";
  if (typeof value === "object" && value !== null) return out === null || out === "object";
  return false;
}

/** エラー文の無い ok:false / changed:false。台帳の「すでにその色」「正しい 404 の報告」と同じ形。 */
function isBusinessNo(body: string): boolean {
  const keys = [...body.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]);
  if (keys.length === 0) return false;
  if (keys.some((k) => ERROR_KEY.test(k)) && /"(?:error|errors|err|error_message|errormessage)"\s*:\s*"(?:[^"\\]|\\.)+"/.test(body)) {
    return false;
  }
  if (/"changed"\s*:\s*false/.test(body)) return true;
  if (!/"(?:ok|success)"\s*:\s*false/.test(body)) return false;
  return keys.some((k) => !FLAG_KEY.test(k));
}

/** success:false かつ障害の語。業務上の no にしない。 */
function successFalseOutage(body: string): boolean {
  if (!/"success"\s*:\s*false/.test(body)) return false;
  if (hasWord(body, ANSWER_SHAPE_SORT_WORDS.outage)) return true;
  return /\b502\b/.test(body) || /\b503\b/.test(body);
}

function htmlTitleIs5xx(body: string): boolean {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title !== null && /\b5\d\d\b/.test(title[1]);
}

function hasScriptSrc(body: string): boolean {
  return /<script\b[^>]*\bsrc\s*=/i.test(body);
}

/** タグと script/style を除いた、人が読む文字。 */
function visibleText(body: string): string {
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** script src があり、本文の文字がほぼ無い。枠組みのパスには頼らない。 */
function isSiteShell(body: string): boolean {
  return hasScriptSrc(body) && visibleText(body).length <= 20;
}

/**
 * 見本でない値を、宣言どおり送ったと示せる。
 * 必須があるのに送った値を持っていないときは、示せない。
 */
function declaredRealInput(row: AnswerShapeSortRow): boolean {
  if (inputNotSent(row) || sentPlaceholder(row) || sentEqualsExample(row)) return false;
  const fields = row.fields ?? [];
  if (fields.length > 0) {
    for (const field of fields) {
      const sent = readSent(row, field);
      if (sent === undefined || sent === null || isPlaceholderValue(sent)) return false;
    }
    return true;
  }
  if (row.required.query.length > 0 || row.required.body.length > 0) {
    const querySent = row.sentQuery != null && Object.keys(row.sentQuery).length > 0;
    const bodySent = row.sentBody !== undefined && row.sentBody !== null;
    return querySent || bodySent;
  }
  return true;
}

/**
 * 影の仕分け。答えの形をしている本文（answerShape が null）は unknown。
 * 呼び手は 2xx で最後まで読めた空でない本文だけを渡す（answer-shape.ts と同じ入口）。
 */
export function sortAnswerShape(row: AnswerShapeSortRow): AnswerShapeSort {
  if (!row.answerShape) return "unknown";
  // refused は、それだけで「宣言したクエリを送っていない」。
  if (row.requestQuery === "refused") return "vet402_input";
  if (sentPlaceholder(row)) return "vet402_input";
  if (namedFieldNotSent(row)) return "vet402_input";

  const fault = hasWord(row.bodyHead, ANSWER_SHAPE_SORT_WORDS.inputFault);
  const missed = inputNotSent(row);
  if (missed && (fault || row.answerShape === "empty_structure")) return "vet402_input";
  if (typeMismatch(row)) return "vet402_input";
  // 例と同じ値を送ったことは、売り手が悪い根拠にしない。落ち度の語があるなら見本を送った側。
  if (sentEqualsExample(row) && fault) return "vet402_input";

  if (successFalseOutage(row.bodyHead) || htmlTitleIs5xx(row.bodyHead)) return "unknown";
  // 落ち度の語があるのに、上で vet402 の誤りと示せなかった。業務上の no にも売り手にもしない。
  if (fault) return "unknown";
  if (row.answerShape === "empty_structure" && emptyConsistent(row)) return "valid_answer";
  if (isBusinessNo(row.bodyHead)) return "valid_answer";
  if (row.answerShape === "html_page") {
    if (isSiteShell(row.bodyHead) || hasScriptSrc(row.bodyHead)) return "unknown";
    if ((row.requestQuery === "declared" || row.requestBody === "declared") && visibleText(row.bodyHead).length > 0) {
      return "valid_answer";
    }
    return "unknown";
  }
  if ((row.answerShape === "error_object" || row.answerShape === "error_flag") && !missed && declaredRealInput(row)) {
    return "seller_suspect";
  }
  return "unknown";
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function inputProperties(schema: unknown): Record<string, unknown> | null {
  return rec(rec(rec(rec(schema)?.properties)?.input)?.properties);
}

/** カタログの declared_schema から、仕分けが使う宣言だけを取る。 */
export function declarationFromSchema(schema: unknown): {
  required: { query: string[]; body: string[] };
  bodyType: string | null;
  outputType: string | null;
  fields: AnswerShapeSortField[];
} {
  const props = inputProperties(schema);
  const queryParams = rec(props?.queryParams);
  const body = rec(props?.body);
  const example = rec(rec(rec(rec(schema)?.properties)?.output)?.properties)?.example;
  const fields: AnswerShapeSortField[] = [];
  const take = (bag: Record<string, unknown> | null, where: "query" | "body") => {
    if (!bag) return;
    for (const [name, raw] of Object.entries(bag)) {
      const field = rec(raw);
      fields.push({
        name,
        in: where,
        type: typeof field?.type === "string" ? field.type : null,
        example: field && "example" in field ? field.example : null,
      });
    }
  };
  take(rec(queryParams?.properties), "query");
  take(rec(body?.properties), "body");
  return {
    required: { query: stringList(queryParams?.required), body: stringList(body?.required) },
    bodyType: typeof body?.type === "string" ? body.type : null,
    outputType: typeof rec(example)?.type === "string" ? (rec(example)!.type as string) : null,
    fields,
  };
}

function parseSentQuery(query: string | null): Record<string, string> | null {
  if (query === null || query === "") return null;
  const out: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (part === "") continue;
    const at = part.indexOf("=");
    const name = decodeURIComponent((at === -1 ? part : part.slice(0, at)).replace(/\+/g, " "));
    const value = decodeURIComponent((at === -1 ? "" : part.slice(at + 1)).replace(/\+/g, " "));
    if (name !== "") out[name] = value;
  }
  return out;
}

function parseSentBody(body: string | null): unknown {
  if (body === null) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * ランナーが持っているもの（本文の頭・送ったチャネル・カタログの schema・実際に送った文字列）から仕分ける。
 * declared_input 列は候補 SQL に無いので null。必須項目は schema から取る。
 */
export function sortAnswerShapeFromRun(input: {
  answerShape: AnswerShape;
  bodyHead: string;
  requestQuery: "declared" | "empty" | "refused" | null;
  requestBody: "declared" | "empty" | "none" | null;
  declaredSchema: unknown;
  declaredInput?: { query: "declared" | "empty" | "refused"; body: "declared" | "empty" } | null;
  sentQuery?: string | null;
  sentBody?: string | null;
}): AnswerShapeSort {
  const decl = declarationFromSchema(input.declaredSchema);
  return sortAnswerShape({
    answerShape: input.answerShape,
    bodyHead: input.bodyHead,
    requestQuery: input.requestQuery,
    requestBody: input.requestBody,
    declaredInput: input.declaredInput ?? null,
    required: decl.required,
    bodyType: decl.bodyType,
    outputType: decl.outputType,
    fields: decl.fields,
    sentQuery: parseSentQuery(input.sentQuery ?? null),
    sentBody: parseSentBody(input.sentBody ?? null),
  });
}

/**
 * 仕分けが落ちたら unknown。支払い済みの行の記録（status・tx）を巻き込まない。
 * l1-runner は answerShape を書く直前に、この関数で sortAnswerShapeFromRun を囲む。
 */
export function sortAnswerShapeCaught(sort: () => AnswerShapeSort): AnswerShapeSort {
  try {
    return sort();
  } catch {
    return "unknown";
  }
}
