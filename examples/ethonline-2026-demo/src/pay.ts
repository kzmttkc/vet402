/**
 * `pay` —— 台本 1:30–2:05。**払う先は The Graph 自身**（WINDOW_PLAN §3）。
 *
 * **既定は空撃ち。** 実際に署名・送信するのは `--live` を明示したときだけで、
 * それは人間の判断として残す。空撃ちでは
 *   - 「何に署名するはずだったか」を**本物の 402 から取って**映す
 *   - **署名器に到達しない**（`payOrRefuse` を呼ばないので、支払いモジュールは読み込まれない）
 * `test/pay.test.mjs` が、ALLOW まで到達できる世界でも空撃ちが署名しないことと、
 * `--live` なら同じハーネスで `signTypedData` がちょうど1回参照されることを両方固定する。
 */
import { readSubgraphReceipts, X402_BASE_SUBGRAPH_ID } from "../../../packages/sdk/dist/index.js";
import type { Emitter } from "./emit.ts";
import { renderPayDryRun, type PayView } from "./render.ts";
import {
  VET402_API,
  computeResourceId,
  instrument,
  selectPayableAccept,
  readChallenge,
  readJson,
  requireEnv,
} from "./probe.ts";

/**
 * SDK が認可に切る窓（秒）。**手で書いた数字は必ず古くなる**ので、
 * `test/pay.test.mjs` が `packages/sdk/dist/x402-pay.js` の実装値と突き合わせる。
 */
export const SDK_AUTHORIZATION_WINDOW_SECONDS = 120;

/** 払う先。The Graph 本体の x402 口（WINDOW_PLAN §3 / §15）。 */
export const PAY_TARGET = {
  method: "POST",
  url: `https://gateway.thegraph.com/api/x402/subgraphs/id/${X402_BASE_SUBGRAPH_ID}`,
  payee: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
  amountUsd: 0.01,
  body: '{"query":"{ _meta { block { number } } }"}',
} as const;

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * **払うときの規則。空撃ちの画も `--live` も、同じこの1つを使う。**
 *
 * 分けて書くと、画に出した規則と本当に効いた規則が別物になり得る——それは動画の嘘になる。
 *
 * `requireVet402Allow: false` の理由（WINDOW_PLAN §3.2・本番実測）:
 * 支払い先の The Graph `0x79DC34E4…FcCB` は我々のエンジンで **69 / WARN / thin**。
 * 受領 0・独立 payer 0・L1 配達 0——**我々が一度も買っていない**からで、
 * The Graph が危ないからではない。同じアドレスについて The Graph 自身の subgraph は
 * 253 件の受領を知っている。だから vet402 の判定を外し、**代わりに第三者のデータで床を置く**。
 *
 * `minSubgraphReceipts: 1` が実際に判定している床。`minL1Deliveries: 0` は
 * **床ではなく読取の宣言**（`source: "both"` で自社台帳も読み、決定行に別の行として残すため）。
 * SDK は 1 以上の床が1つも無ければ `invalid_policy` で落とすので、
 * ここから `minSubgraphReceipts` を消すと、**空撃ちより前に呼び出し側エラーになる**。
 */
export const PAY_POLICY = {
  requireVet402Allow: false as const,
  evidence: { source: "both" as const, minL1Deliveries: 0, minSubgraphReceipts: 1 },
};

export type PayerAccount = { address: string; signTypedData: (typed: unknown) => Promise<string> };

export type RunPayOptions = {
  live: boolean;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  emit: Emitter;
  /** 渡さず `--live` のときだけ `DEMO_PAYER_PRIVATE_KEY` から作る。空撃ちでは使わない。 */
  account?: PayerAccount;
  color?: boolean;
};

function gate(name: string, verdict: "pass" | "fail" | "unknown", detail: string) {
  return { name, verdict, detail };
}

