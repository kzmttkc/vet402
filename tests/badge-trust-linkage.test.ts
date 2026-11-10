// ============================================================
// vet402 — the embeddable badge must not lie to a human (H-1 / H-5).
//
// R4 downstream/TOCTOU round. The public "Verified payee" badge went GREEN
// on nothing but a self-signed message (POST /v1/payees/verify): a BLOCK-
// scored, actively-draining wallet could sign a one-line message and paste a
// vet402 "Verified" badge onto a phishing page. Green must therefore be
// earned by BOTH facts a human reads into it: ownership was proven (a signed
// claim exists) AND the live judgment is a clean ALLOW. A BLOCK verdict is a
// revocation — the badge must actively say "Flagged", never green (H-5). Any
// state where trust cannot be established (WARN, a degraded read, or a failed
// score lookup) is fail-closed to "Caution", never green.
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  resolveBadgeState,
  renderBadgeSvg,
  agentBadgeState,
  payeeBadgeState,
} from "@/lib/badge/trust-badge";
import { __setDbForTests } from "@/lib/db/client";
import { GET as agentBadgeGET } from "@/app/api/badge/agent/[agentId]/route";
import { GET as payeeBadgeGET } from "@/app/api/badge/[address]/route";

const VERIFIED_GREY = "#666666";
const FLAGGED_GREY = "#444444";
const CAUTION_GREY = "#777777";

test("unsigned wallet is Unverified regardless of a good score", () => {
  const s = resolveBadgeState({ signed: false, recommendation: "ALLOW", subject: "payee" });
  assert.equal(s.state, "unverified");
  assert.equal(s.label, "Unverified");
  assert.notEqual(s.color, VERIFIED_GREY);
});

test("signed + clean ALLOW is the only path to green Verified payee", () => {
  const s = resolveBadgeState({ signed: true, recommendation: "ALLOW", subject: "payee" });
  assert.equal(s.state, "verified");
  assert.equal(s.label, "Verified payee");
  assert.equal(s.color, VERIFIED_GREY);
});

test("signed agent + clean ALLOW reads Verified agent", () => {
  const s = resolveBadgeState({ signed: true, recommendation: "ALLOW", subject: "agent" });
  assert.equal(s.state, "verified");
  assert.equal(s.label, "Verified agent");
  assert.equal(s.color, VERIFIED_GREY);
});

test("H-5 revocation: a signed wallet that turns BLOCK shows Flagged, never green", () => {
  const s = resolveBadgeState({ signed: true, recommendation: "BLOCK", subject: "payee" });
  assert.equal(s.state, "flagged");
  assert.equal(s.label, "Flagged");
  assert.notEqual(s.color, VERIFIED_GREY);
});

test("H-1 attack: BLOCK wallet cannot mint a green badge by signing", () => {
  // The exact exploit: self-attest, then embed. The signature is real, the
  // trust is not — the badge must not be green.
  const signed = resolveBadgeState({ signed: true, recommendation: "BLOCK", subject: "payee" });
  assert.notEqual(signed.color, VERIFIED_GREY);
  assert.notEqual(signed.state, "verified");
});

test("signed + WARN is Caution, not green (BLOCK/WARN never green)", () => {
  const s = resolveBadgeState({ signed: true, recommendation: "WARN", subject: "payee" });
  assert.equal(s.state, "caution");
  assert.equal(s.label, "Caution");
  assert.notEqual(s.color, VERIFIED_GREY);
});

test("fail-closed: a signed wallet whose score lookup failed is never green", () => {
  const s = resolveBadgeState({ signed: true, recommendation: null, subject: "payee" });
  assert.equal(s.state, "caution");
  assert.notEqual(s.color, VERIFIED_GREY);
});

test("fail-closed: a degraded read cannot produce green even on an ALLOW band", () => {
  // degraded means the score is a fail-closed refusal, not a measurement —
  // it must never be promoted to green even if `recommendation` came through.
  const s = resolveBadgeState({
    signed: true,
    recommendation: "ALLOW",
    degraded: true,
    subject: "payee",
  });
  assert.notEqual(s.color, VERIFIED_GREY);
  assert.equal(s.state, "caution");
});

