import type { DecisionResult, PayeeScoreResult } from "./index.js";
import type { PayerAccount, X402Accept } from "./x402-pay.js";
import { type ChainProfileName } from "./chain-profile.js";
import type { EnsAttestationPolicy, EnsOfferCheck } from "./ens-attestation.js";
import type { EnsReadClients } from "./ens-read.js";
export type { PayerAccount, X402Accept, X402Settlement, Eip3009Authorization } from "./x402-pay.js";
/**
 * Base メインネット（`network` の既定）。値は `chain-profile.ts` の `base` の行から引く（2026-09-26 に移した・値は同じ）。
 * testnet（`base-sepolia`）は呼び手が `network` で名指ししたときだけ。
 */
export declare const BASE_CHAIN: "eip155:8453";
export declare const BASE_CHAIN_ID: 8453;
/** Base の正規 USDC。ここを可変にしない——「別トークンを掴まされる」が最も安い攻撃。 */
export declare const BASE_USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/**
 * Solana メインネット（CAIP-2）と、その正規 USDC mint（decimals 6）。2026-09-15 に足した 2 本目のレール。
 * 値は本番 `src/lib/observatory/sol402-payer.ts` と同じ（本番の Solana L1 が実決済に使っている）。
 * mint は `===` で照合する——base58 は大文字小文字で別の鍵になる。
 */
export declare const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export declare const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** どのレールで払うか。**payee の形で決まる**（0x → EVM、base58 → Solana）。呼び手が選ぶ引数ではない。 */
export type PayRail = "evm" | "svm";
/**
 * Solana の取引。`@solana/web3.js` の `VersionedTransaction` がそのまま当てはまる形だけを書く
 * ——SDK の型に web3.js を持ち込まない（EVM だけの利用者に型の依存も求めない）。
 */
export type SvmTransactionLike = {
    serialize(): Uint8Array;
    message: {
        serialize(): Uint8Array;
    };
};
/**
 * Solana の署名者。**`payOrRefuse` はこの値の `sign*` に、ALLOW ブランチの最後まで一度も触らない**
 * （EVM の {@link PayerAccount} と同じ規律）。受け取った取引に自分の鍵で署名して返す。
 * 返した取引の message が SDK の組んだものとバイト単位で違えば、SDK は売り手へ送らない。
 */
export type SvmPayerAccount = {
    /** base58 の公開鍵。feePayer と同じなら署名の前に拒否する。 */
    address: string;
    signTransaction(tx: SvmTransactionLike): Promise<SvmTransactionLike>;
};
/** Solana の payee に払うときに渡す。`rpcUrl` は blockhash を 1 回だけ引く先（注入した fetch で呼ぶ）。 */
export type SvmPayOptions = {
    account: SvmPayerAccount;
    rpcUrl: string;
};
/** `@solana/web3.js` の `Keypair` が当てはまる形。{@link svmAccountFromKeypair} の引数。 */
export type SvmKeypairLike = {
    publicKey: {
        toBase58(): string;
    };
    secretKey: Uint8Array;
};
/**
 * web3.js の `Keypair` から {@link SvmPayerAccount} を作る。**web3.js を import しない純関数**——
 * 呼び手が既に持っている Keypair を包むだけ。署名は取引自身の `sign([keypair])`（VersionedTransaction）。
 *
 * ```ts
 * import { Keypair } from "@solana/web3.js";
 * const r = await payOrRefuse({ payee, resource, amountUsd, fetch,
 *   svm: { account: svmAccountFromKeypair(Keypair.fromSecretKey(secret)), rpcUrl } });
 * ```
 */
export declare function svmAccountFromKeypair(keypair: SvmKeypairLike): SvmPayerAccount;
/**
 * 1件あたりの既定上限 $1。呼び手が `policy.maxPerTxUsd` を書かなくても
 * 上限が存在する状態にしておく（DESIGN_payOrRefuse.md §2 の `maxAmountUnits` 既定と同値）。
 */
