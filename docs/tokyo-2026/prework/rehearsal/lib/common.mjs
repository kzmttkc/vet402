// 予行演習の共通部品。元は e15/lib.mjs。
// 変更点は「置き場所」だけ: viem を自前の依存から解決し、ABI は lib/abi/ を import.meta.url 基準で読む。
// 値（アドレス・ロール・キー）は元のまま。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as viemNs from 'viem';
import { sepolia as sepoliaChain } from 'viem/chains';
import * as viemEnsNs from 'viem/ens';

export const viem = viemNs;
export const sepolia = sepoliaChain;
export const viemEns = viemEnsNs;
export const viemVersion = JSON.parse(
  fs.readFileSync(new URL('../node_modules/viem/package.json', import.meta.url), 'utf8'),
).version;

const ABI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'abi');
export const L = n => {
  const d = JSON.parse(fs.readFileSync(path.join(ABI_DIR, `${n}.json`), 'utf8'));
  return d.abi ?? d;
};
export const ABI = {
  PR: L('PermissionedResolverImpl'), VF: L('VerifiableFactory'), UH: L('UniversalHelper'),
  ER: L('ETHRegistry'), UR: L('UniversalResolverV2'), RG: L('ETHRegistrar'), ROOT: L('RootRegistry'),
  URI: L('UserRegistryImpl'),
};

// 2026-09-15 配備【一次: PLAN_DIFF §1.1 / 依頼文】
const lc = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toLowerCase()]));
export const A = lc({
  root: '0x9703DBD26dAB89504490994138cF2c575251a9cE',
  er:   '0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E',
  rg:   '0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca',
  impl: '0x14F09Fd05d4585759e54844dc9b00147131Cf243',
  vf:   '0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C',
  uh:   '0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5',
  ur:   '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
});
export const UR_IMPL = '0xa80338aaa8d23831cea25e858d1774534abb0263';
export const R_VET = '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
export const R_SHARED = '0x49f5022dDe516B92AC1609158bC6AdC772088055';
export const HCA_VET = '0xe96b16ab865aede373c6de768b3943fa615f173f';
export const HCA_ENS = '0xd45a2e001a8e0681a7c4afa27fa88fff0fa1a5d9';

export const W_VET = '0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6';
export const W_ENS = '0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
// 使い捨ての新しいアドレス（鍵は作らない。from に使うだけ）
export const W_OP   = '0x00000000000000000000000000000000000000a1';
export const W_OP2  = '0x00000000000000000000000000000000000000a2';
export const W_OBS  = '0x00000000000000000000000000000000000000b1';
export const K_ATST = '0x41000000000000000000000000000000000000a7';
export const K_AG1  = '0x41000000000000000000000000000000000000c1';
export const K_AG2  = '0x41000000000000000000000000000000000000c2';
export const ZERO   = '0x0000000000000000000000000000000000000000';

