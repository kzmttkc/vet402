/**
 * `payOrRefuse` — 判定を引き、全部の条件を通ったときにだけ署名へ進む。
 *
 * 正典: `docs/ethonline-2026/WINDOW_PLAN.md` §2・§3.1・§4。
 * 契約テスト: `packages/sdk/test/pay-or-refuse.test.mjs`。
 *
 * SpendGuard との違いは1つだけ。SpendGuard は allow/deny を**返す**（実行は呼び手の
 * ウォレットスタックの仕事）。`payOrRefuse` は deny のとき **signer に到達しない**——
 * 支払い実装は `./x402-pay.js` にあり、ALLOW ブランチ内でしか動的 import されない。
 *
 * 判定の流れ（5行）:
 *   1. 呼び出し側の誤り（0x でない payee 等）は throw。名前解決も判定取得もしない
 *   2. 呼び手が名乗った上限を、**判定を引く前に**当てる（price_above_ceiling）
 *   3. `GET /resources/{id}/decision?role=payer` を引く。読めない・degraded・ALLOW でない → 拒否
 *      3'. **404 not_found（カタログ外）→ 402 の payTo と受取人スコアだけで判定する**（§3.1・I23）
 *   4. 402 チャレンジを取り、payTo / network / asset / scheme / 金額を照合
 *   5. 全部通ったときだけ `./x402-pay.js` を動的 import して署名 → **売り手へ再送** → attest
 *
 * 5 について: **買い手は facilitator を呼ばない。決済するのは売り手**（x402-pay.ts の
 * 冒頭に一次根拠）。2026-09-05 まで、ここは買い手から `x402.org/facilitator/settle` を
 * 叩いていた。その形のまま 09-08 に実支払いをすれば、金は動かず理由も残らなかった。
 */
import { DEFAULT_API_URL } from "./index.js";
import type { DecisionResult, SellerFacts, PayeeScoreResult } from "./index.js";
import type { PayerAccount, X402Accept } from "./x402-pay.js";

export type { PayerAccount, X402Accept, X402Settlement, Eip3009Authorization } from "./x402-pay.js";

/** Base メインネット。会期スコープは1チェーンだけ（WINDOW_PLAN §2「範囲外: 新チェーン」）。 */
export const BASE_CHAIN = "eip155:8453";
export const BASE_CHAIN_ID = 8453;
/** Base の正規 USDC。ここを可変にしない——「別トークンを掴まされる」が最も安い攻撃。 */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * 1件あたりの既定上限 $1。呼び手が `policy.maxPerTxUsd` を書かなくても
 * 上限が存在する状態にしておく（DESIGN_payOrRefuse.md §2 の `maxAmountUnits` 既定と同値）。
 */
export const DEFAULT_MAX_PER_TX_USD = 1;

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
export type PayRefuseReason =
  | "price_above_ceiling"
  | "payee_mismatch"
  | "chain_or_asset_mismatch"
  | "evidence_unavailable"
  | "payee_recommendation_not_allow"
  | "insufficient_delivery_evidence"
  | "insufficient_subgraph_evidence"
  | "resource_uncatalogued";

/** 証拠源。`payOrRefuse` の判定が「誰の台帳を読んだか」を機械可読で残す。 */
export type PayEvidenceSource = "vet402" | "subgraph";

