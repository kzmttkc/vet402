import { worstStatus } from "@/lib/scoring/payee-probe";
import { composeDetail, probeSegment } from "./probe-detail";

export type HealthStatus = "ok" | "degraded" | "error";

/**
 * Per-IP ceiling for the PUBLIC liveness probe (2026-08-15 audit).
 *
 * The shallow answer is not cheap: it runs the seller-side scoring probe and
 * the payee probe, i.e. Base RPC + Blockscout + DB. Memoisation is per function
 * INSTANCE, so a concurrent flood fans out to cold instances and pays the full
 * cost on each — and Blockscout answers sustained load with a global cooldown
 * that then degrades real scoring.
 *
 * 60/min = one request per second, far above any honest uptime poller.
 * Lives in lib (not next to the route) so GET /api/health can compose the
 * probes without the public banner importing engines into the HTML layout.
 */
export const HEALTH_RATE_LIMIT = 60;
export const HEALTH_RATE_WINDOW_MS = 60_000;

/**
 * HTTP status for the PUBLIC liveness endpoint.
 *
 * docs/api tells integrators the endpoint "returns 200/503 for uptime
 * pollers". `degraded` is not up — it returns 503. The body still carries
 * `"degraded"` vs `"error"` for a human reading curl.
 */
export function livenessHttpStatus(status: HealthStatus): 200 | 503 {
  return status === "ok" ? 200 : 503;
}

/**
 * detail / fromCache は任意。1 ビットしか持たない古い呼び出し（とテストの
 * スタブ）をそのまま通すため。欠けていれば「不明」として記録され、
 * 「ok だった」に化けることはない。
 */
export type LivenessProbeResult = {
  status: HealthStatus;
  detail?: string | null;
  fromCache?: boolean;
};

export type LivenessProbes = {
  scoring: () => Promise<LivenessProbeResult>;
  payee: () => Promise<LivenessProbeResult>;
};

export type LivenessResult = {
  /** Exactly one bit of detail to an anonymous caller: up, partly, or not. */
  status: HealthStatus;
  httpStatus: 200 | 503;
  /**
   * どちらの probe が・どの状態で・実測かキャッシュか・なぜ落ちたか。
   * **公開本文には入れない。** health_snapshots へ運ぶためだけの値で、
   * 読めるのは admin 経路と DB 直参照だけ（route.ts の 2026-08-06 決定）。
   */
  detail: string;
  /** この判定を出すのにかかった実測ミリ秒。両 probe は並行なので遅い方に近い。 */
  latencyMs: number;
};

/**
 * Runs both engine probes concurrently (so the caller costs the slower one,
 * not the sum) and reports the worse of the two.
 *
 * 2026-09-08: 判定の**理由**をここで組む。組む場所をここにしたのは、
 * 「両方の probe を見た唯一の地点」だから。片方の probe の中で作ると、
 * もう片方が ok だったのか見ていないのかが行から落ちる。
 *
 * 実測でわかったこと（この関数のコメントとして残す価値がある）:
 * 逐次 60 サンプルが 60/60 緑で、同時刻の実トラフィックの 3 分の 1 が赤だった。
 * 分けていたのは**キャッシュの齢**である。scoring の memo は 60 秒、payee は
 * 60 秒 + 10 分の stale-while-revalidate、その下に scoring エンジン自身の
 * 5 分キャッシュがある。25〜55 秒間隔のポーリングはこの 3 層を踏み続けるので
 * 構造的に実測へ行かない。30 分間隔の cron だけが全層を必ず超える。
 * だから segment に fresh/cached を必ず書く——測って ok だったのか、
 * 前に測った ok を出しただけなのかは、同じ ok ではない。
 */
export async function evaluateLiveness(probes: LivenessProbes): Promise<LivenessResult> {
  const startedAt = Date.now();
  const [scoring, payee] = await Promise.all([probes.scoring(), probes.payee()]);
  const status = worstStatus([scoring.status, payee.status]);
  const detail = composeDetail([
    probeSegment("scoring", scoring.status, scoring.fromCache === true, scoring.detail ?? null),
    probeSegment("payee", payee.status, payee.fromCache === true, payee.detail ?? null),
  ]);
  return {
    status,
    httpStatus: livenessHttpStatus(status),
    detail,
    latencyMs: Date.now() - startedAt,
  };
}
