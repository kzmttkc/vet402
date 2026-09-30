// Anchor one vet402 /rwa record in RwaAnchor, and check any anchor (SPEC §9, SPEC patch 023).
//
// Add a record to the existing contract (the normal case; nothing is deployed):
//   npx tsx packages/rwa/scripts/anchor.ts --dry-run --mainnet --contract 0x1955137e7773f2459eb75fb88842026c6517c22d
//   RWA_ANCHOR_KEY=… npx tsx packages/rwa/scripts/anchor.ts --mainnet --contract 0x1955137e7773f2459eb75fb88842026c6517c22d
//
// Check an anchor (anyone, no key; reads the chain named in the record):
//   npx tsx packages/rwa/scripts/anchor.ts --verify <txHash> [--record fixtures/rwa/anchors/<file>.json]
//
// Testnet rehearsal (46630) may still deploy a fresh contract with --deploy. On
// mainnet a deploy is refused: a second RwaAnchor would split the record and break
// every link to 0x1955…c22d.
//
// The facts always come from Robinhood Chain mainnet (4663). The key is read from
// RWA_ANCHOR_KEY and never printed, logged or written. Before sending, the script
// prints the record, the hash, the gas estimate and the cost, and waits for the
// word "anchor" on the terminal. The result goes to a new file
// fixtures/rwa/anchors/<method_version>-<block>.json, opened with O_EXCL, so no
// earlier record is ever overwritten. fixtures/rwa/anchor.json (the 0.1 anchor)
// is never written by this script.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  anchorPreimage,
  asOfSeconds,
  factsHash,
  factsJsonKeccak,
  hashMaterial,
  methodVersionNumber,
  preimageString,
  RWA_ANCHOR_ADDRESS,
  RWA_ANCHOR_CHAIN_ID,
  subjectHash,
} from "../anchor";
import { reconstructFacts, type RwaFacts } from "../facts";

const DEMO_ADDRESS = "0xE9B08727131E34010b34006c660D4c1B436EC25f"; // SPEC §11 patch 011
/** The key that wrote the 0.1 anchor; the default `from` for a dry-run gas estimate. */
const OPERATOR_0_1 = "0x973cD8a91A771C2C04C6036888F8175D6b4F6227";

const CHAINS = {
  46630: defineChain({
    id: 46630,
    name: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
    blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  }),
  4663: defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
    blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  }),
};
type ChainId = keyof typeof CHAINS;

