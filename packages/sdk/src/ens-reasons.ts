// ENSIP-29 gate vocabulary (PLAN_v4.3 §3.2 / §10.4).
// This module has NO imports on purpose: pay-or-refuse.ts may import it statically
// without pulling viem (or any ENS reader) into the static module graph.

/** The 13 refusal words the ENSIP-29 gate can return. */
export const ENS_ATTESTATION_REASONS = [
  "ens_name_unresolved",
  "ens_offer_missing",
  "ens_offer_malformed",
  "ens_offer_mismatch",
  "ens_attestation_missing",
  "ens_attestation_malformed",
  "ens_attestation_signer_mismatch",
  "ens_attestation_stale",
  "ens_attester_unresolved",
  "ens_attester_unpinned",
  "ens_attester_anchor_changed",
  "ens_record_changed_after_attestation",
  "ens_evidence_unavailable",
] as const;

export type EnsAttestationReason = (typeof ENS_ATTESTATION_REASONS)[number];

/** Words that belong to one attester (returned as a set, between offer_missing and offer_malformed). */
export const ENS_ATTESTER_REASONS = [
  "ens_attestation_missing",
  "ens_attestation_malformed",
  "ens_attestation_signer_mismatch",
  "ens_attestation_stale",
  "ens_attester_unresolved",
  "ens_attester_unpinned",
  "ens_attester_anchor_changed",
  "ens_record_changed_after_attestation",
] as const satisfies readonly EnsAttestationReason[];

/**
 * Priority of the words (PLAN_v4.3 §3.3.1):
 * evidence_unavailable > name_unresolved > offer_missing > per-attester words > offer_malformed > offer_mismatch.
 * Lower number sorts first in `reason_codes`.
 */
export const ENS_REASON_PRIORITY: Readonly<Record<EnsAttestationReason, number>> = {
  ens_evidence_unavailable: 0,
  ens_name_unresolved: 1,
  ens_offer_missing: 2,
  ens_attester_anchor_changed: 3,
  ens_attester_unresolved: 3,
  ens_attester_unpinned: 3,
  ens_attestation_malformed: 3,
  ens_attestation_signer_mismatch: 3,
  ens_attestation_stale: 3,
  ens_record_changed_after_attestation: 3,
  ens_attestation_missing: 3,
  ens_offer_malformed: 4,
  ens_offer_mismatch: 5,
};
