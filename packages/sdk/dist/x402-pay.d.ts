/**
 * x402 `exact` の支払い実行——EIP-3009 の署名を載せて、**元のリクエストを売り手へ再送する**。
 *
 * **買い手は facilitator を呼ばない。決済するのは売り手**（が使う facilitator）であり、
 * 買い手がすることは「署名ヘッダを付けて再送し、応答ヘッダのレシートを読む」だけ。
 * 根拠は2つ、どちらも一次:
 *   - coinbase/x402 `specs/transports-v2/http.md`（2026-08-14 取得）——v2 は
 *     PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE、v1 は X-PAYMENT /
 *     X-PAYMENT-RESPONSE。どれも売り手との1本の HTTP 往復に載る
 *   - 本番の実装 `src/lib/observatory/l1-runner.ts` L977-1045 と
 *     `src/lib/observatory/x402-payer.ts`——L1 は実際にこの形で 09-04 までに実支払いをしている
 * 2026-09-05 以前のこのファイルは `https://x402.org/facilitator/settle` を買い手から
 * 叩いていた。その形のまま 09-08 に The Graph へ払えば、金は動かず理由も残らなかった。
 *
 * **このファイルは `payOrRefuse` の ALLOW ブランチからしか動的 import されない**
 * （WINDOW_PLAN §4「呼べないことの4層証明」の第3層）。拒否経路ではモジュールの評価すら
 * 起きないので、「signer を呼ばなかった」ではなく「signer に**到達できない**」を構造で言える。
 * static import に戻すと、この保証は消える——`test/no-static-payment-import.test.mjs` が
 * dist の静的モジュールグラフを辿って、それを赤で知らせる。
 */
/** Base メインネットの CAIP-2。 */
export declare const BASE_CAIP2 = "eip155:8453";
/**
 * Base 正規 USDC の EIP-712 ドメイン。**売り手からは取らない**（本番 2026-08-22 監査）。
 * 2026-08-22 に一次確認済み（https://mainnet.base.org への eth_call・0x8335…2913）:
 *   name() 0x06fdde03 → "USD Coin" / version() 0x54fd4d50 → "2"
 *
 * 誤ったドメインで署名しても資金は不正な宛先へは動かない（検証に落ちるだけ）。
 * それでも売り手に選ばせてはいけないのは、**署名は無料ではない**からで、
 * 決済され得ない認可を掴まされると予算と署名だけが焼ける。
 */
export declare const BASE_USDC_EIP712_NAME = "USD Coin";
export declare const BASE_USDC_EIP712_VERSION = "2";
/**
 * accept の `extra` が正規ドメインと矛盾していないか。未提示は可（ピン留め値を使う）。
 * 提示されていて値が違うなら拒否——`payOrRefuse` の金銭ゲートが署名の前に落とす。
 */
