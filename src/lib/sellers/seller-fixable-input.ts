// ============================================================
// S1-1: 決済済みの 400/422 のうち、宣言された入力を送り、売り手の答えが入力の検証エラーと
// 読める行だけを /sellers で売り手側へ。held_reason（delivery.ts）は変えない。
// 判定の順と証拠の確認は fix-modes.ts の modeKeyOf が持つ。ここは答えの読み方と宣言の有無だけ。
// 許可リスト: 場所は英数と _ のみ。pydantic は loc が 2 段以上。json_invalid と model_attributes_type を除く。
// generic は location または in が body か query のときだけ。認証語は auth|secret|password|credential|bearer|jwt|session|key$。
// ============================================================
import { requestBodyKindOf } from "@/lib/observatory/request-body";
import type { SellerRowFacts } from "./fix-modes";

const BAD_ROOT = new Set(["header", "headers", "cookie", "cookies", "payment", "x402", "signature", "authorization"]);
const PYDANTIC_SKIP_TYPES = new Set(["json_invalid", "model_attributes_type"]);
const SEG_OK = /^[A-Za-z0-9_]+$/;
const AUTH_SEG = /auth|secret|password|credential|bearer|jwt|session|key$/i;

/** 402 が入力（本文かクエリ）を宣言し、vet402 がその宣言どおりの値を送ったと行に記録がある。 */
export function declaredInputWasSent(r: Pick<SellerRowFacts, "meta">): boolean {
  return requestBodyKindOf(r.meta) === "declared" || r.meta?.requestQuery === "declared";
}

function bodyHeadOf(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const h = (meta as Record<string, unknown>).bodyHead;
  return typeof h === "string" ? h : null;
}

function segmentOk(seg: string): boolean {
  if (!SEG_OK.test(seg)) return false;
  const lower = seg.toLowerCase();
  if (BAD_ROOT.has(lower)) return false;
  if (AUTH_SEG.test(lower)) return false;
  return true;
}

function locOk(segments: string[]): boolean {
  if (segments.length < 2) return false;
  const first = segments[0].toLowerCase();
  if (first !== "body" && first !== "query" && first !== "path") return false;
  return segments.every(segmentOk);
}

type ValItem = { kind: "pydantic" | "zod" | "generic"; segments: string[] };

function zodIssues(arr: unknown[]): ValItem[] | null {
  const items: ValItem[] = [];
  for (const it of arr) {
    if (typeof it !== "object" || it === null) return null;
    const z = it as Record<string, unknown>;
    if (!Array.isArray(z.path) || typeof z.code !== "string") return null;
    const segments = z.path.map(String);
    if (!locOk(segments)) return null;
    items.push({ kind: "zod", segments });
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
      if (typeof d.type === "string" && PYDANTIC_SKIP_TYPES.has(d.type)) continue;
      const segments = d.loc.map(String);
      if (!locOk(segments)) return null;
      items.push({ kind: "pydantic", segments });
    }
    return items.length > 0 ? items : null;
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
      let scope: string | null = null;
      if (typeof e.in === "string") scope = e.in.toLowerCase();
      else if (typeof e.location === "string") scope = e.location.toLowerCase();
      if (scope !== "body" && scope !== "query") return null;

      let tail: string[] | null = null;
      if (Array.isArray(e.path)) tail = e.path.map(String);
      else if (typeof e.field === "string") tail = [e.field];
      else if (typeof e.param === "string") tail = [e.param];
      if (!tail) return null;

      const segments = [scope, ...tail];
      if (!locOk(segments)) return null;
      items.push({ kind: "generic", segments });
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
  return items.every((it) => locOk(it.segments));
}