export type PayEvidenceRow = {
  level: "L0" | "L1" | "L2";
  source: PayEvidenceSource;
  url: string;
  purchase_id?: string;
  /** `source: "subgraph"` のとき live であることの証跡（会期中に追加予定・D15）。 */
  subgraphId?: string;
  block?: { number: number };
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

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const USDC_DECIMALS = 6;

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * 資源 ID。WINDOW_PLAN §3.1 の実測で示された規則は sha256("<METHOD> <正規化URL>")。
 * 正規化規則はサーバ側が正典なので、食い違ったときのために `resourceId` を渡せる。
 */
async function computeResourceId(method: string, url: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${method} ${url}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** ヘッダ名の大小を問わずに読む（実 Headers は case-insensitive、テストの Map はそうでない）。 */
function readHeader(headers: unknown, name: string): string | null {
  const get = (headers as { get?: (k: string) => string | null } | undefined)?.get;
  if (typeof get !== "function") return null;
  for (const candidate of [name, name.toUpperCase(), name.toLowerCase()]) {
    const value = get.call(headers, candidate);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * v1 の綴りを v2 の形へ揃える。実在する v1 の壁は `network: "base"` と
 * `maxAmountRequired` を使う（本番 `x402-payer.ts` の normalizeAccept と同じ規則）。
 * ここで揃えておかないと、金銭ゲートが v1 を丸ごと chain_or_asset_mismatch で落とし、
 * v1 の transport（X-PAYMENT）が届かない死んだ枝になる。
 */
function normalizeAccept(raw: unknown): X402Accept | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const amount =
    typeof rec.amount === "string" ? rec.amount
    : typeof rec.maxAmountRequired === "string" ? rec.maxAmountRequired
    : null;
  const payTo = typeof rec.payTo === "string" ? rec.payTo : null;
  if (amount === null || payTo === null) return null;
  if (typeof rec.scheme !== "string" || typeof rec.asset !== "string") return null;
  const network =
    rec.network === "base" ? BASE_CHAIN
    : rec.network === "base-sepolia" ? "eip155:84532"
    : typeof rec.network === "string" ? rec.network
    : "";
  return {
    scheme: rec.scheme,
    network,
    amount,
    asset: rec.asset,
    payTo,
    ...(typeof rec.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: rec.maxTimeoutSeconds } : {}),
    ...(typeof rec.extra === "object" && rec.extra !== null ? { extra: rec.extra as X402Accept["extra"] } : {}),
  };
}

/** チャレンジは **transport のバージョンごと**読む——答える側のヘッダ名がそれで決まる。 */
function decodeChallenge(raw: string): { x402Version: 1 | 2; accept: X402Accept } | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
    const accepts = (json as { accepts?: unknown[] }).accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) return null;
    const accept = normalizeAccept(accepts[0]);
    if (!accept) return null;
    return { x402Version: (json as { x402Version?: unknown }).x402Version === 1 ? 1 : 2, accept };
  } catch {
    return null;
  }
}

/**
 * 判定を引き、全部の条件を通ったときにだけ払う。結果は `decisionStore` を渡したときだけ
 * 1本の JSONL へ追記される（下の {@link appendDecision}）。
 */
export async function payOrRefuse(input: PayOrRefuseInput): Promise<PayOrRefuseResult> {
  const result = await decideAndPay(input);
  if (input.decisionStore === undefined) return result;
  try {
    await appendDecision(
      {
        ...result.decision,
        at: new Date().toISOString(),
        status: result.status,
        resource: input.resource,
        txHash: result.txHash,
        nonce: result.nonce,
      },
      { store: input.decisionStore },
    );
    return { ...result, stored: true, storeError: null };
  } catch (error) {
    // 台帳に書けなかったことを理由に結果を握り潰さない。握り潰すと「払ったのに
    // nonce も txHash も残らない」が起きる。黙って成功にもしない（fail-loud）。
    return { ...result, stored: false, storeError: String(error instanceof Error ? error.message : error) };
  }
}

