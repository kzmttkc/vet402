// ============================================================
// S1-1: 決済済みの 400/422 のうち、宣言された入力を送り、売り手の答えが入力の検証エラーと
// 読める行だけを /sellers で売り手側へ。held_reason（delivery.ts）は変えない。
// 判定の順と証拠の確認は fix-modes.ts の modeKeyOf が持つ。ここは答えの読み方と宣言の有無だけ。
// 2026-11-08: 自由文は読まない。JSON でパースでき、検証フレームワークの構造化エラー形だけを採る。
// ============================================================
import { requestBodyKindOf } from "@/lib/observatory/request-body";
import type { SellerRowFacts } from "./fix-modes";

const BAD_SEG = new Set(["header", "headers", "cookie", "cookies"]);
const BAD_IN_SEG =
  /payment|x402|signature|authorization|token|api_key|apikey|x-api-key|accepts|validbefore|validafter|nonce/i;

/** 402 が入力（本文かクエリ）を宣言し、vet402 がその宣言どおりの値を送ったと行に記録がある。 */
export function declaredInputWasSent(r: Pick<SellerRowFacts, "meta">): boolean {
  return requestBodyKindOf(r.meta) === "declared" || r.meta?.requestQuery === "declared";
}

function bodyHeadOf(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const h = (meta as Record<string, unknown>).bodyHead;
  return typeof h === "string" ? h : null;
}

function segBad(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (BAD_SEG.has(lower)) return true;
  return BAD_IN_SEG.test(lower);
}

function segmentsOk(segments: string[], pydanticFirst: boolean): boolean {
  if (segments.length === 0) return false;
  if (pydanticFirst) {
    const first = segments[0].toLowerCase();
    if (first !== "body" && first !== "query" && first !== "path") return false;
  }
  return segments.every((s) => !segBad(s));
}

type ValItem = { kind: "pydantic" | "zod" | "generic"; segments: string[] };

function zodIssues(arr: unknown[]): ValItem[] | null {
  const items: ValItem[] = [];
  for (const it of arr) {
    if (typeof it !== "object" || it === null) return null;
    const z = it as Record<string, unknown>;
    if (!Array.isArray(z.path) || typeof z.code !== "string") return null;
    items.push({ kind: "zod", segments: z.path.map(String) });
  }
  return items.length > 0 ? items : null;
}

function extractValidationItems(parsed: unknown): ValItem[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;

  if (Array.isArray(o.detail) && o.detail.length > 0) {
    const items: ValItem[] = [];
    for (const it of o.detail) {
      if (typeof it !== "object" || it === null) return null;
      const d = it as Record<string, unknown>;
      if (!Array.isArray(d.loc) || typeof d.msg !== "string") return null;
      items.push({ kind: "pydantic", segments: d.loc.map(String) });
    }
    return items;
  }

  if (Array.isArray(o.issues) && o.issues.length > 0) {
    return zodIssues(o.issues);
  }

  if (typeof o.error === "object" && o.error !== null) {
    const e = o.error as Record<string, unknown>;
    if (Array.isArray(e.issues) && e.issues.length > 0) {
      return zodIssues(e.issues);
    }
  }

  if (Array.isArray(o.errors) && o.errors.length > 0) {
    const items: ValItem[] = [];
    for (const it of o.errors) {
      if (typeof it !== "object" || it === null) return null;
      const e = it as Record<string, unknown>;
      let segs: string[] | null = null;
      if (Array.isArray(e.path)) segs = e.path.map(String);
      else if (typeof e.field === "string") segs = [e.field];
      else if (typeof e.param === "string") segs = [e.param];
      else if (typeof e.property === "string") segs = [e.property];
      if (!segs) return null;
      items.push({ kind: "generic", segments: segs });
    }
    return items;
  }

  return null;
}

/**
 * 有料の要求への答えの先頭（bodyHead）が、構造化された入力検証エラーと読める。
 * JSON.parse できない答え（切れ・HTML・自由文）は読まない。
 */
export function paidAnswerNamesInputError(meta: unknown): boolean {
  const head = bodyHeadOf(meta)?.trim();
  if (!head) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(head);
  } catch {
    return false;
  }
  const items = extractValidationItems(parsed);
  if (!items || items.length === 0) return false;
  return items.every((it) => segmentsOk(it.segments, it.kind === "pydantic"));
}
