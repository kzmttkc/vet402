import { scorePayeeWallet } from "./payee-engine";
import { withDeadline } from "@/lib/util/deadline";
import { keepAliveUntilSettled } from "@/lib/util/after-response";
import { describeProbeFailure, describeUnavailable } from "@/lib/health/probe-detail";
import type { Address } from "viem";

/**
 * Does the BUYER side work right now — can an agent get a payee verdict?
 *
 * WHY THIS EXISTS (2026-08-13). /api/health already probes the seller-side
 * engine (lib/health/scoring-probe.ts), which was itself added because the
 * endpoint used to return a hard-coded "ok". It was still measuring something
 * adjacent to the thing that broke. Measured that day:
 *
 *   09:50:08Z  GET /api/health          → 200 {"status":"ok"}
 *   09:50:17Z  GET /payee/0xd8dA…6045   → "Not verifiable right now"
 *
 * Nine seconds apart, same deploy. The seller-side probe was green because the
 * seller side WAS green; the payee engine — the one the SDK's SpendGuard calls
 * before releasing funds — was failing and nothing looked at it. The docs tell
 * customers to point their uptime monitor at /api/health, so their monitor
 * would have stayed green through it. A monitor that is green during an outage
 * converts that outage into a silent one.
 *
 * WHY THE PROBE ADDRESS IS A BUSY WALLET, DELIBERATELY. The 2026-08-13 failure
 * was activity-dependent: /payee/0x0330070F… (0 transactions on Base) scored
 * 41/WARN in ~7s from the very same deploy that could not answer for
 * 0xd8dA…6045 (37,157 transactions). A probe pointed at a quiet address would
 * have been green throughout — the same "measuring the thing next to the
 * broken thing" mistake this file exists to stop making, for the third time.
 * So the probe reads the hardest wallet the product claims to handle. If a
 * cheap address is ever wanted instead, that is an explicit operator decision
 * via HEALTH_PAYEE_ADDRESS, not a default that quietly weakens the alarm.
 *
 * Cost control: memoised, and the payee engine's own 5-minute cache absorbs
 * the recompute. A healthy probe is a cache hit almost every time.
 */

/** vitalik.eth — the address a visitor tries first, and the one the outage hit. */
const DEFAULT_PROBE_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const DEFAULT_PROBE_TTL_MS = 60_000;
/**
 * 通常は 60 秒。env で下げられるのは、stale-while-revalidate 分岐を
 * 60 秒待たずにテストから踏むため（`PAYEE_LEG_BUDGET_MS` と同じ性格の
 * 運用ノブで、本番では設定しない）。負の値と数値以外は既定へ落とす。
 */
