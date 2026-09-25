import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { createPublicClient, http, encodeFunctionData, labelhash, namehash, keccak256, toBytes } = require('viem');
const { sepolia } = require('viem/chains');
const L = n => { const d = JSON.parse(fs.readFileSync(`../ur/abi/new_${n}.json`)); return d.abi ?? d; };
const PR = L('PermissionedResolverImpl'), VF = L('VerifiableFactory'), UH = L('UniversalHelper'), ER = L('ETHRegistry'), UR = L('UniversalResolverV2'), RG = L('ETHRegistrar');
const A = { impl:'0x14f09fd05d4585759e54844dc9b00147131cf243', vf:'0x9e726eb570beb6bceb495ab8cda7df517d4e841c', uh:'0x33f571aa8a160a21b877cf6e0fb8806692b97df5', er:'0x657ea849311d3d5823348dded7c2aaafb3ede09e', ur:'0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe', rg:'0xabe76f6c8dfced81aa5a2bb8034202a7136b94ca' };
const dns = n => '0x' + Buffer.concat([...n.split('.').map(x => Buffer.concat([Buffer.from([Buffer.byteLength(x)]), Buffer.from(x)])), Buffer.from([0])]).toString('hex');
const W_VET='0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6', W_ENS='0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
const RPCS = ['https://sepolia.rpc.sentio.xyz','https://rpc.sepolia.ethpandaops.io'];
const c0 = createPublicClient({ chain: sepolia, transport: http(RPCS[0]) });
const c1 = createPublicClient({ chain: sepolia, transport: http(RPCS[1]) });
const B = (await Promise.all([c0.getBlockNumber(), c1.getBlockNumber()])).reduce((a,b)=>a<b?a:b) - 2n;
const J = x => JSON.stringify(x, (k,v)=>typeof v==='bigint'?v.toString():v);
const R = async (c, address, abi, functionName, args=[], account) => { try { return J(await c.readContract({ address, abi, functionName, args, blockNumber: B, account })); } catch (e) { return 'ERR:' + (e.shortMessage||e.message).split('\n')[0].slice(0,120); } };
const q = [];
const add = (label, ...a) => q.push([label, a]);
add('helper.findExactOwner(ens.eth)', A.uh, UH, 'findExactOwner', [dns('ens.eth')]);
add('helper.findNearestOwner(ens.eth)', A.uh, UH, 'findNearestOwner', [dns('ens.eth')]);
add('ETHRegistry.getState(labelhash ens)', A.er, ER, 'getState', [BigInt(labelhash('ens'))]);
add('ETHRegistry.findOwner("ens")', A.er, ER, 'findOwner', ['ens']);
add('helper.findExactOwner(eth)', A.uh, UH, 'findExactOwner', [dns('eth')]);
for (const l of ['vet402','seller-a','seller-b','seller-c','pandas']) {
  add(`registrar.isAvailable(${l})`, A.rg, RG, 'isAvailable', [l]);
  add(`ETHRegistry.getState(${l})`, A.er, ER, 'getState', [BigInt(labelhash(l))]);
  add(`helper.findExactOwner(${l}.eth)`, A.uh, UH, 'findExactOwner', [dns(l + '.eth')]);
  add(`ETHRegistry.getResolver(${l})`, A.er, ER, 'getResolver', [l]);
}
add('impl.supportsInterface(0x8c2427cc IPermissionedResolver new)', A.impl, PR, 'supportsInterface', ['0x8c2427cc']);
add('impl.supportsInterface(0x91413117 old id)', A.impl, PR, 'supportsInterface', ['0x91413117']);
add('impl.supportsInterface(0x33cc44a0 Initializable)', A.impl, PR, 'supportsInterface', ['0x33cc44a0']);
const setA = encodeFunctionData({ abi: PR, functionName: 'setText', args: [dns('seller-a.eth'), 'x402-offer', ''] });
const setEmpty = encodeFunctionData({ abi: PR, functionName: 'setText', args: ['0x', 'x402-offer', 'anything'] });
add('impl.decodeSetter(setText(seller-a.eth,"x402-offer",""))', A.impl, PR, 'decodeSetter', [setA]);
add('impl.decodeSetter(setText("","x402-offer","anything"))', A.impl, PR, 'decodeSetter', [setEmpty]);
add('keccak256("x402-offer")', null);
add('UR.findResolver(pandas.eth)', A.ur, UR, 'findResolver', [dns('pandas.eth')]);
add('UR.ROOT_REGISTRY', A.ur, UR, 'ROOT_REGISTRY', []);
for (const [who, from] of [['W_vet', W_VET], ['W_ens', W_ENS]]) {
  const init = encodeFunctionData({ abi: PR, functionName: 'initialize', args: [[{ account: from, roleBitmap: BigInt('0x'+'1'.repeat(64)) }], []] });
  add(`VF.deployProxy from ${who} (salt=keccak(init)) → 予定アドレス`, A.vf, VF, 'deployProxy', [A.impl, BigInt(keccak256(init)), init], from);
}
const out = { block: B.toString(), rows: [] };
for (const [label, a] of q) {
  if (!a[0]) { out.rows.push({ label, v: keccak256(toBytes('x402-offer')) }); continue; }
  const [r0, r1] = await Promise.all([R(c0, ...a.slice(0,4), a[4]), R(c1, ...a.slice(0,4), a[4])]);
  out.rows.push({ label, sentio: r0, ethpandaops: r0 === r1 ? '(same)' : r1 });
}
fs.writeFileSync('reads_result.json', JSON.stringify(out, null, 1));
console.log('block', B); for (const r of out.rows) console.log(r.label, '|', r.v ?? r.sentio, r.ethpandaops && r.ethpandaops !== '(same)' ? ' | pandaops: ' + r.ethpandaops : (r.ethpandaops ? ' [2系統一致]' : ''));