const root = process.cwd();
const artifact = JSON.parse(readFileSync(join(root, "packages/rwa/contracts/RwaAnchor.json"), "utf8"));
const onchain = JSON.parse(readFileSync(join(root, "packages/rwa/contracts/onchain.json"), "utf8"));
const LEGACY_RECORD = resolve(root, "fixtures/rwa/anchor.json");
const ANCHORS_DIR = resolve(root, "fixtures/rwa/anchors");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function clientFor(id: ChainId): PublicClient {
  return createPublicClient({ chain: CHAINS[id], transport: http() }) as PublicClient;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

/** The contract must be RwaAnchor: on mainnet exactly 0x1955…c22d, anywhere with the pinned runtime. */
async function checkContract(client: PublicClient, chainId: ChainId, address: string): Promise<Hex> {
  const a = getAddress(address);
  if (chainId === RWA_ANCHOR_CHAIN_ID && a.toLowerCase() !== RWA_ANCHOR_ADDRESS) {
    throw new Error(`on mainnet the contract is ${RWA_ANCHOR_ADDRESS}; refusing ${a}`);
  }
  const code = await client.getCode({ address: a });
  const hash = code ? keccak256(code) : "none";
  if (hash !== onchain.runtime_keccak256) throw new Error(`${a} runtime keccak ${hash} is not RwaAnchor (${onchain.runtime_keccak256})`);
  return a;
}

type Plan = {
  facts: RwaFacts;
  subject: Hex;
  hash: Hex;
  methodVersion: number;
  asOf: bigint;
};

function plan(facts: RwaFacts): Plan {
  return {
    facts,
    subject: subjectHash(facts.address),
    hash: factsHash(facts),
    methodVersion: methodVersionNumber(facts.method_version),
    asOf: asOfSeconds(facts),
  };
}

function describe(p: Plan) {
  return {
    wallet: p.facts.address,
    method_version: p.facts.method_version,
    hash_material: hashMaterial(p.facts.method_version),
    as_of: p.facts.as_of,
    as_of_block_on_4663: p.facts.as_of_block,
    r1_status: p.facts.r1_status,
    realized_usd: p.facts.realized_usd,
    subject: p.subject,
    facts_hash: p.hash,
    preimage: preimageString(anchorPreimage(p.facts)),
  };
}

async function estimate(client: PublicClient, contract: Hex, from: Hex, p: Plan) {
  const gas = await client.estimateContractGas({
    address: contract,
    abi: artifact.abi,
    functionName: "anchor",
    args: [p.subject, p.hash, p.methodVersion, p.asOf],
    account: from,
  });
  const gasPrice = await client.getGasPrice();
  // Headroom for an L1 data fee swing between the estimate and inclusion.
  const gasLimit = (gas * 13n) / 10n;
  return { gas, gasLimit, gasPrice, maxCostWei: gasLimit * gasPrice };
}

async function reconstruct(): Promise<RwaFacts> {
  const wallet = (opt("--address") ?? DEMO_ADDRESS).toLowerCase();
  console.log(`reconstructing ${wallet} from Robinhood Chain 4663 (tens of seconds)…`);
  return reconstructFacts(wallet, { retries: 6 });
}

function chainFromFlags(): ChainId {
  return flag("--mainnet") ? 4663 : 46630;
}

/** No key needed. Shows exactly what a send would anchor, and what it would cost. */
async function dryRun() {
  const chainId = chainFromFlags();
  const client = clientFor(chainId);
  const rpcChain = await client.getChainId();
  if (rpcChain !== chainId) throw new Error(`RPC answered chain ${rpcChain}, expected ${chainId}`);
  const contractArg = opt("--contract");
  if (!contractArg) {
    if (chainId === RWA_ANCHOR_CHAIN_ID) throw new Error(`on mainnet pass --contract ${RWA_ANCHOR_ADDRESS}; a deploy is refused`);
    const deployGas = await client.estimateGas({ account: OPERATOR_0_1, data: artifact.bytecode as Hex });
    console.log(json({ chain: CHAINS[chainId].name, deploy_gas: deployGas, gas_price_wei: await client.getGasPrice() }));
    return;
  }
  const contract = await checkContract(client, chainId, contractArg);
  const from = getAddress(opt("--from") ?? OPERATOR_0_1);
  const p = plan(await reconstruct());
  const e = await estimate(client, contract, from, p);
  console.log(json({
    dry_run: true,
    chain: CHAINS[chainId].name,
    chain_id: chainId,
    contract,
    estimated_from: from,
    ...describe(p),
    anchor_gas: e.gas,
    gas_limit_with_headroom: e.gasLimit,
    gas_price_wei: e.gasPrice,
    max_cost_eth: formatEther(e.maxCostWei),
    would_write: outputPath(p.facts.method_version, 0, chainId).replace(`${root}/`, "").replace(/-0\.json$/, "-<anchor block>.json"),
  }));
}

function outputPath(methodVersion: string, block: number, chainId: ChainId): string {
  const name = `${chainId === RWA_ANCHOR_CHAIN_ID ? "" : `testnet-`}${methodVersion}-${block}.json`;
  const path = resolve(ANCHORS_DIR, name);
  if (path === LEGACY_RECORD || !path.startsWith(`${ANCHORS_DIR}/`)) throw new Error(`refusing to write ${path}`);
  return path;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim() === "anchor";
  } finally {
    rl.close();
  }
}

