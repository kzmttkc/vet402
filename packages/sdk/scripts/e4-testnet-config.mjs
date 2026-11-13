export const TESTNET_CHAIN_ID = 84532;
export const DEFAULT_RPC = "https://sepolia.base.org";
export const PRICE_UNITS = 10000n;
export const TOTAL_CAP_UNITS = 100000n;

/** Eight public testnet scenarios (runner and spend planning share this list). */
export const E4_TESTNET_SCENARIOS = [
  { id: "delivered", path: "/delivered", expect: "capture" },
  { id: "fail500", path: "/fail500", expect: "void" },
  { id: "empty200", path: "/empty200", expect: "void" },
  { id: "accepted202", path: "/accepted202", expect: "void" },
  { id: "official202", path: "/official202", expect: "operator_captured_undelivered" },
  { id: "ceiling_sdk", path: "/delivered", expect: "refused", policy: { maxPerTxUsd: 0.005 } },
  { id: "ceiling_chain", path: "/greedy", expect: "exceeds_max" },
  { id: "vanish_reclaim", path: "/vanish", expect: "reclaim", deliveryTimeoutMs: 20_000 },
];

export function assertTestnetChainId(id) {
  if (typeof id !== "number" || id !== TESTNET_CHAIN_ID) {
    throw new Error(`e4_testnet_wrong_chain: expected ${TESTNET_CHAIN_ID}, got ${String(id)}`);
  }
}

function rpcOriginForError(url) {
  try {
    return rpcOriginForRecord(url);
  } catch {
    return "unparseable";
  }
}

export function resolveConfig(env = process.env) {
  const rpc = env.E4_TESTNET_RPC ?? DEFAULT_RPC;
  if (!/^https?:\/\//.test(rpc)) {
    throw new Error(`e4_testnet_bad_rpc: ${rpcOriginForError(rpc)}`);
  }
  const buyerKeyFile = env.E4_BUYER_KEY_FILE;
  const operatorKeyFile = env.E4_OPERATOR_KEY_FILE;
  const outPath = env.E4_OUT;
  if (!buyerKeyFile) {
    throw new Error("e4_testnet_missing_env: E4_BUYER_KEY_FILE");
  }
  if (!operatorKeyFile) {
    throw new Error("e4_testnet_missing_env: E4_OPERATOR_KEY_FILE");
  }
  if (!outPath) {
    throw new Error("e4_testnet_missing_env: E4_OUT");
  }
  const reclaimWaitMaxSec = Number(env.E4_RECLAIM_WAIT_MAX_SEC ?? "420");
  if (!Number.isFinite(reclaimWaitMaxSec) || reclaimWaitMaxSec < 0) {
    throw new Error("e4_testnet_bad_env: E4_RECLAIM_WAIT_MAX_SEC");
  }
  const sellerPayTo = env.E4_SELLER_PAYTO?.trim() || null;
  return {
    rpc,
    buyerKeyFile,
    operatorKeyFile,
    outPath,
    sellerPayTo,
    reclaimWaitMaxSec,
  };
}

export function rpcOriginForRecord(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

export function readPrivateKeyFile(path, readFileSync) {
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`e4_testnet_bad_key_file: ${path} is not a 0x-prefixed 32-byte hex key`);
  }
  return raw;
}

export async function preflight(env, { fetchChainId, readKeyFile }) {
  const config = resolveConfig(env);
  const chainId = await fetchChainId(config.rpc);
  assertTestnetChainId(chainId);
  const buyerKey = readKeyFile(config.buyerKeyFile);
  const operatorKey = readKeyFile(config.operatorKeyFile);
  return { ...config, buyerKey, operatorKey, chainId };
}

export function assertSpendWithinCap(plannedUnits) {
  const units = BigInt(plannedUnits);
  if (units > TOTAL_CAP_UNITS) {
    throw new Error(`e4_testnet_spend_over_cap: planned ${units.toString()} > cap ${TOTAL_CAP_UNITS.toString()}`);
  }
}

export function plannedBuyerOutflowUnits(scenarios = E4_TESTNET_SCENARIOS) {
  let total = 0n;
  for (const s of scenarios) {
    if (s.expect === "capture" || s.expect === "operator_captured_undelivered") {
      total += PRICE_UNITS;
    }
  }
  return total;
}

export function assertNoSecretsInText(text, secrets) {
  const hay = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    const s = String(secret).trim();
    const variants = new Set([s, s.replace(/^0x/i, ""), s.toLowerCase(), s.toUpperCase()]);
    for (const v of variants) {
      if (v.length < 8) continue;
      if (hay.includes(v)) {
        throw new Error("e4_testnet_secret_in_output");
      }
      if (hay.toLowerCase().includes(v.toLowerCase())) {
        throw new Error("e4_testnet_secret_in_output");
      }
    }
  }
}

export function minEthWei(gasPriceWei, gasUnits) {
  return BigInt(gasPriceWei) * BigInt(gasUnits);
}
