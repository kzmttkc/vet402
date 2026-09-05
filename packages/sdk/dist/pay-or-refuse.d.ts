import type { DecisionResult, PayeeScoreResult } from "./index.js";
import type { PayerAccount, X402Accept } from "./x402-pay.js";
export type { PayerAccount, X402Accept, X402Settlement, Eip3009Authorization } from "./x402-pay.js";
/** Base メインネット。会期スコープは1チェーンだけ（WINDOW_PLAN §2「範囲外: 新チェーン」）。 */
export declare const BASE_CHAIN = "eip155:8453";
export declare const BASE_CHAIN_ID = 8453;
/** Base の正規 USDC。ここを可変にしない——「別トークンを掴まされる」が最も安い攻撃。 */
export declare const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
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
 */
export type PayRefuseReason = "price_above_ceiling" | "payee_mismatch" | "chain_or_asset_mismatch" | "evidence_unavailable" | "payee_recommendation_not_allow" | "insufficient_delivery_evidence" | "insufficient_subgraph_evidence" | "resource_uncatalogued";
/** 証拠源。`payOrRefuse` の判定が「誰の台帳を読んだか」を機械可読で残す。 */
export type PayEvidenceSource = "vet402" | "subgraph";
export type PayEvidenceRow = {
    level: "L0" | "L1" | "L2";
    source: PayEvidenceSource;
    url: string;
    purchase_id?: string;
    /** `source: "subgraph"` のとき live であることの証跡（会期中に追加予定・D15）。 */
    subgraphId?: string;
    block?: {
        number: number;
    };
};
export type PayEvidencePolicy = {
    /** vet402 の L1 配達台帳（実際に払って届いた件数）の下限。 */
    minL1Deliveries?: number;
    /** The Graph の subgraph が知っている受領件数の下限（会期中に実装・C11/D13-D16）。 */
    minSubgraphReceipts?: number;
    /** 既定 "vet402"。"subgraph" / "both" は未実装で、指定すると fail-closed に落ちる。 */
    source?: "vet402" | "subgraph" | "both";
};
export type PayPolicy = {
    /** 1件あたりの上限（USD）。既定 {@link DEFAULT_MAX_PER_TX_USD}。 */
    maxPerTxUsd?: number;
    /** 呼び手が名指しした証拠の床。書かなければ `/decision` の判定だけで通す。 */
    evidence?: PayEvidencePolicy;
};
export type PayOrRefuseInput = {
    /** 0x アドレス。ENS 名は**解決しない**（名前解決を支払いゲートの中で起こさない）。 */
    payee: string;
    /** 402 を返す資源の URL。 */
    resource: string;
    amountUsd: number;
    account: PayerAccount;
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
};
/** `payOrRefuse` が出した1件の決定。拒否でも通過でも同じ形で残る。 */
export type PayDecisionRecord = {
    recommendation: "ALLOW" | "REFUSE";
    reason_codes: string[];
    /** 判定を何から出したか。404 経路は "payee_score"。 */
    verdict_source: "decision" | "payee_score" | "local_policy";
    evidence: PayEvidenceRow[];
    /** サーバの `/decision` 応答（404 経路では null）。 */
    decision: DecisionResult | null;
    /** 404 経路で読んだ受取人スコア（それ以外では null）。 */
    payeeScore: PayeeScoreResult | null;
    source: string;
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