export declare const DEFAULT_MAX_PER_TX_USD = 1;
/**
 * 拒否理由。**新しい語を増やさない**のが規律で、ここに並ぶ語は既に正典にある:
 *  - `price_above_ceiling` / `payee_mismatch` / `chain_or_asset_mismatch` /
 *    `evidence_unavailable` / `insufficient_delivery_evidence` /
 *    `insufficient_subgraph_evidence` … DESIGN_payOrRefuse.md §2
 *  - `payee_recommendation_not_allow` … `SpendDenyReason`（spend-guard.ts）
 *
 * `resource_uncatalogued` **だけが新語**（2026-09-04 の本番実測で必要になった）。
 * 理由: カタログ外の売り手に対する判定は「証拠が足りない」のでも「読めなかった」のでもなく、
 * **その資源を我々が一度も見たことがない**という別の状態で、既存のどの語もそれを言えない。
 * これは拒否理由ではなく**経路の印**であり、ALLOW で払ったときの決定行にも載る
 * （§3.1「一度も見たことのない売り手に向けて判定できる」が製品の核だから、
 * 通ったのか拒んだのかと独立に、どちらの経路で出た判定かが機械可読で残る必要がある）。
 *
 * 2026-09-05 に2語だけ足した。どちらも既存の語では**言えないこと**を言うために足している。
 *  - `no_eligible_accept` … 本番 `x402-payer.ts` の `AcceptSelection` にある語をそのまま借りる。
 *    「掴んだ1件がチェーン違いだった」（`chain_or_asset_mismatch`）と
 *    「提示された全部を見たが1件も払えなかった」は別のこと。前者だけを返すと、
 *    **売り手が accepts の順序を変えるだけで拒否理由がすり替わる**。
 *    具体の不一致は消さず、この語を**先頭に**置いて一次の所見にする
 *  - `allowed_by_caller_policy` … 拒否理由ではなく**通した規則の印**（§3.2）。
 *    `policy.requireVet402Allow: false` で vet402 の非 ALLOW を免除して払ったときにだけ載る。
 *    黙って弱くならないことを、機械可読な形で示すためにある
 *
 * 2026-09-07 に 1 語足した（第三者監査 A3）。
 *  - `price_above_declared` … 402 の額が呼び手の名乗り（`amountUsd`）を超えた。`price_above_ceiling`
 *    は「上限」（`maxPerTxUsd`）の語で、名乗りは別の関門——`amountUsd: 0.01` と言った呼び手に
 *    $1 の 402 を上限内だからと払うのは、上限は守っても名乗りを破っている。サーバの
 *    `caller_policy` は 402 を見ないのでこの語を出せない（SDK だけの語・parity テストが固定）
 */
export declare const PAY_REFUSE_REASONS: readonly ["price_above_ceiling", "price_above_declared", "payee_mismatch", "chain_or_asset_mismatch", "evidence_unavailable", "payee_recommendation_block", "payee_recommendation_not_allow", "insufficient_delivery_evidence", "insufficient_subgraph_evidence", "resource_uncatalogued", "subgraph_evidence_unavailable", "no_eligible_accept", "allowed_by_caller_policy", "insufficient_chain_evidence", "chain_evidence_unavailable", "ens_name_unresolved", "ens_offer_missing", "ens_offer_malformed", "ens_offer_mismatch", "ens_attestation_missing", "ens_attestation_malformed", "ens_attestation_signer_mismatch", "ens_attestation_stale", "ens_attester_unresolved", "ens_attester_unpinned", "ens_attester_anchor_changed", "ens_record_changed_after_attestation", "ens_evidence_unavailable", "insufficient_ens_attestations", "vet402_unreachable"];
export type PayRefuseReason = (typeof PAY_REFUSE_REASONS)[number];
/** 証拠源。`payOrRefuse` の判定が「誰の台帳を読んだか」を機械可読で残す。 */
export type PayEvidenceSource = "vet402" | "subgraph" | "chain" | "ens";
export type PayEvidenceRow = {
    level: "L0" | "L1" | "L2";
    source: PayEvidenceSource;
    url: string;
    purchase_id?: string;
    /**
     * `source: "subgraph"` のとき live であることの証跡（D15・WINDOW_PLAN §2 #3）。
     * これが無い行は「静的データを読んだのではない」ことを示せないので、証拠として扱わない。
     */
    subgraphId?: string;
    block?: {
        number: number;
        timestamp?: number;
    };
    deployment?: string;
    queriedAt?: string;
    /**
     * **その源が知っている件数**。行ごとに別々に持つ——源をまたいで足さない（D16）。
     * 自社台帳の「配達件数」と subgraph の「受領件数」は**別のことを数えた別の数**であり、
     * 合算した1つの数は何も意味しない。
     */
    receipts?: number;
};
/**
 * 決定行に残す段 2.5 の内訳（`checkEnsOffer` の結果から、payload のバイト列を落としたもの）。
 * `attestations[].recovered`（署名から復元した鍵）と `expected`（固定した attester の鍵）を**両方**残す——
 * 拒否したときに「誰の署名が、誰のはずだったか」が決定行から読める。
 * 証拠の行（{@link PayEvidenceRow}）には入れない: あちらは `/decision` の `Evidence` の部分集合でなければならない
 * （`tests/openapi-schema-parity.test.ts`）。
 */
