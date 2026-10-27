// ============================================================
// 鍵なしの公開 API の呼び出し件数（2026-10-07 に Hermes だけで開始・2026-10-11 に鍵なしの全部へ）。
//
// 鍵なしの /api/v1/resolve と /api/v1/resources/{id}/decision は api_usage に残らず、Vercel のログにも
// User-Agent が出ないので、何回呼ばれたかを数える場所が無かった。10-07 は User-Agent が `vet402-hermes/` の
// 呼び出しだけを数えた。10-11 から、鍵なしの呼び出しを全部、少数の決まった名前（client）に寄せて数える。
//
// client の値（clientUsageLabel。上から順に当てる）:
//   vet402-hermes/<版>・vet402-sdk/<版>・vet402-mcp/<版>
//                      … 配布物（利用者の手元で動く）。DISTRIBUTED_CLIENTS にある名前だけ。版は数字 3 組の semver、
//                         それ以外は `<名前>/other`
//   self-monitor       … 自社のカナリアと監視。UA の先頭の名前が SELF_MONITOR_NAMES にあるもの
//                         （scripts/surface-consistency-canary.ts の `vet402-surface-consistency-canary` など）か、
//                         `kizuna-` で始まるもの。利用の数字から除くために分ける。表に無い `vet402-<何か>` は
//                         自社のものとは限らない（第三者が vet402 を使う道具にそう名付け得る）ので other
//   crawler            … UA に bot / crawl / spider / slurp を含む
//   site               … ブラウザの UA（`Mozilla/` で始まる）で、vet402.com 自身の頁が呼んだもの
//                         （`Sec-Fetch-Site: same-origin`、または Referer が自サイト。売り手頁は判定を自動で引く）
//   browser            … それ以外のブラウザの UA
//   other              … 上のどれでもない（UA 無し・curl・node・python など）。SDK と MCP サーバは今の版では UA を
//                         名乗らない（Node の fetch の既定 `node`）のでここ。自社の skill-live（.github/workflows/
//                         skill-live.yml・SKILL.md の curl をそのまま打つ・1 日数本）もここに混ざる
// 保存するのは client_usage_daily の (UTC 日, client, ルート名, 件数) だけで、IP・URL・クエリ・鍵・resource_id・
// UA の生の文字列・Referer は保存しない。ヘッダは名前を選ぶためだけに読む。
// 名前はどれも呼び手の自己申告（UA は偽れる）。数は「誰が」ではなく「どの入口が何回」を読む。
//
// 数えるのは鍵なしの呼び出しだけ（Authorization ヘッダが空。ルートの側で確かめてから呼ぶ）。decision の鍵つきは
// api_usage が鍵ごとに数えている。resolve は Authorization を読まない（いつも IP 枠）が、SDK と MCP サーバは鍵が
// 設定されていれば resolve にも Authorization を付けるので、付いている呼び出しは「鍵なし」の数に入れない。
//
// 応答を遅らせない: 書き込みは応答の後（runAfterResponse = next/server の after()）。
// 失敗しても応答は変わらない: 例外はログへ出して捨てる。
// 数えるのは、レート枠を消費したまま成功の応答（200）を返す呼び出しだけ。枠で断った 429/503 も、検証で落ちた
// 400 も、404/503 も数えない（resolve の 400/503 は枠を消費するが数えない。decision の 400/404/503 は枠を戻す）。
// 書き込みは枠の内側に収まる（UA を名乗るだけで書き込みを無制限に増やせない）。どちらのルートも 200 を返す直前で呼ぶ。
// 版は semver だけを残し、1 日の版つきの client の種類は MAX_CLIENTS_PER_DAY で止める（決まった名前と
// `<名前>/other` は呼び手が増やせないので、その数に入れない）。
// resolve は CDN が 60 秒キャッシュする（public-route.ts）ので、キャッシュから返った呼び出しは関数に届かず
// 数えられない。件数は「少なくともこれだけ」の下限として読む。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runAfterResponse } from "@/lib/util/after-response";
import { logAndSwallowSafe } from "@/lib/util/log-safe";
import { OWN_ORIGINS } from "@/lib/decision/lookup-caller";

/**
 * 2026-10-28: MCP の入口（/mcp）の 4 本を足した。列は text なので migration は要らない。
 * initialize は clientInfo から、tools/call は UA から client を決める（mcpClientUsageLabel）。
 */
export const MCP_USAGE_ROUTES = ["mcp:initialize", "mcp:check_x402_seller", "mcp:check_my_x402_endpoint", "mcp:find_x402_sellers"] as const;
export type McpUsageRoute = (typeof MCP_USAGE_ROUTES)[number];
export type ClientUsageRoute = "resolve" | "decision" | McpUsageRoute;

