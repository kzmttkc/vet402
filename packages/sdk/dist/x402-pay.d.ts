/**
 * x402 `exact` の支払い実行（EIP-3009 の署名 → facilitator `/settle`）。
 *
 * **このファイルは `payOrRefuse` の ALLOW ブランチからしか動的 import されない**
 * （`docs/ethonline-2026/WINDOW_PLAN.md` §4「呼べないことの4層証明」の第3層）。
 * 拒否経路ではモジュールの評価すら起きないので、「signer を呼ばなかった」ではなく
 * 「signer に**到達できない**」を構造で言える。static import に戻すと、この保証は消える。
 */
/** 402 チャレンジの `accepts[]` 1件（x402 v2 / scheme `exact`）。 */
export type X402Accept = {
    scheme: string;
    network: string;
    /** 最小単位の文字列（USDC は 6 桁）。 */
    amount: string;
    asset: string;
    payTo: string;
    resource?: string;
    extra?: {
        /** 実測（WINDOW_PLAN §3）では The Graph の 402 が "eip3009" を明示する。 */
        assetTransferMethod?: string;
        /** EIP-712 ドメイン。未提示のときは Base の正規 USDC の値に落とす。 */
        name?: string;
        version?: string;
    };
};
/** 署名者。`payOrRefuse` はこの型の値を ALLOW ブランチまで**一度も触らない**。 */
export type PayerAccount = {
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
export type X402PayResult = {
    /** 署名が実在するか。settle が失敗しても true のまま（隠さない）。 */
    signed: boolean;
    settled: boolean;
    txHash: string | null;
    /** facilitator へ送った payload（呼び手が自分で検算できるように返す）。 */
    payload: Record<string, unknown> | null;
};
/**
 * 署名して facilitator に settle させる。**判定は一切しない**——ここへ来た時点で
 * 通っている、というのが `payOrRefuse` との契約。金額・チェーン・asset・payTo の
 * 検査を呼び出し側に残すのは、この関数を単体で「安全な支払い」として再利用させないため。
 */
export declare function executeX402Payment(args: {
    account: PayerAccount;
    accept: X402Accept;
    resource: string;
    chainId: number;
    facilitatorUrl: string;
    fetch: typeof fetch;
}): Promise<X402PayResult>;
