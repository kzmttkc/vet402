// ============================================================
// ERC-8004 Validation Registry への測定結果公開（Phase 1.3・既定OFF）。
//
// 正本: EIP-8004（2026-08-20取得）
//   validationRequest(address validatorAddress, uint256 agentId,
//                     string requestURI, bytes32 requestHash)
//   validationResponse(bytes32 requestHash, uint8 response,
//                      string responseURI, bytes32 responseHash, string tag)
//   response は 0..100（0 = failed / 100 = passed）。
//
// vet402 は validator として自分宛の request を出し、続けて response を
// 書く（自己開始の公開測定）。書ける対象は payee が ERC-8004 agent に
// 解決できるエンドポイントの測定だけ——レジストリの主語は agentId。
//
// 安全設計:
//  - REGISTRY_WRITES_ENABLED === "true" 以外は何もしない（ガス代が動く）
//  - 冪等: registry_writes.request_hash が一意。同じ測定は二度書かない
//  - graceful: ここが失敗しても検証フロー本体は止めない（呼び手が握る）
//  - ガスのサーキットブレーカ: maxFeePerGas が REGISTRY_MAX_FEE_GWEI
//    （既定 0.5 gwei・Base 水準）を超えたら書かずに退く
// ============================================================
import { keccak256, parseAbi, toBytes, type WalletClient } from "viem";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { registryWrites } from "@/lib/db/schema";
import { ERC8004_ADDRESSES } from "./config";

export const validationRegistryAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external",
]);

export function isRegistryWritesEnabled(): boolean {
  return process.env.REGISTRY_WRITES_ENABLED === "true";
}

/** requestKey（purchase_id 等）→ requestHash。buildValidationRecord と同じ式。 */
export function requestHashOf(requestKey: string): `0x${string}` {
  return keccak256(toBytes(requestKey));
}

/**
 * 冪等の先行判定（2026-09-02）: 同じ purchase_id（= request_hash）が台帳にあれば、
 * agent 解決や RPC に触れる前に退く。publishValidation の ON CONFLICT が最終防御。
 */
export async function hasRegistryWriteForHash(requestHash: `0x${string}`): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: registryWrites.id })
    .from(registryWrites)
    .where(eq(registryWrites.requestHash, requestHash))
    .limit(1);
  return rows.length > 0;
}

export function hasRegistryWriteForKey(requestKey: string): Promise<boolean> {
  return hasRegistryWriteForHash(requestHashOf(requestKey));
}

/** 日次上限の分母: 今日（UTC）に台帳へ入った全行（failed も含む——試みは試み）。 */
export async function countRegistryWritesToday(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const raw = await db.execute(sql`
    SELECT count(*)::int AS n FROM registry_writes
    WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  `);
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { n: number | string }[];
  return Number(rows[0]?.n ?? 0);
}

export type ValidationRecord = {
  endpointId: string;
  agentId: bigint;
  /**
   * l1 | l2 — 事実レベルのみ。L3(意見)はオンチェーンにも書かない。
   * 製品定義書 §11（2026-09-02）: L0 のみでは書かない（型からも外した）。
   */
  level: "l1" | "l2";
  verdict: "pass" | "fail";
  /** 公開証拠URI（/observatory/e/{id} 等）。 */
  evidenceUri: string;
  /** §11: subject は payee / agent / resource_hash。registry は agentId を話すので agent_id も併記。 */
  subject: { type: "payee" | "agent" | "resource_hash"; id: string };
  /** §11: result は 0-100 ではなく {level, verdict}。response（0/100）は ERC-8004 の語彙への写像。 */
  result: { level: "l1" | "l2"; verdict: "pass" | "fail" };
  /** §11: 証拠 JSON の keccak（第三者が同じ JSON から再計算できる）。 */
  hash: `0x${string}`;
  /** §11: requestHash は対応する purchase_id / observation_id から決定的に導く。 */
  requestHash: `0x${string}`;
  /** 由来（開示）。 */
  requestKey: string;
  response: number;
};

/**
 * 決定的な requestHash: 同じ (endpoint, agent, level, verdict, evidence) は
 * 常に同じ hash → 台帳の一意制約が冪等性になる。
 */