/**
 * 配布物（利用者の手元で動き、vet402 の API を呼ぶときにこの名前を UA に名乗るもの）。
 * - `vet402-hermes`: Hermes プラグイン（github.com/kzmttkc/vet402-hermes・`vet402-hermes/0.1.0`）。今も名乗っている
 * - `vet402-sdk`・`vet402-mcp`: @vet402/sdk と @vet402/mcp-server の受け皿。今の版は vet402 の API へ UA を付けない
 *   （Node の fetch の既定 `node` → other）。パッケージの側が名乗り始めた版から、ここに入る
 * 新しい配布物に UA を付けるときは、出す前にここへ名前を足す（足さないと other に入る）。
 */
export const DISTRIBUTED_CLIENTS = ["vet402-hermes", "vet402-sdk", "vet402-mcp"] as const;
/**
 * 自社の道具が名乗る UA の先頭の名前（`/`・空白・`(`・`;` の前まで）。完全一致だけ。
 * vet402 リポ: scripts/ のカナリア 2 本と、アプリが外へ出すときの名前（L0・L1 の測定、カタログ、照合、/rwa の頁）。
 * Takeshi_Automation の scripts/: `vet402-<名前>/<版>` の 4 本。`kizuna-<名前>/<版>` は SELF_MONITOR_PREFIX で受ける。
 * この 2 つの口を鍵なしで毎日呼ぶのは今は `vet402-surface-consistency-canary` だけ。ほかは呼んだときに混ざらないための登録。
 * vet402 リポに `vet402-` の UA を足したら、ここにも足す（tests/client-usage.test.ts がリポを走査して落とす）。
 */
export const SELF_MONITOR_NAMES: readonly string[] = [
  "vet402-surface-consistency-canary",
  "vet402-claims-canary",
  "vet402-observatory-l0",
  "vet402-observatory-l0-recheck",
  "vet402-observatory-l1",
  "vet402-observatory-catalog",
  "vet402-verifier",
  "vet402-rwa-page",
  "vet402-state-snapshot",
  "vet402-weekly-facts",
  "vet402-gtm-weekly",
  "vet402-payer-balance",
];
/** Takeshi_Automation の監視が名乗る先頭（`kizuna-grant-figures/1` など）。社内の接頭辞で、配布物には使わない。 */
const SELF_MONITOR_PREFIX = "kizuna-";
/** UA の先頭の名前（product token）。`/`・空白・`(`・`;` の前まで。 */
const UA_NAME_RE = /^[^/\s(;]+/;

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
 * 1 日に持つ**版つきの** client（`<配布物の名前>/<semver>`）の種類の上限。版は呼び手が名乗るので、上限を超えた
 * 新しい版はその日 `<名前>/other` に寄せる。決まった名前と `<名前>/other` は呼び手が増やせないので数に入れない
 * （決まった名前が先に並んでも、本物の版の枠は減らない）。UA を変えながら叩いても、1 日の行数は
 * (上限 + 配布物の数の other + 決まった名前) × ルート数で止まる。
 */
export const MAX_CLIENTS_PER_DAY = 16;
/** 配布物の名前で始まるが版が上の形でないもの・上限を超えた版の寄せ先の末尾。版の文字列は保存しない。 */
const OTHER_VERSION = "other";
/** `vet402-hermes/` で始まるが版が上の形でないもの。 */
export const HERMES_OTHER_VERSION = `vet402-hermes/${OTHER_VERSION}`;

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
    return m ? `${name}/${m[1]}` : `${name}/${OTHER_VERSION}`;
  }
  if (isSelfMonitorUa(ua)) return SELF_MONITOR_CLIENT;
  if (CRAWLER_RE.test(ua)) return CRAWLER_CLIENT;
  if (ua.startsWith("Mozilla/")) return ownPage ? SITE_CLIENT : BROWSER_CLIENT;
  return OTHER_CLIENT;
}

/**
 * MCP の呼び手を寄せる先（2026-10-28）。版を持たない決まった名前なので、FIXED_CLIENTS と同じく
 * 1 日の種類の上限（MAX_CLIENTS_PER_DAY）の外に置く（clientUsageOverflowLabel が自分自身を返す）。
 */
export const MCP_CLIENTS: readonly string[] = ["grok-bot", "cursor", "claude", "chatgpt", "paybox"];

/** 小文字にした名前に当てる表（上から順に最初に当たったもの）。 */
const MCP_CLIENT_RULES: readonly { test: (s: string) => boolean; client: string }[] = [
  { test: (s) => s.includes("grok") || /\bsand\b/.test(s), client: "grok-bot" },
  { test: (s) => s.includes("cursor"), client: "cursor" },
  { test: (s) => s.includes("claude") || s.includes("anthropic"), client: "claude" },
  { test: (s) => s.includes("openai") || s.includes("chatgpt"), client: "chatgpt" },
  { test: (s) => s.includes("paybox") || s.includes("moonpay"), client: "paybox" },
];