// RPC は環境変数で差し替えられる。既定は A3 で 20/20 の組＋予備の3本目。
export const RPC_LIST = (process.env.SEPOLIA_RPCS || [
  process.env.RPC_S || 'https://sepolia.rpc.sentio.xyz',
  process.env.RPC_P || 'https://rpc.sepolia.ethpandaops.io',
  process.env.RPC_3 || 'https://0xrpc.io/sep',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);
export const RPC_S = RPC_LIST[0];
export const RPC_P = RPC_LIST[1] ?? RPC_LIST[0];

// eth_simulateV1 を出す RPC は限られる【実測 2026-09-19】
//   sentio        OK
//   0xrpc.io/sep  OK
//   ethpandaops   NG (-32601 "method ignored by upstream")。しかも失敗するまで 25 秒かかる
// 読み取り（A3 で 20/20 の組）と、simulate に回す順は分けて持つ。
const NO_SIMULATE = [/ethpandaops\.io/];
export const SIM_RPC_LIST = (process.env.SIM_RPCS
  ? process.env.SIM_RPCS.split(',').map(s => s.trim()).filter(Boolean)
  : [...RPC_LIST].sort((a, b) => Number(NO_SIMULATE.some(r => r.test(a))) - Number(NO_SIMULATE.some(r => r.test(b)))));

export const ALL_ROLES = BigInt('0x' + '1'.repeat(64));
export const ROLE_SET_TEXT = 0x10n;
export const ROLE_SET_ADDR = 0x1n;
export const ROLE_LINK = 1n << 28n;
export const ROLE_RENEW = 1n << 16n;
export const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;
export const ROLE_UNREGISTER = 1n << 12n;
export const ROLE_SET_SUBREGISTRY = 1n << 20n;
export const ROLE_SET_RESOLVER = 1n << 24n;
export const ROLE_UPGRADE = 1n << 124n;
// UserRegistry が「解放されていない」間のビット列（admin 側 <<128 込み）。T7 はこれを剥がす。
// ROLE_UNREGISTER が入っているので T7 を D-6 より先に打つと unregister ができなくなる（§4）。
export const UNEMANCIPATED = ROLE_SET_SUBREGISTRY | (ROLE_SET_SUBREGISTRY << 128n)
  | ROLE_SET_RESOLVER | (ROLE_SET_RESOLVER << 128n)
  | ROLE_UNREGISTER | (ROLE_UNREGISTER << 128n)
  | ROLE_UPGRADE | (ROLE_UPGRADE << 128n);
// 実鍵に近い形（非ゼロバイト 20 本）の対照用ダミー。鍵は作らない・from にしか使わない
export const W_OP_REAL = '0x7b3d9f2a8c14e65bd0a7c2f41e98b6537ad2c9e4';

export const dns = n => '0x' + Buffer.concat([...n.split('.').map(x => Buffer.concat([Buffer.from([Buffer.byteLength(x)]), Buffer.from(x)])), Buffer.from([0])]).toString('hex');
export const J = x => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString() : v);
export const client = rpc => viem.createPublicClient({ chain: sepolia, transport: viem.http(rpc, { timeout: 60000 }) });
export const pr = (fn, args) => viem.encodeFunctionData({ abi: ABI.PR, functionName: fn, args });
export const er = (fn, args) => viem.encodeFunctionData({ abi: ABI.ER, functionName: fn, args });
export const usr = (fn, args) => viem.encodeFunctionData({ abi: ABI.URI, functionName: fn, args });
export const urv = (fn, args) => viem.encodeFunctionData({ abi: ABI.UR, functionName: fn, args });
export const uh = (fn, args) => viem.encodeFunctionData({ abi: ABI.UH, functionName: fn, args });
export const ALL_ERRORS = [...ABI.PR, ...ABI.VF, ...ABI.ER, ...ABI.UH, ...ABI.UR, ...ABI.RG, ...ABI.URI].filter(x => x.type === 'error');
export const decErr = data => {
  try {
    const d = viem.decodeErrorResult({ abi: ALL_ERRORS, data });
    return d.errorName + '(' + (d.args || []).map(a => typeof a === 'bigint' ? '0x' + a.toString(16) : String(a)).join(',') + ')';
  } catch { return 'raw:' + String(data).slice(0, 138); }
};
export const RD = viem.parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
  'function addr(bytes32 node, uint256 coinType) view returns (bytes)',
]);
export const ATT_KEY = 'attestations[x402-offer][atst.vet402.eth]';

