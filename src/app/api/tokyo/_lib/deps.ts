// ============================================================
// 本物の差し替え口（viem・DB・リース）。署名器を作るのはこのファイルだけで、
// 鍵の値はここから外へ出ない（operatorAddress はアドレスだけを返す）。
// 既存 lib は3本だけ（W01）: db/client（store.ts・halt.ts 経由）・util/log・cron/lease。
// ============================================================
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { resolveText, type EnsReadClients } from "@vet402/sdk/ens";
import { acquireLease } from "@/lib/cron/lease";
import { KEY, LEASE_NAME, LEASE_TTL_SECONDS, RECEIPT_TIMEOUT_MS, SELLER_D, STATE_CACHE_MS } from "./constants";
import { TtlCache } from "./cache";
import { envButtonDisabled, readOperatorKey } from "./env";
import { probeTokyoHalt } from "./halt";
import { readRpcUrl } from "./rpc-env";
import { dbStore } from "./store";
import type { ButtonDeps, WriteRequest } from "./types";

const SET_TEXT_ABI = parseAbi(["function setText(bytes name, string key, string value)"]);

/** state の読みの使い回し（プロセスに1つ。route.ts は要求ごとに realButtonDeps() を作るので、ここに置く）。 */
const stateCache = new TtlCache<unknown>(STATE_CACHE_MS, 32);

export function realButtonDeps(): ButtonDeps {
  const rpc = readRpcUrl();
  const transport = http(rpc, { timeout: 15_000, retryCount: 1 });
  const pub = createPublicClient({ chain: sepolia, transport });

  let account: PrivateKeyAccount | null | undefined;
  const operator = (): PrivateKeyAccount | null => {
    if (account === undefined) {
      const key = readOperatorKey();
      try {
        account = key ? privateKeyToAccount(key) : null;
      } catch {
        account = null;
      }
    }
    return account;
  };

  return {
    envDisabled: envButtonDisabled,
    operatorAddress: () => operator()?.address ?? null,
    getChainId: () => pub.getChainId(),
    getBalance: (address) => pub.getBalance({ address }),
    getGasPrice: () => pub.getGasPrice(),
    async readOffer() {
      const B = await pub.getBlockNumber();
      const clients = { primary: pub, secondary: pub } as unknown as EnsReadClients;
      return resolveText(clients, B, SELLER_D, KEY);
    },
    async writeContract(request: WriteRequest) {
      const acct = operator();
      if (!acct) throw new Error("no operator key");
      const wallet = createWalletClient({ account: acct, chain: sepolia, transport });
      return wallet.writeContract({
        address: request.address,
        abi: SET_TEXT_ABI,
        functionName: request.functionName,
        args: [request.args[0], request.args[1], request.args[2]],
      });
    },
    async waitForReceipt(hash) {
      try {
        const r = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
        return r.status === "success" ? "success" : "reverted";
      } catch {
        return "timeout";
      }
    },
    readHalt: probeTokyoHalt,
    store: dbStore(),
    async withLease(fn) {
      const lease = await acquireLease(LEASE_NAME, LEASE_TTL_SECONDS);
      if (!lease.acquired) return { acquired: false };
      try {
        return { acquired: true, value: await fn() };
      } finally {
        await lease.release();
      }
    },
    now: () => Date.now(),
    memo: <T>(key: string, load: () => Promise<T>) => stateCache.get(key, load) as Promise<T>,
  };
}
