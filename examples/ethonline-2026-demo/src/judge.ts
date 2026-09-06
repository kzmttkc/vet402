/**
 * `judge <url>` —— 審査員が**自分の好きな x402 の 402 URL**を入れて、`pay` と同じ画で
 * 「resolve → 402 → `/decision`（404 可）→ 受取人スコア → The Graph subgraph」を見て、
 * **署名なしの判定**（ALLOW / REFUSE と理由コード）を得る。
 *
 * **署名の経路が最初から無い。** `--live` を持たず、account を受け取らず、
 * 支払いモジュールを静的にも動的にも読まない（`test/judge.test.mjs` が src を走査して固定する）。
 *
 * 判定の規則は SDK `packages/sdk/src/pay-or-refuse.ts` の `decideAndPay` と同じ順序・同じ語。
 * SDK は判定だけを行う関数を export していない（判定と署名が1本の関数の中にある）ので、
 * ここでは**閾値を SDK の定数から引き、理由コードは SDK のソースに実在する語だけ**を使う。
 * 語を1つでも発明すれば `judge.test.mjs`「理由コードは SDK に実在する語」が落ちる。
 */
import { DEFAULT_MAX_PER_TX_USD } from "../../../packages/sdk/dist/index.js";
import type { PayRefuseReason } from "../../../packages/sdk/src/pay-or-refuse.ts";
import { assess, l1Delivered, type AssessPolicy, type DecisionBody, type EvidenceSource, type Reads } from "./assess.ts";
import type { Emitter } from "./emit.ts";
import { renderPayDryRun, type PayView } from "./render.ts";
import {
  NotX402Error,
  PolicyError,
  hasCanonicalUsdcDomain,
  instrument,
  isProtocolEligible,
  probeChallenge,
  requireEnv,
} from "./probe.ts";

/**
 * `judge` が出せる理由コードの全部。**SDK のソースに文字通り実在する語だけ**
 * （`test/judge.test.mjs` が `pay-or-refuse.ts` と突き合わせる）。
 * `payee_recommendation_block` は SDK が実際に出す語だが `PayRefuseReason` 型には載っていない
 * （SDK 側の型の抜け。会期中は `packages/**` を触らないので、ここでは型を緩めて受ける）。
 */
export const JUDGE_REASON_CODES = [
  "price_above_ceiling",
  "payee_mismatch",
  "chain_or_asset_mismatch",
  "evidence_unavailable",
  "payee_recommendation_not_allow",
  "payee_recommendation_block",
  "insufficient_delivery_evidence",
  "insufficient_subgraph_evidence",
  "resource_uncatalogued",
  "subgraph_evidence_unavailable",
  "no_eligible_accept",
  "allowed_by_caller_policy",
] as const;

type ReasonCode = PayRefuseReason | "payee_recommendation_block";
type VerdictSource = "decision" | "payee_score" | "local_policy" | "caller_policy";

export type JudgeVerdict = {
  verdict: "ALLOW" | "REFUSE";
  reasonCodes: ReasonCode[] | string[];
  verdictSource: VerdictSource;
  /** 常に false。`judge` に署名の経路は無い。 */
  signed: false;
  /** vet402 の非 ALLOW を呼び手の床が免除して通したときだけ非 null（SDK の `policy_override` と同じ形）。 */
  override: {
    rule: "requireVet402Allow:false";
    waived: { source: "decision" | "payee_score"; recommendation: string; score: number | null; reason_codes: string[] };
    floors_met: { floor: "minL1Deliveries" | "minSubgraphReceipts"; source: "vet402" | "subgraph"; required: number; observed: number }[];
  } | null;
};

export type JudgeArgs = {
  url: string;
  method: string;
  body?: string;
  policy: EvidenceSource;
  minSubgraphReceipts?: number;
  minL1Deliveries?: number;
  ceilingUsd: number;
  color: boolean;
};

const VALUE_FLAGS = new Set(["--method", "--body", "--policy", "--min-subgraph-receipts", "--min-l1-deliveries", "--ceiling-usd"]);