function probeTtlMs(): number {
  const raw = Number(process.env.HEALTH_PAYEE_PROBE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PROBE_TTL_MS;
}
/** Failures re-checked sooner, so one blip cannot pin a false outage for a
 *  full minute. Same reasoning as the seller-side probe. */
const PROBE_FAILURE_TTL_MS = 15_000;
/**
 * Above the engine's own per-leg budget (PAYEE_LEG_BUDGET_MS, 20s), not under
 * it. A probe whose deadline is tighter than the thing it probes reports an
 * outage every time the product is merely doing its slowest legitimate work —
 * and a monitor that cries wolf gets muted, which costs exactly as much as one
 * that stays silent.
 *
 * 2026-08-13: shipped at 14s against a 16s leg budget, and production duly
 * reported {"status":"error", latencyMs: 14030} — the probe timing ITSELF out,
 * indistinguishable in the response from the payee path being down. A probe
 * must outlive what it probes or it measures its own deadline.
 */
const PROBE_DEADLINE_MS = 24_000;

export type PayeeProbe = {
  /**
   * ok       — a payee verdict was computed from complete inputs.
   * degraded — a verdict came back but the engine could not read everything:
   *            either a fail-closed refusal (`degraded`, which is what
   *            /payee/[address] renders as "Not verifiable right now") or a
   *            partial measurement. Both mean a caller is not getting the
   *            answer the product promises.
   * error    — no verdict at all. This is an outage of the buyer side.
   */
  status: "ok" | "degraded" | "error";
  /** Which inputs were missing — server-side detail, never in the public body. */
  unavailable: string[];
  latencyMs: number;
  /** なぜ ok でないか。ok のときは null。サーバー側だけ（公開本文は {status} のまま）。 */
  detail: string | null;
  /**
   * 今このリクエストで測ったのか、memo（TTL 内 or stale-while-revalidate）から
   * 出しただけなのか。**この probe は SWR を持つので、温かいインスタンスでは
   * 直近 10 分の測定が生きている限り error を表に出さない。** その事実を行に
   * 残さないと、表は健全性ではなくポーリング間隔を記録することになる。
   */
  fromCache: boolean;
};

let cached: { probe: PayeeProbe; expiresAt: number; measuredAt: number } | null = null;
let refreshing: Promise<PayeeProbe> | null = null;

/**
 * How stale a cached probe may be before a caller is made to WAIT for a fresh
 * one. Between the TTL and this, callers get the last real measurement
 * immediately and a refresh runs behind them.
 *
 * WHY (2026-08-13). Probing the payee path made /api/health take 21.5s,
 * because the probe runs the real engine and the engine now waits up to 20s on
 * a wallet Blockscout is struggling with. docs/api tells customers to point
 * their uptime monitor at this endpoint, and monitors typically time out
 * between 10s and 30s — so the fix for "health lies about being up" had
 * started causing "health times out and is recorded as down". Both are wrong
 * answers; this one was mine.
 *
 * Serving the last measurement is still honest: it is something that was
 * actually measured, at most STALE_LIMIT_MS ago, rather than an assumption.
 * Past that limit the endpoint blocks rather than vouch for an old reading.
 */
const STALE_LIMIT_MS = 10 * 60 * 1000;

export function resetPayeeProbeCache(): void {
  cached = null;
  refreshing = null;
}

function probeAddress(): Address {
  const configured = process.env.HEALTH_PAYEE_ADDRESS?.trim();
  return ((configured && /^0x[0-9a-fA-F]{40}$/.test(configured)
    ? configured
    : DEFAULT_PROBE_ADDRESS) as Address);
}

export async function runPayeeProbe(): Promise<PayeeProbe> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return { ...cached.probe, fromCache: true };

  // Expired but not ancient: answer with the last real measurement now and
  // refresh behind the caller, so an uptime monitor is never held for the
  // engine's full budget. One refresh at a time, never one per request.
  if (cached && now - cached.measuredAt < STALE_LIMIT_MS) {
    if (!refreshing) {
      const inFlight = measurePayeeProbe().finally(() => {
        refreshing = null;
      });
      refreshing = inFlight;
      // The refresh must not surface as an unhandled rejection; measurePayeeProbe
      // already converts failure into an `error` status, so this is belt-and-braces.
      inFlight.catch(() => undefined);
      // 2026-09-08: この行が無いと、リフレッシュは「応答を返し終えた invocation の中で
      // 誰にも待たれていない promise」になる。Vercel はそこでインスタンスを suspend
      // するので、リフレッシュは**消えるのではなく止まる**——そして次に誰かが同じ
      // インスタンスを起こすまで `cached` は古い測定を配り続ける。
      // 実測（本番 2026-09-08）: 宣言上限 24,000ms の probe が payee.latencyMs 59,957ms
      // を、しかも withDeadline の**成功側**で返した。期限の setTimeout は凍結中に
      // 進まないので発火していない（deadline.ts の「凍結」節）。
      // 開始のタイミングは変えない（遅らせるほどキャッシュが古くなる）。延ばすのは
      // invocation の生存期間だけ。
      keepAliveUntilSettled(inFlight);
    }
    return { ...cached.probe, fromCache: true };
  }

  // Nothing measured yet, or the last reading is too old to stand behind.
  const pending = refreshing ?? (refreshing = measurePayeeProbe().finally(() => {
    refreshing = null;
  }));
  return pending;
}

async function measurePayeeProbe(): Promise<PayeeProbe> {
  const startedAt = Date.now();
  let probe: PayeeProbe;

  try {
    const result = await withDeadline(
      scorePayeeWallet(probeAddress()),
      PROBE_DEADLINE_MS,
      "payee_probe",
    );
    // `degraded` and a non-empty `signalsUnavailable` are different failures
    // (a refusal versus an incomplete reading) but the same news to an
    // operator: an upstream this product depends on is not answering.
    const unavailable = result.degraded
      ? ["payee_verdict_degraded", ...result.signalsUnavailable]
      : result.signalsUnavailable;
    probe = {
      status: unavailable.length > 0 ? "degraded" : "ok",
      unavailable,
      latencyMs: Date.now() - startedAt,
      detail: describeUnavailable(unavailable),
      fromCache: false,
    };
    if (unavailable.length > 0) {
      console.warn(`[vouch] payee_probe degraded: ${unavailable.join(",")}`);
    }
  } catch (error) {
    // 2026-09-08: 同じ文字列をログと health_snapshots.detail の両方へ。
    // `deadline_exceeded:payee_probe:24000ms` なら probe が自分の期限で死んだ
    // （= 上流が遅い）、そうでなければ上流が拒否した。足す資源が違う。
    const detail = describeProbeFailure(error);
    console.error(`[vouch] payee_probe failed: ${detail}`);
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
    measuredAt: Date.now(),
    expiresAt: Date.now() + (probe.status === "error" ? PROBE_FAILURE_TTL_MS : probeTtlMs()),
  };
  return probe;
}

/** Worst of several probe statuses — an outage anywhere is an outage. */
export function worstStatus(
  statuses: ("ok" | "degraded" | "error")[],
): "ok" | "degraded" | "error" {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}
