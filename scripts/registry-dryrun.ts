// ============================================================
// ERC-8004 Validation Registry 書込の dry-run（読み取り専用・2026-09-02 是正）。
//
// 「今 REGISTRY_WRITES_ENABLED=true にしたら、直近 24h に確定した購入のうち
//  何件・どの endpoint がチェーンへ向かい、ガスは幾らか」を出す。
// 門は registry-hook と 1:1（settled/refuted 確定 → not_evm → duplicate → tier →
// daily_cap）。agent 解決（no_agent）は索引テーブル（agents / owner_agents）で
// 目安を付ける。残高は --operator 0x... を渡した時だけ見る（鍵は読まない）。
//
// 何をしないか（設計で封じる）:
//  - 鍵を読まない・walletClient を作らない・署名しない・送信しない
//  - env を変えない。REGISTRY_WRITES_ENABLED が何であっても読むだけ
//  - DB へ INSERT/UPDATE しない（registry-hook / publishValidation を import しない）
//
// 使い方:
//   DATABASE_URL=postgresql://... npm run registry:dryrun                 # 24h
//   DATABASE_URL=... npm run registry:dryrun -- --hours 72 --out path.json --operator 0x...
//   任意: BASE_RPC_URL / REGISTRY_MAX_FEE_GWEI / REGISTRY_WRITE_TIERS / REGISTRY_DAILY_MAX_WRITES / REGISTRY_MIN_BALANCE_WEI
// ============================================================
import * as fs from "node:fs";
import * as path from "node:path";
import { createPublicClient, encodeFunctionData, http, isAddress, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db/client";
import { ERC8004_ADDRESSES } from "../src/lib/chain/config";
import { loadCoverageTiers, parseRegistryWriteTiers } from "../src/lib/observatory/coverage";
import { countRegistryWritesToday } from "../src/lib/chain/registry";
import {
  capGweiToWei,
  DEFAULT_MAX_FEE_GWEI,
  estimateWriteCostWei,
  FIXED_FALLBACK_GAS,
  formatWeiAsEth,
  planRegistryWrites,
  selectGasUnits,
  wouldSkipForGasCap,
  HOOK_OUTCOME_STATUSES,
  type VerifiedPurchaseRowLike,
} from "../src/lib/chain/registry-dryrun";

// registry.ts と同じ ABI 文字列（書込経路の関数は import しない）。
const validationRegistryAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external",
]);

/** 署名しないので鍵は不要。見積もりの from には資金ゼロのダミーを使う（eth_estimateGas は残高を見ない）。 */
const DRY_RUN_FROM: Address = "0x000000000000000000000000000000000000dEaD";
const SAMPLE_HASH = `0x${"11".repeat(32)}` as `0x${string}`;
const SAMPLE_EVIDENCE_URI = "https://vet402.com/observatory/e/00000000-0000-0000-0000-000000000000";
const DEFAULT_DAILY_MAX = 200;
const DEFAULT_MIN_BALANCE_WEI = 500_000_000_000_000n;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const unwrap = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).split("\n").slice(0, 3).join(" | ").slice(0, 400);

type RpcEstimate = {
  rpc_url_host: string;
  request_gas: bigint | null;
  request_gas_error: string | null;
  response_gas: bigint | null;
  response_gas_error: string | null;
  request_l1_fee_wei: bigint | null;
  response_l1_fee_wei: bigint | null;
  l1_fee_error: string | null;
  max_fee_per_gas_wei: bigint | null;
  fees_error: string | null;
  operator_balance_wei: bigint | null;
  operator_balance_error: string | null;
};

