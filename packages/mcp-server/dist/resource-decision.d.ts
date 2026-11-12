import { type DecisionQuery, type DecisionResult, type ResolveEndpointRef } from "./vouch-client.js";
/** 402 を読む HTTP method。診断 URL に載せる語は GET と POST だけ。 */
export type DiagnoseHttpMethod = "GET" | "POST";
/** 呼び手の誤り。メッセージは我々が組み立てる（上流の文字列を含まない）ので tool-errors がそのまま通す。 */
export declare const INVALID_TARGET_PREFIX = "invalid_target:";
export type ResourceTarget = {
    resourceId?: string;
    url?: string;
};
/** カタログに無いときの応答。decision / safe_to_pay を先頭に置く形は他のツールと同じ。 */
export type UncataloguedResult = {
    decision: "REFUSE";
    safe_to_pay: false;
    refuse_reasons: ["resource_uncatalogued"];
    not_in_catalog: true;
    summary: string;
    lookup: {
        resourceId: string | null;
        url: string | null;
        /** /resolve が url から作った正規形（URL を渡したときだけ）。 */
        canonical_url: string | null;
        /** 同じホストでカタログに載っている endpoint（最大 5 件）。打ち間違いの手がかり。 */
        same_host_candidates: {
            resource_id: string | null;
            canonical_url: string;
            method: string;
        }[];
    };
    /** 払う前の 402 読み取り。REFUSE の意味は変えない。 */
    diagnose_at: {
        tool: "diagnose_x402_url";
        url: string | null;
        note: string | null;
    };
};
export type ResourceDecisionOutcome = {
    kind: "decision";
    resourceId: string;
    resolvedFrom: string | null;
    result: DecisionResult;
} | {
    kind: "uncatalogued";
    body: UncataloguedResult;
};
/** 入力を検査する。どちらか片方だけ。URL は https の絶対 URL に限る（resolve と同じ）。 */
export declare function assertTarget(target: ResourceTarget): {
    resourceId: string;
} | {
    url: string;
};
export declare function uncatalogued(lookup: {
    resourceId: string | null;
    url: string | null;
    canonicalUrl: string | null;
}, candidates?: ResolveEndpointRef[], method?: DiagnoseHttpMethod): UncataloguedResult;
/**
 * url なら /resolve → resource_id、id ならそのまま。/decision の 404 は「カタログに無い」に写す。
 * それ以外の失敗は throw のまま（呼び手の scoreToolFailure が REFUSE に写す）。
 */
export declare function resourceDecision(target: ResourceTarget, query: DecisionQuery, method?: DiagnoseHttpMethod): Promise<ResourceDecisionOutcome>;
/**
 * 判定の `verified_terms` を summary に添える 1 文。読める条件が 1 つも無ければ null（何も足さない）。
 * 配列なら先頭 3 件まで。
 */
export declare function verifiedTermsNote(v: unknown): string | null;