async function send() {
  const key = process.env.RWA_ANCHOR_KEY as Hex | undefined;
  if (!key) throw new Error("RWA_ANCHOR_KEY is not set (use --dry-run to see the plan without a key)");
  const chainId = chainFromFlags();
  const chain = CHAINS[chainId];
  const client = clientFor(chainId);
  const rpcChain = await client.getChainId();
  if (rpcChain !== chainId) throw new Error(`RPC answered chain ${rpcChain}, expected ${chainId}`);
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http() });

  let contract: Hex;
  let deployTx: Hex | undefined;
  const contractArg = opt("--contract");
  if (contractArg) {
    contract = await checkContract(client, chainId, contractArg);
  } else if (flag("--deploy") && chainId !== RWA_ANCHOR_CHAIN_ID) {
    deployTx = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode as Hex });
    const deployed = await client.waitForTransactionReceipt({ hash: deployTx });
    if (!deployed.contractAddress) throw new Error(`deploy ${deployTx} produced no contract`);
    contract = await checkContract(client, chainId, deployed.contractAddress);
  } else {
    throw new Error(`pass --contract ${RWA_ANCHOR_ADDRESS}${chainId === RWA_ANCHOR_CHAIN_ID ? "" : " (or --deploy on testnet)"}`);
  }

  const p = plan(await reconstruct());
  const e = await estimate(client, contract, account.address, p);
  const balance = await client.getBalance({ address: account.address });
  console.log(json({ chain: chain.name, contract, from: account.address, balance_eth: formatEther(balance), ...describe(p), anchor_gas: e.gas, gas_limit: e.gasLimit, gas_price_wei: e.gasPrice, max_cost_eth: formatEther(e.maxCostWei) }));
  if (balance < e.maxCostWei) throw new Error(`balance ${formatEther(balance)} ETH is below the max cost ${formatEther(e.maxCostWei)} ETH`);
  if (!(await confirm(`Send one anchor() from ${account.address} to ${contract} on ${chain.name}? Type "anchor" to send: `))) {
    console.log("not sent");
    return;
  }

  const anchorTx = await wallet.writeContract({
    address: contract,
    abi: artifact.abi,
    functionName: "anchor",
    args: [p.subject, p.hash, p.methodVersion, p.asOf],
    gas: e.gasLimit,
  });
  console.log(`sent ${anchorTx}, waiting for the receipt…`);
  const anchored = await client.waitForTransactionReceipt({ hash: anchorTx });
  if (anchored.status !== "success") throw new Error(`anchor ${anchorTx} reverted`);

  const record = {
    chain_id: chainId,
    contract: contract.toLowerCase(),
    ...(deployTx ? { deploy_tx: deployTx } : {}),
    anchor_tx: anchorTx,
    anchor_block: Number(anchored.blockNumber),
    anchored_by: account.address,
    explorer: `${chain.blockExplorers.default.url}/tx/${anchorTx}`,
    subject: { address: p.facts.address, keccak: p.subject },
    facts_hash: p.hash,
    hash_material: hashMaterial(p.facts.method_version),
    facts_json_keccak: hashMaterial(p.facts.method_version) === 2 ? factsJsonKeccak(p.facts) : null,
    preimage: preimageString(anchorPreimage(p.facts)),
    method_version: { string: p.facts.method_version, number: p.methodVersion },
    as_of: { iso: p.facts.as_of, unix: p.asOf.toString(), block_on_4663: p.facts.as_of_block },
    facts: p.facts,
  };
  const problems = verifyRecord(record, anchored);
  mkdirSync(ANCHORS_DIR, { recursive: true });
  const path = outputPath(p.facts.method_version, record.anchor_block, chainId);
  writeFileSync(path, `${json(record)}\n`, { flag: "wx" });
  console.log(`anchor tx ${anchorTx}\n${record.explorer}\nwrote ${path.replace(`${root}/`, "")}`);
  if (problems.length) throw new Error(`written, but the receipt does not verify: ${problems.join("; ")}`);
  console.log("verified against the receipt: contract, anchoredBy, subject, factsHash, methodVersion, asOf");
}