async function readRpc(operator: Address | null): Promise<RpcEstimate> {
  const rpcUrl = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }) }).extend(publicActionsL2());
  const reqData = encodeFunctionData({
    abi: validationRegistryAbi,
    functionName: "validationRequest",
    args: [DRY_RUN_FROM, 1n, SAMPLE_EVIDENCE_URI, SAMPLE_HASH],
  });
  const resData = encodeFunctionData({
    abi: validationRegistryAbi,
    functionName: "validationResponse",
    args: [SAMPLE_HASH, 100, SAMPLE_EVIDENCE_URI, SAMPLE_HASH, "vet402:l1"],
  });
  const out: RpcEstimate = {
    rpc_url_host: new URL(rpcUrl).host,
    request_gas: null,
    request_gas_error: null,
    response_gas: null,
    response_gas_error: null,
    request_l1_fee_wei: null,
    response_l1_fee_wei: null,
    l1_fee_error: null,
    max_fee_per_gas_wei: null,
    fees_error: null,
    operator_balance_wei: null,
    operator_balance_error: null,
  };
  const to = ERC8004_ADDRESSES.validationRegistry;
  try {
    out.request_gas = await client.estimateGas({ account: DRY_RUN_FROM, to, data: reqData });
  } catch (e) {
    out.request_gas_error = errMsg(e);
  }
  try {
    out.response_gas = await client.estimateGas({ account: DRY_RUN_FROM, to, data: resData });
  } catch (e) {
    out.response_gas_error = errMsg(e);
  }
  try {
    out.request_l1_fee_wei = await client.estimateL1Fee({ account: DRY_RUN_FROM, to, data: reqData });
    out.response_l1_fee_wei = await client.estimateL1Fee({ account: DRY_RUN_FROM, to, data: resData });
  } catch (e) {
    out.l1_fee_error = errMsg(e);
  }
  try {
    const fees = await client.estimateFeesPerGas();
    out.max_fee_per_gas_wei = fees.maxFeePerGas ?? (await client.getGasPrice());
  } catch (e) {
    out.fees_error = errMsg(e);
  }
  if (operator) {
    try {
      out.operator_balance_wei = await client.getBalance({ address: operator });
    } catch (e) {
      out.operator_balance_error = errMsg(e);
    }
  }
  return out;
}

type PurchaseRow = {
  id: string;
  endpoint_id: string;
  status: string;
  pay_to: string | null;
  network: string | null;
  tx_hash: string | null;
  l2_schema: string | null;
  settlement_verified_at: string | Date;
  resource_url: string | null;
};

async function readDb(hours: number) {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not configured");
  const dbName = unwrap<{ db: string }>(await db.execute(sql`SELECT current_database() AS db`))[0]?.db ?? null;

  const purchases = unwrap<PurchaseRow>(
    await db.execute(sql`
      SELECT pu.id::text AS id, pu.endpoint_id::text AS endpoint_id, pu.status, pu.pay_to, pu.network, pu.tx_hash, pu.l2_schema,
             pu.settlement_verified_at, e.resource_url
      FROM x402_l1_purchases pu
      LEFT JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE pu.settlement_verified_at >= now() - make_interval(hours => ${hours})
        AND pu.status IN ('settled', 'settle_claim_refuted', 'settle_claimed')
      ORDER BY pu.settlement_verified_at ASC
    `),
  );
  const rows: VerifiedPurchaseRowLike[] = purchases.map((r) => ({
    purchaseRowId: r.id,
    endpointId: r.endpoint_id,
    status: r.status,
    payTo: r.pay_to,
    network: r.network,
    txHash: r.tx_hash,
    l2Schema: r.l2_schema,
    settlementVerifiedAt: new Date(r.settlement_verified_at),
  }));
  const urlOf = new Map(purchases.map((r) => [r.endpoint_id, r.resource_url]));

  const tiers = await loadCoverageTiers([...new Set(rows.map((r) => r.endpointId))]);
  const existing = new Set(
    unwrap<{ request_hash: string }>(await db.execute(sql`SELECT request_hash FROM registry_writes`)).map((r) => r.request_hash),
  );
  const writesToday = await countRegistryWritesToday();
  const ledger = unwrap<{ status: string; n: number | string }>(
    await db.execute(sql`SELECT status, count(*)::int AS n FROM registry_writes GROUP BY status`),
  );

  // agent 解決の目安（索引テーブル）。hook の resolveAgentIdByWallet はチェーンを読むので実数はこれと違い得る。
  const payees = [...new Set(rows.map((r) => r.payTo).filter((p): p is string => !!p && /^0x[0-9a-fA-F]{40}$/.test(p)).map((p) => p.toLowerCase()))];
  const indexed = new Set<string>();
  if (payees.length > 0) {
    const hits = unwrap<{ w: string }>(
      await db.execute(sql`
        SELECT lower(wallet) AS w FROM agents WHERE lower(wallet) IN ${payees}
        UNION
        SELECT lower(owner) AS w FROM owner_agents WHERE lower(owner) IN ${payees}
      `),
    );
    for (const h of hits) if (h.w) indexed.add(h.w);
  }
  const payToOf = new Map(rows.map((r) => [r.purchaseRowId, r.payTo]));

  return { dbName, rows, tiers, existing, writesToday, ledger, indexed, urlOf, payToOf };
}

function jsonReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

async function main() {
  const hours = Number(arg("hours") ?? 24);
  if (!Number.isInteger(hours) || hours <= 0) throw new Error("--hours must be a positive integer");
  const operatorArg = arg("operator");
  if (operatorArg && !isAddress(operatorArg)) throw new Error("--operator must be an EVM address");
  const operator = (operatorArg ?? null) as Address | null;
  const capEnv = process.env.REGISTRY_MAX_FEE_GWEI;
  const capGwei = Number(capEnv ?? DEFAULT_MAX_FEE_GWEI);
  const allowedTiers = parseRegistryWriteTiers(process.env.REGISTRY_WRITE_TIERS);
  const dailyMax = Number(process.env.REGISTRY_DAILY_MAX_WRITES ?? DEFAULT_DAILY_MAX);
  const minBalanceWei = /^\d+$/.test(process.env.REGISTRY_MIN_BALANCE_WEI ?? "") ? BigInt(process.env.REGISTRY_MIN_BALANCE_WEI!) : DEFAULT_MIN_BALANCE_WEI;

  const [dbRead, rpc] = await Promise.all([readDb(hours), readRpc(operator)]);
  const plan = planRegistryWrites(dbRead.rows, {
    allowedTiers,
    tierOf: dbRead.tiers,
    existingHashes: dbRead.existing,
    dailyMax,
    writesToday: dbRead.writesToday,
  });

  const reqGas = selectGasUnits({ estimated: rpc.request_gas, observedMedian: null, fixed: FIXED_FALLBACK_GAS.validationRequest });
  const resGas = selectGasUnits({ estimated: rpc.response_gas, observedMedian: null, fixed: FIXED_FALLBACK_GAS.validationResponse });
  const l1Req = rpc.request_l1_fee_wei ?? 0n;
  const l1Res = rpc.response_l1_fee_wei ?? 0n;
  const capWei = capGweiToWei(capGwei);
  const perWriteAtCap = estimateWriteCostWei({ requestGas: reqGas.units, responseGas: resGas.units, feePerGasWei: capWei, requestL1FeeWei: l1Req, responseL1FeeWei: l1Res });
  const nowFee = rpc.max_fee_per_gas_wei;
  const perWriteNow = nowFee === null ? null : estimateWriteCostWei({ requestGas: reqGas.units, responseGas: resGas.units, feePerGasWei: nowFee, requestL1FeeWei: l1Req, responseL1FeeWei: l1Res });
  const n = BigInt(plan.writes.length);
  const totalAtCap = n * perWriteAtCap.total_wei;
  const totalNow = perWriteNow ? n * perWriteNow.total_wei : null;

  const withIndexedAgent = plan.writes.filter((w) => {
    const p = dbRead.payToOf.get(w.purchaseRowId);
    return !!p && dbRead.indexed.has(p.toLowerCase());
  }).length;

  const balance = rpc.operator_balance_wei;
  const report = {
    generated_at: new Date().toISOString(),
    mode: "dry-run (read-only: no key loaded, no tx signed or sent, no env changed, no DB write)",
    window_hours: hours,
    env: {
      REGISTRY_WRITES_ENABLED: process.env.REGISTRY_WRITES_ENABLED === "true",
      REGISTRY_WRITE_TIERS: [...allowedTiers].sort(),
      REGISTRY_DAILY_MAX_WRITES: dailyMax,
      REGISTRY_MAX_FEE_GWEI: capGwei,
      REGISTRY_MIN_BALANCE_WEI: minBalanceWei,
    },
    database: { name: dbRead.dbName, registry_writes_by_status: Object.fromEntries(dbRead.ledger.map((r) => [r.status, Number(r.n)])), writes_today_utc: dbRead.writesToday },
    if_enabled_now: {
      verified_rows_in_window: dbRead.rows.length,
      final_statuses_that_fire: HOOK_OUTCOME_STATUSES,
      writes: plan.writes.length,
      writes_l1: plan.writes.filter((w) => w.level === "l1").length,
      writes_l2: plan.writes.filter((w) => w.level === "l2").length,
      writes_pass: plan.writes.filter((w) => w.verdict === "pass").length,
      writes_fail: plan.writes.filter((w) => w.verdict === "fail").length,
      writes_with_indexed_agent: withIndexedAgent,
      skipped: plan.skipped,
      by_endpoint: plan.byEndpoint
        .map((e) => ({ ...e, resource_url: dbRead.urlOf.get(e.endpointId) ?? null }))
        .sort((a, b) => b.writes - a.writes),
      writes_detail: plan.writes.map((w) => ({ ...w, resource_url: dbRead.urlOf.get(w.endpointId) ?? null })),
      note: "writes = 門を通る件数（tier / duplicate / daily_cap まで）。hook はさらに no_agent（payTo が ERC-8004 agent に解決できない）・balance_low・gas_over_cap で退くので、実数は writes_with_indexed_agent 以下が目安。",
    },
    gas: {
      chain: "base (eip155:8453)",
      rpc_url_host: rpc.rpc_url_host,
      validation_request: { gas_units: reqGas.units, source: reqGas.source, estimate_error: rpc.request_gas_error },
      validation_response: { gas_units: resGas.units, source: resGas.source, estimate_error: rpc.response_gas_error },
      l1_data_fee_wei: { request: l1Req, response: l1Res, error: rpc.l1_fee_error },
      current_max_fee_per_gas_wei: nowFee,
      fees_error: rpc.fees_error,
      would_skip_for_gas_cap_now: nowFee === null ? null : wouldSkipForGasCap(nowFee, capEnv),
      per_write_at_cap: { ...perWriteAtCap, total_eth: formatWeiAsEth(perWriteAtCap.total_wei) },
      per_write_at_current_fee: perWriteNow ? { ...perWriteNow, total_eth: formatWeiAsEth(perWriteNow.total_wei) } : null,
      total_for_planned_writes: {
        writes: plan.writes.length,
        at_cap_wei: totalAtCap,
        at_cap_eth: formatWeiAsEth(totalAtCap),
        at_current_fee_wei: totalNow,
        at_current_fee_eth: totalNow === null ? null : formatWeiAsEth(totalNow),
      },
    },
    operator: operator
      ? {
          address: operator,
          balance_wei: balance,
          balance_eth: balance === null ? null : formatWeiAsEth(balance),
          min_balance_wei: minBalanceWei,
          would_skip_for_balance_low: balance === null ? null : balance < minBalanceWei,
          writes_affordable_at_cap: balance === null || perWriteAtCap.total_wei === 0n ? null : Number(balance / perWriteAtCap.total_wei),
          error: rpc.operator_balance_error,
        }
      : { address: null, note: "--operator 0x... を渡すと残高と balance_low 判定を出す（鍵は読まない）" },
    units: "wei は10進文字列（丸めなし）。eth は18桁固定小数。",
  };

  const json = JSON.stringify(report, jsonReplacer, 2);
  const outPath = arg("out");
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json + "\n");
  }
  console.log(json);
  console.log(
    `\n[registry:dryrun] 直近${hours}h: 確定行 ${dbRead.rows.length} → 書込 ${plan.writes.length} 件 ` +
      `(L1 ${report.if_enabled_now.writes_l1} / L2 ${report.if_enabled_now.writes_l2}・索引済み agent ${withIndexedAgent} 件・endpoint ${plan.byEndpoint.filter((e) => e.writes > 0).length}) | ` +
      `skip ${JSON.stringify(plan.skipped)} | ` +
      `1件 ${formatWeiAsEth(perWriteAtCap.total_wei)} ETH @cap ${capGwei}gwei (gas ${perWriteAtCap.gas_units_total} [${reqGas.source}/${resGas.source}]) | ` +
      `合計 ${formatWeiAsEth(totalAtCap)} ETH @cap | tiers=${[...allowedTiers].sort().join(",")} daily_max=${dailyMax} today=${dbRead.writesToday} | ` +
      `writes_enabled=${report.env.REGISTRY_WRITES_ENABLED}` +
      (operator ? ` | operator ${operator} balance=${balance === null ? "n/a" : formatWeiAsEth(balance)} ETH balance_low=${report.operator && "would_skip_for_balance_low" in report.operator ? report.operator.would_skip_for_balance_low : "n/a"}` : ""),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[registry:dryrun] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
