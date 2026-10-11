// ============================================================
// 鍵なしの公開 API の呼び出し件数（2026-10-07 に Hermes だけで開始・2026-10-11 に鍵なしの全部へ）。
//
// 鍵なしの /api/v1/resolve と /api/v1/resources/{id}/decision は api_usage に残らず、Vercel のログにも
// User-Agent が出ないので、何回呼ばれたかを数える場所が無かった。10-07 は User-Agent が `vet402-hermes/` の
// 呼び出しだけを数えた。10-11 から、鍵なしの呼び出しを全部、少数の決まった名前（client）に寄せて数える。
//
// client の値（clientUsageLabel。上から順に当てる）:
//   vet402-hermes/<版> … 配布物（利用者の手元で動く）。DISTRIBUTED_CLIENTS にある名前だけ。版は数字 3 組の semver、
//                         それ以外は `<名前>/other`
//   self-monitor       … 自社のカナリアと監視。UA が `vet402-` か `kizuna-` で始まり、配布物の名前でないもの
//                         （scripts/surface-consistency-canary.ts の `vet402-surface-consistency-canary` など）。
//                         利用の数字から除くために分ける
//   crawler            … UA に bot / crawl / spider / slurp を含む
//   site               … ブラウザの UA（`Mozilla/` で始まる）で、vet402.com 自身の頁が呼んだもの
//                         （`Sec-Fetch-Site: same-origin`、または Referer が自サイト。売り手頁は判定を自動で引く）
//   browser            … それ以外のブラウザの UA
//   other              … 上のどれでもない（UA 無し・curl・node・python など。SDK と MCP サーバは UA を名乗らないのでここ）
// 保存するのは client_usage_daily の (UTC 日, client, ルート名, 件数) だけで、IP・URL・クエリ・鍵・resource_id・
// UA の生の文字列・Referer は保存しない。ヘッダは名前を選ぶためだけに読む。
// 名前はどれも呼び手の自己申告（UA は偽れる）。数は「誰が」ではなく「どの入口が何回」を読む。
//
// 鍵つきの呼び出しは数えない（decision は api_usage が鍵ごとに数えている。ルートの側で鍵なしのときだけ呼ぶ）。
// resolve には鍵の経路が無い（Authorization を読まず、いつも IP 枠）ので、全部を数える。
//
// 応答を遅らせない: 書き込みは応答の後（runAfterResponse = next/server の after()）。
// 失敗しても応答は変わらない: 例外はログへ出して捨てる。
// 数えるのはレート枠を消費したまま返る呼び出しだけ（枠で断った 429/503、枠を戻す早期 return は数えない）。
// UA を名乗るだけで書き込みを無制限に増やせないようにするため。resolve は枠を通った後、decision は判定を
// 返す 200 の直前で呼ぶ（decision の 400/404/503 は枠を戻すので数えない）。版は semver だけを残し、1 日の
// client の種類は MAX_CLIENTS_PER_DAY で止める（決まった名前は数が固定なので上限の外）。
// resolve は CDN が 60 秒キャッシュする（public-route.ts）ので、キャッシュから返った呼び出しは関数に届かず
// 数えられない。件数は「少なくともこれだけ」の下限として読む。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runAfterResponse } from "@/lib/util/after-response";
import { logAndSwallowSafe } from "@/lib/util/log-safe";
import { OWN_ORIGINS } from "@/lib/decision/lookup-caller";

export type ClientUsageRoute = "resolve" | "decision";

/**
 * 配布物（利用者の手元で動き、vet402 の API を呼ぶときにこの名前を UA に名乗るもの）。
 * 名乗っているのは今は Hermes プラグイン（github.com/kzmttkc/vet402-hermes・`vet402-hermes/0.1.0`）だけ。
 * @vet402/sdk と @vet402/mcp-server は UA を付けない（Node の fetch の既定 `node`）ので other に入る。
 * 新しい配布物に UA を付けるときは、出す前にここへ名前を足す——足さないと `vet402-` の規則で self-monitor に入り、
 * 利用の数字から除かれる（多く数える側ではなく、少なく数える側に倒してある）。
 */
export const DISTRIBUTED_CLIENTS = ["vet402-hermes"] as const;
/** 自社の道具が名乗る UA の先頭（vet402 リポの scripts/ と Takeshi_Automation の scripts/ の監視はどれもこの形）。 */
const SELF_PREFIXES = ["vet402-", "kizuna-"] as const;

export const SELF_MONITOR_CLIENT = "self-monitor";
export const CRAWLER_CLIENT = "crawler";
export const SITE_CLIENT = "site";
export const BROWSER_CLIENT = "browser";
export const OTHER_CLIENT = "other";
/** 版を持たない決まった名前。呼び手が増やせないので、1 日の種類の上限（MAX_CLIENTS_PER_DAY）の外に置く。 */
export const FIXED_CLIENTS: readonly string[] = [SELF_MONITOR_CLIENT, CRAWLER_CLIENT, SITE_CLIENT, BROWSER_CLIENT, OTHER_CLIENT];