function nonNegativeInteger(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new PolicyError(`invalid_argument: ${flag} takes a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * `judge <url> [--method POST] [--body '<json>'] [--policy vet402|subgraph|both]
 *              [--min-subgraph-receipts N] [--min-l1-deliveries N] [--ceiling-usd X]`
 *
 * 既定は `--policy both`（`pay` と同じ・2つの源を両方読む）、上限は SDK の既定 $1。
 * **`--live` は受け付けない**——この命令に署名の経路は無い。
 * 評価されない床（`--policy subgraph` に `--min-l1-deliveries`）は SDK と同じく呼び出し側エラー。
 */
export function parseJudgeArgs(argv: string[]): JudgeArgs {
  let url: string | null = null;
  const values: Record<string, string> = {};
  let color = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") throw new PolicyError("judge has no --live: it never signs. Use `pay --live` for the one filmed payment.");
    if (arg === "--color") {
      color = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new PolicyError(`invalid_argument: ${arg} needs a value`);
      values[arg] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new PolicyError(`invalid_argument: unknown option ${arg}`);
    if (url !== null) throw new PolicyError(`invalid_argument: only one url, got a second: ${arg}`);
    url = arg;
  }
  if (url === null) throw new PolicyError("invalid_argument: judge needs a url — node src/run.ts judge <url>");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PolicyError(`invalid_argument: not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PolicyError(`invalid_argument: url must be http(s), got ${parsed.protocol}`);
  }

  const policy = values["--policy"] ?? "both";
  if (policy !== "vet402" && policy !== "subgraph" && policy !== "both") {
    throw new PolicyError(`invalid_evidence_policy: unknown evidence source ${JSON.stringify(policy)} (vet402 | subgraph | both)`);
  }
  const minSubgraphReceipts =
    values["--min-subgraph-receipts"] === undefined ? undefined : nonNegativeInteger("--min-subgraph-receipts", values["--min-subgraph-receipts"]);
  const minL1Deliveries =
    values["--min-l1-deliveries"] === undefined ? undefined : nonNegativeInteger("--min-l1-deliveries", values["--min-l1-deliveries"]);
  // SDK `assertEvidencePolicy` と同じ: 評価されない床を黙って無視しない。
  if (minSubgraphReceipts !== undefined && policy === "vet402") {
    throw new PolicyError(
      `invalid_evidence_policy: --min-subgraph-receipts needs --policy subgraph or both, got "vet402". It would otherwise be ignored in silence.`,
    );
  }
  if (minL1Deliveries !== undefined && policy === "subgraph") {
    throw new PolicyError(
      `invalid_evidence_policy: --min-l1-deliveries needs --policy vet402 or both, got "subgraph". It would otherwise be ignored in silence.`,
    );
  }
  let ceilingUsd = DEFAULT_MAX_PER_TX_USD;
  if (values["--ceiling-usd"] !== undefined) {
    ceilingUsd = Number(values["--ceiling-usd"]);
    if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0) {
      throw new PolicyError(`invalid_argument: --ceiling-usd takes a non-negative number, got ${JSON.stringify(values["--ceiling-usd"])}`);
    }
  }
  return {
    url,
    method: (values["--method"] ?? "GET").toUpperCase(),
    ...(values["--body"] === undefined ? {} : { body: values["--body"] }),
    policy,
    ...(minSubgraphReceipts === undefined ? {} : { minSubgraphReceipts }),
    ...(minL1Deliveries === undefined ? {} : { minL1Deliveries }),
    ceilingUsd,
    color,
  };
}

/**
 * 呼び手の規則。**床を1つでも（1 以上で）宣言したら vet402 の判定を免除する**——`pay` と同じ形で、
 * SDK が `requireVet402Allow: false` に許す唯一の構成（床が無ければ `invalid_policy`）。
 * 床が無ければ既定の fail-closed（vet402 が ALLOW と言わなければ払わない）。
 */
