/**
 * x402 `auth-capture` payment, buyer side. (English header for judges. The Japanese block below is
 * the same content in our working language.)
 *
 * Signs one ERC-3009 ReceiveWithAuthorization with the official client
 * (`@x402/evm/auth-capture/client`, 2.30.0), re-sends the request to the seller once, waits for the
 * answer, and reports what happened. The buyer never calls the facilitator and never calls
 * capture or void: those belong to the seller's operator (scheme_auth_capture.md L27). The buyer
 * keeps one call of its own, `reclaim`, which `reclaimAuthCapture` in `./auth-capture.js` sends from
 * the buyer's wallet after the capture deadline.
 *
 * **Reached only by a dynamic import from the ALLOW branch of `payOrRefuse`**, like `./x402-pay.js`.
 */
/**
 * 買い手側の x402 `auth-capture` の支払い。公式 client（`@x402/evm/auth-capture/client` 2.30.0）で
 * ERC-3009 ReceiveWithAuthorization に 1 回だけ署名し、売り手へ 1 回だけ再送し、答えを待ち、何が起きたかを返す。
 * 買い手は facilitator を呼ばず、capture も void も呼ばない（売り手の operator の仕事）。買い手が持つのは
 * 期限後の `reclaim` だけで、それは `./auth-capture.js` の `reclaimAuthCapture` が買い手の財布から送る。
 *
 * **`payOrRefuse` の ALLOW ブランチからの動的 import でしか評価されない**（`./x402-pay.js` と同じ）。
 */
import type { ChainProfile } from "./chain-profile.js";
import { type AuthCapturePaymentInfo, type AuthCaptureReceipt, type AuthCaptureStateReader } from "./auth-capture.js";
import { type PayerAccount, type X402Accept, type X402Settlement } from "./x402-pay.js";
export type AuthCaptureAuthorization = {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
};
export type AuthCapturePayResult = {
    signed: true;
    /** 届いて、capture された（chain を読んだときは chain で、読まないときは売り手の申告で）。 */
    paid: boolean;
    txHash: string | null;
    nonce: string;
    authorization: AuthCaptureAuthorization;
    settlement: X402Settlement | null;
    responseStatus: number | null;
    receipt: AuthCaptureReceipt;
};
/** `AuthCaptureEscrow.getHash` と同じ計算。`payer` を 0 にすると、署名の nonce（payer に依らない hash）になる。 */
export declare function hashPaymentInfo(chainId: number, info: AuthCapturePaymentInfo, payer: string, escrow: string): string;
/**
 * 署名して、元のリクエストを PAYMENT-SIGNATURE 付きで**1回だけ**売り手へ再送し、答えを待つ。判定はしない
 * （ここへ来た時点で金銭ゲートと payee 照合は通っている、が `payOrRefuse` との契約）。払い直さない。
 */
export declare function executeAuthCapturePayment(args: {
    account: PayerAccount;
    accept: X402Accept;
    resource: string;
    method: string;
    profile: ChainProfile;
    fetch: typeof fetch;
    deliveryTimeoutMs?: number;
    stateReader?: AuthCaptureStateReader;
    onSigned?: (info: {
        nonce: string;
        authorization: AuthCaptureAuthorization;
        payer: string;
    }) => void;
}): Promise<AuthCapturePayResult>;