export async function runPay(options: RunPayOptions): Promise<{ view: PayView; result: unknown | null }> {
  const needed = ["GRAPH_API_KEY", "VOUCH_API_KEY"];
  if (options.live && options.account === undefined) needed.push("DEMO_PAYER_PRIVATE_KEY");
  requireEnv(options.env, needed);

  const net = instrument(options.fetch);
  const apiKey = options.env.VOUCH_API_KEY;
  const graphApiKey = options.env.GRAPH_API_KEY;

  // --- 読むだけ。ここで判定はしない ---
  const challenge = await readChallenge(net.fetch, PAY_TARGET.method, PAY_TARGET.url, PAY_TARGET.body);
  const accept = challenge ? (selectPayableAccept(challenge.accepts) as PayView["accept"]) : null;

  const resourceId = await computeResourceId(PAY_TARGET.method, PAY_TARGET.url);
  const decision = await readJson(net.fetch, `${VET402_API}/resources/${resourceId}/decision?role=payer`, apiKey);

  const payTo = (accept?.payTo ?? PAY_TARGET.payee) as string;
  const score = await readJson(net.fetch, `${VET402_API}/payees/${payTo}/score`, apiKey);
  const scoreBody = score.status === 200 ? (score.body as { recommendation?: string; score?: number; degraded?: boolean }) : null;

  const read = await readSubgraphReceipts({
    address: PAY_TARGET.payee,
    fetch: net.fetch,
    apiKey: graphApiKey,
    subgraphId: X402_BASE_SUBGRAPH_ID,
  });
  const rawSummary = (net.subgraphRaw as { data?: { x402AddressSummaries?: unknown[] } } | undefined)?.data
    ?.x402AddressSummaries?.[0] as PayView["subgraph"] extends null ? never : { role: string; totalPayments: string; totalVolumeDecimal: string } | undefined;

  const view: PayView = {
    live: options.live,
    policy: {
      requireVet402Allow: PAY_POLICY.requireVet402Allow,
      floors: [
        { floor: "minL1Deliveries", source: "vet402", required: PAY_POLICY.evidence.minL1Deliveries },
        { floor: "minSubgraphReceipts", source: "subgraph", required: PAY_POLICY.evidence.minSubgraphReceipts },
      ],
    },
    acceptsOffered: challenge?.accepts.length ?? 0,
    target: { method: PAY_TARGET.method, url: PAY_TARGET.url },
    expectedPayTo: PAY_TARGET.payee,
    amountUsd: PAY_TARGET.amountUsd,
    ranAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    accept,
    x402Version: challenge?.x402Version ?? 2,
    authorizationWindowSeconds: SDK_AUTHORIZATION_WINDOW_SECONDS,
    payeeScore: scoreBody
      ? {
          recommendation: String(scoreBody.recommendation ?? "—"),
          score: typeof scoreBody.score === "number" ? scoreBody.score : null,
          degraded: scoreBody.degraded === true,
        }
      : null,
    decisionStatus: decision.status,
    subgraph: read.ok
      ? {
          endpoint: read.publicUrl,
          block: read.block,
          deployment: read.deployment,
          row: rawSummary ?? null,
        }
      : null,
    gates: [],
    envReady: {
      GRAPH_API_KEY: typeof options.env.GRAPH_API_KEY === "string" && options.env.GRAPH_API_KEY !== "",
      VOUCH_API_KEY: typeof options.env.VOUCH_API_KEY === "string" && options.env.VOUCH_API_KEY !== "",
      DEMO_PAYER_PRIVATE_KEY:
        typeof options.env.DEMO_PAYER_PRIVATE_KEY === "string" && options.env.DEMO_PAYER_PRIVATE_KEY !== "",
    },
  };

  // 読み取り値どうしの突き合わせ。**拘束力を持つ関門は payOrRefuse の中**にあり、
  // ここはその予告（撮影前に「今日払えるか」を目で確かめるためのもの）。
  const units = Number(accept?.amount);
  view.gates = [
    gate(
      "payTo == expected",
      accept ? (String(accept.payTo).toLowerCase() === PAY_TARGET.payee.toLowerCase() ? "pass" : "fail") : "unknown",
      accept ? String(accept.payTo) : "402 not read",
    ),
    gate(
      "chain + asset are Base USDC",
      accept
        ? accept.network === "eip155:8453" && String(accept.asset).toLowerCase() === BASE_USDC.toLowerCase() && accept.scheme === "exact"
          ? "pass"
          : "fail"
        : "unknown",
      accept ? `${accept.network} ${accept.scheme}` : "402 not read",
    ),
    gate(
      "amount <= ceiling",
      Number.isFinite(units) ? (units / 1e6 <= PAY_TARGET.amountUsd ? "pass" : "fail") : "unknown",
      Number.isFinite(units) ? `${units} units = $${(units / 1e6).toFixed(2)}` : "402 not read",
    ),
    gate(
      "EIP-712 domain is pinned USDC",
      accept
        ? (accept.extra?.name === undefined || accept.extra?.name === "USD Coin") &&
          (accept.extra?.version === undefined || accept.extra?.version === "2")
          ? "pass"
          : "fail"
        : "unknown",
      accept ? JSON.stringify({ name: accept.extra?.name, version: accept.extra?.version }) : "402 not read",
    ),
    gate(
      "subgraph evidence is live",
      read.ok ? "pass" : "fail",
      read.ok ? `block ${read.block.number}, ${read.receipts} receipts` : `not read (${read.error})`,
    ),
    // **免除した判定も関門として残す。** 消すと「見なかったこと」になり、
    // 何を免除したのかが画から読めなくなる。`waived` は「見たうえで通す」の印。
    gate(
      "payee verdict is ALLOW",
      scoreBody
        ? scoreBody.recommendation === "ALLOW"
          ? "pass"
          : PAY_POLICY.requireVet402Allow
            ? "fail"
            : "waived"
        : "unknown",
      scoreBody
        ? `${scoreBody.recommendation} (${scoreBody.score ?? "—"})` +
          (scoreBody.recommendation === "ALLOW" || PAY_POLICY.requireVet402Allow
            ? ""
            : " — not required by policy")
        : "score not read",
    ),
    // 免除の代わりに置いた床。**これが実際に判定している。**
    gate(
      // 関門の名前は 32 桁に収める（`render.ts` が padEnd で桁を揃えるので、超えると画が崩れる）。
      `evidence floor: subgraph >= ${PAY_POLICY.evidence.minSubgraphReceipts}`,
      read.ok ? (read.receipts >= PAY_POLICY.evidence.minSubgraphReceipts ? "pass" : "fail") : "unknown",
      read.ok
        ? `${read.receipts} receipts (need ${PAY_POLICY.evidence.minSubgraphReceipts})`
        : `subgraph not read (${read.error})`,
    ),
  ];
  // 402 は読めたが、払える accept が1件も無い——「読めなかった」とは別の所見なので分けて出す。
  if (challenge && accept === null) {
    view.gates.unshift(
      gate("no acceptable accept in 402", "fail", `${challenge.accepts.length} offered, none is Base USDC exact/eip3009`),
    );
  }

  options.emit.lines(renderPayDryRun(view, { color: options.color === true }));

  if (!options.live) return { view, result: null };

  // --- ここから先だけが支払い。**`--live` を明示したときにしか評価されない** ---
  const account = options.account ?? (await accountFromEnv(options.env));
  const { payOrRefuse } = await import("../../../packages/sdk/dist/index.js");
  const result = await payOrRefuse({
    payee: PAY_TARGET.payee,
    resource: PAY_TARGET.url,
    method: PAY_TARGET.method,
    amountUsd: PAY_TARGET.amountUsd,
    account,
    fetch: net.fetch,
    apiKey,
    source: "agent-demo",
    // **空撃ちの画と同じ規則**。ここで別の値を書いた瞬間、映っているものが嘘になる。
    policy: {
      maxPerTxUsd: PAY_TARGET.amountUsd,
      requireVet402Allow: PAY_POLICY.requireVet402Allow,
      evidence: { ...PAY_POLICY.evidence, graphApiKey },
    },
  });
  options.emit.line("");
  options.emit.line(
    ` payOrRefuse   status=${result.status}   signed=${result.signed}   attested=${result.attested}`,
  );
  options.emit.line(` reasons       ${result.decision.reason_codes.join(", ") || "(none)"}`);
  options.emit.line(` verdict from  ${result.decision.verdict_source}`);
  const override = result.decision.policy_override;
  if (override) {
    options.emit.line(
      ` allowed by    ${override.rule} — waived ${override.waived.source} ${override.waived.recommendation}` +
        `${override.waived.score === null ? "" : ` (${override.waived.score})`}`,
    );
    for (const f of override.floors_met) {
      options.emit.line(` floor met     ${f.floor} (${f.source}) ${f.required} <= ${f.observed}`);
    }
  }
  options.emit.line(` nonce         ${result.nonce ?? "null"}`);
  options.emit.line(` txHash        ${result.txHash ?? "null"}`);
  if (result.txHash) options.emit.line(` basescan      https://basescan.org/tx/${result.txHash}`);
  return { view, result };
}

/** `--live` のときだけ呼ぶ。鍵は環境からしか読まない。 */
async function accountFromEnv(env: Record<string, string | undefined>): Promise<PayerAccount> {
  const key = env.DEMO_PAYER_PRIVATE_KEY as string;
  let privateKeyToAccount: (key: `0x${string}`) => PayerAccount;
  try {
    ({ privateKeyToAccount } = (await import("viem/accounts")) as unknown as {
      privateKeyToAccount: (key: `0x${string}`) => PayerAccount;
    });
  } catch {
    throw new Error(
      "viem is required for --live. Run `npm install viem` inside examples/ethonline-2026-demo/ first.",
    );
  }
  return privateKeyToAccount(key as `0x${string}`);
}