export function policyFromArgs(args: JudgeArgs): AssessPolicy {
  const floors = [args.minL1Deliveries, args.minSubgraphReceipts];
  const hasFloor = floors.some((f) => typeof f === "number" && f > 0);
  return {
    requireVet402Allow: !hasFloor,
    evidence: {
      source: args.policy,
      ...(args.minL1Deliveries === undefined ? {} : { minL1Deliveries: args.minL1Deliveries }),
      ...(args.minSubgraphReceipts === undefined ? {} : { minSubgraphReceipts: args.minSubgraphReceipts }),
    },
  };
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/** SDK `evaluateMoneyGate` と同じ順序・同じ語。閾値は SDK の定数（`isProtocolEligible` 経由）。 */
function moneyGate(accept: Record<string, unknown>, ceilingUsd: number): ReasonCode[] | null {
  if (!isProtocolEligible(accept)) return ["chain_or_asset_mismatch"];
  if (!hasCanonicalUsdcDomain(accept)) return ["chain_or_asset_mismatch"];
  const units = Number(accept.amount);
  if (!Number.isFinite(units) || units <= 0) return ["chain_or_asset_mismatch"];
  if (units / 1e6 > ceilingUsd) return ["price_above_ceiling"];
  return null;
}

/** SDK `evaluateEvidencePolicy` と同じ。源をまたいで足さない（D16）。 */
function evaluateFloors(
  policy: AssessPolicy,
  decision: DecisionBody | null,
  subgraph: Reads["subgraph"],
): { shortfall: ReasonCode[] | null; met: NonNullable<JudgeVerdict["override"]>["floors_met"] } {
  const met: NonNullable<JudgeVerdict["override"]>["floors_met"] = [];
  const { source, minL1Deliveries, minSubgraphReceipts } = policy.evidence;
  if ((source === "vet402" || source === "both") && minL1Deliveries !== undefined) {
    const delivered = l1Delivered(decision);
    if (delivered < minL1Deliveries) return { shortfall: ["insufficient_delivery_evidence"], met };
    met.push({ floor: "minL1Deliveries", source: "vet402", required: minL1Deliveries, observed: delivered });
  }
  if ((source === "subgraph" || source === "both") && minSubgraphReceipts !== undefined) {
    if (!subgraph?.ok) return { shortfall: ["evidence_unavailable", "subgraph_evidence_unavailable"], met };
    if (subgraph.receipts < minSubgraphReceipts) return { shortfall: ["insufficient_subgraph_evidence"], met };
    met.push({ floor: "minSubgraphReceipts", source: "subgraph", required: minSubgraphReceipts, observed: subgraph.receipts });
  }
  return { shortfall: null, met };
}

/**
 * **署名なしの判定。** SDK `decideAndPay` の判定部分と同じ順序で、読んだものだけから結論を出す。
 * 署名の直前で止まる——ここから先の SDK は `executeX402Payment` であり、この関数には無い。
 */
export function dryRunVerdict(
  reads: Reads,
  policy: AssessPolicy,
  target: { expectedPayee: string | null; ceilingUsd: number },
): JudgeVerdict {
  const refuse = (reasonCodes: string[], verdictSource: VerdictSource): JudgeVerdict => ({
    verdict: "REFUSE",
    reasonCodes,
    verdictSource,
    signed: false,
    override: null,
  });

  // --- 3. /decision ---
  if (reads.decision.status === null) return refuse(["evidence_unavailable"], "decision");
  const uncatalogued = reads.uncatalogued;
  let decision: DecisionBody | null = null;
  if (!uncatalogued) {
    const s = reads.decision.status;
    if (s < 200 || s >= 300) return refuse(["evidence_unavailable"], "decision");
    decision = reads.decision.body as DecisionBody;
  }
  const pathReasons: string[] = uncatalogued ? ["resource_uncatalogued"] : [];
  const serverReasons = decision && Array.isArray(decision.reason_codes) ? decision.reason_codes.map(String) : [];
  const evidenceVerdictSource: VerdictSource = uncatalogued ? "payee_score" : "decision";

  // --- 3.5 宣言された証拠源をすべて読めているか（C12: 片方でも読めなければ fail-closed）---
  if (policy.evidence.source !== "vet402" && !reads.subgraph?.ok) {
    return refuse([...pathReasons, ...serverReasons, "evidence_unavailable", "subgraph_evidence_unavailable"], evidenceVerdictSource);
  }

  let waived: NonNullable<JudgeVerdict["override"]>["waived"] | null = null;
  if (decision) {
    if (decision.degraded === true) return refuse([...serverReasons, "evidence_unavailable"], "decision");
    const recommendation = String(decision.recommendation ?? "").toUpperCase();
    // BLOCK は免除の対象外（WINDOW_PLAN §3.2.1）。WARN は意見、BLOCK は遮断。
    if (recommendation === "BLOCK") return refuse([...serverReasons, "payee_recommendation_block"], "decision");
    if (recommendation !== "ALLOW") {
      if (policy.requireVet402Allow) return refuse([...serverReasons, "payee_recommendation_not_allow"], "decision");
      waived = { source: "decision", recommendation: String(decision.recommendation), score: null, reason_codes: serverReasons };
    }
  }

  // --- 3.6 呼び手が名指しした床。カタログ外でも当てる（C11c）---
  const floors = evaluateFloors(policy, decision, reads.subgraph);
  if (floors.shortfall) return refuse([...pathReasons, ...serverReasons, ...floors.shortfall], evidenceVerdictSource);

  // --- 4. 402 チャレンジ ---
  const first = reads.probe.challenge?.accepts[0] ?? null;
  if (!first) return refuse([...pathReasons, "evidence_unavailable"], evidenceVerdictSource);
  // SDK `selectAccept`: 払える1件があればそれ、無ければ提示された先頭を関門に通して**具体の不一致**を残す。
  const accept = reads.accept ?? first;
  const selectionReasons: string[] = reads.accept ? [] : ["no_eligible_accept"];
  if (target.expectedPayee !== null && !sameAddress(accept.payTo, target.expectedPayee)) {
    return refuse([...pathReasons, ...selectionReasons, "payee_mismatch"], evidenceVerdictSource);
  }
  const money = moneyGate(accept, target.ceilingUsd);
  if (money) return refuse([...pathReasons, ...selectionReasons, ...money], evidenceVerdictSource);

  // --- 3'. カタログ外なら payTo の受取人スコアで判定（I23）---
  if (uncatalogued) {
    const score = reads.score;
    if (score.status === null || score.status < 200 || score.status >= 300 || !score.body) {
      return refuse([...pathReasons, "evidence_unavailable"], "payee_score");
    }
    const body = score.body;
    const unavailable = Array.isArray(body.signalsUnavailable) ? body.signalsUnavailable.length : 0;
    // 測れなかったことは、ALLOW でないことと別（J7）。免除しない。
    if (body.degraded === true || unavailable > 0) return refuse([...pathReasons, "evidence_unavailable"], "payee_score");
    const recommendation = String(body.recommendation ?? "").toUpperCase();
    if (recommendation === "BLOCK") return refuse([...pathReasons, "payee_recommendation_block"], "payee_score");
    if (recommendation !== "ALLOW") {
      if (policy.requireVet402Allow) return refuse([...pathReasons, "payee_recommendation_not_allow"], "payee_score");
      waived = {
        source: "payee_score",
        recommendation: String(body.recommendation ?? "unknown"),
        score: typeof body.score === "number" ? body.score : null,
        reason_codes: [],
      };
    }
  }

  const override: JudgeVerdict["override"] = waived ? { rule: "requireVet402Allow:false", waived, floors_met: floors.met } : null;
  const reasonCodes = override ? [...pathReasons, ...override.waived.reason_codes, "allowed_by_caller_policy"] : pathReasons;
  return {
    verdict: "ALLOW",
    reasonCodes,
    verdictSource: override ? "caller_policy" : uncatalogued ? "payee_score" : "decision",
    signed: false,
    override,
  };
}

export type RunJudgeOptions = JudgeArgs & {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  emit: Emitter;
};

/** `judge` が知っている鍵。署名鍵は**無い**（画の env 行にも出ない）。 */
export function judgeEnvNames(policy: EvidenceSource): string[] {
  return policy === "vet402" ? ["VOUCH_API_KEY"] : ["VOUCH_API_KEY", "GRAPH_API_KEY"];
}

export async function runJudge(options: RunJudgeOptions): Promise<{ view: PayView; verdict: JudgeVerdict }> {
  const envNames = judgeEnvNames(options.policy);
  requireEnv(options.env, envNames);
  const policy = policyFromArgs(options);
  const net = instrument(options.fetch);

  // 402 が取れなければ、そこで止まる。vet402 へも The Graph へも1本も出さない。
  const probe = await probeChallenge(net.fetch, options.method, options.url, options.body);
  if (probe.error !== null) {
    throw new NotX402Error(`not an x402 endpoint: could not connect to ${options.method} ${options.url} (${probe.error})`);
  }
  if (probe.challenge === null) {
    throw new NotX402Error(
      probe.status === 402
        ? `not an x402 endpoint: HTTP 402 from ${options.method} ${options.url} has no decodable PAYMENT-REQUIRED header (x402 v1 body-only challenges are not read by the SDK either)`
        : `not an x402 endpoint: HTTP ${probe.status} from ${options.method} ${options.url} has no PAYMENT-REQUIRED header`,
    );
  }

  const target = {
    method: options.method,
    url: options.url,
    ...(options.body === undefined ? {} : { body: options.body }),
    expectedPayee: null,
    ceilingUsd: options.ceilingUsd,
  };
  const { view, reads } = await assess({ target, policy, env: options.env, net, probe, envNames, mode: "judge", live: false });
  const verdict = dryRunVerdict(reads, policy, target);
  view.verdict = {
    verdict: verdict.verdict,
    reasonCodes: verdict.reasonCodes,
    verdictSource: verdict.verdictSource,
    override: verdict.override,
  };
  options.emit.lines(renderPayDryRun(view, { color: options.color }));
  return { view, verdict };
}