export declare function hasCanonicalUsdcDomain(extra: X402Accept["extra"] | undefined): boolean;
/** 402 チャレンジの `accepts[]` 1件（x402 v1/v2 / scheme `exact`）。 */
export type X402Accept = {
    scheme: string;
    /** CAIP-2 に正規化済み（v1 の "base" スラッグはここへ来るまでに変換される）。 */
    network: string;
    /** 最小単位の文字列（USDC は 6 桁）。v1 の `maxAmountRequired` はここへ正規化される。 */
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    resource?: string;
    extra?: {
        /** 実測（WINDOW_PLAN §3）では The Graph の 402 が "eip3009" を明示する。 */
        assetTransferMethod?: string;
        /** 売り手が名乗る EIP-712 ドメイン。**採用しない**。矛盾の検出にだけ使う。 */
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
export type Eip3009Authorization = {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
};
/** 決済レシート（v2 PAYMENT-RESPONSE / v1 X-PAYMENT-RESPONSE を復号したもの）。 */
export type X402Settlement = {
    success: boolean;
    transaction: string | null;
    network: string | null;
    payer: string | null;
    errorReason: string | null;
};
export type X402PayResult = {
    /** 署名が実在するか。決済が失敗しても true のまま（隠さない）。 */
    signed: boolean;
    settled: boolean;
    txHash: string | null;
    /**
     * 署名した認可の nonce。**我々しか作れない一回性の値**で、
     * 「その決済 tx はこの購入のものか」を後から確かめる唯一の手段
     * （本番 `settlement-verify.ts` の nonce 束縛・2026-09-04 監査 P1-1）。
     * 決済が失敗しても、署名した以上は必ず返る。
     */
    nonce: string | null;
    authorization: Eip3009Authorization | null;
    /** 復号したレシート。ヘッダが無ければ null（本文は決して読まない）。 */
    settlement: X402Settlement | null;
    /** 売り手からの応答ステータス。 */
    responseStatus: number | null;
};
/**
 * 認可の有効窓の上限（秒）。本番は 2026-09-04 監査 P2 で 600 → 120 に短縮した。
 * 署名した EIP-3009 は validBefore まで**生きた金**で、その間ずっと売り手はいつでも
 * 決済できる。我々は決済されなかった試行をその場で failed と記帳するので、窓が長いほど
 * 「記帳と実際の支出が食い違う」時間が延びる。
 */
export declare const MAX_AUTHORIZATION_WINDOW_SECONDS = 120;
/**
 * 短命・ランダム nonce の認可。売り手が名乗る `maxTimeoutSeconds` に関わらず
 * validBefore ≤ now + {@link MAX_AUTHORIZATION_WINDOW_SECONDS}。
 * 小数の maxTimeoutSeconds は既定値へ落とす（本番 2026-09-04 監査 P1-2:
 * validBefore が "…​.5" になり BigInt が throw していた）。
 */
export declare function buildAuthorization(input: {
    from: string;
    to: string;
    value: string;
    nowSec: number;
    maxTimeoutSeconds?: number;
}): Eip3009Authorization;
/**
 * EIP-3009 TransferWithAuthorization の署名。ドメインは**トークンのもの**であって
 * 売り手のものではない（{@link BASE_USDC_EIP712_NAME}）。呼び手のゲートを素通りした
 * 場合の保険として、矛盾する `extra` はここでも拒否する——このモジュールは金に署名する。
 */
export declare function signX402Payment(input: {
    account: PayerAccount;
    accept: X402Accept;
    authorization: Eip3009Authorization;
    chainId: number;
}): Promise<{
    signature: string;
}>;
/**
 * 署名済みペイロードを、**チャレンジが話した transport** に包む。
 *   v2 → PAYMENT-SIGNATURE: { x402Version:2, resource, accepted, payload }
 *   v1 → X-PAYMENT:        { x402Version:1, scheme, network(スラッグ), payload }
 */
export declare function encodePaymentHeader(input: {
    x402Version: 1 | 2;
    accept: X402Accept;
    payload: {
        signature: string;
        authorization: Eip3009Authorization;
    };
    resourceUrl: string;
}): {
    headerName: string;
    headerValue: string;
};
/**
 * 決済レシートを**応答ヘッダ**から読む（v2 PAYMENT-RESPONSE / v1 X-PAYMENT-RESPONSE）。
 * **本文は読まない。** 本文は売り手が売った中身であって、決済の記録ではない。
 */
export declare function parseSettlementResponse(headers: unknown): X402Settlement | null;
/**
 * 署名して、元のリクエストを支払いヘッダ付きで**売り手へ再送する**。判定は一切しない
 * ——ここへ来た時点で通っている、というのが `payOrRefuse` との契約。金額・チェーン・
 * asset・payTo の検査を呼び出し側に残すのは、この関数を単体で「安全な支払い」として
 * 再利用させないため。
 *
 * `onSigned` は**署名の直後**に同期で呼ぶ。ここから先は金が生きているので、
 * 再送で落ちても「何に署名したか」を呼び手が先に確定させられる
 * （本番は同じ位置で購入行に authNonce を UPDATE している）。
 */
export declare function executeX402Payment(args: {
    account: PayerAccount;
    accept: X402Accept;
    resource: string;
    method: string;
    chainId: number;
    x402Version: 1 | 2;
    fetch: typeof fetch;
    onSigned?: (info: {
        nonce: string;
        authorization: Eip3009Authorization;
        signature: string;
    }) => void;
}): Promise<X402PayResult>;