export function buildValidationRecord(input: {
  endpointId: string;
  agentId: bigint;
  level: "l1" | "l2";
  verdict: "pass" | "fail";
  evidenceUri: string;
  /** purchase_id（chain:tx_hash）または observation_id。無ければ endpoint+level+verdict から導く（互換）。 */
  requestKey?: string;
  subject?: { type: "payee" | "agent" | "resource_hash"; id: string };
}): ValidationRecord {
  if ((input.level as string) === "l0") {
    throw new Error("validation_record_l0_not_allowed"); // §11: L0 のみでは書かない
  }
  const subject = input.subject ?? { type: "agent" as const, id: String(input.agentId) };
  const evidence = {
    v: 2,
    endpointId: input.endpointId,
    agentId: String(input.agentId),
    subject,
    result: { level: input.level, verdict: input.verdict },
    evidenceUri: input.evidenceUri,
  };
  const hash = keccak256(toBytes(JSON.stringify(evidence)));
  const requestKey = input.requestKey ?? `${input.endpointId}:${input.level}:${input.verdict}`;
  return {
    endpointId: input.endpointId,
    agentId: input.agentId,
    level: input.level,
    verdict: input.verdict,
    evidenceUri: input.evidenceUri,
    subject,
    result: { level: input.level, verdict: input.verdict },
    hash,
    requestHash: keccak256(toBytes(requestKey)),
    requestKey,
    response: input.verdict === "pass" ? 100 : 0,
  };
}

const DEFAULT_MAX_FEE_GWEI = 0.5;

export type PublishOutcome =
  | { status: "disabled" }
  | { status: "duplicate" }
  | { status: "gas_over_cap"; maxFeeGwei: number }
  | { status: "submitted"; txHash: string }
  | { status: "failed"; error: string };

type MinimalWalletClient = Pick<WalletClient, "writeContract"> & {
  account: NonNullable<WalletClient["account"]>;
  chain: NonNullable<WalletClient["chain"]>;
};

/**
 * request → response の2トランザクションを送る。台帳に先に行を確保して
 * から送信（送ったのに記録が無い、を作らない——l1-runner.reserveSpend と
 * 同じ向きの規律）。
 */
export async function publishValidation(input: {
  record: ValidationRecord;
  walletClient: MinimalWalletClient;
  /** 現在の maxFeePerGas (wei)。呼び手が取得して渡す（テスト可能性）。 */
  currentMaxFeeWei: bigint;
}): Promise<PublishOutcome> {
  if (!isRegistryWritesEnabled()) return { status: "disabled" };
  const db = getDb();
  if (!db) return { status: "failed", error: "db_unavailable" };

  const capGwei = Number(process.env.REGISTRY_MAX_FEE_GWEI ?? DEFAULT_MAX_FEE_GWEI);
  const maxFeeGwei = Number(input.currentMaxFeeWei) / 1e9;
  if (maxFeeGwei > capGwei) return { status: "gas_over_cap", maxFeeGwei };

  const { record } = input;
  // 行の確保が冪等ゲート。既存 hash なら何も送らない。
  const inserted = await db.execute(sql`
    INSERT INTO registry_writes (request_hash, endpoint_id, agent_id, level, response, evidence_uri, status)
    VALUES (${record.requestHash}, ${record.endpointId}::uuid, ${String(record.agentId)},
            ${record.level}, ${record.response}, ${record.evidenceUri}, 'pending')
    ON CONFLICT (request_hash) DO NOTHING
    RETURNING id
  `);
  const rows = (Array.isArray(inserted) ? inserted : (inserted as { rows?: unknown[] }).rows ?? []) as {
    id: string;
  }[];
  if (rows.length === 0) return { status: "duplicate" };
  const ledgerId = rows[0].id;

  try {
    const { walletClient } = input;
    await walletClient.writeContract({
      address: ERC8004_ADDRESSES.validationRegistry,
      abi: validationRegistryAbi,
      functionName: "validationRequest",
      args: [walletClient.account.address, record.agentId, record.evidenceUri, record.requestHash],
      account: walletClient.account,
      chain: walletClient.chain,
    });
    const txHash = await walletClient.writeContract({
      address: ERC8004_ADDRESSES.validationRegistry,
      abi: validationRegistryAbi,
      functionName: "validationResponse",
      args: [record.requestHash, record.response, record.evidenceUri, record.hash, `vet402:${record.level}`],
      account: walletClient.account,
      chain: walletClient.chain,
    });
    await db
      .update(registryWrites)
      .set({ status: "submitted", txHash })
      .where(eq(registryWrites.id, ledgerId));
    return { status: "submitted", txHash };
  } catch (error) {
    const message = String(error).slice(0, 300);
    await db.update(registryWrites).set({ status: "failed" }).where(eq(registryWrites.id, ledgerId));
    return { status: "failed", error: message };
  }
}