/** 版は数字 3 組の semver（各 1〜3 桁）だけ。その後ろは UA の終わりか空白・`(`・`;`。プレリリース等は other。 */
const VERSION_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3})(?=$|[\s(;])/;
const CRAWLER_RE = /bot|crawl|spider|slurp/i;
/** UA のうち名前を選ぶために読む長さ。それより後ろは見ない（長い UA で正規表現を回さない）。 */
const UA_READ_CHARS = 512;
/**
 * 1 日に持つ client の種類の上限。版は呼び手が名乗るので、上限を超えた新しい版はその日 `<名前>/other` に寄せる
 * （UA を変えながら叩いても、1 日の行数は (上限 + 配布物の other + 決まった名前) × ルート数で止まる）。
 */
export const MAX_CLIENTS_PER_DAY = 16;
/** `vet402-hermes/` で始まるが版が上の形でないもの。版の文字列は保存しない。 */
export const HERMES_OTHER_VERSION = "vet402-hermes/other";

/**
 * vet402.com 自身の頁がブラウザから呼んだ要求か。`Sec-Fetch-Site: same-origin`（ブラウザが付け、頁の script は
 * 書き換えられない）か、Referer の origin が自サイト。どちらも無ければ false。値は保存しない。
 */
export function isOwnPageRequest(headers: Pick<Headers, "get">): boolean {
  if ((headers.get("sec-fetch-site") ?? "").trim().toLowerCase() === "same-origin") return true;
  const referer = headers.get("referer");
  if (!referer || referer.length > 2048) return false;
  try {
    return OWN_ORIGINS.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

/**
 * User-Agent から保存する client の値を作る。返す値は `<配布物の名前>/<版>`・`<配布物の名前>/other`・
 * FIXED_CLIENTS のどれかだけで、UA の文字列そのものは返さない。`ownPage` は isOwnPageRequest の結果
 * （ブラウザの UA のときだけ効く）。
 */
export function clientUsageLabel(userAgent: string | null | undefined, ownPage = false): string {
  if (!userAgent) return OTHER_CLIENT;
  const ua = userAgent.slice(0, UA_READ_CHARS);
  for (const name of DISTRIBUTED_CLIENTS) {
    if (!ua.startsWith(`${name}/`)) continue;
    const m = VERSION_RE.exec(ua.slice(name.length + 1));
    return m ? `${name}/${m[1]}` : `${name}/other`;
  }
  if (SELF_PREFIXES.some((p) => ua.startsWith(p))) return SELF_MONITOR_CLIENT;
  if (CRAWLER_RE.test(ua)) return CRAWLER_CLIENT;
  if (ua.startsWith("Mozilla/")) return ownPage ? SITE_CLIENT : BROWSER_CLIENT;
  return OTHER_CLIENT;
}

/**
 * その日の種類が上限に達した後、新しい client を寄せる先。配布物の版は `<名前>/other`。
 * 決まった名前は自分自身（上限に関係なく自分の行に足す）。
 */
export function clientUsageOverflowLabel(client: string): string {
  if (FIXED_CLIENTS.includes(client)) return client;
  const slash = client.indexOf("/");
  const name = slash > 0 ? client.slice(0, slash) : "";
  return (DISTRIBUTED_CLIENTS as readonly string[]).includes(name) ? `${name}/other` : OTHER_CLIENT;
}

/** 1 件を加算する単文 upsert。失敗はログへ出して捨てる（呼び手へ投げない）。 */
export function upsertClientUsage(client: string, route: ClientUsageRoute, now: Date = new Date()): Promise<void> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (error) {
    logAndSwallowSafe("client_usage.record")(error);
    return Promise.resolve();
  }
  if (!db) return Promise.resolve();
  const day = now.toISOString().slice(0, 10);
  const overflow = clientUsageOverflowLabel(client);
  let pending: PromiseLike<unknown>;
  try {
    // その日に既にある client はそのまま、新しい client は種類が上限未満のときだけ。それ以外は overflow へ寄せる
    // （決まった名前は overflow が自分自身なので、どちらの枝でも自分の行に足される）。
    pending = db.execute(
      sql`INSERT INTO client_usage_daily (day, client, route, count)
          SELECT ${day}::date,
                 CASE WHEN EXISTS (SELECT 1 FROM client_usage_daily WHERE day = ${day}::date AND client = ${client})
                        OR (SELECT count(DISTINCT client) FROM client_usage_daily WHERE day = ${day}::date) < ${MAX_CLIENTS_PER_DAY}
                      THEN ${client} ELSE ${overflow} END,
                 ${route}, 1
          ON CONFLICT (day, client, route) DO UPDATE SET count = client_usage_daily.count + 1`,
    );
  } catch (error) {
    logAndSwallowSafe("client_usage.record")(error);
    return Promise.resolve();
  }
  return Promise.resolve(pending)
    .then(() => undefined)
    .catch(logAndSwallowSafe("client_usage.record"));
}

/**
 * ルートから呼ぶ入口。鍵なしで、枠を消費したまま返る呼び出しのときだけ呼ぶ（呼ぶ場所はルートが決める）。
 * 応答の後に 1 件を加算する。同期的に返り、例外を外へ出さない。
 */
export function recordClientUsage(headers: Headers, route: ClientUsageRoute): void {
  try {
    const client = clientUsageLabel(headers.get("user-agent"), isOwnPageRequest(headers));
    const now = new Date();
    runAfterResponse(() => upsertClientUsage(client, route, now));
  } catch (error) {
    logAndSwallowSafe("client_usage.schedule")(error);
  }
}
