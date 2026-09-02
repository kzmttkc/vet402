// ============================================================
// 測定結果を ERC-8004 Validation Registry へ流す配線（C4）。
//
// 呼び手は settlement-verifier（2026-09-02 監査 P1-7）——オンチェーンで
// settled / settle_claim_refuted が**確定した後**だけ。購入直後の売り手の
// 自己申告（success:true）では呼ばない。**graceful が絶対条件**——ここが何を
// 返そうと投げようと、照合の記帳（正典は x402_l1_purchases）には影響
// させない。フラグOFF（既定）の間は env を1つ読むだけで即帰る。
//
// 書けるのは payTo が ERC-8004 agent に解決できる購入だけ（レジストリの
// 主語は agentId）。解決できない・Solana・フラグOFFは全て no-op。
// 鍵は購入ウォレットと別（REGISTRY_OPERATOR_PRIVATE_KEY）——購入資金と
// ガス資金を同じ鍵に載せない。
//
// 門（順に。前の門で退いたら後ろには触れない）:
//   disabled → not_evm → key_missing → duplicate（台帳・RPC なし）
//   → tier_excluded（REGISTRY_WRITE_TIERS・既定 C2,C3）
//   → daily_cap（REGISTRY_DAILY_MAX_WRITES・既定 200）
//   → no_agent（RPC）→ balance_low（REGISTRY_MIN_BALANCE_WEI・既定 0.0005 ETH・fail-loud）
//   → publishValidation（REGISTRY_MAX_FEE_GWEI と ON CONFLICT の最終防御）
// ============================================================
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { resolveAgentIdByWallet } from "./agent-resolver";
import { getPublicClient, isValidAddress } from "./client";
import {
  buildValidationRecord,
  countRegistryWritesToday,
  hasRegistryWriteForHash,
  isRegistryWritesEnabled,
  publishValidation,
  requestHashOf,
  type PublishOutcome,
} from "./registry";
import { loadCoverageTier, parseRegistryWriteTiers, type CoverageTier } from "@/lib/observatory/coverage";
import { logServerError } from "@/lib/util/log";
import { payeeId, purchaseId } from "@/lib/ids/canonical";

export const DEFAULT_REGISTRY_DAILY_MAX_WRITES = 200;
/** 0.0005 ETH。Base の 1 件（request+response）が cap 0.5 gwei で ~0.0003 ETH 未満なので 1 件分は必ず残る。 */
export const DEFAULT_REGISTRY_MIN_BALANCE_WEI = 500_000_000_000_000n;

export type L1OutcomeInput = {
  endpointId: string;
  payTo: string | null;
  /** settlement-verifier がチェーンで確定した値。true = settled、false = settle_claim_refuted。 */
  settled: boolean;
  /** §11: requestHash は purchase_id（chain:tx_hash）から導く。無ければ互換キー。 */
  txHash?: string | null;
  network?: string | null;
};

export type L2OutcomeInput = {
  endpointId: string;
  payTo: string | null;
  /** conform | mismatch のときだけ書く（undeclared / 未検査は書かない）。 */
  l2: "conform" | "mismatch";
  txHash?: string | null;
  network?: string | null;
};

export type HookOutcome =
  | PublishOutcome
  | { status: "not_evm" }
  | { status: "no_agent" }
  | { status: "key_missing" }
  | { status: "tier_excluded"; tier: CoverageTier }
  | { status: "daily_cap"; count: number; max: number }
  | { status: "balance_low"; balanceWei: string; minWei: string };

type MinimalWalletClient = Parameters<typeof publishValidation>[0]["walletClient"];

/** 差し替え点（テスト用）。本番は既定＝本物。viem・DB をここで切り離す。 */
export type RegistryHookDeps = {
  resolveTier?: (endpointId: string) => Promise<CoverageTier>;
  resolveAgentId?: (wallet: Address) => Promise<bigint | null>;
  hasExistingWrite?: (requestHash: `0x${string}`) => Promise<boolean>;
  countWritesToday?: () => Promise<number>;
  chain?: {
    estimateFees: () => Promise<bigint>;
    getBalance: (address: Address) => Promise<bigint>;
  };
  createWallet?: (privateKey: `0x${string}`) => MinimalWalletClient;
  publish?: typeof publishValidation;
};

const realDeps: Required<RegistryHookDeps> = {
  resolveTier: loadCoverageTier,
  resolveAgentId: resolveAgentIdByWallet,
  hasExistingWrite: hasRegistryWriteForHash,
  countWritesToday: countRegistryWritesToday,
  chain: {
    estimateFees: async () => (await getPublicClient().estimateFeesPerGas()).maxFeePerGas ?? 0n,
    getBalance: (address) => getPublicClient().getBalance({ address }),
  },
  createWallet: (privateKey) =>
    createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain: base,
      transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
    }) as never,
  publish: publishValidation,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function envBigint(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  return BigInt(raw);
}

function operatorKey(): `0x${string}` | null {
  const rawPk = process.env.REGISTRY_OPERATOR_PRIVATE_KEY?.trim() ?? "";
  const pk = rawPk.startsWith("0x") ? rawPk : rawPk ? `0x${rawPk}` : "";
  return /^0x[0-9a-fA-F]{64}$/.test(pk) ? (pk as `0x${string}`) : null;
}

