// ============================================================
// 「次に vet402 がこの出品を買うのはいつか」の目安（2026-09-29 敵対的監査 6 周目・中）。
//
// 売り手が直した後に知りたいのは「いつ確かめてもらえるか」。L1 の掃引（l1-runner.ts の候補 SQL）の規則のうち、
// 出品ごとに計算できるものだけから出す。計算できなければ何も書かない（null）。約束ではなく「この日より前には買わない」。
//   窓    直近の購入行（status・チェーンを問わない）から SWEEP_WINDOW_DAYS 日は買わない。優先ホストは
//         PRIORITY_SWEEP_WINDOW_DAYS、settled が MATURE_SETTLED_MIN 件以上なら MATURE_SWEEP_WINDOW_DAYS。
//   冷却  署名後の行（COOLDOWN_STATUSES）の新しい 3 件が全部、決済に至っていない（settled / settle_claimed が無い）なら
//         候補にしない（NON_SETTLING_COOLDOWN_STREAK・期限は無い: 新しい行が増えるまで続く）。
//   L0    最新の L0 プローブが pass の出品だけが候補。
//   形    未置換のパスパラメータのある URL・https でない URL は買わない。
// 日次予算・需要の順・売り手ごとの日次上限・初回購入の枠は日ごとに変わるので計算しない（だから「目安」）。
//
// 定数は l1-runner.ts の値の写し（/sellers は l1-runner を import できない: tests/sellers-no-payment-imports.test.ts）。
// tests/sellers-r6.test.ts が l1-runner の値・候補 SQL の status の並びと一致することを固定する。
// ============================================================
import { isPathTemplate } from "@/lib/observatory/path-template";

export const SWEEP_WINDOW_DAYS = 6;
export const PRIORITY_SWEEP_WINDOW_DAYS = 1;
export const MATURE_SWEEP_WINDOW_DAYS = 30;
export const MATURE_SETTLED_MIN = 3;
export const NON_SETTLING_COOLDOWN_STREAK = 3;
export const PRIORITY_SELLER_HOSTS = ["x402.twit.sh", "x402.tavily.com", "stableenrich.dev", "api.exa.ai"] as const;
/** 冷却が数える status（候補 SQL の順のまま）。このうち settled / settle_claimed が 1 つでもあれば冷却しない。 */
export const COOLDOWN_STATUSES = [
  "settled",
  "settle_claimed",
  "settle_claim_refuted",
  "settle_claimed_unverifiable",
  "delivered_no_receipt",
  "settle_failed",
  "request_error",
] as const;

/** l1-runner の isPriorityResourceKey と同じ判定（ホストそのものか、ホスト + "/"）。 */
export function isPriorityKey(resourceKey: string): boolean {
  const key = resourceKey.toLowerCase();
  return PRIORITY_SELLER_HOSTS.some((h) => key === h || key.startsWith(`${h}/`));
}

/** 出品ごとの材料（reader.ts の readSellerDetail が DB から読む。無ければ目安を出さない）。 */
export interface NextBuyFacts {
  /** その出品の最新の購入行の時刻（status・チェーンを問わない・ISO8601 UTC）。 */
  lastAttemptAnyAt: string | null;
  /** status = settled の行の数（チェーンを問わない）。 */
  settledCount: number;
  /** 署名後の新しい 3 件が全部、決済に至っていない（冷却中）。 */
  cooldown: boolean;
  /** 最新の L0 プローブの判定（無ければ null）。 */
  latestL0Verdict: string | null;
  /** 最新の L0 プローブの時刻（ISO8601 UTC・無ければ null）と記録した理由（2026-09-29 監査 7 周目）。 */
  latestL0At?: string | null;
  latestL0Reason?: string | null;
}

/**
 * 次の L0 プローブの目安（2026-09-29 監査 7 周目）。プローブは古い順に回るので予約は無い。本番 2026-09-29 の実測
 * （掲載中・直近 14 日の再プローブ間隔）で p50 18h・p95 117h・p99 120h。
 */
export const L0_REPROBE_WITHIN_HOURS = 120;

/**
 * 購入の有無を問わず出品に出す L0 の 1〜2 文（最新の判定・理由・次のプローブの目安）。未プローブは先頭近くに並ぶ。
 */
