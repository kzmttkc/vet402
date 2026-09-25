/**
 * Payment-chain profiles for `payOrRefuse` and `x402-pay`. (English header for judges. The Japanese
 * block below is the same content in our working language.)
 *
 * One row per chain the EVM rail can pay on. **`base` is the production default and its values are
 * the ones `pay-or-refuse.ts` / `x402-pay.ts` hard-coded before this file existed** — moving them
 * here must not change a single byte of what gets signed on Base mainnet. `base-sepolia` exists so
 * the ETHGlobal Tokyo 2026 demo can pay on testnet; it never attests to the production ledger.
 *
 * Primary sources (eth_call, 2026-09-25):
 *   - Base mainnet USDC 0x8335…2913: name() "USD Coin" / version() "2" (first checked 2026-08-22)
 *   - Base Sepolia USDC 0x036C…CF7e: name() "USDC" / version() "2"; chainId 0x14a34 (84532)
 */
/**
 * 支払いチェーンの profile（`payOrRefuse` と `x402-pay` が引く定数表）。
 *
 * EVM のレールが払えるチェーンを1行ずつ。**`base` は本番の既定で、値はこのファイルができる前に
 * `pay-or-refuse.ts` / `x402-pay.ts` に直書きされていたものと同じ**——ここへ移しても、
 * Base メインネットで署名する中身は1バイトも変わってはいけない。`base-sepolia` は
 * ETHGlobal Tokyo 2026 のデモが testnet で払うための行で、本番の台帳へは attest しない。
 *
 * 一次確認（eth_call・2026-09-25）:
 *   - Base メインネット USDC 0x8335…2913: name() "USD Coin" / version() "2"（初回 2026-08-22）
 *   - Base Sepolia USDC 0x036C…CF7e: name() "USDC" / version() "2"・chainId 0x14a34（84532）
 *
 * **このファイルは何も import しない**（`pay-or-refuse.js` の静的グラフに入るので、
 * 支払いモジュールへの静的な辺を作らない・`test/no-static-payment-import.test.mjs`）。
 */
export declare const CHAIN_PROFILES: {
    readonly base: {
        readonly name: "base";
        /** CAIP-2。 */
        readonly network: "eip155:8453";
        readonly chainId: 8453;
        /** 正規 USDC。EIP-712 の verifyingContract もこれ。 */
        readonly asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
        /** USDC の EIP-712 ドメイン。**売り手からは取らない**（本番 2026-08-22 監査）。 */
        readonly usdcEip712: {
            readonly name: "USD Coin";
            readonly version: "2";
        };
        /** x402 v1 の network スラッグ。 */
        readonly v1Slug: "base";
        /** 決済した tx を本番の台帳（`/payments/x402`）へ attest するか。 */
        readonly attest: true;
    };
    readonly "base-sepolia": {
        readonly name: "base-sepolia";
        readonly network: "eip155:84532";
        readonly chainId: 84532;
        readonly asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
        readonly usdcEip712: {
            readonly name: "USDC";
            readonly version: "2";
        };
        readonly v1Slug: "base-sepolia";
        /** testnet の支払いは本番の台帳へ入れない。 */
        readonly attest: false;
    };
};
export type ChainProfileName = keyof typeof CHAIN_PROFILES;
export type ChainProfile = (typeof CHAIN_PROFILES)[ChainProfileName];
/**
 * 呼び手の `network` から profile を引く。**省略は `"base"`**（今までの挙動）。
 * 知らない値は黙って既定へ落とさず throw する——`"base-sepoila"` の打ち間違いが本番 Base で
 * 払う呼び出しに化けるのが、ここで起き得る最悪の事故だから。
 */
export declare function profileFor(network: unknown): ChainProfile;
/** CAIP-2 の network から profile を引く（知らなければ null）。v1 のスラッグを書くときに使う。 */
export declare function profileForCaip2(caip2: string): ChainProfile | null;
