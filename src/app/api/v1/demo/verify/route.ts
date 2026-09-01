import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { runDemoL0 } from "@/lib/demo/verify";
import { runL1Batch } from "@/lib/observatory/l1-runner";
import { getEndpointPurchases } from "@/lib/observatory/reader";
import { logServerError } from "@/lib/util/log";
import { UUID_RE } from "@/lib/validation/uuid";

/**
 * POST /api/v1/demo/verify — /playground のライブL0検証（Phase 0.1）。
 *
 * キー無し・IPレート制限のみの公開デモ呼び口。カタログの1エンドポイントへ
 * その場で L0 プローブを撃ち、結果をそのまま返す。公開台帳へは書かない
 * （デモが測定ケイデンスを汚さない——src/lib/demo/verify.ts 冒頭を参照）。
 *
 * ライブの外向きHTTPを1リクエスト誘発するため、レート制限は他の
 * 公開GETより一段きつい 5回/分。プローブ自体のSSRFガードは
 * probeEndpoint 側（createSafeFetchImpl）が持つ。
 */

const RL_LIMIT = 5;
const RL_WINDOW_MS = 60_000;

/**
 * デモ経由の L1 実購入に対する、デモ専用の日次サブ予算（2026-08-22 監査）。
 *
 * この経路は APIキー不要で**実資金の購入**を起動できる。既存の多重ゲート
 * （DEMO_L1_ENABLED ＋ OBSERVATORY_L1_ENABLED ＋ 1回/日/IP ＋ $25/日 ＋
 * スイープ窓）のうち、**デモ起点の支出だけを縛るものが1つも無かった**——
 * IPは無限に用意できるので、ONにした日はランナー本来の日次予算 $25 を
 * デモが単独で食い尽くせる。
 *
 * ここで足すのは「対象エンドポイントの限定」ではなく「日次サブ予算」。
 * 理由: /playground の価値は**カタログのどの行でもその場で実測できる**こと
 * にあり、許可リストにするとデモが実質デモでなくなる。件数の上限なら
 * consumeIpRateLimit の単一SQL upsert（読んでから書かない予約）でそのまま
 * 原子的に取れるので、他部門が作業中の l1-runner にも schema にも触らずに
 * 効かせられる。
 *
 * 正直に書いておく: これが直接縛るのは**回数**であって USD ではない。
 * 金額の天井は従来どおりランナー側の $25/日（原子的予約）が持つ。
 * 既定5回は、デモが1日に踏める上限として最小限から始める値。
 */
const DEMO_L1_DAILY_DEFAULT = 5;
const DEMO_L1_DAILY_CEILING = 25;

function demoL1DailyMax(): number {
  const raw = Number(process.env.DEMO_L1_DAILY_MAX);
  if (!Number.isInteger(raw) || raw < 0) return DEMO_L1_DAILY_DEFAULT;
  // 設定ミスで天井を跳ね上げられないよう、上からも留める。
  return Math.min(raw, DEMO_L1_DAILY_CEILING);
}

/** ランナーの日次予算と同じ UTC 日で数える（窓の境目をずらさない）。 */
function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`demo-verify:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  let endpointId: unknown;
  let level: unknown;
  try {
    const body = await request.json();
    endpointId = (body as { endpointId?: unknown })?.endpointId;
    level = (body as { level?: unknown })?.level ?? "l0";
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: perCaller });
  }
  if (typeof endpointId !== "string" || endpointId.length === 0) {
    return NextResponse.json({ error: "endpoint_id_required" }, { status: 400, headers: perCaller });
  }
  // 2026-08-22 監査: uuid 検査がここに無く、非uuid が SQL の ::uuid まで届いて
  // Postgres 22P02 → 503 になっていた。しかも L1 経路ではその手前で
  // 「1回/日/IP」のトークンを消費していたので、打ち間違い1回で呼び手の
  // その日ぶんが消えた。検査はトークン消費より前、かつ両レベル共通に置く。
  if (!UUID_RE.test(endpointId)) {
    return NextResponse.json({ error: "invalid_endpoint_id" }, { status: 400, headers: perCaller });
  }
  if (level !== "l0" && level !== "l1") {
    return NextResponse.json({ error: "invalid_level" }, { status: 400, headers: perCaller });
  }

  // L1 は実資金が動く。二重ゲート（デモ側フラグ＋観測所側フラグは runL1Batch
  // 内の isL1Enabled が見る）で、既定はどちらも OFF。フラグ確認を1日1回の
  // レート消費より先に置く——無効な機能で呼び手の1日分トークンを燃やさない。
  if (level === "l1") {
    if (process.env.DEMO_L1_ENABLED !== "true") {
      return NextResponse.json({ error: "demo_l1_disabled" }, { status: 403, headers: perCaller });
    }
    // デモ専用の日次サブ予算を、呼び手の1日ぶんトークンより**先**に見る
    // （上の「無効な機能で呼び手の1日分トークンを燃やさない」と同じ理由——
    // 予算切れの日は、そもそも誰にも提供できない）。
    const dailyMax = demoL1DailyMax();
    const demoBudget = await consumeIpRateLimit(
      `demo-l1-day:${utcDayKey()}`,
      dailyMax,
      86_400_000,
    );
    if (!demoBudget.allowed) {
      return NextResponse.json(
        {
          error: "demo_budget_exhausted",
          detail: `demo-triggered live purchases are capped at ${dailyMax} per day`,
        },
        { status: 429, headers: ipRateLimitHeaders(demoBudget) },
      );
    }

    const l1Limited = await consumeIpRateLimit(`demo-l1:${ip}`, 1, 86_400_000);
    if (!l1Limited.allowed) {
      return NextResponse.json(
        { error: "rate_limited", detail: "one live purchase per caller per day" },
        { status: 429, headers: ipRateLimitHeaders(l1Limited) },
      );
    }
    try {
      // 予算・重複・自己除外・L0-pass 要件はランナー内の既存ゲートがそのまま利く。
      const summary = await runL1Batch({ onlyEndpointId: endpointId, limit: 1 });
      const purchases = await getEndpointPurchases(endpointId);
      return NextResponse.json(
        { ok: true, level: "l1", summary, purchases },
        { headers: { ...perCaller, "Cache-Control": "no-store" } },
      );
    } catch (error) {
      logServerError("demo_verify_l1", error);
      return NextResponse.json({ error: "demo_unavailable" }, { status: 503, headers: perCaller });
    }
  }

  try {
    const result = await runDemoL0(endpointId);
    if (!result.ok) {
      if (result.reason === "db_unavailable") {
        return NextResponse.json({ error: "demo_unavailable" }, { status: 503, headers: perCaller });
      }
      return NextResponse.json({ error: result.reason }, { status: 404, headers: perCaller });
    }
    // ライブ実測は共有キャッシュに載せない（毎回いまの状態を見せるのがデモの価値）。
    return NextResponse.json(result, {
      headers: { ...perCaller, "Cache-Control": "no-store" },
    });
  } catch (error) {
    logServerError("demo_verify", error);
    return NextResponse.json({ error: "demo_unavailable" }, { status: 503, headers: perCaller });
  }
}