async function decideAndPay(input: PayOrRefuseInput): Promise<PayOrRefuseResult> {
  const fetchFn = input.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("invalid_fetch: pass the fetch implementation payOrRefuse should use");
  }
  // **呼び出し側の誤り**は判定でも拒否でもなく throw。0x でない payee はここで止まる:
  // 名前解決を支払いゲートの中で起こさない（解決先が入れ替われば payee_mismatch すら
  // 通ってしまうので、解決は呼び手の責任として外に出す）。B8。
  if (typeof input.payee !== "string" || !WALLET_RE.test(input.payee)) {
    throw new Error(
      `invalid_payee_address: payOrRefuse takes a 0x address, got ${JSON.stringify(input.payee)}. ` +
        "ENS names are not resolved here — resolve it yourself and pass the resulting address.",
    );
  }
  if (typeof input.resource !== "string" || input.resource.trim() === "") {
    throw new Error("invalid_resource: pass the URL that answers 402");
  }
  if (typeof input.amountUsd !== "number" || !Number.isFinite(input.amountUsd) || input.amountUsd < 0) {
    throw new Error("invalid_amount_usd: pass a finite, non-negative USD amount");
  }
  // account は**検査しない**。`typeof account.signTypedData === "function"` と書いた瞬間に
  // 拒否経路から signer へのプロパティ参照が発生し、「到達できない」が嘘になる。

  const method = (input.method ?? "GET").toUpperCase();
  const apiUrl = (input.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
  const maxPerTxUsd = input.policy?.maxPerTxUsd ?? DEFAULT_MAX_PER_TX_USD;
  const source = input.source ?? "sdk";
  const headers: Record<string, string> = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {};

  const evidence: PayEvidenceRow[] = [];
  const record = (
    recommendation: "ALLOW" | "REFUSE",
    reason_codes: string[],
    verdict_source: PayDecisionRecord["verdict_source"],
    decision: DecisionResult | null,
    payeeScore: PayeeScoreResult | null,
  ): PayDecisionRecord => ({ recommendation, reason_codes, verdict_source, evidence, decision, payeeScore, source });

  const refuse = (
    reason_codes: string[],
    verdict_source: PayDecisionRecord["verdict_source"],
    decision: DecisionResult | null = null,
    payeeScore: PayeeScoreResult | null = null,
    challenge: X402Accept | null = null,
  ): PayOrRefuseResult => ({
    status: "refused",
    decision: record("REFUSE", reason_codes, verdict_source, decision, payeeScore),
    signed: false,
    attested: false,
    txHash: null,
    nonce: null,
    challenge,
    stored: false,
    storeError: null,
  });

  // --- 2. 呼び手が名乗った上限は、判定を引く前に当てる（C9）---
  if (input.amountUsd > maxPerTxUsd) {
    return refuse(["price_above_ceiling"], "local_policy");
  }

  // --- 3. /decision ---
  const resourceId = input.resourceId ?? (await computeResourceId(method, input.resource));
  const decisionUrl = `${apiUrl}/resources/${resourceId}/decision?role=payer`;
  let decision: DecisionResult | null = null;
  let uncatalogued = false;
  try {
    const response = await fetchFn(decisionUrl, { headers });
    let body: unknown = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (response.status === 404 && (body as { error?: unknown })?.error === "not_found") {
      // §3.1: カタログ外。`getResource()` は resource_id の単純照会なので未登録は必ずここ。
      uncatalogued = true;
    } else if (!response.ok) {
      return refuse(["evidence_unavailable"], "decision");
    } else {
      decision = body as DecisionResult;
    }
  } catch {
    // A3: 読めなかったのだから払わない。
    return refuse(["evidence_unavailable"], "decision");
  }

  const pathReasons: string[] = uncatalogued ? ["resource_uncatalogued"] : [];

  if (decision) {
    const serverReasons = Array.isArray(decision.reason_codes) ? decision.reason_codes : [];
    // A2: degraded は「測れなかった」。fail-closed のゲートにとっては読めなかったのと同じ。
    if (decision.degraded === true) {
      return refuse([...serverReasons, "evidence_unavailable"], "decision", decision);
    }
    // A1: ALLOW 以外。理由はサーバの reason_codes をそのまま通す（我々の語で上書きしない）。
    if (decision.recommendation !== "ALLOW") {
      return refuse([...serverReasons, "payee_recommendation_not_allow"], "decision", decision);
    }
    evidence.push(
      ...(Array.isArray(decision.evidence) ? decision.evidence : []).map((row) => ({
        level: row.level,
        source: "vet402" as const,
        url: row.url,
        ...(row.purchase_id ? { purchase_id: row.purchase_id } : {}),
      })),
    );
    const shortfall = evaluateEvidencePolicy(input.policy?.evidence, decision);
    if (shortfall) return refuse([...serverReasons, ...shortfall], "decision", decision);
  }

  // --- 4. 402 チャレンジ ---
  let accept: X402Accept | null = null;
  let x402Version: 1 | 2 = 2;
  try {
    const response = await fetchFn(input.resource, { method });
    const raw = readHeader(response.headers, "payment-required");
    const challenge = raw ? decodeChallenge(raw) : null;
    if (challenge) {
      accept = challenge.accept;
      x402Version = challenge.x402Version;
    }
  } catch {
    accept = null;
  }
  if (!accept) {
    // 402 を読めない＝いくら誰に払うのかが分からない。判定と同じく fail-closed。
    return refuse([...pathReasons, "evidence_unavailable"], uncatalogued ? "payee_score" : "decision", decision);
  }

  // A4: 照合は payTo で行う。402 の resource.url は内部ホスト名を返すことがある（§3）。
  if (!sameAddress(accept.payTo, input.payee)) {
    return refuse([...pathReasons, "payee_mismatch"], uncatalogued ? "payee_score" : "decision", decision, null, accept);
  }
  const moneyGate = evaluateMoneyGate(accept, maxPerTxUsd);
  if (moneyGate) {
    return refuse([...pathReasons, ...moneyGate], uncatalogued ? "payee_score" : "decision", decision, null, accept);
  }

  // --- 3'. カタログ外なら、ここまでで分かった payTo で受取人スコアを引く（I23）---
  let payeeScore: PayeeScoreResult | null = null;
  if (uncatalogued) {
    const scoreUrl = `${apiUrl}/payees/${accept.payTo}/score`;
    try {
      const response = await fetchFn(scoreUrl, { headers });
      if (!response.ok) throw new Error("payee_score_unavailable");
      payeeScore = (await response.json()) as PayeeScoreResult;
    } catch {
      return refuse([...pathReasons, "evidence_unavailable"], "payee_score", null, null, accept);
    }
    if (payeeScore?.degraded === true || (payeeScore?.signalsUnavailable?.length ?? 0) > 0) {
      return refuse([...pathReasons, "evidence_unavailable"], "payee_score", null, payeeScore, accept);
    }
    if (payeeScore?.recommendation !== "ALLOW") {
      return refuse([...pathReasons, "payee_recommendation_not_allow"], "payee_score", null, payeeScore, accept);
    }
    evidence.push({ level: "L0", source: "vet402", url: scoreUrl });
  }

  // --- 5. ここから先だけが支払い。実装は ALLOW ブランチ内の動的 import（第3層）---
  // 署名 → **売り手へ再送** → 応答ヘッダのレシート。facilitator は買い手の経路に無い。
  const { executeX402Payment } = await import("./x402-pay.js");
  // 署名の直後に nonce を確定させる。ここから先で落ちても「何に署名したか」は残る。
  let signedNonce: string | null = null;
  const paid = await executeX402Payment({
    account: input.account,
    accept,
    resource: input.resource,
    method,
    chainId: BASE_CHAIN_ID,
    x402Version,
    fetch: fetchFn,
    onSigned: ({ nonce }) => {
      signedNonce = nonce;
    },
  });

  const verdictSource: PayDecisionRecord["verdict_source"] = uncatalogued ? "payee_score" : "decision";
  if (!paid.settled) {
    // E18: 署名は実在する。隠さない。nonce も返す——署名した認可は validBefore まで
    // 生きた金で、後から遅れて決済され得る。何に署名したかが残らないと照合できない。
    return {
      status: "failed",
      decision: record("ALLOW", [...pathReasons, "settle_failed"], verdictSource, decision, payeeScore),
      signed: paid.signed,
      attested: false,
      txHash: paid.txHash,
      nonce: paid.nonce ?? signedNonce,
      challenge: accept,
      stored: false,
      storeError: null,
    };
  }

  let attested = false;
  if (paid.txHash) {
    try {
      const response = await fetchFn(`${apiUrl}/payments/x402`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: input.payee,
          txHash: paid.txHash,
          amount: accept.amount,
          network: accept.network,
          resource: input.resource,
          // 監査の nonce 束縛（本番 settlement-verify.ts）。attest がこれを載せて初めて、
          // 「その決済 tx はこの購入のものか」を第三者が確かめられる。
          authNonce: paid.nonce,
          source,
        }),
      });
      attested = response.ok === true;
    } catch {
      attested = false;
    }
  }

  return {
    status: "paid",
    decision: record("ALLOW", pathReasons, verdictSource, decision, payeeScore),
    signed: paid.signed,
    attested,
    txHash: paid.txHash,
    nonce: paid.nonce ?? signedNonce,
    challenge: accept,
    stored: false,
    storeError: null,
  };
}