type AnchorRecord = {
  chain_id: number;
  contract: string;
  anchor_tx?: string;
  anchored_by: string;
  facts_hash?: string;
  facts: RwaFacts;
};

type Receipt = Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;

/** Every check a reader needs; returns the failures (empty = verified). */
export function verifyRecord(record: AnchorRecord, receipt: Receipt): string[] {
  const problems: string[] = [];
  if (receipt.status !== "success") problems.push("tx failed");
  if (record.contract.toLowerCase() !== RWA_ANCHOR_ADDRESS && record.chain_id === RWA_ANCHOR_CHAIN_ID) {
    problems.push(`record names contract ${record.contract}, not RwaAnchor ${RWA_ANCHOR_ADDRESS}`);
  }
  const logs = parseEventLogs({ abi: artifact.abi, logs: receipt.logs, eventName: "Anchored" }) as unknown as {
    address: string;
    args: { subject: Hex; factsHash: Hex; methodVersion: number; asOf: bigint; anchoredBy: string };
  }[];
  const fromContract = logs.filter((l) => l.address.toLowerCase() === record.contract.toLowerCase());
  if (fromContract.length !== 1) {
    problems.push(`${fromContract.length} Anchored logs from ${record.contract} (${logs.length - fromContract.length} from other addresses ignored)`);
    return problems;
  }
  const { args: a } = fromContract[0];
  const f = record.facts;
  if (a.anchoredBy.toLowerCase() !== record.anchored_by.toLowerCase()) problems.push(`anchoredBy ${a.anchoredBy} != record ${record.anchored_by}`);
  if (a.subject !== subjectHash(f.address)) problems.push("subject does not match the address");
  const recomputed = factsHash(f);
  if (a.factsHash !== recomputed) problems.push(`factsHash ${a.factsHash} != recomputed ${recomputed}`);
  if (record.facts_hash && record.facts_hash !== recomputed) problems.push("record facts_hash != recomputed");
  if (a.methodVersion !== methodVersionNumber(f.method_version)) problems.push("methodVersion mismatch");
  if (a.asOf !== asOfSeconds(f)) problems.push("asOf mismatch");
  return problems;
}

/** Anyone can run this: read the receipt and recompute everything from the record JSON. */
async function verify(txHash: Hex) {
  const recordPath = opt("--record") ?? "fixtures/rwa/anchor.json";
  const record = JSON.parse(readFileSync(resolve(root, recordPath), "utf8")) as AnchorRecord;
  const chainId = record.chain_id as ChainId;
  if (!CHAINS[chainId]) throw new Error(`record chain ${record.chain_id} is not Robinhood Chain`);
  const client = clientFor(chainId);
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const problems = verifyRecord(record, receipt);
  if (record.anchor_tx && record.anchor_tx.toLowerCase() !== txHash.toLowerCase()) problems.push(`record anchor_tx is ${record.anchor_tx}`);
  const code = await client.getCode({ address: getAddress(record.contract) });
  if (!code || keccak256(code) !== onchain.runtime_keccak256) problems.push("contract runtime is not the pinned RwaAnchor build");
  console.log(json({
    tx: txHash,
    record: recordPath,
    contract: record.contract,
    anchored_by: record.anchored_by,
    method_version: record.facts.method_version,
    hash_material: hashMaterial(record.facts.method_version),
    recomputed_from_json: factsHash(record.facts),
    problems,
    match: problems.length === 0,
  }));
  if (problems.length) process.exit(1);
}

const verifyTx = opt("--verify");
const run = verifyTx ? () => verify(verifyTx as Hex) : flag("--dry-run") ? dryRun : send;
if (process.argv[1]?.endsWith("anchor.ts")) {
  run().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e).slice(0, 400));
    process.exit(1);
  });
}
