// ============================================================
// L2（支払い付き応答と、カタログが宣言した出力の一致）の判定。2026-09-29（監査 6 周目）に l1-runner.ts から分けた。
//
// 判定の読み手（src/lib/decision/seller-facts.ts）が、支払いのモジュールを読み込まずに同じ規則で古い行を
// 読み直せるように、ここは純関数と定数だけを置く（DB も fetch も読まない）。
//
// 2026-09-29 の計器の誤り: l1-runner は支払い付き応答の本文の先頭 16,000 バイトしか読まず、長い JSON は閉じないまま
// JSON.parse に渡っていた。読めない本文は mismatch になり、しかも宣言した必須キーを全部「欠けた」と記録していた。
// 本番（SELECT のみ）: L2 = mismatch の 711 行のうち、先頭 500 文字が `{` で始まり 500 文字を超える行が 660 行。
// 欠けたキーを記録した 77 出品（公開の判定で BLOCK）のうち 70 出品はこの形で、うち 34 出品は「欠けた」はずの
// キーが先頭 500 文字に実際に入っていた（売り手への冤罪）。直したこと:
//   1. 読む上限を 256 KiB に上げ、超えた本文は判定しない（not_checked・body_over_cap）。本文の読み取りが途中で
//      落ちた応答も、1 バイト以上受け取っていれば判定しない（body_timeout / body_read_error）。数えるのは生のバイト。
//   2. JSON として読めない本文からは欠けたキーを作らない。最後まで読めた本文が JSON として読めない（閉じていない等）
//      のは売り手の不具合なので mismatch（unparseable・欠けたキーは空＝判定は l2_mismatch_unexplained の WARN）。
//   3. 印（reason）の無い古い行は legacyL2SchemaOf で読み直す（seller-facts が使う）。not_checked にするのは
//      切れた証拠（記録した欠けたキーが、保存した本文の頭の最上位に見える）がある行だけ（独立レビュー BLOCK 2026-09-29）。
// ============================================================
import { createHash } from "node:crypto";

/**
 * 支払い付き応答の本文を読む上限（バイト）。2026-09-29 まで 16,000 だった。上限そのものは残す
 * （readBodyCapped の目的＝敵対的な巨大本文でメモリを食わせない）。読む時間は要求の timeoutMs が本文の読み取りまで覆う。
 */
export const L1_PAID_BODY_CAP_BYTES = 256 * 1024;
/** 上限の変更が本番に載る日（UTC）。これより前の行は 16,000 バイトで読んだ行。 */
export const L1_PAID_BODY_CAP_RAISED_ON = "2026-09-29";
/** 16,000 バイトで読んでいた頃の上限（古い行を説明する側が使う）。 */
export const L1_LEGACY_PAID_BODY_CAP_BYTES = 16_000;
/** L0 の BODY_OVER_CAP_REASON（l0-probe.ts）と同じ語。 */
export const L1_BODY_OVER_CAP_REASON = "body_over_cap" as const;
/** raw_response_meta.bodyHead に残す本文の先頭の長さ（JS の文字数・l1-runner の slice(0, 500)）。 */
export const BODY_HEAD_CHARS = 500;

/** L2 を判定しなかった理由（本文を読み切れなかった）。 */
export type L2NotCheckedReason = typeof L1_BODY_OVER_CAP_REASON | "body_timeout" | "body_read_error" | "legacy_body_cut";
/**
 * L2 の判定が何で決まったか（raw_response_meta.l2.reason・2026-09-29 から）。これより前の行には無い。
 *   not_json_content_type  必須キーを宣言しているのに Content-Type が JSON でない（mismatch）
 *   not_json_body          Content-Type は JSON だが、本文が JSON の頭（{ か [）ですらない（mismatch）
 *   unparseable            最後まで読めた本文が JSON の頭で始まるが JSON として読めない（閉じていない等。mismatch）
 *   not_object             JSON だがオブジェクトでも配列でもない（数値・文字列・null。mismatch）
 *   missing_keys           JSON として読め、宣言した必須キーが欠けている（mismatch・欠けたキーを記録）
 *   body_over_cap          本文が上限を超えた（not_checked）
 *   body_timeout / body_read_error  本文を 1 バイト以上受け取った後で時間切れ・切断（not_checked）
 *   legacy_body_cut        古い行の読み直しで、切れた証拠がある（not_checked・legacyL2SchemaOf だけが返す）
 */
export type L2Reason =
  | "not_json_content_type"
  | "not_json_body"
  | "not_object"
  | "missing_keys"
  | "unparseable"
  | L2NotCheckedReason;