/**
 * 金銭ゲート。**署名の前**にしか意味が無いので、呼ぶ位置を動かさないこと。
 * 本番には4チェーン提示の 402 が実在する（WINDOW_PLAN §4 B）。
 */
function evaluateMoneyGate(accept: X402Accept, maxPerTxUsd: number): string[] | null {
  if (accept.network !== BASE_CHAIN) return ["chain_or_asset_mismatch"];
  if (!sameAddress(accept.asset, BASE_USDC)) return ["chain_or_asset_mismatch"];
  if (accept.scheme !== "exact") return ["chain_or_asset_mismatch"];
  // 明示された転送方式が eip3009 でなければ拒否する。未提示は許す——Base 正規 USDC の
  // `exact` は構造上 EIP-3009 の transferWithAuthorization であり、未提示を拒むと
  // 実在する 402（フィールドを出さない実装）に払えなくなる。値が違うときだけ止める。
  const transfer = accept.extra?.assetTransferMethod;
  if (transfer !== undefined && transfer !== "eip3009") return ["chain_or_asset_mismatch"];
  // EIP-712 ドメインはトークンのものであって売り手のものではない（本番 2026-08-22 監査）。
  // 矛盾する accept を**署名の前に**落とす: 誤ったドメインの署名は決済され得ないので、
  // 通せば「一円も動かないまま署名だけが生きている」状態を売り手が無料で作れてしまう。
  // 判定は署名器と同じ述語（hasCanonicalUsdcDomain）で行う——別の述語では関門にならない。
  const name = accept.extra?.name;
  const version = accept.extra?.version;
  if ((name !== undefined && name !== "USD Coin") || (version !== undefined && version !== "2")) {
    return ["chain_or_asset_mismatch"];
  }
  const units = Number(accept.amount);
  if (!Number.isFinite(units) || units <= 0) return ["chain_or_asset_mismatch"];
  if (units / 10 ** USDC_DECIMALS > maxPerTxUsd) return ["price_above_ceiling"];
  return null;
}