export type PayEnsEvidence = {
    /** `"gate"` は段 2.5、`"recheck"` は署名直前の読み直し。 */
    pass: "gate" | "recheck";
    ok: boolean;
    name: string;
    node: string;
    chainId: number;
    manager: string | null;
    reason_codes: string[];
    /** 有効な証明の数。 */
    valid: number;
    attestations: Array<{
        attester: string;
        profile: string | null;
        t: number | null;
        recovered: string | null;
        expected: string | null;
        digest: string | null;
        valid: boolean;
        reason: string | null;
    }>;
    trace: EnsOfferCheck["trace"];
};
export type PayEvidencePolicy = {
    /** vet402 の L1 配達台帳（実際に払って届いた件数）の下限。 */
    minL1Deliveries?: number;
    /**
     * The Graph の x402 Base subgraph が知っている**受領**件数の下限（C11/D13-D16）。
     * `source` が `"subgraph"` か `"both"` でなければ**呼び出し側エラー**（下記）。
     */
    minSubgraphReceipts?: number;
    /**
     * **支払いチェーンそのもの**（profile の USDC・`Transfer` の宛先が payee・額 > 0）の受領件数の下限（D1-a・Tokyo B3）。
     * 読むのは呼び手が渡す `chainReader` と `chainReaderCrossCheck` の2系統で、**2つの受領の集合が一致したときだけ**数える
     * （違えば・どちらかが読めなければ `chain_evidence_unavailable`）。`source` とは無関係（どの値でも評価する）。
     * 0 以上の整数。0x の payee だけ（base58 の payee に渡せば呼び出し側エラー）。
     */
    minChainReceipts?: number;
    /**
     * `minChainReceipts` を数え始めるブロック（含む）。省略は「2系統の head の小さい方から
     * {@link DEFAULT_CHAIN_LOOKBACK_BLOCKS} ブロック」。`getLogs` は {@link CHAIN_LOGS_SPAN} ブロックずつに分けて引く
     * （公開 RPC の範囲上限。Base Sepolia の公開 RPC は 1,000・2026-09-25 実測）。
     */
    chainFromBlock?: number | bigint;
    /**
     * 段 2.5（ENSIP-29）で**有効だった証明の数**の下限（Tokyo B6・§3.3.3 G1）。`payeeName` と `ens` を渡した
     * 呼び出しでだけ宣言できる（それ以外は呼び出し側エラー `invalid_evidence_policy`）。0 以上の整数。
     * `source` とは無関係（どの値でも評価する・S4）。
     *
     * **vet402 に届かないとき**（接続不能・HTTP 5xx）、`requireVet402Allow: false` とこの床 ≥ 1 がそろっていれば、
     * 取りに行けなかったことを免除して先へ進む（G5）。届いた答えが悪い（degraded・BLOCK・4xx・読めない 200）なら免除しない。
     */
    minEnsAttestations?: number;
    /**
     * 既定 `"vet402"`。`"subgraph"` は**我々の台帳を証拠の床に使わない**——
     * 呼び手が自分の鍵で The Graph を引いて自分で確かめる。`"both"` は両方読め、
     * **片方でも読めなければ fail-closed**（黙って弱い方に落ちない・C12）。
     */
    source?: "vet402" | "subgraph" | "both";
    /**
     * 呼び手の Graph Gateway API キー。**我々の鍵を SDK に埋め込まない。**
     * この機能の主張は「`source: "subgraph"` にすれば我々の台帳を一行も読まない」であり、
     * 我々の鍵を通せばその主張は成立しない（結局 vet402 を信じていることになる）。
     * 無いときは keyless パスへ出て Gateway が拒否し、`evidence_unavailable` になる。
     */
    graphApiKey?: string;
    /** 引く subgraph。既定は x402 Base（{@link X402_BASE_SUBGRAPH_ID}）。 */
    subgraphId?: string;
    /**
     * 読んだ先の **deployment を名指しする（pin）**。渡したときだけ、応答の `_meta.deployment`
     * と突き合わせ、違えば「読めなかった」として扱う（`subgraph_evidence_unavailable`）。
     * subgraph ID は同じまま再デプロイで中身が別物になりうる——block 高は live であることしか
     * 証明しない。照合は {@link readSubgraphReceipts} が行う（判定の条件式は変わらない）。
     * **渡さなければ挙動は変わらない。** 既定は照合しない。
     */
    deploymentId?: string;
};
export type PayPolicy = {
    /** 1件あたりの上限（USD）。既定 {@link DEFAULT_MAX_PER_TX_USD}。 */
    maxPerTxUsd?: number;
    /** 呼び手が名指しした証拠の床。書かなければ `/decision` の判定だけで通す。 */
    evidence?: PayEvidencePolicy;
    /**
     * **vet402 の推奨が ALLOW であることを要求するか。既定 `true`（fail-closed）。**
     *
     * `false` にすると、vet402 が **WARN** を出していても、**呼び手が宣言した
     * 証拠の床がすべて満たされていれば**払う。これは「あなたは vet402 を信じなくてよい」
     * という主張そのものであり（WINDOW_PLAN §3.2）、実測に裏打ちがある——
     * デモの支払い先 The Graph `0x79DC34E4…FcCB` は我々のエンジンで **69 / WARN / thin**
     * だが、The Graph 自身の subgraph は同じアドレスの受領を 253 件知っている。
     * 我々の判定が薄いことと、その相手が危険であることは、別のことである。
     *
     * **床を1つも宣言せずに `false` にするのは呼び出し側エラー**（`invalid_policy`）。
     * vet402 の判定を外し、代わりを置かなければ、**誰もこの支払いを判定していない**。
     * 0 の床は床ではない（何も判定しない）ので、少なくとも1つは 1 以上でなければならない。
     * ただし判定を取りに行けなかったときに限り、呼び手が ENS の証明の床を宣言していれば、取りに行けなかったことを
     * 免除する。届いた判定の degraded と BLOCK は免除しない（Tokyo B6・§3.3.3 G7）。
     *
     * **免除するのは「判定の中身」であって「判定が存在すること」ではない。**
     * `degraded`（測れなかった）と `signalsUnavailable`（一部が測れなかった）は
     * `false` でも fail-closed のまま。ALLOW でないことと、読めなかったことは別である。
     *
     * 通したときは決定行に残る: `verdict_source: "caller_policy"`、
     * 理由コード `allowed_by_caller_policy`、そして {@link PayDecisionRecord.policy_override}
     * に「何を免除し、どの床をいくつで満たしたか」の内訳。**黙って弱くならない。**
     */
    requireVet402Allow?: boolean;
};
/** 満たした床1つ。**要求値と実測値を両方持つ**——「床を見たふり」を機械可読に潰す。 */
export type EvidenceFloorCheck = {
    floor: "minL1Deliveries" | "minSubgraphReceipts" | "minChainReceipts" | "minEnsAttestations";
    /** どの源の数で当てたか。源をまたいで足さない（D16）。 */
    source: PayEvidenceSource;
    required: number;
    observed: number;
};
/**
 * **どの規則で通したか。** vet402 の非 ALLOW を呼び手の policy が免除して払ったときにだけ載る。
 * 審査員が読むのはここなので、「何を免除したか」と「代わりに何を満たしたか」を両方置く。
 */
