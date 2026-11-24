#!/usr/bin/env node
/**
 * Etch sealed ledger day roots on Base mainnet (self-directed 0-value txs; calldata carries the root).
 * Broadcast runs off Vercel. POST /api/v1/observatory/anchors/tx registers the tx after confirmation.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  hexToString,
  http,
  parseEther,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const PREFIX = "vet402-anchor:v1";
const CHAIN_ID = 8453;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const maxN = Number(args.find((a, i) => args[i - 1] === "--max") ?? "1");
const maxGasEth = Number(args.find((a, i) => args[i - 1] === "--max-gas-eth") ?? "0.0005");

const apiBase = (process.env.VET402_API ?? "https://vet402.com").replace(/\/$/, "");
const rpcUrl = (process.env.ANCHOR_BASE_RPC_URL ?? "https://mainnet.base.org").trim();
const keyPath = (process.env.ANCHOR_BASE_KEY_FILE ?? "").trim();
const postSecret = (process.env.ANCHOR_POST_SECRET ?? "").trim();

function anchorMessage(day, rootHash) {
  return `${PREFIX}:${day}:${rootHash.toLowerCase()}`;
}

function anchorCalldata(day, rootHash) {
  return stringToHex(anchorMessage(day, rootHash));
}

function loadKey() {
  if (dryRun) return null;
  if (!keyPath) {
    console.error("ANCHOR_BASE_KEY_FILE is not set (use --dry-run to plan without a key)");
    process.exit(2);
  }
  const raw = readFileSync(keyPath, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    console.error("ANCHOR_BASE_KEY_FILE must contain one line: 0x plus 64 hex digits");
    process.exit(2);
  }
  return raw;
}

async function pendingDays() {
  // The public GET is CDN-cached. A stale list re-sent an already anchored day on 2026-11-24
  // (2026-08-14, second tx 0xc01f7b90…, register 409). Read past the cache every time.
  const res = await fetch(`${apiBase}/api/v1/observatory/anchors?days=366&fresh=${Date.now()}`, {
    cache: "no-store",
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) {
    console.error(`anchors GET failed: HTTP ${res.status}`);
    process.exit(2);
  }
  const body = await res.json();
  const anchors = Array.isArray(body.anchors) ? body.anchors : [];
  return anchors
    .filter((r) => r && r.rootHash && r.anchoredTx == null)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(0, Math.max(1, maxN));
}

async function estimateCost(client, from, data) {
  const gas = await client.estimateGas({ account: from, to: from, value: 0n, data });
  const fees = await client.estimateFeesPerGas();
  const price = fees.maxFeePerGas ?? (await client.getGasPrice());
  return { gas, maxWei: gas * price, price };
}

async function registerTx(day, txHash) {
  if (!postSecret) {
    console.error("ANCHOR_POST_SECRET is not set; cannot register the tx");
    process.exit(2);
  }
  const res = await fetch(`${apiBase}/api/v1/observatory/anchors/tx`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${postSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ day, txHash, chainId: CHAIN_ID }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`register failed (${res.status}): ${body.error ?? res.statusText}`);
    process.exit(2);
  }
  console.log(`registered ${day} → ${txHash}`);
}

async function main() {
  const pending = await pendingDays();
  if (pending.length === 0) {
    console.log("no sealed days with empty anchoredTx");
    return;
  }
  const key = loadKey();
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const capWei = parseEther(String(maxGasEth));
  let spentWei = 0n;

  for (const row of pending) {
    const { day, rootHash } = row;
    const data = anchorCalldata(day, rootHash);
    console.log(`day ${day}`);
    console.log(`message ${anchorMessage(day, rootHash)}`);
    console.log(`calldata ${data}`);
    if (dryRun) {
      const from = (process.env.ANCHOR_BASE_SIGNER ?? "").trim();
      if (/^0x[0-9a-fA-F]{40}$/.test(from)) {
        try {
          const est = await estimateCost(publicClient, from, data);
          console.log(`gas_estimate ${est.gas} max_cost_eth ${formatEther(est.maxWei)}`);
        } catch (e) {
          console.log(`gas_estimate skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.log("gas_estimate skipped: set ANCHOR_BASE_SIGNER for an estimate");
      }
      continue;
    }
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
    const est = await estimateCost(publicClient, account.address, data);
    if (spentWei + est.maxWei > capWei) {
      console.error(`stopping: gas cap ${maxGasEth} ETH would be exceeded`);
      process.exit(2);
    }
    console.log(`max_cost_eth ${formatEther(est.maxWei)} (run cap remaining ${formatEther(capWei - spentWei)})`);
    const hash = await wallet.sendTransaction({
      to: account.address,
      value: 0n,
      data,
      gas: est.gas,
      maxFeePerGas: est.price,
      maxPriorityFeePerGas: est.price / 10n || 1n,
    });
    console.log(`sent ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      console.error(`tx ${hash} failed on-chain`);
      process.exit(2);
    }
    const tx = await publicClient.getTransaction({ hash });
    const back = hexToString(tx.input);
    if (back !== anchorMessage(day, rootHash)) {
      console.error("on-chain calldata does not match the planned message");
      process.exit(2);
    }
    spentWei += est.maxWei;
    await registerTx(day, hash);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
});