/** raw_response_meta.l2 の形（seller-facts.ts の parseL2Detail が読む。reason は 2026-09-29 から）。 */
export type L2Detail = { missing: string[]; declarationHash: string | null; responseHash: string; reason: L2Reason | null };

/** 本文の読み取りの失敗が時間切れ（AbortController の abort・タイムアウト）か。 */
export function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * 読んだ本文（上限 + 1 バイトまで）から、L2 に渡す本文・記録するバイト数・読み切れたかを出す。純関数。
 * `rawBytes` は受け取った生のバイト数（readBodyCappedDetailed の bytes）。`failure` は本文の読み取りの失敗（無ければ null）。
 * 失敗しても 0 バイトなら従来どおり空の本文として扱う（incomplete は null）。
 */
export function paidBodyReadOf(
  text: string,
  rawBytes: number,
  failure: unknown | null,
): { body: string; bytes: number; incomplete: L2NotCheckedReason | null } {
  if (rawBytes > L1_PAID_BODY_CAP_BYTES) {
    return { body: text, bytes: L1_PAID_BODY_CAP_BYTES, incomplete: L1_BODY_OVER_CAP_REASON };
  }
  if (failure !== null && failure !== undefined && rawBytes > 0) {
    return { body: text, bytes: rawBytes, incomplete: isTimeoutError(failure) ? "body_timeout" : "body_read_error" };
  }
  return { body: text, bytes: rawBytes, incomplete: null };
}

/** 宣言（カタログの schema）の output から、必須キーと例のプロパティを取り出す。 */
export function declaredOutputOf(declaredSchema: unknown): { requiredKeys: string[]; exampleProps: Record<string, unknown> | null } {
  const schema = typeof declaredSchema === "object" && declaredSchema !== null ? (declaredSchema as Record<string, unknown>) : null;
  // The catalog schema wraps input/output; the OUTPUT declaration is what the
  // response must honor.
  const props = (schema?.properties ?? null) as Record<string, unknown> | null;
  const output = (props?.output ?? null) as Record<string, unknown> | null;
  const outputProps = (output?.properties ?? null) as Record<string, unknown> | null;
  const example = (outputProps?.example ?? null) as Record<string, unknown> | null;
  const exampleProps = (example?.properties ?? null) as Record<string, unknown> | null;
  const requiredKeys = Array.isArray(example?.required) ? (example!.required as unknown[]).filter((k): k is string => typeof k === "string") : [];
  return { requiredKeys, exampleProps };
}

/** 本文が JSON の頭（空白の後の { か [）で始まるか。 */
export function looksLikeJson(body: string): boolean {
  const c = body.trimStart().charAt(0);
  return c === "{" || c === "[";
}

function parsedRecord(bodyText: string): { ok: true; rec: Record<string, unknown> | null } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    // 配列も従来どおり object として扱う（キーは無いので、必須キーがあれば欠ける）。
    return { ok: true, rec: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null };
  } catch {
    return { ok: false };
  }
}

/**
 * L2 の判定（純関数）。
 *
 * 宣言が無い、または出力に必須キーも例のプロパティも無ければ no_declaration（失敗にしない。2026-09-29 まで
 * 読めない本文はこの場合も mismatch になっていた——本番の mismatch 711 行のうち 437 行）。
 * 欠けたキー（missing）は JSON として読めた本文からだけ作る。
 */
export function checkL2Detailed(
  declaredSchema: unknown,
  bodyText: string,
  contentType: string | null,
  bodyIncomplete: L2NotCheckedReason | null = null,
): { status: string; missing: string[]; declarationHash: string | null; responseHash: string; reason: L2Reason | null } {
  const schema = typeof declaredSchema === "object" && declaredSchema !== null ? (declaredSchema as Record<string, unknown>) : null;
  const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
  const out = (status: string, reason: L2Reason | null, missing: string[] = []) => ({
    status,
    missing,
    declarationHash: schema ? sha(JSON.stringify(schema)) : null,
    responseHash: sha(bodyText),
    reason,
  });
  if (!schema) return out("no_declaration", null);
  const { requiredKeys, exampleProps } = declaredOutputOf(schema);
  const missingIn = (rec: Record<string, unknown>) => requiredKeys.filter((k) => !(k in rec));

  // Content-Type だけで決まる判定は本文の長さに依らない。欠けたキーは本文が読めたときだけ並べる。
  if (!contentType?.includes("json")) {
    if (requiredKeys.length === 0) return out("no_declaration", null);
    const p = bodyIncomplete ? ({ ok: false } as const) : parsedRecord(bodyText);
    return out("mismatch", "not_json_content_type", p.ok && p.rec ? missingIn(p.rec) : []);
  }
  if (requiredKeys.length === 0 && !exampleProps) return out("no_declaration", null);
  // 本文を読み切れていなければ判定しない（切れた JSON は閉じないので、読めば必ず読めない）。
  if (bodyIncomplete) return out("not_checked", bodyIncomplete);

  const p = parsedRecord(bodyText);
  // 最後まで読めた本文が JSON として読めないのは売り手の不具合（mismatch）。欠けたキーは作らない。
  if (!p.ok) return looksLikeJson(bodyText) ? out("mismatch", "unparseable") : out("mismatch", "not_json_body");
  if (!p.rec) return out("mismatch", "not_object");
  const missing = missingIn(p.rec);
  return missing.length > 0 ? out("mismatch", "missing_keys", missing) : out("match", null);
}