export function l0ProbeLine(f: NextBuyFacts | null | undefined, nowMs: number = Date.now()): string | null {
  if (!f) return null;
  if (!f.latestL0Verdict || !f.latestL0At) {
    return "Latest L0 check (the 402 to an unpaid request): none yet. Listings never probed go near the front of the daily L0 run. Not probed is not a failure.";
  }
  const t = Date.parse(f.latestL0At);
  if (!Number.isFinite(t)) return null;
  const at = new Date(t).toISOString().slice(0, 16).replace("T", " ");
  const reason = f.latestL0Reason ? ` (${f.latestL0Reason.replace(/[^\x20-\x7e]/g, "").slice(0, 60)})` : "";
  const due = t + L0_REPROBE_WITHIN_HOURS * 3_600_000;
  const next =
    due <= nowMs
      ? "The next probe is due; probes run oldest first, so there is no booked time."
      : `Probes run oldest first, so there is no booked time; the next one usually comes by ${new Date(due).toISOString().slice(0, 16).replace("T", " ")} UTC (within ${L0_REPROBE_WITHIN_HOURS} hours of the last).`;
  const unverified = f.latestL0Verdict === "unverified" ? " Unverified is not a failure." : "";
  return `Latest L0 check (the 402 to an unpaid request): ${f.latestL0Verdict}${reason} at ${at} UTC.${unverified} ${next}`;
}

export type NextBuy =
  | { kind: "not_bought"; reason: "path_template" | "not_https" }
  | { kind: "cooldown" }
  | {
      kind: "window";
      notBefore: string;
      windowDays: number;
      basis: "priority" | "mature" | "default";
      l0: string | null;
      /** 頁を読んだ時点で窓がもう明けている（notBefore が過去）。 */
      open: boolean;
    };

const DAY_MS = 86_400_000;

/** 目安。材料が無い・時刻が読めないなら null（書かない）。 */
export function nextBuyOf(
  listing: { resourceKey: string; resourceUrl: string },
  f: NextBuyFacts | null | undefined,
  nowMs: number = Date.now(),
): NextBuy | null {
  if (isPathTemplate(listing.resourceUrl)) return { kind: "not_bought", reason: "path_template" };
  if (!/^https:\/\//i.test(listing.resourceUrl)) return { kind: "not_bought", reason: "not_https" };
  if (!f) return null;
  if (f.cooldown) return { kind: "cooldown" };
  const basis = isPriorityKey(listing.resourceKey) ? "priority" : f.settledCount >= MATURE_SETTLED_MIN ? "mature" : "default";
  const windowDays = basis === "priority" ? PRIORITY_SWEEP_WINDOW_DAYS : basis === "mature" ? MATURE_SWEEP_WINDOW_DAYS : SWEEP_WINDOW_DAYS;
  if (!f.lastAttemptAnyAt) return null;
  const t = Date.parse(f.lastAttemptAnyAt);
  if (!Number.isFinite(t)) return null;
  const end = t + windowDays * DAY_MS;
  const notBefore = new Date(end).toISOString().slice(0, 16).replace("T", " ");
  return { kind: "window", notBefore: `${notBefore} UTC`, windowDays, basis, l0: f.latestL0Verdict, open: end <= nowMs };
}

/** 頁に出す 1〜2 文（null は書かない）。 */
export function nextBuyLine(nb: NextBuy | null): string | null {
  if (!nb) return null;
  if (nb.kind === "not_bought") {
    return nb.reason === "path_template"
      ? "vet402 does not buy this listing: its URL has a path parameter vet402 cannot fill."
      : "vet402 does not buy this listing: its URL is not https.";
  }
  if (nb.kind === "cooldown") {
    return `Not scheduled: the last ${NON_SETTLING_COOLDOWN_STREAK} paid attempts here did not settle, so the regular sweep does not pick this listing until that changes.`;
  }
  const why =
    nb.basis === "priority"
      ? "this host is on the priority list, bought at most once a day"
      : nb.basis === "mature"
        ? `this listing has ${MATURE_SETTLED_MIN} or more settled purchases, so it is bought at most once every ${nb.windowDays} days`
        : `a listing is bought at most once every ${nb.windowDays} days`;
  const l0 =
    nb.l0 === "pass"
      ? ""
      : ` It is picked only while its latest L0 check passes; the latest one reads ${nb.l0 ?? "not probed"}.`;
  if (nb.open) {
    return `The regular sweep can pick this listing again since ${nb.notBefore} (${why}). When it does depends on the daily budget and the order of demand, so there is no booked date.${l0}`;
  }
  return `Not before ${nb.notBefore} (${why}). After that it depends on the daily budget and the order of demand, so this is the earliest date, not a booking.${l0}`;
}
