import { scoreAgentById } from "@/lib/scoring/engine";
import { withDeadline } from "@/lib/util/deadline";
import { describeProbeFailure, describeUnavailable } from "./probe-detail";

/**
 * Does the product's core capability — computing a trust score — actually work
 * right now?
 *
 * WHY THIS EXISTS (2026-08-12). /api/health returned a hard-coded
 * {"status":"ok"} while every score on the site was failing, and the deep
 * check only proved the RPC could answer `eth_getBlockNumber`. Both were
 * measuring something ADJACENT to the thing that was broken: the block-number
 * read stayed fast and green the entire time `eth_getLogs` was failing and
 * scoring was timing out. The docs point customers at /api/health as their
 * uptime monitor, so this was worse than having no monitoring — it actively
 * asserted health during a total outage of the one feature people pay for.
 *
 * So the probe runs the real thing: the same scoreAgentById() call that
 * /api/demo/score and /agent/[id] make. If a customer cannot get a score,
 * neither can this probe, and the endpoint must say so.
 *
 * Cost control: the result is memoised briefly, so an uptime poller hitting
 * this every few seconds costs one score per PROBE_TTL_MS, not one per
 * request. The scoring engine's own 5-minute cache absorbs the rest.
 */

const PROBE_TTL_MS = 60_000;
/**
 * Failures are re-checked sooner than successes. A single transient blip (one
 * 429 from the RPC) should not pin a 503 for a full minute — an uptime monitor
 * would read that as a minute-long outage that never happened. Over-reporting
 * costs trust in the signal almost as fast as under-reporting does; the point
 * of this endpoint is to be believable in both directions.
 */
const PROBE_FAILURE_TTL_MS = 15_000;
/** Under the engine's own 6s budget — a probe must never outlive what it probes. */
const PROBE_DEADLINE_MS = 7_000;

export type ScoringProbe = {
  /**
   * ok       — a score was computed from live signals.
   * degraded — a score was computed, but one or more upstreams were unavailable
   *            (fail-closed: those verdicts are forced cautious).
   * error    — no score could be computed at all. This is an outage.
   */
  status: "ok" | "degraded" | "error";
  /** Flags that made it degraded — server-side detail, never in the public body. */
  unavailable: string[];
  latencyMs: number;
  /**
   * なぜ ok でないか。ok のときは null。**サーバー側だけ**——公開本文は
   * 今までどおり {status} の 1 ビット（route.ts の 2026-08-06 監査コメント）。
   */
  detail: string | null;
  /**
   * この結果を今このリクエストで測ったのか、下の memo から出しただけなのか。
   * 2026-09-08: これが赤と緑を分けている変数だった。詳細は ../health/liveness.ts。
   */
  fromCache: boolean;
};

let cached: { probe: ScoringProbe; expiresAt: number } | null = null;

function probeAgentId(): bigint {
  try {
    return BigInt(process.env.DEMO_AGENT_ID ?? "1");
  } catch {
    return BigInt(1);
  }
}

export function resetScoringProbeCache(): void {
  cached = null;
}

export async function runScoringProbe(): Promise<ScoringProbe> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return { ...cached.probe, fromCache: true };

  const startedAt = Date.now();
  let probe: ScoringProbe;

  try {
    const result = await withDeadline(
      scoreAgentById(probeAgentId()),
      PROBE_DEADLINE_MS,
      "scoring_probe",
    );
    const unavailable = (result.signals.sybil.flags ?? []).filter((flag) =>
      flag.endsWith("_unavailable"),
    );
    probe = {
      status: unavailable.length > 0 ? "degraded" : "ok",
      unavailable,
      latencyMs: Date.now() - startedAt,
      detail: describeUnavailable(unavailable),
      fromCache: false,
    };
    if (unavailable.length > 0) {
      console.warn(`[vouch] scoring_probe degraded: ${unavailable.join(",")}`);
    }
  } catch (error) {
    // The engine wraps upstream failures as `new Error(tag, { cause })`. The
    // tag alone ("agent_identity_unavailable") says WHICH read died but not
    // WHY, which is the half an operator actually needs.
    //
    // 2026-09-08: この行はログにしか残らず、`vercel logs` は直近 12 件しか
    // 返さない。**同じ文字列**を probe.detail に載せて health_snapshots へ運ぶ。
    // ログと列が別々の材料から作られると、どちらが本当かを確かめる作業が増える。
    const detail = describeProbeFailure(error);
    console.error(`[vouch] scoring_probe failed: ${detail}`);
    probe = {
      status: "error",
      unavailable: [],
      latencyMs: Date.now() - startedAt,
      detail,
      fromCache: false,
    };
  }

  cached = {
    probe,
    expiresAt: Date.now() + (probe.status === "error" ? PROBE_FAILURE_TTL_MS : PROBE_TTL_MS),
  };
  return probe;
}
