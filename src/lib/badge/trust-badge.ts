// ============================================================
// vet402 — embeddable-badge trust linkage (H-1 / H-5, 2026-08-13 R4).
//
// WHY THIS EXISTS. The public SVG badge used to go GREEN "Verified payee" on
// nothing but a self-signed message. A human reads "Verified" as "vet402 says
// this counterparty is safe", but the green was decoupled from the real
// judgment: a BLOCK-scored, actively-draining wallet could self-attest (POST
// /v1/payees/verify) and paste a vet402 "Verified" badge onto a phishing page.
//
// This is the single decision function both badge routes share. Green is
// earned by BOTH facts a human reads into the badge:
//   1. ownership was proven — a signed claim/passport exists (`signed`), AND
//   2. the LIVE judgment is a clean ALLOW (not degraded, not WARN, not BLOCK).
//
// Everything else is fail-closed away from green:
//   - BLOCK          → "Flagged" (red). This IS the revocation path (H-5): a
//                      signed wallet that later scores BLOCK stops being green.
//   - WARN / degraded / lookup-failed → "Caution" (amber). Ownership may be
//     attested but trust is NOT established, so the badge must not vouch.
//   - not signed     → "Unverified" (grey), unchanged.
//
// The machine layer (SDK / middleware) never reads this badge — it reads the
// score API directly — and that stays true. This only closes the HUMAN
// misread, and the honest meaning of each state is spelled out in `aria` so a
// screen reader / hover learns that green means "signed AND ALLOW", not a
// blanket trust guarantee.
// ============================================================

import { hasUnavailableInput } from "@/lib/scoring/verdict";

export type BadgeRecommendation = "ALLOW" | "WARN" | "BLOCK";

/** Machine-readable badge state, independent of colour/label wording. */
export type BadgeStateName = "verified" | "caution" | "flagged" | "unverified";

export type BadgeSubject = "payee" | "agent";

export type BadgeStateInput = {
  /** True when a signed self-attestation exists (verifiedPayees / agentPassports). */
  signed: boolean;
  /**
   * The LIVE recommendation for this subject. `null` means the score lookup
   * could not be completed — treated as trust-unknown and fail-closed away
   * from green, never as an implicit ALLOW.
   */
  recommendation: BadgeRecommendation | null;
  /**
   * True when the score came from a degraded read (a fail-closed refusal, not
   * a measurement). Never promoted to green even if `recommendation` is ALLOW.
   */
  degraded?: boolean;
  subject: BadgeSubject;
};

export type BadgeState = {
  state: BadgeStateName;
  /** Short visible label rendered in the badge's right segment. */
  label: string;
  /** Fill colour for the right segment. Green is reserved for `verified`. */
  color: string;
  /** Full accessible description — the honest meaning of the state. */
  aria: string;
};

// R=G=B greys only (2026-11-11). Labels distinguish states; hue does not signal trust.
const VERIFIED_GREY = "#666666";
const CAUTION_GREY = "#777777";
const FLAGGED_GREY = "#444444";
const UNVERIFIED_GREY = "#555555";

/**
 * The one place that decides what an embeddable vet402 badge is allowed to
 * say. Pure and side-effect-free so it is unit-tested directly; the routes
 * supply `signed` (a DB lookup) and `recommendation`/`degraded` (a live score,
 * fail-closed to null on any error) and render the result.
 */
export function resolveBadgeState(input: BadgeStateInput): BadgeState {
  const noun = input.subject === "agent" ? "agent" : "payee";

  if (!input.signed) {
    return {
      state: "unverified",
      label: "Unverified",
      color: UNVERIFIED_GREY,
      aria: `vet402: Unverified — this ${noun} has not signed a vet402 ownership attestation. Not a trust guarantee.`,
    };
  }

  // Signed from here down. A degraded read is not a measurement, so it can
  // never reach green even if a recommendation string came through.
  const trustUnknown = input.recommendation === null || input.degraded === true;

  if (!trustUnknown && input.recommendation === "BLOCK") {
    return {
      state: "flagged",
      label: "Flagged",
      color: FLAGGED_GREY,
      aria: `vet402: Flagged — ownership is signed but the live vet402 score for this ${noun} is BLOCK. Do not treat as safe.`,
    };
  }

  if (!trustUnknown && input.recommendation === "ALLOW") {
    const label = input.subject === "agent" ? "Verified agent" : "Verified payee";
    return {
      state: "verified",
      label,
      color: VERIFIED_GREY,
      aria: `vet402: ${label} — wallet ownership is signed AND the live vet402 trust score is ALLOW.`,
    };
  }

  // WARN, a degraded read, or a failed lookup: ownership is attested but trust
  // is not established. Fail-closed to amber — never green.
  return {
    state: "caution",
    label: "Caution",
    color: CAUTION_GREY,
    aria: `vet402: Caution — ownership is signed but trust is not established (the live vet402 score is not a clean ALLOW). Ownership only; not a trust guarantee.`,
  };
}