async function publishOutcome(
  input: {
    endpointId: string;
    payTo: string | null;
    level: "l1" | "l2";
    verdict: "pass" | "fail";
    txHash?: string | null;
    network?: string | null;
  },
  overrides: RegistryHookDeps,
): Promise<HookOutcome> {
  if (!isRegistryWritesEnabled()) return { status: "disabled" };
  if (!input.payTo || !input.payTo.startsWith("0x") || !isValidAddress(input.payTo)) {
    return { status: "not_evm" };
  }
  const pk = operatorKey();
  if (!pk) return { status: "key_missing" };
  const deps = { ...realDeps, ...overrides };

  const network = input.network ?? "eip155:8453";
  const requestKey = input.txHash
    ? `${purchaseId(network, input.txHash)}${input.level === "l2" ? ":l2" : ""}`
    : undefined;

  // 冪等: 同じ purchase_id は 2 回書かない。台帳を先に引く（RPC・agent 解決の前）。
  if (requestKey && (await deps.hasExistingWrite(requestHashOf(requestKey)))) {
    return { status: "duplicate" };
  }

  // 階層: REGISTRY_WRITE_TIERS に入る endpoint だけ。
  const tier = await deps.resolveTier(input.endpointId);
  if (!parseRegistryWriteTiers(process.env.REGISTRY_WRITE_TIERS).has(tier)) {
    return { status: "tier_excluded", tier };
  }

  // 日次上限: 超えたら書かず、理由を残す。
  const max = envInt("REGISTRY_DAILY_MAX_WRITES", DEFAULT_REGISTRY_DAILY_MAX_WRITES);
  const count = await deps.countWritesToday();
  if (count >= max) {
    logServerError("registry.hook.daily_cap", `writes_today=${count} max=${max} endpoint=${input.endpointId}`);
    return { status: "daily_cap", count, max };
  }

  const agentId = await deps.resolveAgentId(input.payTo);
  if (agentId === null) return { status: "no_agent" };

  // ガス残高: 閾値未満なら書かず fail-loud（黙って failed を積まない）。
  const walletClient = deps.createWallet(pk);
  const minWei = envBigint("REGISTRY_MIN_BALANCE_WEI", DEFAULT_REGISTRY_MIN_BALANCE_WEI);
  const balanceWei = await deps.chain.getBalance(walletClient.account.address);
  if (balanceWei < minWei) {
    logServerError(
      "registry.hook.balance_low",
      `operator=${walletClient.account.address} balance_wei=${balanceWei} min_wei=${minWei} — fund the REGISTRY_OPERATOR key or lower REGISTRY_MIN_BALANCE_WEI`,
    );
    return { status: "balance_low", balanceWei: balanceWei.toString(), minWei: minWei.toString() };
  }

  const currentMaxFeeWei = await deps.chain.estimateFees();
  const record = buildValidationRecord({
    endpointId: input.endpointId,
    agentId,
    level: input.level,
    verdict: input.verdict,
    evidenceUri: `https://vet402.com/observatory/e/${input.endpointId}`,
    subject: { type: "payee", id: payeeId(network, input.payTo) },
    requestKey,
  });
  const out = await deps.publish({ record, walletClient, currentMaxFeeWei });
  if (out.status === "gas_over_cap") {
    logServerError("registry.hook.gas_over_cap", `max_fee_gwei=${out.maxFeeGwei} endpoint=${input.endpointId}`);
  }
  return out;
}

/**
 * fire-and-forget用の実体。テストは戻り値で分岐を検証する。
 */
export function publishL1OutcomeToRegistry(input: L1OutcomeInput, deps: RegistryHookDeps = {}): Promise<HookOutcome> {
  return publishOutcome(
    {
      endpointId: input.endpointId,
      payTo: input.payTo,
      level: "l1",
      verdict: input.settled ? "pass" : "fail",
      txHash: input.txHash,
      network: input.network,
    },
    deps,
  );
}

/**
 * settlement-verifier から呼ぶ版——**絶対に投げない**。
 *
 * 2026-08-22: 以前は fire-and-forget（void）だった。Vercel の関数は
 * レスポンス返却後に凍結するので、バッチ最後の候補の書き込みは静かに
 * 消える。返り値を await できる形にして、呼び手が末尾でまとめて待つ。
 * rejection は起こさず、失敗は logServerError に残るだけで照合の記帳には
 * 影響しない。
 */
export function fireL1RegistryHook(input: L1OutcomeInput): Promise<void> {
  // フラグOFFの通常運転で余計な作業をしない。
  if (!isRegistryWritesEnabled()) return Promise.resolve();
  return publishL1OutcomeToRegistry(input).then(
    () => undefined,
    (error) => {
      logServerError("registry.hook", error);
    },
  );
}

/**
 * §11（2026-09-02）: L2（適合）の確定時にも書く。settled 確定＋L2 conform/mismatch が条件。
 * 失敗してもチェーン書き込みの状態は decision の registry ブロックで開示するだけで、
 * API 判定は出す。
 */
export function publishL2OutcomeToRegistry(input: L2OutcomeInput, deps: RegistryHookDeps = {}): Promise<HookOutcome> {
  return publishOutcome(
    {
      endpointId: input.endpointId,
      payTo: input.payTo,
      level: "l2",
      verdict: input.l2 === "conform" ? "pass" : "fail",
      txHash: input.txHash,
      network: input.network,
    },
    deps,
  );
}

export function fireL2RegistryHook(input: L2OutcomeInput): Promise<void> {
  if (!isRegistryWritesEnabled()) return Promise.resolve();
  return publishL2OutcomeToRegistry(input).then(
    () => undefined,
    (error) => {
      logServerError("registry.hook.l2", error);
    },
  );
}