// ---- 名前に置く文字列の正典（PLAN_v4.3 §3.3.1 の逐語 266 バイト／§3.5.1 の 178 バイト）----
// **ここ1か所にだけ書く。** checks/k1.mjs も checks/gas.mjs もここから取る。
// 仮値（39 バイトの約束・68 バイトの方針）で測ると K1-04 / K1-07 / K1-12 のガスが本番より小さく出る。
// 32 バイト境界を跨ぐたびに記憶枠が1つ増えて +約 22,800 gas 動く【実測・guards/GAS.md §1】。
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const mkOffer = (amount, payTo) => `{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"${USDC_BASE_SEPOLIA}","amount":"${amount}","payTo":"${payTo}","output":{"required":["result","observed_at"]}}`;
export const mkPolicy = (max = '50000', maxAgeSeconds = 86400) => `{"v":1,"network":"eip155:84532","trust":["atst.vet402.eth"],"floors":{"minEnsAttestations":1,"minChainReceipts":1},"requireVet402Allow":false,"max":"${max}","maxAgeSeconds":${maxAgeSeconds}}`;
export const OFFER_BYTES = 266, POLICY_BYTES = 178, ENVELOPE_B64_CHARS = 108;
// ENSIP-29 envelope 79 バイト → base64 108 文字（B5b で置く本物と同じ長さのダミー）
export const ENVELOPE_B64 = Buffer.from(Array.from({ length: 79 }, (_, i) => (i * 37 + 11) & 0xff)).toString('base64');
export const OBS_KEYS = ['class', 'description', 'x402.resource', 'x402.method', 'x402.l2', 'x402.declaration-sha256', 'x402.response-sha256', 'x402.purchase', 'x402.purchase-block', 'x402.observed-at', 'x402.source', 'x402.rerun', 'x402.pipeline-commit', 'x402.attested-name', 'x402.attested-t'];

// viem のバージョン差を吸収（2.31 以降 getEventSelector は toEventSelector に改名）
export const eventSelector = viem.toEventSelector ?? viem.getEventSelector;

// 署名・送信はしない。読み取りだけの JSON-RPC を直に叩く。
const ALLOWED_RPC_METHODS = new Set([
  'eth_call', 'eth_simulateV1', 'eth_getLogs', 'eth_getCode', 'eth_gasPrice',
  'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_chainId',
]);
export const rpc = async (url, method, params, timeoutMs = 60000) => {
  if (!ALLOWED_RPC_METHODS.has(method)) throw new Error(`読み取り以外の RPC は打たない: ${method}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method} RPC ERROR ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
};

// eth_simulateV1 を、RPC を順に試して1本でも通ればその結果を返す
export const simulate = async (calls, blockNumber, urls = SIM_RPC_LIST) => {
  const errs = [];
  for (const u of urls) {
    try {
      const r = await rpc(u, 'eth_simulateV1', [
        { blockStateCalls: [{ calls }], validation: false }, viem.toHex(blockNumber),
      ]);
      return { rpc: u, calls: r[0].calls };
    } catch (e) { errs.push(`${u}: ${String(e.message || e).slice(0, 160)}`); }
  }
  throw new Error('eth_simulateV1 が全 RPC で失敗: ' + errs.join(' / '));
};

// 複数ブロック（blockOverrides で時刻を進める等）を使う eth_simulateV1。
// 1ブロックしか要らないときは simulate() を使う。
export const simulateBlocks = async (blockStateCalls, blockNumber, urls = SIM_RPC_LIST) => {
  const errs = [];
  for (const u of urls) {
    try {
      const r = await rpc(u, 'eth_simulateV1', [{ blockStateCalls, validation: false }, viem.toHex(blockNumber)]);
      return { rpc: u, blocks: r };
    } catch (e) { errs.push(`${u}: ${String(e.message || e).slice(0, 160)}`); }
  }
  throw new Error('eth_simulateV1（複数ブロック）が全 RPC で失敗: ' + errs.join(' / '));
};

// 先頭から順に「読める」RPC を1本決める
export const pickRpc = async (urls = SIM_RPC_LIST) => {
  const errs = [];
  for (const u of urls) {
    try { await rpc(u, 'eth_blockNumber', [], 20000); return u; }
    catch (e) { errs.push(`${u}: ${String(e.message || e).slice(0, 120)}`); }
  }
  throw new Error('どの RPC も読めない: ' + errs.join(' / '));
};
