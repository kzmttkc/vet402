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
 *   3. `degraded` → 拒否。`recommendation !== "ALLOW"` → 拒否。**理由はサーバの reason_codes をそのまま通す**
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
import { DEFAULT_API_URL } from "./vouch-client.js";

/**
 * 署名者。**ALLOW ブランチに入るまで、この値のプロパティには一度も触らない。**
 * `typeof signer.signTypedData === "function"` と書いた瞬間に拒否経路から
 * signer へのプロパティ参照が発生し、「到達できない」が嘘になる（第1層）。
 */
export type PayIfTrustedSigner = {
  address: string;
  signTypedData: (typedData: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
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

const RESOURCE_ID_RE = /^[0-9a-f]{64}$/;

/** 判定を引き、全部の関門を通ったときにだけ signer へ到達する。 */
export async function payIfTrusted(input: PayIfTrustedInput): Promise<PayIfTrustedResult> {
  const fetchFn = input.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("invalid_fetch: pass the fetch implementation pay_if_trusted should use");
  }
  if (typeof input.resourceId !== "string" || !RESOURCE_ID_RE.test(input.resourceId)) {
    throw new Error(
      "invalid_resource_id: pass sha256(\"<METHOD> <canonical url>\") as 64 lowercase hex — " +
        "get it from GET /api/v1/resolve?q=<url>",
    );
  }
  // signer は**検査しない**。検査は参照であり、参照した時点で第1層の主張が崩れる。

  const apiUrl = (input.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
  const headers: Record<string, string> = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {};

  // --- 2. 判定 ---
  let body: unknown = null;
  try {
    const response = await fetchFn(`${apiUrl}/resources/${input.resourceId}/decision?role=payer`, { headers });
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      // 404（カタログ外）もここに落ちる。SDK の `payOrRefuse` は 402 の payTo と
      // 受取人スコアで判定へ落とせるが（§3.1・I23）、MCP は支払い先を渡されていない
      // 段階でそこへ進めない。**読めなかったのだから払わない**を先に守る。
      return refuse(measure(body), ["evidence_unavailable"], "The decision could not be read — no answer is not an ALLOW.");
    }
  } catch {
    return refuse(measure(null), ["evidence_unavailable"], "The decision lookup did not answer — no answer is not an ALLOW.");
  }

  const m = measure(body);

  // --- 3. degraded / ALLOW でない ---
  if (m.degraded === true) {
    return refuse(m, [...m.reason_codes, "evidence_unavailable"], "Do not pay: an input could not be measured, so this body is a refusal, not a measurement.");
  }
  if (m.recommendation !== "ALLOW") {
    return refuse(m, [...m.reason_codes, "payee_recommendation_not_allow"], `Do not pay: the recommendation is ${m.recommendation ?? "absent"}, not ALLOW.`);
  }

  // --- 4. ALLOW でも、払う相手を知らなければ払わない ---
  if (typeof input.payee !== "string" || typeof input.resource !== "string" || typeof input.amountUsd !== "number") {
    return refuse(
      m,
      [...m.reason_codes, "payment_target_unknown"],
      "ALLOW, but pay_if_trusted was not told what to pay: pass resource, payee and amountUsd to execute the payment.",
    );
  }

  // --- 5. ここから先だけが支払い。実装は ALLOW ブランチ内の動的 import（第3層）---
  const { payOrRefuse } = await import("@vet402/sdk");
  const paid = await payOrRefuse({
    payee: input.payee,
    resource: input.resource,
    amountUsd: input.amountUsd,
    account: input.signer,
    fetch: fetchFn,
    method: input.method,
    resourceId: input.resourceId,
    apiUrl,
    apiKey: input.apiKey,
    source: input.source ?? "mcp",
    policy: input.maxPerTxUsd === undefined ? undefined : { maxPerTxUsd: input.maxPerTxUsd },
  });

  const reasons = Array.isArray(paid.decision?.reason_codes) ? paid.decision.reason_codes : [];
  if (paid.status === "refused") {
    return {
      ...refuse(m, [...m.reason_codes, ...reasons], `Do not pay: ${reasons.join(", ") || "the payment gate refused"}.`),
      signed: paid.signed,
      nonce: paid.nonce,
    };
  }
  if (paid.status === "failed") {
    // §4 E18: 署名は実在する。隠さない——認可は validBefore まで生きた金で、
    // 遅れて決済され得る。何に署名したか（nonce）が残らないと後から照合できない。
    return {
      decision: "FAILED",
      safe_to_pay: false,
      refuse_reasons: [...m.reason_codes, ...reasons],
      summary: "Signed, but the seller did not settle. The authorization is live until validBefore — reconcile with the nonce below.",
      signed: paid.signed,
      attested: false,
      txHash: paid.txHash,
      nonce: paid.nonce,
      settlement: null,
      measurement: m,
    };
  }
  return {
    decision: "PAID",
    safe_to_pay: true,
    refuse_reasons: [],
    summary: `Paid. The seller claims settlement${paid.txHash ? ` in ${paid.txHash}` : ""}; that claim is not yet an on-chain confirmation.`,
    signed: paid.signed,
    attested: paid.attested,
    txHash: paid.txHash,
    nonce: paid.nonce,
    settlement: "settle_claimed",
    measurement: m,
  };
}

/** `/decision` の応答を**組み替えずに**測定として持つ。読めない体は空で埋める。 */
function measure(body: unknown): PayIfTrustedMeasurement {
  const b = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    recommendation: typeof b.recommendation === "string" ? b.recommendation : null,
    reason_codes: Array.isArray(b.reason_codes) ? b.reason_codes.filter((r): r is string => typeof r === "string") : [],
    facts: b.facts !== null && typeof b.facts === "object" ? (b.facts as Record<string, unknown>) : {},
    // **そのまま通す。** 行を作り直すと `source` / `subgraphId` / `block` が落ちる。
    evidence: Array.isArray(b.evidence) ? (b.evidence as Record<string, unknown>[]) : [],
    rules_version: typeof b.rules_version === "string" ? b.rules_version : null,
    degraded: typeof b.degraded === "boolean" ? b.degraded : null,
  };
}

function refuse(
  measurement: PayIfTrustedMeasurement,
  refuse_reasons: string[],
  summary: string,
): PayIfTrustedResult {
  return {
    decision: "REFUSE",
    safe_to_pay: false,
    refuse_reasons,
    summary,
    signed: false,
    attested: false,
    txHash: null,
    nonce: null,
    settlement: null,
    measurement,
  };
}
