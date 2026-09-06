/**
 * `pay` —— 台本 1:30–2:05。**払う先は The Graph 自身**（WINDOW_PLAN §3）。
 *
 * **既定は空撃ち。** 実際に署名・送信するのは `--live` を明示したときだけで、
 * それは人間の判断として残す。空撃ちでは
 *   - 「何に署名するはずだったか」を**本物の 402 から取って**映す
 *   - **署名器に到達しない**（`payOrRefuse` を呼ばないので、支払いモジュールは読み込まれない）
 * `test/pay.test.mjs` が、ALLOW まで到達できる世界でも空撃ちが署名しないことと、
 * `--live` なら同じハーネスで `signTypedData` がちょうど1回参照されることを両方固定する。
 *
 * 読み取りと関門表は `./assess.ts`（`judge` と共有）。ここにあるのは The Graph 固定の相手と、
 * `--live` の枝だけ。
 */
import { X402_BASE_SUBGRAPH_ID } from "../../../packages/sdk/dist/index.js";
import { assess, SDK_AUTHORIZATION_WINDOW_SECONDS } from "./assess.ts";
import type { Emitter } from "./emit.ts";
import { renderPayDryRun, type PayView } from "./render.ts";
import { instrument, probeChallenge, requireEnv } from "./probe.ts";

export { SDK_AUTHORIZATION_WINDOW_SECONDS };

/** 払う先。The Graph 本体の x402 口（WINDOW_PLAN §3 / §15）。 */
export const PAY_TARGET = {
  method: "POST",
  url: `https://gateway.thegraph.com/api/x402/subgraphs/id/${X402_BASE_SUBGRAPH_ID}`,
  payee: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
  amountUsd: 0.01,
  body: '{"query":"{ _meta { block { number } } }"}',
} as const;

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

const PAY_ENV_NAMES = ["GRAPH_API_KEY", "VOUCH_API_KEY", "DEMO_PAYER_PRIVATE_KEY"] as const;

export async function runPay(options: RunPayOptions): Promise<{ view: PayView; result: unknown | null }> {
  const needed = ["GRAPH_API_KEY", "VOUCH_API_KEY"];
  if (options.live && options.account === undefined) needed.push("DEMO_PAYER_PRIVATE_KEY");
  requireEnv(options.env, needed);

  const net = instrument(options.fetch);
  const apiKey = options.env.VOUCH_API_KEY;
  const graphApiKey = options.env.GRAPH_API_KEY;

  // --- 読むだけ。ここで判定はしない ---
  const probe = await probeChallenge(net.fetch, PAY_TARGET.method, PAY_TARGET.url, PAY_TARGET.body);
  // 相手は固定なので、繋がらないのは想定外——原因を隠さずスタックごと出す。
  if (probe.error !== null) throw new Error(probe.error);
  const { view } = await assess({
    target: {
      method: PAY_TARGET.method,
      url: PAY_TARGET.url,
      body: PAY_TARGET.body,
      expectedPayee: PAY_TARGET.payee,
      ceilingUsd: PAY_TARGET.amountUsd,
    },
    policy: PAY_POLICY,
    env: options.env,
    net,
    probe,
    envNames: PAY_ENV_NAMES,
    mode: "pay",
    live: options.live,
  });

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
