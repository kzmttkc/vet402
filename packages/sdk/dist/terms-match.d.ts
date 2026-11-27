/** chain-profile.ts の CHAIN_PROFILES.base.network と同じ値。 */
export declare const TERMS_BASE_NETWORK = "eip155:8453";
/** pay-or-refuse.ts の SOLANA_MAINNET と同じ値（tests が一致を確かめる）。 */
export declare const SOLANA_MAINNET_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** 照合が返す語。どれも PayRefuseReason の語（新しい語は無い）。 */
export type TermsMismatchReason = "payee_mismatch" | "price_above_declared" | "chain_or_asset_mismatch" | "evidence_unavailable" | "payee_unverified_on_rail" | "price_unverified";
/** 照合が読む判定の欄だけ。`/resources/{id}/decision?role=payer` の本文がそのまま当てはまる。 */
export type TermsDecision = {
    facts?: unknown;
    verified_terms?: unknown;
    verified_pay_to_by_network?: unknown;
};
/** v2 の形に揃えた accept（X402Accept と同じ欄）。 */
export type TermsAccept = {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
};
export declare function sameAddress(a: unknown, b: unknown): boolean;
export declare function payeeMatchesDeclared(payee: string, acceptPayTo: string, acceptNetwork: string): boolean;
export declare function isKnownUsdc6(network: string | null, asset: unknown): boolean;
/**
 * vet402 が記録した payTo・額と accept を照合する。
 * `verified_terms` があるときは判定語（ALLOW かどうか）や WARN 免除に関わらず照合する（N7）。
 * `verified_terms` が null のときは recommendation に関わらず `facts.payees` で照合する。
 */
export declare function matchDeclaredPayTerms(decision: TermsDecision | null, accept: TermsAccept, profile: {
    network: string;
}, requireVet402Allow: boolean): TermsMismatchReason[] | null;
/**
 * v1 の綴りを v2 の形へ揃える。実在する v1 の壁は `network: "base"` と
 * `maxAmountRequired` を使う（本番 `x402-payer.ts` の normalizeAccept と同じ規則）。
 * ここで揃えておかないと、金銭ゲートが v1 を丸ごと chain_or_asset_mismatch で落とし、
 * v1 の transport（X-PAYMENT）が届かない死んだ枝になる。
 */
export declare function normalizeAccept(raw: unknown): TermsAccept | null;
