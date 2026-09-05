/**
 * 署名者。**ALLOW ブランチに入るまで、この値のプロパティには一度も触らない。**
 * `typeof signer.signTypedData === "function"` と書いた瞬間に拒否経路から
 * signer へのプロパティ参照が発生し、「到達できない」が嘘になる（第1層）。
 */
export type PayIfTrustedSigner = {
    address: string;
    signTypedData: (typedData: {
        domain: Record<string, unknown>;
        types: Record<string, {
            name: string;
            type: string;
        }[]>;
        primaryType: string;
        message: Record<string, unknown>;
    }) => Promise<string>;
};
export type PayIfTrustedInput = {
    /** `sha256("<METHOD> <正規化URL>")`。`GET /api/v1/resolve?q=<url>` が返す。 */
    resourceId: string;
    signer: PayIfTrustedSigner;
    /**
     * 使う fetch。**必須**——グローバル fetch を黙って掴むと、拒否経路が本当に
     * どこへも出ていないことを呼び手が検算できない。
     */
    fetch: typeof fetch;
    /** 402 を返す資源の URL。無ければ ALLOW でも払わない。 */
    resource?: string;
    method?: string;
    /** 事前に知っている受取アドレス。402 が名乗る `payTo` との一致を要求する（§14.1 #2）。 */
    payee?: string;
    amountUsd?: number;
    maxPerTxUsd?: number;
    apiUrl?: string;
    apiKey?: string;
    /** 決定行の出所。既定 "mcp"（L1 台帳と混ぜない・F19/F20）。 */
    source?: string;
};
/**
 * 判定の測定そのもの。**`/decision` の応答をそのまま通す**——とくに
 * `evidence[]` は要素を組み替えない。各行の `source`（"vet402" / "subgraph"）が
 * 落ちると、審査員が「どの台帳を読んだ答えか」を目で追えなくなる（§2 #3・G21c）。
 */
export type PayIfTrustedMeasurement = {
    recommendation: string | null;
    reason_codes: string[];
    facts: Record<string, unknown>;
    evidence: Record<string, unknown>[];
    rules_version: string | null;
    degraded: boolean | null;
};
export type PayIfTrustedResult = {
    /** PAID = 署名して売り手が受理した / REFUSE = 署名前に止めた / FAILED = 署名後に決済されなかった。 */
    decision: "PAID" | "REFUSE" | "FAILED";
    safe_to_pay: boolean;
    /** 機械可読な固定語彙。サーバの reason_codes をそのまま含む。 */
    refuse_reasons: string[];
    summary: string;
    /** 署名が実在するか。FAILED でも true——隠さない（§4 E18）。 */
    signed: boolean;
    attested: boolean;
    txHash: string | null;
    /** 署名した EIP-3009 認可の nonce。拒否経路では null＝「署名が存在しない」の機械可読な印。 */
    nonce: string | null;
    /**
     * §14.1 #5: `PAYMENT-RESPONSE` は売り手の**主張**であって `settled` ではない。
     * チェーンで再読した照合器だけが `settled` を名乗れるので、ここは `settle_claimed` まで。
     */
    settlement: "settle_claimed" | null;
    measurement: PayIfTrustedMeasurement;
};
/** 判定を引き、全部の関門を通ったときにだけ signer へ到達する。 */
export declare function payIfTrusted(input: PayIfTrustedInput): Promise<PayIfTrustedResult>;
