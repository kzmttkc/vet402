// ============================================================
// L1 実購入の結果を ERC-8004 Validation Registry へ流す配線（C4）。
//
// 呼び手は l1-runner の購入確定後。**graceful が絶対条件**——ここが何を
// 返そうと投げようと、購入の記帳（正典は x402_l1_purchases）には影響
// させない。フラグOFF（既定）の間は env を1つ読むだけで即帰る。
//
// 書けるのは payTo が ERC-8004 agent に解決できる購入だけ（レジストリの
// 主語は agentId）。解決できない・Solana・フラグOFFは全て no-op。
// 鍵は購入ウォレットと別（REGISTRY_OPERATOR_PRIVATE_KEY）——購入資金と
// ガス資金を同じ鍵に載せない。
// ============================================================
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { resolveAgentIdByWallet } from "./agent-resolver";
import { getPublicClient, isValidAddress } from "./client";
import {
  buildValidationRecord,
  isRegistryWritesEnabled,
  publishValidation,
  type PublishOutcome,
} from "./registry";
import { logServerError } from "@/lib/util/log";
import { payeeId, purchaseId } from "@/lib/ids/canonical";

export type L1OutcomeInput = {
  endpointId: string;
  payTo: string | null;
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
  | { status: "key_missing" };

/**
 * fire-and-forget用の実体。テストは戻り値で分岐を検証する。
 */
export async function publishL1OutcomeToRegistry(input: L1OutcomeInput): Promise<HookOutcome> {
  if (!isRegistryWritesEnabled()) return { status: "disabled" };
  if (!input.payTo || !input.payTo.startsWith("0x") || !isValidAddress(input.payTo)) {
    return { status: "not_evm" };
  }

  const rawPk = process.env.REGISTRY_OPERATOR_PRIVATE_KEY?.trim() ?? "";
  const pk = rawPk.startsWith("0x") ? rawPk : rawPk ? `0x${rawPk}` : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return { status: "key_missing" };

  const agentId = await resolveAgentIdByWallet(input.payTo);
  if (agentId === null) return { status: "no_agent" };

  const account = privateKeyToAccount(pk as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  });
  const fees = await getPublicClient().estimateFeesPerGas();

  const record = buildValidationRecord({
    endpointId: input.endpointId,
    agentId,
    level: "l1",
    verdict: input.settled ? "pass" : "fail",
    evidenceUri: `https://vet402.com/observatory/e/${input.endpointId}`,
    subject: { type: "payee", id: payeeId(input.network ?? "eip155:8453", input.payTo) },
    requestKey: input.txHash ? purchaseId(input.network ?? "eip155:8453", input.txHash) : undefined,
  });
  return publishValidation({
    record,
    walletClient: walletClient as never,
    currentMaxFeeWei: fees.maxFeePerGas ?? 0n,
  });
}

/**
 * l1-runner から呼ぶ版——**絶対に投げない**。
 *
 * 2026-08-22: 以前は fire-and-forget（void）だった。Vercel の関数は
 * レスポンス返却後に凍結するので、バッチ最後の候補の書き込みは静かに
 * 消える（フラグをONにした瞬間から、最後の1件だけレジストリに載らない）。
 * 返り値を await できる形にして、runL1Batch が末尾でまとめて待つ。
 * 待てるようになっても性質は同じ: rejection は起こさず、失敗は
 * logServerError に残るだけで購入の記帳（正典は x402_l1_purchases）には
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
 * §11（2026-09-02）: L2（適合）の確定時にも書く。C2 以上の L1/L2 確定時が頻度。
 * 失敗してもチェーン書き込みの状態は decision の registry ブロックで開示するだけで、
 * API 判定は出す。
 */
export async function publishL2OutcomeToRegistry(input: L2OutcomeInput): Promise<HookOutcome> {
  if (!isRegistryWritesEnabled()) return { status: "disabled" };
  if (!input.payTo || !input.payTo.startsWith("0x") || !isValidAddress(input.payTo)) {
    return { status: "not_evm" };
  }
  const rawPk = process.env.REGISTRY_OPERATOR_PRIVATE_KEY?.trim() ?? "";
  const pk = rawPk.startsWith("0x") ? rawPk : rawPk ? `0x${rawPk}` : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return { status: "key_missing" };
  const agentId = await resolveAgentIdByWallet(input.payTo);
  if (agentId === null) return { status: "no_agent" };
  const account = privateKeyToAccount(pk as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  });
  const fees = await getPublicClient().estimateFeesPerGas();
  const record = buildValidationRecord({
    endpointId: input.endpointId,
    agentId,
    level: "l2",
    verdict: input.l2 === "conform" ? "pass" : "fail",
    evidenceUri: `https://vet402.com/observatory/e/${input.endpointId}`,
    subject: { type: "payee", id: payeeId(input.network ?? "eip155:8453", input.payTo) },
    requestKey: input.txHash ? `${purchaseId(input.network ?? "eip155:8453", input.txHash)}:l2` : undefined,
  });
  return publishValidation({ record, walletClient: walletClient as never, currentMaxFeeWei: fees.maxFeePerGas ?? 0n });
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
