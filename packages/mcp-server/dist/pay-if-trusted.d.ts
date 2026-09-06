/**
 * `pay_if_trusted` — `payOrRefuse` と同じ関門を MCP ツールとして出す（会期中の新規）。
 *
 * 正典: `docs/ethonline-2026/WINDOW_PLAN.md` §2 #2・§4 の 21・§14/§14.1/§14.3。
 * 契約テスト: `packages/mcp-server/test/pay-if-trusted.test.mjs`（G21a/b/c）。
 *
 * **既存の `check_resource_decision`（2026-09-02 出荷・読むだけ）との違い**は1つだけ。
 * あちらは判定を返し、払うかどうかは呼び手が決める。こちらは **signer を握る**——
 * 判定が ALLOW でなければ、支払いモジュールは**評価すらされない**。
 *
 * 判定の流れ（5行）:
 *   1. 呼び出し側の誤り（64桁hex でない resourceId、fetch 未注入）は throw。判定も引かない
 *   2. `GET /resources/{id}/decision?role=payer` を引く。読めない → 拒否（沈黙は ALLOW ではない）
 *      **404 not_found（カタログ外・§3.1）は例外**: `resource`（402 を返す URL）が与えられていれば
 *      止めずに 5 へ通し、SDK が 402 の payTo ＋ 受取人スコア ＋ 宣言された床で判定する（I23・2026-09-06）。
 *      `resource` が無い 404 は判定材料が存在しないので従来どおり `evidence_unavailable`
 *   3. `degraded` → 拒否。`recommendation !== "ALLOW"` → 拒否。**理由はサーバの reason_codes をそのまま通す**
 *      （カタログ外は判定本文が無いのでこの段を飛ばす。受取人スコアの BLOCK / degraded は SDK の 3' 段が持つ）
 *   4. ALLOW でも支払い先（payee / resource / amountUsd）が無ければ拒否（`payment_target_unknown`）
 *   5. ここまで全部通ったときだけ `@vet402/sdk` を**動的 import** し、`payOrRefuse` に渡す
 *
 * **なぜ支払いを自分で書かずに `payOrRefuse` に渡すか。** 402 チャレンジの取得・payTo 照合・
 * マネーゲート・EIP-3009 の署名・売り手への再送・応答ヘッダのレシート・attest は、
 * 2026-09-05 に本番実装と突き合わせて是正された一式である（WINDOW_PLAN §14/§14.2）。
 * MCP 側に写せば、次に本番が穴を塞いだとき**こちらだけ古いまま**になる——
 * §14.2 が「今日いちばん学んだこと」として記録した失敗そのもの。だから写さずに呼ぶ。
 *
 * **なぜ判定を2回引くのか**（ここと `payOrRefuse` の中で1回ずつ）。MCP ツールは、
 * 支払い先を1つも知らない段階でも「サーバがどの reason_code で ALLOW を出さなかったか」を
 * 機械可読で返せなければならない（G21a/G21c はまさにその形で呼ぶ）。一方 signer を
 * 実際に守っている関門は `payOrRefuse` の中にある。どちらを削っても片方が弱くなるので、
 * 2回引く。GET は副作用を持たない。
 */
import { type CallerPolicy } from "./vouch-client.js";
import type { PayDecisionRecord, PayEvidencePolicy, PayPolicy } from "@vet402/sdk";
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
    /**
     * 呼び手の規則（WINDOW_PLAN §3.2）。**値はそのまま SDK の `payOrRefuse` へ渡す**——
     * 判定ロジックを MCP に写さない。`requireVet402Allow: false` は「vet402 の ALLOW を要求しない」
     * で、代わりの床（`evidence.minSubgraphReceipts` 等）が必須。BLOCK と degraded は
     * `false` でも常に拒否（§3.2.1・SDK が持つ境界をそのまま通す）。
     */
    policy?: PayIfTrustedPolicy;
    /**
     * The Graph Gateway の API キー。**ツール入力には載せない**（LLM の文脈に鍵を通さない）——
     * `index.ts` が環境変数 `GRAPH_API_KEY` から渡す。`evidence.source` が `"subgraph"` / `"both"`
     * なのに無ければ、通信の前に `graph_key_not_configured` で拒否する。黙って vet402 だけで判定しない。
     */
    graphApiKey?: string;
    apiUrl?: string;
    apiKey?: string;
    /** 決定行の出所。既定 "mcp"（L1 台帳と混ぜない・F19/F20）。 */
    source?: string;
};
/** ツール入力に載せる policy。SDK の `PayPolicy` から **鍵だけを除いた**形。 */
export type PayIfTrustedPolicy = Omit<PayPolicy, "evidence"> & {
    evidence?: Omit<PayEvidencePolicy, "graphApiKey">;
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
    /**
     * サーバが呼び手の policy を当てた結果（`/decision` の `caller_policy`・§16.3・2026-09-07）。
     * **組み替えずに透過する。** 送っていない／古いサーバの応答では null（無いものを作らない）。
     */
    caller_policy: CallerPolicy | null;
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
    /**
     * SDK の `payOrRefuse` が出した決定行（`PayDecisionRecord`）を**そのまま**通す。
     * `evidence[]` には `/decision` の行に加えて The Graph subgraph の行（`source: "subgraph"`・
     * `receipts`・`block.number`）が載り、`verdict_source` と `policy_override` が
     * 「誰の規則で通したか・何を免除しどの床をいくつで満たしたか」を持つ。
     * `payOrRefuse` に到達する前に止まったときは null。
     */
    decision_record: PayDecisionRecord | null;
};
/** 判定を引き、全部の関門を通ったときにだけ signer へ到達する。 */
export declare function payIfTrusted(input: PayIfTrustedInput): Promise<PayIfTrustedResult>;