export type PayPolicyOverride = {
    rule: "requireVet402Allow:false";
    /** 免除した判定。**消さずに残す**——弱くしたことを隠さない。 */
    waived: {
        /**
         * `"vet402_unreachable"` は判定そのものが**届かなかった**ことを免除した（Tokyo B6・G8）。そのとき
         * `recommendation` は `"unreachable"`、`score` は null、`reason_codes` は空。
         */
        source: "decision" | "payee_score" | "vet402_unreachable";
        recommendation: string;
        /** 受取人スコアの点数（`/decision` 経路には無いので null）。 */
        score: number | null;
        reason_codes: string[];
    };
    /** 代わりに満たした床の内訳。空になることはない（空なら呼び出し側エラーで到達しない）。 */
    floors_met: EvidenceFloorCheck[];
};
/**
 * 署名者は**レールごとに1つ**。0x の payee には `account`（EIP-3009）、base58 の payee には
 * `svm`（Solana の署名者と RPC）。payee の形と合わない方を渡す・両方渡す・どちらも無いは、
 * 通信の前に `invalid_payer` で throw する。
 */
export type PayOrRefuseInput = PayOrRefuseBaseInput & (PayOrRefusePayeeInput | PayOrRefuseNamedPayeeInput) & ({
    account: PayerAccount;
    svm?: undefined;
} | {
    svm: SvmPayOptions;
    account?: undefined;
});
/** 既存の呼び方（`payee` を渡す）。型も実行時の挙動も 2026-09-25 までと同じ。 */
export type PayOrRefusePayeeInput = {
    /**
     * 0x アドレス（Base）か base58 アドレス（Solana）。ENS 名は**解決しない**（名前解決を支払いゲートの中で起こさない）。
     * Solana の payee は大文字小文字を含めて 402 の payTo と完全一致でなければ払わない。
     */
    payee: string;
    payeeName?: undefined;
};
/**
 * 名前で払う呼び方（ETHGlobal Tokyo 2026）。`payee` は ENSIP-29 の証明が有効な約束の `payTo` から決まる（段 2.5）。
 * **払えるのは `network: "base-sepolia"` だけ**（本番 Base を名前経路で払わない）。
 */
