// ============================================================
// L1 の POST 本文を、売り手自身の宣言から取る（Issue #29・2026-09-17）。
//
// それまで L1 は POST に常に `{}` を送っていた。方法論 §2 は「カタログの掲載は
// エンドポイントが期待する JSON 本文を教えてくれない」と書いていたが、Bazaar の
// discovery 拡張を載せた掲載はそれを宣言している: `extensions.bazaar.info.input.body`。
// 同じ宣言は L1 が最初に取りに行く無払いの 402 応答（PAYMENT-REQUIRED ヘッダの
// base64 JSON、または本文の JSON）にも載っているので、スキーマを変えずに読める。
// 2026-09-16 実測: Bazaar 16,062 件中 6,683 件（41.6%）が input.body を宣言。
//
// 規則（ここが正典）:
//   - 読むのは parseChallenge が支払い条件を取ったのと**同じ文書**だけ
//     （ヘッダが accepts を持てばヘッダ、無ければ本文）。別の文書の宣言を混ぜない。
//   - body が JSON の object か array で、JSON 文字列にして 16KB（バイト）以下なら
//     それを送る。**中身は書き換えない**（補完・既定値の注入をしない）。
//   - それ以外（宣言なし・null・スカラー・16KB 超・壊れた JSON）は従来どおり `{}`。
//
// 無払いの要求の本文は `{}` のまま（l1-runner のコメント参照）: 宣言はこの 402 応答を
// 読んで初めて手に入るので、その前に送れる本文は無い。
// ============================================================
import { parseChallenge } from "./x402-payer";

/** 宣言本文の上限（UTF-8 バイト）。readBodyCapped の応答上限と同じ桁。 */
export const DECLARED_BODY_MAX_BYTES = 16 * 1024;

export type RequestBodySource = "declared" | "empty";

export type DeclaredRequestBody = { body: string; source: RequestBodySource };

const EMPTY: DeclaredRequestBody = { body: "{}", source: "empty" };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** parseChallenge が採用する文書（ヘッダ優先・次に本文）を、同じ関数で決める。 */
function challengeDocument(input: { bodyText: string; headers: Headers }): unknown {
  const headerB64 = input.headers.get("PAYMENT-REQUIRED");
  if (headerB64) {
    const headerOnly = parseChallenge({ bodyText: "", headers: input.headers });
    if (headerOnly) {
      try {
        return JSON.parse(Buffer.from(headerB64, "base64").toString("utf8"));
      } catch {
        return undefined;
      }
    }
  }
  if (input.bodyText && parseChallenge({ bodyText: input.bodyText, headers: new Headers() })) {
    return parseJson(input.bodyText);
  }
  return undefined;
}

export function declaredRequestBody(input: { bodyText: string; headers: Headers }): DeclaredRequestBody {
  const doc = asRecord(challengeDocument(input));
  const bazaar = asRecord(asRecord(doc?.extensions)?.bazaar);
  const declared = asRecord(asRecord(bazaar?.info)?.input)?.body;
  if (typeof declared !== "object" || declared === null) return EMPTY;
  let body: string;
  try {
    body = JSON.stringify(declared);
  } catch {
    return EMPTY;
  }
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > DECLARED_BODY_MAX_BYTES) return EMPTY;
  return { body, source: "declared" };
}

// ============================================================
// 支払い付き要求のクエリを、売り手自身の宣言から取る（2026-09-20）。
//
// 本文と同じ宣言の隣に、GET の売り手は `extensions.bazaar.info.input.queryParams` を
// 「名前 → 例の値」で載せている。L1 はこれを読まず、カタログの URL のまま払っていた。
// 2026-09-20 実測（本番・XRPL レーンの直近 6 件中 4 件）: 売り手は必須のクエリが無い有料の
// 要求を、決済せずに 400（missing_parameter 等）で返した。4 件とも、無払いの 402 は
// その名前と値を宣言していた（例: `{ exchange: "NYSE", at: "2026-12-25T14:30:00Z" }`）。
// カタログ全体では active 15,960 行中 2,305 行のスキーマが必須のクエリを宣言している。
//
// 規則（本文の規則と揃える・ここが正典）:
//   - 読むのは parseChallenge が支払い条件を取ったのと**同じ文書**だけ。
//   - 送るのは `info.input.queryParams` に**実在する名前と値だけ**。スキーマ
//     （`bazaar.schema` / カタログの declared_schema）の required・enum・default・
//     description の "e.g." から値を作らない。宣言に無い必須の名前は埋めない。
//   - 値は文字列・有限の数・真偽値だけ（String() にして送る）。それ以外の値や空の名前が
//     1 つでもあれば**宣言ごと使わない**（一部だけ送って別の要求を作らない）。
//   - カタログの URL に既にある名前は足さない（掲載された URL が先）。既存のクエリ文字列は
//     書き換えない——後ろに足すだけ。ホスト・経路は変わらない（変わったら使わない）。
//   - 「同じ名前」は畳んでから比べる（2026-09-20 独立レビュー W-1）: 前後の空白を落とし、小文字にし、
//     空白・ドット・`[` を `_` にする。裏側がクエリ名を大小無視で引く（ASP.NET 等）か、PHP のように
//     空白とドットを `_` に畳むと、`SYMBOL=TSLA` は掲載の `symbol=AAPL` を実質上書きし、台帳は
//     `symbol=AAPL` の行のまま別のものを買う。畳んで衝突する名前は足さない。**宣言の名前どうしが
//     畳んだ後に衝突するなら宣言ごと使わない**（どちらが効くかを裏側の実装に委ねない）。
//   - 上限: 名前 32 個・足すクエリ 2KB・URL 全体 4KB（いずれも符号化後のバイト数）。
//     超えたら宣言ごと使わない。
//   - 無払いの要求はカタログの URL のまま（宣言はその 402 を読んで初めて手に入る）。
//   - 転送: safe-fetch は Location を自分で解決し、こちらのクエリを次のホップへ持ち越さない。
//     足した値が別オリジンへ出るのは売り手の Location がそれを書いたときだけで、値はもともと
//     売り手が公開の 402 で宣言したもの。ホップごとの SSRF 検査は従来どおり全ホップに掛かる。
//   - 署名するもの（額・宛先・封筒の resource.url）には触らない。呼び手は URL だけを差し替える。
// ============================================================