/** 自社の道具の UA か（先頭の名前が SELF_MONITOR_NAMES にあるか、`kizuna-` で始まる）。clientUsageLabel と MCP で同じ規則。 */
function isSelfMonitorUa(ua: string): boolean {
  return ua.startsWith(SELF_MONITOR_PREFIX) || SELF_MONITOR_NAMES.includes(UA_NAME_RE.exec(ua)?.[0] ?? "");
}

/**
 * MCP の入口（`mcp:*` の route）だけの client の値。順は 2026-10-28 の指示どおり:
 *   1. vet402 の自分の確認（self-monitor）
 *   2. MCP の表（MCP_CLIENT_RULES: grok-bot・cursor・claude・chatgpt・paybox。小文字にして部分一致・上から最初に当たったもの）
 *   3. 既存の clientUsageLabel（配布物・crawler・site・browser・other）
 * 2 を 3 より先にするのは、`grok-bot/1.0` のように bot を含む MCP の呼び手を crawler に入れないため。
 * resolve・decision の route は clientUsageLabel のままで、この関数を通らない。
 * 生の値（clientInfo.name・UA）は返さない・保存しない。
 */
export function mcpClientUsageLabel(raw: string | null | undefined, ownPage = false): string {
  const ua = (raw ?? "").slice(0, UA_READ_CHARS);
  if (ua && isSelfMonitorUa(ua)) return SELF_MONITOR_CLIENT;
  const s = ua.toLowerCase();
  for (const rule of MCP_CLIENT_RULES) if (rule.test(s)) return rule.client;
  return clientUsageLabel(raw, ownPage);
}

/**
 * その日の種類が上限に達した後、新しい client を寄せる先。配布物の版は `<名前>/other`。
 * 決まった名前は自分自身（上限に関係なく自分の行に足す）。
 */
export function clientUsageOverflowLabel(client: string): string {
  if (FIXED_CLIENTS.includes(client) || MCP_CLIENTS.includes(client)) return client;
  const slash = client.indexOf("/");
  const name = slash > 0 ? client.slice(0, slash) : "";
  return (DISTRIBUTED_CLIENTS as readonly string[]).includes(name) ? `${name}/${OTHER_VERSION}` : OTHER_CLIENT;
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
    // その日に既にある client はそのまま、新しい client は版つきの種類が上限未満のときだけ。それ以外は overflow へ寄せる
    // （決まった名前と `<名前>/other` は overflow が自分自身なので、どちらの枝でも自分の行に足される）。
    // 上限に数えるのは版つきの client だけ（`/` を含み、末尾が `/other` でないもの）。
    pending = db.execute(
      sql`INSERT INTO client_usage_daily (day, client, route, count)
          SELECT ${day}::date,
                 CASE WHEN EXISTS (SELECT 1 FROM client_usage_daily WHERE day = ${day}::date AND client = ${client})
                        OR (SELECT count(DISTINCT client) FROM client_usage_daily
                             WHERE day = ${day}::date AND position('/' in client) > 0 AND client NOT LIKE '%/other') < ${MAX_CLIENTS_PER_DAY}
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

/** Authorization ヘッダが空か（鍵なしの呼び出しか）。decision ルートの admit と同じ見方（空白だけは空）。 */
export function isKeylessRequest(headers: Pick<Headers, "get">): boolean {
  return (headers.get("authorization") ?? "").trim() === "";
}

/**
 * ルートから呼ぶ入口。鍵なしで、枠を消費したまま成功の応答（200）を返す呼び出しのときだけ呼ぶ（呼ぶ場所はルートが決める）。
 * Authorization ヘッダが付いた呼び出しは、ここでも数えない（ルートの確かめ漏れに備えた二重の関門）。
 * 応答の後に 1 件を加算する。同期的に返り、例外を外へ出さない。
 */
export function recordClientUsage(headers: Headers, route: ClientUsageRoute): void {
  try {
    if (!isKeylessRequest(headers)) return;
    const client = clientUsageLabel(headers.get("user-agent"), isOwnPageRequest(headers));
    const now = new Date();
    runAfterResponse(() => upsertClientUsage(client, route, now));
  } catch (error) {
    logAndSwallowSafe("client_usage.schedule")(error);
  }
}

/**
 * MCP の入口から呼ぶ（2026-10-28）。HTTP 200 で答えた initialize と tools/call のときだけ route が呼ぶ。
 * client は mcpClientUsageLabel が選んだ名前。MCP は鍵を持たないので Authorization の有無で分けない
 * （api_usage と二重に数えることが無い）。応答の後に 1 件を加算し、例外を外へ出さない。
 */
export function recordMcpUsage(client: string, route: McpUsageRoute): void {
  try {
    const now = new Date();
    runAfterResponse(() => upsertClientUsage(client, route, now));
  } catch (error) {
    logAndSwallowSafe("client_usage.schedule")(error);
  }
}
