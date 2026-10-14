// ============================================================
// 払った後に 2xx で返ってきた本文が「答えの形をしていない」かを見る（2026-10-15・影の記録だけ）。
//
// なぜ: 「届いた」（決済済み・2xx・本文が空でない）に数えた答えの中に、200 で返るエラーの本体
// （{"error":"missing 'symbol'"}）、ok:false の失敗の印、HTML のページ、空の箱（{"data":[]}）が混ざる。
// 10/15 に直近 30 日の 5,729 行を保存済みの本文の頭で数えると、約 1.2%（68 行・延べ 24 ホスト。この 4 型だけで数えた値）がこの形だった
// （Takeshi_Automation/output/1015/junk_census_result.txt）。外の作り手（@ziggydakid）も
// 「一番よく見るのは 200 の中のエラー文」と言っている。
//
// 影の記録: ここでの判定は raw_response_meta.answerShape に残すだけ。status・L2・公開の判定（BLOCK 等）は
// 変えない。理由: 200 の中のエラーの多くは vet402 が宣言された入力を送らなかったせいで起きる
// （missing agentId 等）。誰の側の失敗かを切り分ける前に売り手の失点にすると冤罪になる
// （2026-09-29 の L2 の冤罪 34 出品と同じ型）。数週分を貯め、切り分けの規則を独立レビューに通してから公開に使う。
//
// 規則は控えめにする（誤って「ゴミ」と言わない側に倒す）:
//   error_object     最上位が JSON のオブジェクトで、中身のある鍵がエラーの鍵（error 等）とその添え物だけ
//   error_flag       最上位に ok:false / success:false / status:"error"|"fail"|"failed" がある
//   html_page        本文が HTML の文書（<!doctype html / <html で始まる）
//   empty_structure  {} / [] / null / "" か、{"data"|"result"|"results"|"items": [] | {} | null} だけ
// 文の中の "rate limit" "timeout" 等の言葉だけで決める規則は入れない（10/15 の実測で半分ほどが誤検出だった）。
// ============================================================

export type AnswerShape = "error_object" | "error_flag" | "html_page" | "empty_structure";

/** エラーを表す最上位の鍵（小文字で比べる）。 */
const ERROR_KEYS = new Set(["error", "errors", "validationerrors", "err", "error_message", "errormessage"]);
/** エラーの本体に添えられがちな鍵。これ以外の鍵が 1 つでもあれば、答えの中身を持つとみなして error_object にしない。 */
const ERROR_COMPANION_KEYS = new Set([
  "code",
  "message",
  "status",
  "statuscode",
  "success",
  "ok",
  "detail",
  "details",
  "request_id",
  "requestid",
  "timestamp",
  "hint",
  "docs",
]);
const EMPTY_WRAPPER_KEYS = new Set(["data", "result", "results", "items"]);

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

function parseJson(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

/**
 * 2xx の本文が答えの形をしていなければ、その型を返す。普通の答え・判定できない本文は null。
 * 呼び手は「本文を最後まで読めた・空でない・2xx」のときだけ呼ぶこと（読み切れない本文は判定しない）。
 */
export function answerShapeOf(body: string, contentType: string | null): AnswerShape | null {
  const text = body.trim();
  if (text.length === 0) return null; // 空は payload_non_empty が既に扱う
  const lower = text.slice(0, 32).toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) return "html_page";

  const looksJson = text.startsWith("{") || text.startsWith("[") || (contentType ?? "").toLowerCase().includes("json");
  if (!looksJson) return null;
  const parsed = parseJson(text);
  if (!parsed.ok) return null; // 読めない JSON は L2 の担当（unparseable）

  const v = parsed.value;
  if (isEmptyValue(v)) return "empty_structure";
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;

  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  const lowerKeys = keys.map((k) => k.toLowerCase());

  // {"data": []} のように、包みの鍵 1 つだけで中身が空。
  if (keys.length === 1 && EMPTY_WRAPPER_KEYS.has(lowerKeys[0]) && isEmptyValue(obj[keys[0]])) return "empty_structure";

  const errorKeys = keys.filter((k) => ERROR_KEYS.has(k.toLowerCase()));
  const hasErrorContent = errorKeys.some((k) => !isEmptyValue(obj[k]) && obj[k] !== false);
  const onlyErrorAndCompanions = lowerKeys.every((k) => ERROR_KEYS.has(k) || ERROR_COMPANION_KEYS.has(k));
  if (hasErrorContent && onlyErrorAndCompanions) return "error_object";

  const status = typeof obj.status === "string" ? obj.status.toLowerCase() : null;
  if (obj.ok === false || obj.success === false || status === "error" || status === "fail" || status === "failed") {
    return "error_flag";
  }
  return null;
}