/** 足すクエリ文字列の上限（符号化後・バイト）。 */
export const DECLARED_QUERY_MAX_BYTES = 2 * 1024;
/** 宣言された名前の数の上限。 */
export const DECLARED_QUERY_MAX_PARAMS = 32;
/** クエリを足した後の URL 全体の上限（バイト）。 */
export const DECLARED_URL_MAX_BYTES = 4 * 1024;

export type RequestQuerySource = "declared" | "empty";

/** `query` は URL に足した文字列そのもの（`?`/`&` を除く・符号化後）。足していなければ null。行に残す SHA-256 の元。 */
export type DeclaredRequestUrl = { url: string; source: RequestQuerySource; query: string | null };

/** クエリ名の畳み方（上の規則）。比べるためだけに使い、送る名前は宣言のまま。 */
function foldQueryName(name: string): string {
  return name.trim().toLowerCase().replace(/[ .[]/g, "_");
}

/**
 * 最後の関門: 出来た URL が掲載の URL と違うのはクエリ（とフラグメント）だけか。
 * いまの組み立て（フラグメントを落として後ろに足す）ではここで落ちる入力を作れない。それでも置くのは、
 * 将来組み立て方を変えたときに、払う先が動く不具合を黙って通さないため（tests が直接叩いて固定）。
 */
export function onlyQueryAdded(listed: URL, built: URL): boolean {
  return (
    built.origin === listed.origin &&
    built.pathname === listed.pathname &&
    built.username === listed.username &&
    built.password === listed.password
  );
}

function scalarToQueryValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function declaredRequestUrl(input: { resourceUrl: string; bodyText: string; headers: Headers }): DeclaredRequestUrl {
  const unchanged: DeclaredRequestUrl = { url: input.resourceUrl, source: "empty", query: null };
  const doc = asRecord(challengeDocument(input));
  const bazaar = asRecord(asRecord(doc?.extensions)?.bazaar);
  const declared = asRecord(asRecord(asRecord(bazaar?.info)?.input)?.queryParams);
  if (!declared) return unchanged;
  const entries = Object.entries(declared);
  if (entries.length === 0 || entries.length > DECLARED_QUERY_MAX_PARAMS) return unchanged;

  let listed: URL;
  try {
    listed = new URL(input.resourceUrl);
  } catch {
    return unchanged;
  }

  const listedNames = new Set([...listed.searchParams.keys()].map(foldQueryName));
  const declaredNames = new Set<string>();
  const add = new URLSearchParams();
  for (const [name, raw] of entries) {
    const value = scalarToQueryValue(raw);
    const folded = foldQueryName(name);
    if (name.length === 0 || folded.length === 0 || value === null) return unchanged;
    if (declaredNames.has(folded)) return unchanged;
    declaredNames.add(folded);
    if (listedNames.has(folded)) continue;
    add.append(name, value);
  }
  const query = add.toString();
  if (query.length === 0 || Buffer.byteLength(query, "utf8") > DECLARED_QUERY_MAX_BYTES) return unchanged;

  // 既存の文字列は書き換えない: フラグメント（送られない部分）を落として後ろに足すだけ。
  const hashAt = input.resourceUrl.indexOf("#");
  const base = hashAt === -1 ? input.resourceUrl : input.resourceUrl.slice(0, hashAt);
  const separator = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
  const url = `${base}${separator}${query}`;
  if (Buffer.byteLength(url, "utf8") > DECLARED_URL_MAX_BYTES) return unchanged;

  // 足したのはクエリだけ、を結果の側で確かめる（ホスト・経路・認証情報が動いたら使わない）。
  let built: URL;
  try {
    built = new URL(url);
  } catch {
    return unchanged;
  }
  if (!onlyQueryAdded(listed, built)) return unchanged;
  return { url, source: "declared", query };
}