export type PayOrRefuseNamedPayeeInput = {
    /** 売り手の ENS 名（Sepolia の ENSv2）。ENSIP-15 で正規化でき、ドットを含むこと。 */
    payeeName: string;
    /** 段 2.5 が読む2系統の Sepolia RPC と、信じる attester の設定。 */
    ens: EnsGateInput;
    /** 渡したときは約束の `payTo` と一致しなければ拒否（`payee_mismatch`・`/decision` の前）。 */
    payee?: string;
};
/**
 * 段 2.5 の入力。`clients` は**別々の** Sepolia（chainId 11155111）RPC 2本（viem の `PublicClient` がそのまま当てはまる）。
 * `policy` は `assertEnsAttestationPolicy` の規則で、通信の前に検査する（外れれば `invalid_attestation_policy`）。
 */
export type EnsGateInput = {
    clients: EnsReadClients;
    policy: EnsAttestationPolicy;
};
export type PayOrRefuseBaseInput = {
    /**
     * 0x の payee を払うチェーン。**既定 `"base"`（Base メインネット・今までの挙動）**。
     * `"base-sepolia"` は testnet の USDC で払い、本番の台帳へは attest しない。知らない値は `invalid_network` で throw。
     * base58（Solana）の payee には渡さない（渡せば throw）。
     */
    network?: ChainProfileName;
    /** 402 を返す資源の URL。 */
    resource: string;
    amountUsd: number;
    /**
     * 使う fetch。**必須**——グローバル fetch を黙って掴むと、拒否経路が本当に
     * どこへも出ていないことを呼び手が検算できない。
     */
    fetch: typeof fetch;
    /** 資源の HTTP メソッド。既定 "GET"。The Graph の x402 口は "POST"。 */
    method?: string;
    policy?: PayPolicy;
    apiUrl?: string;
    apiKey?: string;
    /** 決定行の出所。デモは "agent-demo"（L1 台帳と混ぜない・F19/F20）。 */
    source?: string;
    /** 資源 ID を自分で計算済みなら渡す（正規化規則はサーバ側が持つ）。 */
    resourceId?: string;
    /**
     * 決定行を追記する JSONL のパス。渡したときだけ書く。
     * 既定は {@link DEFAULT_DECISION_STORE} だが、**渡されない限り書かない**——
     * npm に載る SDK が、呼び手の cwd に黙ってファイルを作ってはいけない。
     * デモも L1 も同じ既定パスを渡すので、行は1本の store に混ざる（F19/F20 の主題）。
     */
    decisionStore?: string;
    /**
     * `policy.evidence.minChainReceipts` の受領を読む2系統（D1-a・Tokyo B3）。viem の `PublicClient` がそのまま当てはまる。
     * **別の RPC を2本**渡す（同じ RPC を2回読んでも2系統にならない）。床を宣言しないなら読まない。
     */
    chainReader?: ChainReceiptReader;
    chainReaderCrossCheck?: ChainReceiptReader;
};
/**
 * 支払いチェーンの受領を読む口（viem `PublicClient` の部分集合）。`getLogs` は ERC-20 `Transfer` を
 * `event` と `args.to` で絞って引く。戻りの log は**信じずに**読み直す（address・topics・額・ブロック範囲）。
 */
