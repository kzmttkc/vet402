import { createRequire } from 'module'; import fs from 'fs';
const require = createRequire(import.meta.url);
const { createPublicClient, http, encodeFunctionData, decodeFunctionResult, decodeErrorResult, namehash, keccak256, toBytes, toHex, parseAbi } = require('viem');
const { sepolia } = require('viem/chains');
const RPC = 'https://sepolia.rpc.sentio.xyz';
const c = createPublicClient({ chain: sepolia, transport: http(RPC) });
const L = n => { const d = JSON.parse(fs.readFileSync(`../ur/abi/new_${n}.json`)); return d.abi ?? d; };
const PR = L('PermissionedResolverImpl'), VF = L('VerifiableFactory');
const RD = parseAbi(['function text(bytes32 node, string key) view returns (string)','function addr(bytes32 node) view returns (address)','function addr(bytes32 node, uint256 coinType) view returns (bytes)']);
const dns = n => '0x' + Buffer.concat([...n.split('.').map(x => Buffer.concat([Buffer.from([Buffer.byteLength(x)]), Buffer.from(x)])), Buffer.from([0])]).toString('hex');
const impl='0x14f09fd05d4585759e54844dc9b00147131cf243', vf='0x9e726eb570beb6bceb495ab8cda7df517d4e841c';
const W = '0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6', OP='0x00000000000000000000000000000000000000a1', OBS='0x00000000000000000000000000000000000000b1';
const ALL = BigInt('0x' + '1'.repeat(64));
const pr = (fn, args) => encodeFunctionData({ abi: PR, functionName: fn, args });
const block = await c.getBlockNumber();
const SALT_A = BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
const SALT_B = BigInt(keccak256(toBytes('tokyo-2026/grant-in-init')));
const initA = pr('initialize', [[{ account: W, roleBitmap: ALL }], [
  pr('setText', [dns('seller-a.eth'), 'x402-offer', '{"v":1}']),
  pr('setText', [dns('seller-a.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']),
  pr('setAddress', [dns('seller-a.eth'), 60n, W]),
]]);
const initBad = pr('initialize', [[{ account: W, roleBitmap: ALL }], [ pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), OP]) ]]);
const depA = encodeFunctionData({ abi: VF, functionName: 'deployProxy', args: [impl, SALT_A, initA] });
const depBad = encodeFunctionData({ abi: VF, functionName: 'deployProxy', args: [impl, SALT_B, initBad] });
const PA = decodeFunctionResult({ abi: VF, functionName: 'deployProxy', data: (await c.call({ account: W, to: vf, data: depA, blockNumber: block })).data });
// 同じ salt で initData を変えたときのアドレス
const initA2 = pr('initialize', [[{ account: W, roleBitmap: ALL }], []]);
const PA2 = decodeFunctionResult({ abi: VF, functionName: 'deployProxy', data: (await c.call({ account: W, to: vf, data: encodeFunctionData({ abi: VF, functionName: 'deployProxy', args: [impl, SALT_A, initA2] }), blockNumber: block })).data });
const obsKeys = ['class','description','x402.resource','x402.method','x402.l2','x402.declaration-sha256','x402.response-sha256','x402.purchase','x402.purchase-block','x402.observed-at','x402.source','x402.rerun','x402.pipeline-commit','x402.attested-name','x402.attested-t'];
const res = (name, fn, args) => pr('resolve', [dns(name), encodeFunctionData({ abi: RD, functionName: fn, args })]);
const steps = [
  ['A1 W deployProxy(impl, SALT_A, initialize([(W_ens,ALL)], [setText×2, setAddress(60)]))', W, vf, depA],
  ['A2 W grantSetterRoles(setText(dns(seller-a.eth),"x402-offer",""), W_op)', W, PA, pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), OP])],
  ['A3 W multicall(grantSetterRoles×15 obs keys → W_obs)', W, PA, pr('multicall', [obsKeys.map(k => pr('grantSetterRoles', [pr('setText', [dns('x.obs.vet402.eth'), k, '']), OBS]))])],
  ['A4 W setAddress(dns(atst.vet402.eth), 60, 20bytes)', W, PA, pr('setAddress', [dns('atst.vet402.eth'), 60n, '0x41000000000000000000000000000000000000a7'])],
  ['A5 OBS setAddress(dns(atst.vet402.eth), 60, evil)', OBS, PA, pr('setAddress', [dns('atst.vet402.eth'), 60n, '0x9c000000000000000000000000000000000000e1'])],
  ['A6 OBS setText(atst.vet402.eth, description)  ← 付与キーは名前を問わない', OBS, PA, pr('setText', [dns('atst.vet402.eth'), 'description', 'x'])],
  ['A7 resolve(seller-a.eth, text x402-offer)', W, PA, res('seller-a.eth', 'text', [namehash('seller-a.eth'), 'x402-offer']), 'str'],
  ['A8 resolve(seller-a.eth, addr(node))', W, PA, res('seller-a.eth', 'addr', [namehash('seller-a.eth')]), 'addr'],
  ['A9 resolve(atst.vet402.eth, addr(node))', W, PA, res('atst.vet402.eth', 'addr', [namehash('atst.vet402.eth')]), 'addr'],
  ['A10 W deployProxy(initialize の calls に grantSetterRoles)', W, vf, depBad],
  ['A11 roles(0, W_ens) on PA', W, PA, pr('roles', [0n, W]), 'roles'],
];
const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: steps.map(([, from, to, data]) => ({ from, to, data })) }], validation: false }, toHex(block)] };
const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
if (r.error) { console.log(JSON.stringify(r.error).slice(0,500)); process.exit(1); }
const ERR = [...PR, ...VF].filter(x => x.type === 'error');
const out = { rpc: RPC, block: block.toString(), PA, PA_sameSalt_emptyInit: PA2, rows: [] };
r.result[0].calls.forEach((cl, i) => {
  const [label, , , , kind] = steps[i]; const o = { step: label, status: cl.status, logs: cl.logs?.length };
  if (cl.status === '0x1' && kind) {
    const inner = kind === 'roles' ? null : decodeFunctionResult({ abi: PR, functionName: 'resolve', data: cl.returnData });
    o.value = kind === 'roles' ? '0x' + BigInt(cl.returnData).toString(16) : kind === 'str' ? decodeFunctionResult({ abi: RD, functionName: 'text', data: inner }) : decodeFunctionResult({ abi: RD, functionName: 'addr', args:[namehash('x')], data: inner });
  }
  if (cl.status !== '0x1') { try { const d = decodeErrorResult({ abi: ERR, data: cl.error?.data ?? cl.returnData }); o.revert = d.errorName + '(' + (d.args||[]).map(a => typeof a === 'bigint' ? '0x' + a.toString(16).slice(0, 10) : a).join(',') + ')'; } catch { o.revert = JSON.stringify(cl.error).slice(0, 200); } }
  out.rows.push(o);
});
fs.writeFileSync('sim2_result.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