// ---- score → badge bridges (中-2B, 2026-08-14 double-check) ----------------
//
// WHY THESE EXIST, AND WHY THEY ARE NOT just resolveBadgeState. resolveBadgeState
// takes `degraded` as an ALREADY-COMPUTED input, so a pure test of it can pass
// while a ROUTE forgets to derive and pass `degraded` at all. That is exactly
// what happened: the payee badge route read `score.degraded` and passed it, but
// the AGENT badge route passed only `recommendation` — so a degraded agent
// (recommendation BLOCK because its reads failed) rendered red "Flagged"
// ("we caught this agent"), while the identical payee rendered amber "Caution"
// ("we could not check"). An asymmetric, accusatory misread of "we don't know".
//
// The two subjects carry "degraded" in DIFFERENT shapes — the payee engine
// exposes an explicit `degraded` boolean plus a flat `signals.flags`, while the
// agent engine exposes `signals.sybil.flags` — so the derivation is per-subject.
// Routing BOTH badge routes through these bridges means the derivation lives in
// ONE tested place per subject and a route can no longer build a badge that
// skips it. Structural input types keep this file free of the engine (and its DB
// imports); `hasUnavailableInput` is the SAME definition the fail-closed verdict
// uses, so "degraded" means the one thing here it means everywhere.

/** The slice of an agent trust-score result a badge needs. */
export type AgentBadgeScoreView = {
  recommendation: BadgeRecommendation | null;
  signals: { sybil: { flags: readonly string[] } };
};

/** The slice of a payee trust-score result a badge needs. */
export type PayeeBadgeScoreView = {
  recommendation: BadgeRecommendation | null;
  degraded?: boolean;
  signals?: { flags?: readonly string[] };
};

/**
 * Agent badge state from a raw agent score (or null when the lookup could not be
 * completed). Derives `degraded` from the score's OWN sybil flags so a
 * fail-closed agent reads amber "Caution", symmetric with the payee side.
 */
export function agentBadgeState(signed: boolean, score: AgentBadgeScoreView | null): BadgeState {
  return resolveBadgeState({
    signed,
    subject: "agent",
    recommendation: score ? score.recommendation : null,
    degraded: score ? hasUnavailableInput(score.signals.sybil.flags) : false,
  });
}

/**
 * Payee badge state from a raw payee score (or null). Honours the engine's
 * explicit `degraded` flag AND, belt-and-suspenders, the same unavailable-input
 * derivation the agent side uses — so if `degraded` were ever dropped from the
 * payee result, the flags still keep a fail-closed read out of red.
 */
export function payeeBadgeState(signed: boolean, score: PayeeBadgeScoreView | null): BadgeState {
  const degraded = score
    ? score.degraded === true || hasUnavailableInput(score.signals?.flags ?? [])
    : false;
  return resolveBadgeState({
    signed,
    subject: "payee",
    recommendation: score ? score.recommendation : null,
    degraded,
  });
}

// Minimal XML-attribute/text escaper. Labels come from a fixed set today, but
// the render must be safe by construction so no future caller can inject
// markup into the badge via the label/aria.
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render the embeddable SVG for a resolved badge state. Geometry is shared by
 * both badge routes (payee + agent) so the two stay pixel-identical. The
 * honest, full meaning of the state rides in `aria-label` (and `<title>` for
 * hover), which is where the "green means signed AND ALLOW" clarification
 * lives — the visible right segment is too small for a sentence.
 */
export function renderBadgeSvg(state: BadgeState): string {
  const aria = xmlEscape(state.aria);
  const label = xmlEscape(state.label);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="156" height="24" role="img" aria-label="${aria}">
  <title>${aria}</title>
  <rect width="58" height="24" rx="4" fill="#111111"/>
  <rect x="58" width="98" height="24" rx="4" fill="${state.color}"/>
  <rect x="58" width="6" height="24" fill="${state.color}"/>
  <text x="29" y="16" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11" fill="#ffffff">vet402</text>
  <text x="107" y="16" text-anchor="middle" font-family="Verdana,sans-serif" font-size="10" fill="#ffffff">${label}</text>
</svg>`;
}