export type ChainReceiptReader = {
    getChainId(): Promise<number>;
    getBlockNumber(): Promise<bigint>;
    getLogs(args: {
        address: string;
        event: typeof ERC20_TRANSFER_EVENT;
        args: {
            to: string;
        };
        fromBlock: bigint;
        toBlock: bigint;
    }): Promise<readonly unknown[]>;
};
/** `Transfer(address indexed from, address indexed to, uint256 value)`（viem の `AbiEvent` の形）。 */
export declare const ERC20_TRANSFER_EVENT: {
    readonly type: "event";
    readonly name: "Transfer";
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly name: "value";
        readonly type: "uint256";
    }];
};
/** `chainFromBlock` 省略時に遡るブロック数（Base / Base Sepolia の 2 秒ブロックで約 5.5 時間）。 */
export declare const DEFAULT_CHAIN_LOOKBACK_BLOCKS = 10000n;
/** `getLogs` 1本あたりのブロック数（両端を含む）。 */
export declare const CHAIN_LOGS_SPAN = 1000n;
/** 1回の評価で読む上限。これを超える範囲は読まずに `chain_evidence_unavailable`。 */
export declare const MAX_CHAIN_SCAN_BLOCKS = 100000n;
/** `payOrRefuse` が出した1件の決定。拒否でも通過でも同じ形で残る。 */
export type PayDecisionRecord = {
    recommendation: "ALLOW" | "REFUSE";
    reason_codes: string[];
    /**
     * 判定を何から出したか。404 経路は "payee_score"。
     * **"caller_policy" は「vet402 ではなく呼び手の規則が通した」**（§3.2）。
     * vet402 が ALLOW を出したなら、`requireVet402Allow: false` でも "decision" のまま——
     * 上書きしていないのに上書きしたと記帳すると、決定行が読めなくなる。
     */
    verdict_source: "decision" | "payee_score" | "local_policy" | "caller_policy";
    evidence: PayEvidenceRow[];
    /** サーバの `/decision` 応答（404 経路では null）。 */
    decision: DecisionResult | null;
    /** 404 経路で読んだ受取人スコア（それ以外では null）。 */
    payeeScore: PayeeScoreResult | null;
    /** 呼び手の規則が vet402 の非 ALLOW を免除して**通した**ときだけ非 null。 */
    policy_override: PayPolicyOverride | null;
    source: string;
    /**
     * 段 2.5（ENSIP-29）の内訳（Tokyo B6）。**名前で払った呼び出しの決定行にだけ**あり、段 2.5 と署名直前の
     * 読み直しの順に並ぶ。名前を使わない呼び手の決定行には、このキー自体が無い（形を1バイトも変えない）。
     */
    ens?: PayEnsEvidence[];
};
export type PayOrRefuseResult = {
    /** "refused" は署名前に止まったこと。"failed" は署名後に settle が失敗したこと。 */
    status: "paid" | "refused" | "failed";
    decision: PayDecisionRecord;
    /** 署名が実在するか。"failed" のとき true——隠さない（E18）。 */
    signed: boolean;
    attested: boolean;
    txHash: string | null;
    /**
     * 署名した EIP-3009 認可の nonce。**我々しか作れない一回性の値**で、
     * 「その決済 tx はこの購入のものか」を後から確かめる唯一の手段（監査の nonce 束縛）。
     * 署名していない拒否経路では null——そこが「署名が存在しない」ことの機械可読な印になる。
     */
    nonce: string | null;
    challenge: X402Accept | null;
    /** 決定行を store に書けたか。`decisionStore` を渡さなかったときは false。 */
    stored: boolean;
    /** 書けなかった理由。書けた／書こうとしなかったときは null。 */
    storeError: string | null;
    /**
     * どのレールで判定・支払いをしたか（payee の形で決まる）。2026-09-15 に**足しただけ**で、上の欄の意味は
     * レールで変わらない。Solana では `nonce` は取引の Memo 命令に載せた 32 hex（我々しか作れない値）、
     * `txHash` は PAYMENT-RESPONSE の base58 署名、`attested` は常に false（attest API は 0x の txHash しか受けない）。
     */
    rail: PayRail;
    /** Solana で売り手へ送った署名済み取引（base64）。送っていなければ・EVM では null。 */
    svmTransaction: string | null;
};
/**
 * 判定を引き、全部の条件を通ったときにだけ払う。結果は `decisionStore` を渡したときだけ
 * 1本の JSONL へ追記される（下の {@link appendDecision}）。
 */
