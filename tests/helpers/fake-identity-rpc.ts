// ============================================================
// 手元だけで動く Base の JSON-RPC の偽物（identity registry の索引テスト用・2026-10-31）。
//
// 索引（owner-indexer / agent-wallet-indexer）は getIndexerPublicClient() の実物（viem の http
// transport・chunked-logs・multicall）を通して読む。差し替え口を使わずに、読み先の URL を
// この偽物へ向けるだけで、変更前のコードにも同じテストを当てられる。
//
// 答えるのは eth_chainId・eth_blockNumber・eth_getLogs（address・topic0・範囲で絞る）・
// eth_call（Multicall3 aggregate3 の中の ownerOf だけ）。それ以外は JSON-RPC のエラー。
// ============================================================
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  multicall3Abi,
  parseAbiItem,
  toHex,
  type Address,
  type Hex,
} from "viem";

export const REGISTERED = parseAbiItem(
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
);
export const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);
export const WALLET_SET = parseAbiItem("event WalletSet(uint256 indexed agentId, address indexed wallet)");

const OWNER_OF_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export type FakeLogKind = "registered" | "transfer" | "walletSet";

export type FakeLog =
  | { kind: "registered"; block: bigint; agentId: bigint; owner: Address }
  | { kind: "transfer"; block: bigint; from: Address; to: Address; agentId: bigint }
  | { kind: "walletSet"; block: bigint; agentId: bigint; wallet: Address };

export type FakeChain = {
  tip: bigint;
  logs: FakeLog[];
  /** ownerOf の今の答え。無い id は revert（燃やした token と同じ）。 */
  owners: Map<bigint, Address>;
};

export type GetLogsCall = { kind: FakeLogKind; from: bigint; to: bigint };

export type FakeRpc = {
  url: string;
  calls: GetLogsCall[];
  /** eth_getLogs を 1 回受けるたびに呼ぶ（テストの時計を進める）。 */
  onGetLogs: (call: GetLogsCall) => void;
  /** true を返した eth_getLogs には、いつまでも答えない（close で接続ごと切る）。 */
  hangGetLogs: (call: GetLogsCall) => boolean;
  close: () => Promise<void>;
};

const TOPIC0: Record<FakeLogKind, Hex> = {
  registered: encodeEventTopics({ abi: [REGISTERED], eventName: "Registered" })[0] as Hex,
  transfer: encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer" })[0] as Hex,
  walletSet: encodeEventTopics({ abi: [WALLET_SET], eventName: "WalletSet" })[0] as Hex,
};

function kindOfTopic(topic: string | undefined): FakeLogKind | null {
  for (const [kind, t] of Object.entries(TOPIC0)) if (t.toLowerCase() === topic?.toLowerCase()) return kind as FakeLogKind;
  return null;
}

function encodeLog(log: FakeLog, logIndex: number, registry: Address) {
  let topics: readonly unknown[];
  let data: Hex = "0x";
  if (log.kind === "registered") {
    topics = encodeEventTopics({ abi: [REGISTERED], eventName: "Registered", args: { agentId: log.agentId, owner: log.owner } });
    data = encodeAbiParameters([{ type: "string" }], [`ipfs://agent-${log.agentId}`]);
  } else if (log.kind === "transfer") {
    topics = encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from: log.from, to: log.to, tokenId: log.agentId } });
  } else {
    topics = encodeEventTopics({ abi: [WALLET_SET], eventName: "WalletSet", args: { agentId: log.agentId, wallet: log.wallet } });
  }
  return {
    address: registry,
    topics,
    data,
    blockNumber: toHex(log.block),
    blockHash: `0x${log.block.toString(16).padStart(64, "0")}`,
    transactionHash: `0x${(log.block * 1000n + BigInt(logIndex)).toString(16).padStart(64, "0")}`,
    transactionIndex: "0x0",
    logIndex: toHex(logIndex),
    removed: false,
  };
}

export async function startFakeIdentityRpc(chain: FakeChain, registry: Address): Promise<FakeRpc> {
  const calls: GetLogsCall[] = [];
  const rpc: FakeRpc = { url: "", calls, onGetLogs: () => {}, hangGetLogs: () => false, close: async () => {} };
  const HANG = Symbol("hang");

  function handle(req: { id: unknown; method: string; params?: unknown[] }): unknown {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
      case "eth_chainId":
        return ok("0x2105");
      case "eth_blockNumber":
        return ok(toHex(chain.tip));
      case "eth_getLogs": {
        const filter = (req.params?.[0] ?? {}) as { address?: string; topics?: (string | null)[]; fromBlock: Hex; toBlock: Hex };
        const kind = kindOfTopic(filter.topics?.[0] ?? undefined);
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        if (!kind) return ok([]);
        const call = { kind, from, to };
        calls.push(call);
        rpc.onGetLogs(call);
        if (rpc.hangGetLogs(call)) return HANG;
        // logIndex はブロックの中の並び順（全種類を通した順）。
        const out = [];
        const perBlock = new Map<bigint, number>();
        for (const log of chain.logs) {
          const index = perBlock.get(log.block) ?? 0;
          perBlock.set(log.block, index + 1);
          if (log.kind !== kind || log.block < from || log.block > to) continue;
          if (filter.address && filter.address.toLowerCase() !== registry.toLowerCase()) continue;
          out.push(encodeLog(log, index, registry));
        }
        return ok(out);
      }
      case "eth_call": {
        const call = (req.params?.[0] ?? {}) as { data?: Hex; input?: Hex };
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: (call.data ?? call.input)! });
        if (decoded.functionName !== "aggregate3") {
          return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "unsupported call" } };
        }
        const inner = decoded.args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
        const results = inner.map((c) => {
          const { args } = decodeFunctionData({ abi: OWNER_OF_ABI, data: c.callData });
          const owner = chain.owners.get(args[0]);
          if (!owner) return { success: false, returnData: "0x" as Hex };
          return { success: true, returnData: encodeFunctionResult({ abi: OWNER_OF_ABI, functionName: "ownerOf", result: owner }) };
        });
        return ok(encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }));
      }
      default:
        return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
    }
  }

  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const answer = Array.isArray(parsed) ? parsed.map(handle) : handle(parsed);
      if (answer === HANG || (Array.isArray(answer) && answer.includes(HANG))) return; // 答えない
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  rpc.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rpc.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return rpc;
}