/**
 * 呼び手が名指しした証拠の床を当てる。**判定（`/decision`）と policy 評価を分けてある**のは、
 * 会期中に証拠源（The Graph）を足すときにここだけを差し替えられるようにするため。
 *
 * 未実装の証拠源を黙って弱い方（自社台帳）に落とさない: `subgraph` を名指しされたのに
 * 読めていないなら、それは `evidence_unavailable` である（DESIGN §3.5）。
 */
function evaluateEvidencePolicy(
  policy: PayEvidencePolicy | undefined,
  decision: DecisionResult,
): string[] | null {
  if (!policy) return null;
  const wanted = policy.source ?? "vet402";
  if (wanted === "vet402" || wanted === "both") {
    const facts = decision.facts as SellerFacts | undefined;
    const delivered = typeof facts?.l1?.n_delivered === "number" ? facts.l1.n_delivered : 0;
    if (policy.minL1Deliveries !== undefined && delivered < policy.minL1Deliveries) {
      return ["insufficient_delivery_evidence"];
    }
  }
  if (wanted === "subgraph" || wanted === "both") {
    // 会期中に実装（C11 / C12 / D13-D16）。読めていない以上、通してはいけない。
    return ["evidence_unavailable"];
  }
  return null;
}

// ============================================================
// 決定行の保存先（WINDOW_PLAN §2 #4 / F19・F20）
//
// **1本のローカル追記専用 JSONL に、行ごと `source` で区別して入れる。**
//
// なぜ1本か: デモ行と L1 行を別ファイルに分けると、「混ざっていない」が
// ファイルが違うという理由で構造的に自明になり、F20 が何も証明しなくなる。
// 同じ store に混ぜて、**読み手が正しく分ける**ことを要求してはじめて混線が検出できる。
//
// なぜローカルか: 会期中は本番のスキーマを触らない（実装凍結）。決定行は
// **本番 DB へは一切書かない**——`payOrRefuse` が出す書き込み系の HTTP は
// 支払いの再送と attest だけであることを F19 が固定している。
// ============================================================

/** 既定の保存先。呼び出し側の cwd からの相対。 */
export const DEFAULT_DECISION_STORE = ".vet402/decisions.jsonl";

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
export async function appendDecision(
  row: StoredDecision,
  options: DecisionStoreOptions = {},
): Promise<void> {
  // node:fs は動的 import。ブラウザ／エッジで `payOrRefuse` を判定だけに使う呼び手が、
  // ファイルシステムを持たないという理由で import 時に落ちないようにする。
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const path = options.store ?? DEFAULT_DECISION_STORE;
  const dir = dirname(path);
  if (dir && dir !== "." && dir !== path) await mkdir(dir, { recursive: true });
  await appendFile(path, JSON.stringify(row) + "\n", "utf8");
}

/** store を読み、`source` が一致する行だけ返す。 */
async function readDecisions(source: string, options: DecisionStoreOptions): Promise<StoredDecision[]> {
  const { readFile } = await import("node:fs/promises");
  const path = options.store ?? DEFAULT_DECISION_STORE;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // まだ1行も書かれていない = 決定が0件。存在しないことを異常にしない。
    return [];
  }
  const rows: StoredDecision[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const row = JSON.parse(trimmed) as StoredDecision;
      // 追記専用ファイルは書き込みの途中で千切れ得る。読めない行は**捨てるが、
      // 読めた行は返す**——1行の破損で台帳全体が読めなくなる方が危険。
      if (row && row.source === source) rows.push(row);
    } catch {
      continue;
    }
  }
  return rows;
}

/** デモ（`source: "agent-demo"`）の決定行だけを返す。 */
export async function readDemoDecisions(options: DecisionStoreOptions = {}): Promise<StoredDecision[]> {
  return readDecisions("agent-demo", options);
}

/** L1（`source: "vet402"`）の決定行だけを返す。 */
export async function readL1Decisions(options: DecisionStoreOptions = {}): Promise<StoredDecision[]> {
  return readDecisions("vet402", options);
}