export declare function payOrRefuse(input: PayOrRefuseInput): Promise<PayOrRefuseResult>;
/** 既定の保存先。呼び出し側の cwd からの相対。 */
export declare const DEFAULT_DECISION_STORE = ".vet402/decisions.jsonl";
export type DecisionStoreOptions = {
    /** JSONL のパス。既定 {@link DEFAULT_DECISION_STORE}。 */
    store?: string;
};
/** 保存する1行。決定そのものに、いつ・どの経路で出たかを添える。 */
export type StoredDecision = PayDecisionRecord & {
    at: string;
    status: PayOrRefuseResult["status"];
    resource: string;
    txHash: string | null;
    nonce: string | null;
};
/**
 * 決定行を1行追記する。**追記専用**——既存の行を書き換えない
 * （書き換えられる台帳は台帳ではない。過去の判定は後から都合よく直せてはいけない）。
 */
export declare function appendDecision(row: StoredDecision, options?: DecisionStoreOptions): Promise<void>;
/** デモ（`source: "agent-demo"`）の決定行だけを返す。 */
export declare function readDemoDecisions(options?: DecisionStoreOptions): Promise<StoredDecision[]>;
/** L1（`source: "vet402"`）の決定行だけを返す。 */
export declare function readL1Decisions(options?: DecisionStoreOptions): Promise<StoredDecision[]>;
