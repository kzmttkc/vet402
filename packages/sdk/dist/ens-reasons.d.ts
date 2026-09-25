/** The 13 refusal words the ENSIP-29 gate can return. */
export declare const ENS_ATTESTATION_REASONS: readonly ["ens_name_unresolved", "ens_offer_missing", "ens_offer_malformed", "ens_offer_mismatch", "ens_attestation_missing", "ens_attestation_malformed", "ens_attestation_signer_mismatch", "ens_attestation_stale", "ens_attester_unresolved", "ens_attester_unpinned", "ens_attester_anchor_changed", "ens_record_changed_after_attestation", "ens_evidence_unavailable"];
export type EnsAttestationReason = (typeof ENS_ATTESTATION_REASONS)[number];
/** Words that belong to one attester (returned as a set, between offer_missing and offer_malformed). */
export declare const ENS_ATTESTER_REASONS: readonly ["ens_attestation_missing", "ens_attestation_malformed", "ens_attestation_signer_mismatch", "ens_attestation_stale", "ens_attester_unresolved", "ens_attester_unpinned", "ens_attester_anchor_changed", "ens_record_changed_after_attestation"];
/**
 * Priority of the words (PLAN_v4.3 §3.3.1):
 * evidence_unavailable > name_unresolved > offer_missing > per-attester words > offer_malformed > offer_mismatch.
 * Lower number sorts first in `reason_codes`.
 */
export declare const ENS_REASON_PRIORITY: Readonly<Record<EnsAttestationReason, number>>;