/**
 * JSON の頭（途中で切れていてよい）から、根のオブジェクトの最上位のキーを拾う。根がオブジェクトでなければ空。
 * 文字列の中の括弧・エスケープは数えない。深さ 1 で「文字列の直後に : が来る」ものだけをキーとする。
 */
export function topLevelKeysOfJsonHead(head: string): Set<string> {
  const keys = new Set<string>();
  const t = head.trimStart();
  if (t.charAt(0) !== "{") return keys;
  let depth = 0;
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '"') {
      let j = i + 1;
      let raw = "";
      while (j < t.length && t[j] !== '"') {
        if (t[j] === "\\") {
          raw += t.slice(j, j + 2);
          j += 2;
        } else {
          raw += t[j];
          j += 1;
        }
      }
      if (j >= t.length) break; // 文字列の途中で切れた
      let k = j + 1;
      while (k < t.length && /\s/.test(t[k])) k++;
      if (depth === 1 && t[k] === ":") {
        try {
          keys.add(JSON.parse(`"${raw}"`) as string);
        } catch {
          keys.add(raw);
        }
      }
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return keys;
}

/**
 * 印（raw_response_meta.l2.reason）の無い古い行の L2 を読み直す（2026-09-29 より前の行・純関数）。
 *
 * 古い行は 16,000 バイトで切った本文を判定し、読めない本文でも mismatch・欠けたキー＝宣言した必須キー全部と
 * 記録していた。本文は残っていない（先頭 500 文字の bodyHead だけ）ので、次の順で読み直す:
 *   - mismatch 以外・印のある行・Content-Type が JSON でない行 → そのまま（Content-Type の判定は本文に依らない）
 *   - 出力に必須キーも例のプロパティも無い宣言 → no_declaration（今の規則でも本文に依らず no_declaration）
 *   - bodyHead が本文の全部（500 文字未満）→ 今の規則で判定し直す（閉じていない JSON は mismatch・欠けたキーは空）
 *   - それより長い本文: 記録した欠けたキーのどれかが bodyHead の最上位に見える → 切れた証拠（キーはあるのに
 *     読めなかった）なので not_checked（legacy_body_cut）。それ以外はそのまま mismatch（例: 必須キーが output の
 *     下にある本物の不一致・api.agentsouk.dev）。欠けたキーの記録が無い行もそのまま（判定は l2_mismatch_unexplained）。
 */
export function legacyL2SchemaOf(input: {
  l2Schema: string | null;
  l2Reason: string | null | undefined;
  missing: readonly string[] | null | undefined;
  bodyHead: string | null | undefined;
  contentType: string | null | undefined;
  declaredSchema: unknown;
}): { l2Schema: string | null; missing: string[] | null; reason: L2Reason | null } {
  const keep = { l2Schema: input.l2Schema, missing: input.missing ? [...input.missing] : null, reason: (input.l2Reason ?? null) as L2Reason | null };
  if (input.l2Schema !== "mismatch" || input.l2Reason) return keep;
  if (!input.contentType?.includes("json")) return keep;
  const { requiredKeys, exampleProps } = declaredOutputOf(input.declaredSchema);
  if (requiredKeys.length === 0 && !exampleProps) return { l2Schema: "no_declaration", missing: null, reason: null };
  const head = input.bodyHead ?? "";
  if (head !== "" && head.length < BODY_HEAD_CHARS) {
    const d = checkL2Detailed(input.declaredSchema, head, input.contentType);
    return { l2Schema: d.status, missing: d.status === "mismatch" ? d.missing : null, reason: d.reason };
  }
  const missing = input.missing ?? [];
  if (missing.length === 0) return keep;
  const top = topLevelKeysOfJsonHead(head);
  if (missing.some((k) => top.has(k))) return { l2Schema: "not_checked", missing: null, reason: "legacy_body_cut" };
  return keep;
}
