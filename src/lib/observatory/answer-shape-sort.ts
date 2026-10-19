// ============================================================
// 答えの形をしていない有料の 2xx を、影の記録の中だけで仕分ける（2026-10-19・段S1）。
//
// 公開はしない。status・L2・/sellers・export・判定 API は変えない。raw_response_meta.answerShapeSort に残すだけ。
// 規則は 2026-09-15〜10-15 の 68 件を人が仕分けた理由（vet402 42・正当 17・売り手 4・判断できない 5）から取る。
// キーワードは下の定数だけ。本文の「rate limit」等では決めない（answer-shape.ts と同じく、言葉だけの規則は誤検出が多かった）。
//
// 決め方（先に当たったもの）:
//   vet402_input    本文が missing/required/invalid/validation を含み、宣言どおり送っていないか、送った値が宣言の型・例と違う。
//                   または empty_structure で、宣言の必須入力を送っていない（空の data に必須の id が無い、生の本文を {} で送った）。
//   valid_answer    必須は送ってあり、空の配列・空の結果が宣言の出力の型と矛盾しない。業務上の「no」（ok:false かつ changed:false 等、
//                   エラー文が無い）。宣言どおり送った結果の HTML で、売り手のサイト枠（/_next/ 等）ではないもの。
//   seller_suspect  宣言どおり送った（送るものが無い含む）のに error_object / error_flag / html_page。
//   unknown         サイト枠の HTML、材料が足りないもの。
// ============================================================

import type { AnswerShape } from "./answer-shape";

/** 仕分けの語。ここ以外にキーワードを置かない。 */
export const ANSWER_SHAPE_SORT_WORDS = {
  /** 本文が入力の落ち度を名指す語。missing_agentId・field_required・validationErrors のように、語の一部でも当たる。 */
  inputFault: ["missing", "required", "invalid", "validation"],
  /** 送った値が違う、と本文が言っている印。 */
  badValue: ["invalid", "validation", "wrong_"],
  /** 売り手のサイトそのもの。API が返した文書（取得した頁・図）とは分ける。 */
  siteShell: ["/_next/", "__next", "__variable_"],
} as const;

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
  const q = row.declaredInput?.query;
  if (q === "declared" || q === "refused") return true;
  return row.required.query.length > 0;
}

function expectsBody(row: AnswerShapeSortRow): boolean {
  if (row.declaredInput?.body === "declared") return true;
  return row.required.body.length > 0 || row.bodyType === "string";
}

/** 宣言された入力を、その行は送っていない。 */
function inputNotSent(row: AnswerShapeSortRow): boolean {
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

function sameValue(sent: unknown, example: unknown): boolean {
  if (sent === example) return true;
  if (typeof example === "number" && typeof sent === "string" && sent.trim() !== "" && Number(sent) === example) return true;
  if (typeof example === "boolean" && (sent === "true" || sent === "false")) return sent === String(example);
  if (typeof example === "string" && (typeof sent === "number" || typeof sent === "boolean")) return String(sent) === example;
  return false;
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

/** 送った値を宣言の型・例と比べる。比べる材料が無いときは "none"。 */
function compareSent(row: AnswerShapeSortRow): "mismatch" | "match" | "none" {
  const fields = row.fields ?? [];
  if (fields.length === 0) return "none";
  let checked = 0;
  for (const field of fields) {
    const sent = readSent(row, field);
    if (sent === undefined) continue;
    checked += 1;
    if (field.example !== undefined && field.example !== null && !sameValue(sent, field.example)) return "mismatch";
    if (field.type && !matchesType(sent, field.type)) return "mismatch";
  }
  return checked > 0 ? "match" : "none";
}

function textSaysBadValue(body: string): boolean {
  if (hasWord(body, ANSWER_SHAPE_SORT_WORDS.badValue)) return true;
  return /"actual"\s*:\s*(?:""|\[\]|null)/.test(body);
}

/** 送った値が宣言の型・例と違う。本文がそう言っているときも含む。 */
function valueDiffers(row: AnswerShapeSortRow): boolean {
  const compared = compareSent(row);
  if (compared === "mismatch") return true;
  if (compared === "match") return textSaysBadValue(row.bodyHead);
  if (textSaysBadValue(row.bodyHead)) return true;
  // 宣言のチャネルは送った記録があるのに、本文が missing と言う。中身を持っていないので、例と違うとみなす。
  if (lower(row.bodyHead).includes("missing") && (row.requestQuery === "declared" || row.requestBody === "declared")) return true;
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

function isSiteShell(body: string): boolean {
  return hasWord(body, ANSWER_SHAPE_SORT_WORDS.siteShell);
}

/**
 * 影の仕分け。答えの形をしている本文（answerShape が null）は unknown。
 * 呼び手は 2xx で最後まで読めた空でない本文だけを渡す（answer-shape.ts と同じ入口）。
 */
export function sortAnswerShape(row: AnswerShapeSortRow): AnswerShapeSort {
  if (!row.answerShape) return "unknown";
  const fault = hasWord(row.bodyHead, ANSWER_SHAPE_SORT_WORDS.inputFault);
  const missed = inputNotSent(row);
  if ((fault && (missed || valueDiffers(row))) || (row.answerShape === "empty_structure" && missed)) return "vet402_input";
  if (row.answerShape === "empty_structure" && emptyConsistent(row)) return "valid_answer";
  if (isBusinessNo(row.bodyHead)) return "valid_answer";
  if (row.answerShape === "html_page") {
    if (isSiteShell(row.bodyHead)) return "unknown";
    if (row.requestQuery === "declared" || row.requestBody === "declared") return "valid_answer";
  }
  if (
    (row.answerShape === "error_object" || row.answerShape === "error_flag" || row.answerShape === "html_page") &&
    !missed
  ) {
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
