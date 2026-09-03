// ============================================================
// ERC-8004 ValidationRegistry — 受信箱（2026-09-03）。
//
// 何を直したか: それまでの実装は vet402 の側から `validationRequest` を出していた。
// これは仕様上できない。Base 本番への eth_call で確認した事実:
//   - validationRequest(...) → revert "Not authorized"
//   - validationResponse(...) → revert "unknown"（対応する request が無い）
//   - 対象 agent（38213 / 57008 / 59849）の owner はいずれも第三者
// ERC-8004 の順序は「agent の owner（または承認された operator）が validator を指名して
// request を出す → validator が response を返す」。vet402 は validator であって agent の
// 持ち主ではないので、request を自己開始できない。8/21〜9/3 の 14 件連続失敗はこれが原因。
//
// したがって正しい向きは「指名されたものにだけ答える」。ここはその受信箱で、
// **我々を validator に指名した request を数えて返すだけ**（読み取り専用・チェーンに書かない）。
// 応答の送信はこの上に載せるが、依頼が 0 件のあいだは載せる意味がない——
// 直近 50 万ブロック（約 11 日）の ValidationRegistry のログは全体で 0 件だった。
// つまりこれは技術の問題ではなく採用の問題である、というのが 9/3 時点の事実。
// ============================================================
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { base } from "viem/chains";
import { ERC8004_ADDRESSES } from "./config";

/**
 * ValidationRequest。**実物のログで topic0 を突き合わせて確定した**（2026-09-03）:
 * 本番 Base の ValidationRegistry を 747,000 ブロック走査し、存在した 2 件のうち
 * request 側の topic0 が `0x530436c3…` ＝ keccak("ValidationRequest(address,uint256,string,bytes32)")
 * と一致。indexed は validator / agentId / requestHash の 3 つ、requestURI は data。
 * 引数の順序が仕様書の記述と違うので、ここは推測ではなく実測に合わせてある。
 */
export const VALIDATION_REQUEST_TOPIC0 = "0x530436c3634a98e1e626b0898be2f1e9980cc1bd2a78c07a0aba52d0a48a5059" as const;
export const validationRequestEvent = parseAbiItem(
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
);

export type InboxScan = {
  /** 我々を validator に指名した request。0 件なら「まだ誰も依頼していない」。 */
  addressedToUs: { agentId: string; requestHash: string; blockNumber: string }[];
  /** レジストリ全体のログ数（0 なら、レジストリ自体が誰にも使われていない）。 */
  totalLogs: number;
  blocksScanned: number;
  fromBlock: string;
  toBlock: string;
  /** ValidationRequest の topic0 を実物のログで確認できたか（走査窓に 1 件でもあれば true）。 */
  eventSignatureConfirmed: boolean;
};

/** 我々宛の validation request を数える（読み取り専用）。 */
export async function scanRegistryInbox(options: { validator: Address; blocks?: bigint; rpcUrl?: string; chunk?: bigint } = {} as never): Promise<InboxScan> {
  const { validator, blocks = 200_000n, rpcUrl, chunk = 9_000n } = options;
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const toBlock = await client.getBlockNumber();
  const fromBlock = toBlock > blocks ? toBlock - blocks : 0n;
  const addressedToUs: InboxScan["addressedToUs"] = [];
  let totalLogs = 0;
  let confirmed = false;
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    const logs = await client.getLogs({ address: ERC8004_ADDRESSES.validationRegistry, fromBlock: start, toBlock: end });
    totalLogs += logs.length;
    if (logs.some((l) => l.topics[0] === VALIDATION_REQUEST_TOPIC0)) confirmed = true;
    for (const log of logs) {
      if (log.topics[0] !== VALIDATION_REQUEST_TOPIC0) continue;
      const topic1 = log.topics[1];
      if (!topic1) continue;
      const from = `0x${topic1.slice(-40)}`.toLowerCase();
      if (from !== validator.toLowerCase()) continue;
      addressedToUs.push({
        agentId: BigInt(log.topics[2] ?? "0x0").toString(),
        requestHash: log.topics[3] ?? "0x",
        blockNumber: log.blockNumber?.toString() ?? "?",
      });
    }
  }
  return {
    addressedToUs,
    totalLogs,
    blocksScanned: Number(toBlock - fromBlock),
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    eventSignatureConfirmed: confirmed,
  };
}
