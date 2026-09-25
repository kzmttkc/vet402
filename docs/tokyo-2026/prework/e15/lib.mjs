import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire('/Users/takeshi/vouch/package.json');
export const viem = require('viem');
export const { sepolia } = require('viem/chains');
export const viemEns = require('viem/ens');
export const viemVersion = require('/Users/takeshi/vouch/node_modules/viem/package.json').version;

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const L = n => { const d = JSON.parse(fs.readFileSync(path.join(HERE, 'ref/abi', `new_${n}.json`))); return d.abi ?? d; };
export const ABI = {
  PR: L('PermissionedResolverImpl'), VF: L('VerifiableFactory'), UH: L('UniversalHelper'),
  ER: L('ETHRegistry'), UR: L('UniversalResolverV2'), RG: L('ETHRegistrar'), ROOT: L('RootRegistry'),
};
// 2026-09-15 配備【一次: PLAN_DIFF §1.1 / 依頼文】
const lc = o => Object.fromEntries(Object.entries(o).map(([k,v])=>[k, v.toLowerCase()]));
export const A = lc({
  root: '0x9703DBD26dAB89504490994138cF2c575251a9cE',
  er:   '0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E',
  rg:   '0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca',
  impl: '0x14F09Fd05d4585759e54844dc9b00147131Cf243',
  vf:   '0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C',
  uh:   '0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5',
  ur:   '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
});
export const W_VET = '0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6';
export const W_ENS = '0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
// 使い捨ての新しいアドレス（鍵は作らない。from に使うだけ）
export const W_OP  = '0x00000000000000000000000000000000000000a1';
export const W_OP2 = '0x00000000000000000000000000000000000000a2';
export const W_OBS = '0x00000000000000000000000000000000000000b1';
export const K_ATST= '0x41000000000000000000000000000000000000a7';

export const RPC_S = 'https://sepolia.rpc.sentio.xyz';
export const RPC_P = 'https://rpc.sepolia.ethpandaops.io';
export const ALL_ROLES = BigInt('0x' + '1'.repeat(64));
export const ROLE_SET_TEXT = 0x10n;
export const ROLE_SET_ADDR = 0x1n;
export const ROLE_LINK = 1n << 28n;

export const dns = n => '0x' + Buffer.concat([...n.split('.').map(x => Buffer.concat([Buffer.from([Buffer.byteLength(x)]), Buffer.from(x)])), Buffer.from([0])]).toString('hex');
export const J = x => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString() : v);
export const client = rpc => viem.createPublicClient({ chain: sepolia, transport: viem.http(rpc, { timeout: 60000 }) });
export const pr = (fn, args) => viem.encodeFunctionData({ abi: ABI.PR, functionName: fn, args });
export const ALL_ERRORS = [...ABI.PR, ...ABI.VF, ...ABI.ER, ...ABI.UH, ...ABI.UR, ...ABI.RG].filter(x => x.type === 'error');
export const decErr = data => {
  try { const d = viem.decodeErrorResult({ abi: ALL_ERRORS, data }); return d.errorName + '(' + (d.args || []).map(a => typeof a === 'bigint' ? '0x' + a.toString(16) : String(a)).join(',') + ')'; }
  catch { return 'raw:' + String(data).slice(0, 138); }
};
export const RD = viem.parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
  'function addr(bytes32 node, uint256 coinType) view returns (bytes)',
]);
export const ATT_KEY = 'attestations[x402-offer][atst.vet402.eth]';
export const OBS_KEYS = ['class','description','x402.resource','x402.method','x402.l2','x402.declaration-sha256','x402.response-sha256','x402.purchase','x402.purchase-block','x402.observed-at','x402.source','x402.rerun','x402.pipeline-commit','x402.attested-name','x402.attested-t'];
