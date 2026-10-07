// ============================================================
// 既知の公開クライアントの呼び出し件数（2026-10-07）。
//
// Hermes プラグイン（github.com/kzmttkc/vet402-hermes）は鍵なしで /api/v1/resolve と
// /api/v1/resources/{id}/decision を呼び、User-Agent に `vet402-hermes/<版>` を名乗る。鍵なしの呼び出しは
// api_usage に残らず、Vercel のログにも User-Agent が出ないので、使われているかを数える場所が無かった。
//
// 数えるのは User-Agent が `vet402-hermes/` で始まる呼び出しだけ。他の UA は何も書かない。
// 保存するのは client_usage_daily の (UTC 日, `vet402-hermes/<版>`, ルート名, 件数) だけで、
// IP・URL・クエリ・鍵・resource_id・UA の残りの部分は保存しない。
//
// 応答を遅らせない: 書き込みは応答の後（runAfterResponse = next/server の after()）。
// 失敗しても応答は変わらない: 例外はログへ出して捨てる。
// 数えるのはレート枠を消費したまま返る呼び出しだけ（枠で断った 429/503、枠を戻す早期 return は数えない）。
// UA を名乗るだけで書き込みを無制限に増やせないようにするため。resolve は枠を通った後、decision は判定を
// 返す 200 の直前で呼ぶ（decision の 400/404/503 は枠を戻すので数えない）。版は semver だけを残し、1 日の
// client の種類は MAX_CLIENTS_PER_DAY で止める。
// resolve は CDN が 60 秒キャッシュする（public-route.ts）ので、キャッシュから返った呼び出しは関数に届かず
// 数えられない。件数は「少なくともこれだけ」の下限として読む。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runAfterResponse } from "@/lib/util/after-response";
import { logAndSwallowSafe } from "@/lib/util/log-safe";

export type ClientUsageRoute = "resolve" | "decision";

const HERMES_PREFIX = "vet402-hermes/";
/** 版は数字 3 組の semver（各 1〜3 桁）だけ。その後ろは UA の終わりか空白・`(`・`;`。プレリリース等は other。 */
const HERMES_VERSION_RE = /^vet402-hermes\/(\d{1,3}\.\d{1,3}\.\d{1,3})(?=$|[\s(;])/;
/**
 * 1 日に持つ client の種類の上限。版は呼び手が名乗るので、上限を超えた新しい版はその日 other に寄せる
 * （UA を変えながら叩いても、1 日の行数は (上限 + 1) × ルート数で止まる）。
 */
export const MAX_CLIENTS_PER_DAY = 16;
/** `vet402-hermes/` で始まるが版が上の形でないもの。版の文字列は保存しない。 */
export const HERMES_OTHER_VERSION = "vet402-hermes/other";

/**
 * User-Agent から保存する client の値を作る。数えない UA は null。
 * 返す値は `vet402-hermes/<版>` か `vet402-hermes/other` のどちらかだけ（UA の残りは捨てる）。
 */
export function clientUsageLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent || !userAgent.startsWith(HERMES_PREFIX)) return null;
  const m = HERMES_VERSION_RE.exec(userAgent);
  return m ? `${HERMES_PREFIX}${m[1]}` : HERMES_OTHER_VERSION;
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
  let pending: PromiseLike<unknown>;
  try {
    // その日に既にある client はそのまま、新しい client は種類が上限未満のときだけ。それ以外は other へ寄せる。
    pending = db.execute(
      sql`INSERT INTO client_usage_daily (day, client, route, count)
          SELECT ${day}::date,
                 CASE WHEN EXISTS (SELECT 1 FROM client_usage_daily WHERE day = ${day}::date AND client = ${client})
                        OR (SELECT count(DISTINCT client) FROM client_usage_daily WHERE day = ${day}::date) < ${MAX_CLIENTS_PER_DAY}
                      THEN ${client} ELSE ${HERMES_OTHER_VERSION} END,
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
 * ルートから呼ぶ入口。UA が `vet402-hermes/` で始まるときだけ、応答の後に 1 件を加算する。
 * 同期的に返り、例外を外へ出さない。
 */
export function recordClientUsage(headers: Headers, route: ClientUsageRoute): void {
  try {
    const client = clientUsageLabel(headers.get("user-agent"));
    if (!client) return;
    const now = new Date();
    runAfterResponse(() => upsertClientUsage(client, route, now));
  } catch (error) {
    logAndSwallowSafe("client_usage.schedule")(error);
  }
}