test("rendered SVG uses a distinct grey fill for verified state", () => {
  const verified = renderBadgeSvg(
    resolveBadgeState({ signed: true, recommendation: "ALLOW", subject: "payee" }),
  );
  assert.match(verified, new RegExp(VERIFIED_GREY));
  assert.match(verified, /Verified payee/);

  const flagged = renderBadgeSvg(
    resolveBadgeState({ signed: true, recommendation: "BLOCK", subject: "payee" }),
  );
  assert.doesNotMatch(flagged, new RegExp(VERIFIED_GREY));
  assert.match(flagged, /Flagged/);

  const caution = renderBadgeSvg(
    resolveBadgeState({ signed: true, recommendation: "WARN", subject: "payee" }),
  );
  assert.doesNotMatch(caution, new RegExp(VERIFIED_GREY));
});

test("trust badge SVG fill colours are R=G=B only", () => {
  for (const s of [
    resolveBadgeState({ signed: false, recommendation: null, subject: "payee" }),
    resolveBadgeState({ signed: true, recommendation: "ALLOW", subject: "payee" }),
    resolveBadgeState({ signed: true, recommendation: "BLOCK", subject: "payee" }),
    resolveBadgeState({ signed: true, recommendation: "WARN", subject: "payee" }),
  ]) {
    const svg = renderBadgeSvg(s);
    for (const m of svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)) {
      const hex = m[1];
      assert.equal(hex.slice(1, 3), hex.slice(3, 5), hex);
      assert.equal(hex.slice(3, 5), hex.slice(5, 7), hex);
    }
  }
});

test("rendered SVG is well-formed and stays 156px wide", () => {
  const svg = renderBadgeSvg(
    resolveBadgeState({ signed: false, recommendation: null, subject: "payee" }),
  );
  assert.match(svg, /^<svg xmlns=/);
  assert.match(svg, /width="156"/);
  assert.match(svg, /<title>/);
});

// ============================================================
// 中-2B (2026-08-14 double-check) — the badge ROUTES must DERIVE `degraded`,
// not merely accept it. resolveBadgeState takes `degraded` pre-computed, so a
// pure test of it passed while the AGENT route dropped the derivation and a
// fail-closed agent (recommendation BLOCK because its reads failed) rendered red
// "Flagged" — accusing an agent we simply could not measure, while the identical
// payee rendered amber "Caution". These tests exercise the score→badge bridges
// the routes now delegate to, so a future drop of the derivation turns a test
// red instead of a live badge.
// ============================================================

test("agentBadgeState: a degraded BLOCK (unavailable reads) is amber Caution, NOT red Flagged", () => {
  const s = agentBadgeState(true, {
    recommendation: "BLOCK", // assessSybilRisk turns any *_unavailable into high→BLOCK
    signals: { sybil: { flags: ["sybil_checks_unavailable"] } },
  });
  assert.equal(s.state, "caution", "a read we could not complete is 'we don't know', not 'flagged'");
  assert.equal(s.color, CAUTION_GREY);
  assert.notEqual(s.color, FLAGGED_GREY);
});

test("agentBadgeState: a GENUINE BLOCK (no unavailable flags) still reads Flagged", () => {
  const s = agentBadgeState(true, {
    recommendation: "BLOCK",
    signals: { sybil: { flags: ["funding_cluster", "multi_agent_owner"] } },
  });
  assert.equal(s.state, "flagged", "a measured BLOCK is a real revocation, not merely unknown");
  assert.equal(s.color, FLAGGED_GREY);
});

test("agentBadgeState: a clean ALLOW is green; a null score (lookup failed) is amber", () => {
  const green = agentBadgeState(true, { recommendation: "ALLOW", signals: { sybil: { flags: [] } } });
  assert.equal(green.state, "verified");
  assert.equal(green.color, VERIFIED_GREY);

  const failed = agentBadgeState(true, null);
  assert.equal(failed.state, "caution");
  assert.notEqual(failed.color, VERIFIED_GREY);
});

