// Deploy RwaAnchor once and anchor one reconstruction (SPEC §9: "提出前に1回").
//
//   npx tsx packages/rwa/scripts/anchor.ts --dry-run              # estimate only, no key needed
//   RWA_ANCHOR_KEY=0x… npx tsx packages/rwa/scripts/anchor.ts      # testnet 46630 (default)
//   RWA_ANCHOR_KEY=0x… npx tsx packages/rwa/scripts/anchor.ts --mainnet   # 4663
//   npx tsx packages/rwa/scripts/anchor.ts --verify <txHash> [--mainnet]  # anyone: recompute and compare
//
// The facts being anchored always come from Robinhood Chain mainnet (4663); only
// where the commitment is written changes. The key is read from the environment
// and never printed, logged or written. Output goes to fixtures/rwa/anchor.json
// so the submission can cite the contract, the tx and the exact preimage.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anchorPreimage, asOfSeconds, factsHash, methodVersionNumber, preimageString, subjectHash } from "../anchor";
import { reconstructFacts } from "../facts";

const DEMO_ADDRESS = "0xE9B08727131E34010b34006c660D4c1B436EC25f"; // SPEC §11 patch 011

const CHAINS = {
  testnet: defineChain({
    id: 46630,
    name: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
    blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  }),
  mainnet: defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
    blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  }),
};

const artifact = JSON.parse(readFileSync(join(process.cwd(), "packages/rwa/contracts/RwaAnchor.json"), "utf8"));
const args = process.argv.slice(2);
const chain = args.includes("--mainnet") ? CHAINS.mainnet : CHAINS.testnet;
const client = createPublicClient({ chain, transport: http() });

async function dryRun() {
  const chainId = await client.getChainId();
  if (chainId !== chain.id) throw new Error(`RPC answered chain ${chainId}, expected ${chain.id}`);
  const probe = "0x000000000000000000000000000000000000dEaD";
  const deployGas = await client.estimateGas({ account: probe, data: artifact.bytecode as Hex });
  const gasPrice = await client.getGasPrice();
  // anchor() on a fresh contract: one SSTORE 0→1 plus an event; bounded well under this.
  const anchorGasBound = 80_000n;
  const wei = (deployGas + anchorGasBound) * gasPrice;
  console.log(JSON.stringify({
    chain: chain.name, chain_id: chain.id,
    deploy_gas: deployGas.toString(), anchor_gas_upper_bound: anchorGasBound.toString(),
    gas_price_wei: gasPrice.toString(),
    total_eth_upper_bound: (Number(wei) / 1e18).toFixed(9),
  }, null, 2));
}

async function deployAndAnchor() {
  const key = process.env.RWA_ANCHOR_KEY as Hex | undefined;
  if (!key) throw new Error("RWA_ANCHOR_KEY is not set (use --dry-run to estimate without a key)");
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http() });

  const facts = await reconstructFacts(DEMO_ADDRESS.toLowerCase(), { retries: 6 });
  const hash = factsHash(facts);
  const subject = subjectHash(facts.address);
  const methodVersion = methodVersionNumber(facts.method_version);
  const asOf = asOfSeconds(facts);

  const deployTx = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode as Hex });
  const deployed = await client.waitForTransactionReceipt({ hash: deployTx });
  if (!deployed.contractAddress) throw new Error(`deploy ${deployTx} produced no contract`);

  const anchorTx = await wallet.writeContract({
    address: deployed.contractAddress, abi: artifact.abi, functionName: "anchor",
    args: [subject, hash, methodVersion, asOf],
  });
  const anchored = await client.waitForTransactionReceipt({ hash: anchorTx });
  if (anchored.status !== "success") throw new Error(`anchor ${anchorTx} reverted`);

  const out = {
    chain_id: chain.id,
    contract: deployed.contractAddress,
    deploy_tx: deployTx,
    anchor_tx: anchorTx,
    anchor_block: Number(anchored.blockNumber),
    anchored_by: account.address,
    explorer: `${chain.blockExplorers.default.url}/tx/${anchorTx}`,
    subject: { address: facts.address, keccak: subject },
    facts_hash: hash,
    preimage: preimageString(anchorPreimage(facts)),
    method_version: { string: facts.method_version, number: methodVersion },
    as_of: { iso: facts.as_of, unix: asOf.toString(), block_on_4663: facts.as_of_block },
    facts,
  };
  const path = join(process.cwd(), "fixtures/rwa/anchor.json");
  writeFileSync(path, `${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  console.log(`contract ${deployed.contractAddress}\nanchor tx ${anchorTx}\n${out.explorer}\nwrote ${path}`);
}

/** Anyone can run this: read the Anchored event and recompute the hash from fixtures/rwa/anchor.json. */
async function verify(txHash: Hex) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const [log] = parseEventLogs({ abi: artifact.abi, logs: receipt.logs, eventName: "Anchored" }) as unknown as { args: { subject: Hex; factsHash: Hex; methodVersion: number; asOf: bigint } }[];
  if (!log) throw new Error(`no Anchored event in ${txHash}`);
  const record = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/anchor.json"), "utf8"));
  const recomputed = factsHash(record.facts);
  const ok = recomputed === log.args.factsHash && subjectHash(record.facts.address) === log.args.subject;
  console.log(JSON.stringify({ tx: txHash, on_chain: log.args.factsHash, recomputed_from_json: recomputed, match: ok }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  if (!ok) process.exit(1);
}

const i = args.indexOf("--verify");
(args.includes("--dry-run") ? dryRun() : i >= 0 ? verify(args[i + 1] as Hex) : deployAndAnchor()).catch((e) => {
  console.error(String(e instanceof Error ? e.message : e).slice(0, 400));
  process.exit(1);
});
