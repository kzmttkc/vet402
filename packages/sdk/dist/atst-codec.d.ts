export declare const ATST_TAG = 1635021684;
export type AtstProfile = "ensip29-draft" | "atst-me-v2";
export type AttestationPayload = {
    n: string;
    a: `0x${string}`;
    k: string;
    v: string;
    t: number;
};
export type DecodedEnvelope = {
    version: 1 | 2;
    t: number;
    sig: `0x${string}`;
};
export type EnvelopeDecodeError = {
    error: string;
};
export declare function bytesToHex(b: Uint8Array): `0x${string}`;
export declare function hexToBytes(h: string): Uint8Array;
/** keccak256 (Ethereum's, i.e. pre-FIPS padding 0x01). */
export declare function keccak256Bytes(data: Uint8Array): Uint8Array;
/**
 * Canonical payload bytes. The signature covers keccak256 of exactly these bytes (draft line 66).
 * - ensip29-draft: { n, a, k, v, t }
 * - atst-me-v2 (0xLighthouse/ens-metadata@07ded0e2): { n, a, p = k, h = keccak256(utf8(v)), t }
 *   [the p/h reading is unconfirmed at the source; see PLAN_v4.3 §2.3 Q2]
 */
export declare function encodePayload(p: AttestationPayload, profile: AtstProfile): Uint8Array;
/** Envelope as it is stored in the text record: "0x…" hex or standard base64. */
export declare function encodeEnvelope(e: DecodedEnvelope, encoding: "base64" | "hex"): string;
/**
 * Decode an envelope record value. "0x" prefix → hex, anything else → base64 (draft line 104).
 * Returns `{ error: "ens_attestation_malformed: …" }` for a wrong tag, not exactly 3 elements,
 * a version other than 1/2, a signature that is not 65 bytes, or trailing bytes.
 * Whether a given version is accepted is the caller's policy (`profiles`), not the decoder's.
 */
export declare function decodeEnvelope(recordValue: string): DecodedEnvelope | EnvelopeDecodeError;
/** Text record key of an attestation: `attestations[RECORD_KEY][ATTESTER_NAME]` (draft lines 92-100). */
export declare function attestationKey(recordKey: string, attesterName: string): string;
/** Envelope version → payload profile. */
export declare function profileOfVersion(version: 1 | 2): AtstProfile;