test("agent vs payee are SYMMETRIC on a degraded read — both amber, neither red", () => {
  const agent = agentBadgeState(true, {
    recommendation: "BLOCK",
    signals: { sybil: { flags: ["wallet_metrics_unavailable"] } },
  });
  const payee = payeeBadgeState(true, {
    recommendation: "BLOCK",
    degraded: true,
    signals: { flags: ["wallet_metrics_unavailable"] },
  });
  assert.equal(agent.state, payee.state, "the two subjects must not disagree on 'we could not check'");
  assert.equal(agent.state, "caution");
});

test("payeeBadgeState: degraded via unavailable flags alone (no explicit flag) still avoids red", () => {
  // Belt-and-suspenders: if the engine's explicit `degraded` were ever dropped,
  // the flags still keep a fail-closed read out of "Flagged".
  const s = payeeBadgeState(true, {
    recommendation: "BLOCK",
    signals: { flags: ["reputation_summary_unavailable"] },
  });
  assert.equal(s.state, "caution");
  assert.notEqual(s.color, FLAGGED_GREY);
});

test("payeeBadgeState: a genuine measured BLOCK is Flagged; clean ALLOW is green", () => {
  const flagged = payeeBadgeState(true, { recommendation: "BLOCK", degraded: false, signals: { flags: [] } });
  assert.equal(flagged.state, "flagged");
  const green = payeeBadgeState(true, { recommendation: "ALLOW", degraded: false, signals: { flags: [] } });
  assert.equal(green.state, "verified");
  assert.equal(green.color, VERIFIED_GREY);
});

// ---- real route handlers: the unsigned path drives the actual GET ----------
// The degraded case cannot be driven end-to-end without a live chain (the score
// needs an RPC), so the bridges above pin that wiring; here the REAL handlers
// are driven through the injectable DB seam for the branch that needs no chain —
// no signed claim → Unverified — proving each route calls its bridge + renders.

function emptySignedDb() {
  return {
    // The key-less badge routes rate-limit first (DB-backed when a db is set):
    // model one fresh bucket hit (count 1 ≤ limit → allowed).
    insert() {
      return {
        values(v: { bucketKey: string; resetAt: Date }) {
          return {
            onConflictDoUpdate() {
              return {
                returning: async () => [{ bucketKey: v.bucketKey, count: 1, resetAt: v.resetAt }],
              };
            },
          };
        },
      };
    },
    // The signed-claim lookup: no row → unsigned → Unverified, no scoring.
    select() {
      return {
        from() {
          return {
            where() {
              return { limit: async () => [] as unknown[] };
            },
          };
        },
      };
    },
  };
}

afterEach(() => __setDbForTests(null));

test("ROUTE /api/badge/agent/[agentId]: an unsigned agent renders Unverified SVG", async () => {
  __setDbForTests(emptySignedDb());
  const req = new NextRequest("http://localhost/api/badge/agent/42.svg");
  const res = await agentBadgeGET(req, { params: Promise.resolve({ agentId: "42.svg" }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/svg+xml");
  const svg = await res.text();
  assert.match(svg, /Unverified/);
  assert.doesNotMatch(svg, /#059669|#b45309|#b91c1c/);
});

test("ROUTE /api/badge/[address]: an unsigned payee renders Unverified SVG", async () => {
  __setDbForTests(emptySignedDb());
  const addr = "0x1111111111111111111111111111111111111111";
  const req = new NextRequest(`http://localhost/api/badge/${addr}.svg`);
  const res = await payeeBadgeGET(req, { params: Promise.resolve({ address: `${addr}.svg` }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/svg+xml");
  const svg = await res.text();
  assert.match(svg, /Unverified/);
  assert.doesNotMatch(svg, /#059669|#b45309|#b91c1c/);
});

test("every state carries an aria description that says what green means", () => {
  // The human-misread fix lives partly in the accessible name: a screen
  // reader / hover must learn that green = ownership signed AND ALLOW, and
  // that the other states are not a trust guarantee.
  const green = resolveBadgeState({ signed: true, recommendation: "ALLOW", subject: "payee" });
  assert.match(green.aria, /Verified payee/);
  assert.match(green.aria, /ALLOW|trust/i);
  const caution = resolveBadgeState({ signed: true, recommendation: "WARN", subject: "payee" });
  assert.match(caution.aria, /not a trust guarantee|trust not established|ownership/i);
});
