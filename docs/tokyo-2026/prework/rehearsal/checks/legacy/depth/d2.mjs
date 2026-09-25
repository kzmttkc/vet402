// D2: 戻り値の復号・期限切れ（2段ブロック）・namespace aliasing と record aliasing の合わせ技
import fs from 'fs';
import { viem, ABI, A, W_VET, W_ENS, RPC_S, dns, client, pr, ALL_ROLES } from '../e15/lib.mjs';
const { labelhash, keccak256, toBytes, toHex, encodeFunctionData, decodeAbiParameters, parseAbi } = viem;
const UR_ABI = (() => { const d = JSON.parse(fs.readFileSync(new URL('../../../lib/abi/UserRegistryImpl.json', import.meta.url))); return d.abi ?? d; })();
const UR_IMPL = '0xa80338aaa8d23831cea25e858d1774534abb0263';
const K_AG1 = '0x00000000000000000000000000000000000000c1';
const R_RENEW = 1n << 16n;
const c0 = client(RPC_S);
const B = await c0.getBlockNumber() - 3n;
const NOW = Number((await c0.getBlock({ blockNumber: B })).timestamp);
const ALL_ERR = [...ABI.PR, ...ABI.VF, ...ABI.ER, ...ABI.UH, ...ABI.UR, ...UR_ABI].filter(x => x.type === 'error');
const dec = d => { try { const r = viem.decodeErrorResult({ abi: ALL_ERR, data: d }); return r.errorName + '(' + (r.args || []).map(a => typeof a === 'bigint' ? '0x' + a.toString(16) : String(a)).join(',') + ')'; } catch { return 'raw:' + String(d).slice(0, 74); } };
const ur = (fn, args) => encodeFunctionData({ abi: UR_ABI, functionName: fn, args });
const er = (fn, args) => encodeFunctionData({ abi: ABI.ER, functionName: fn, args });
const uh = (fn, args) => encodeFunctionData({ abi: ABI.UH, functionName: fn, args });
const urv = (fn, args) => encodeFunctionData({ abi: ABI.UR, functionName: fn, args });
const RD = parseAbi(['function text(bytes32 node, string key) view returns (string)']);
const rd = (fn, args) => encodeFunctionData({ abi: RD, functionName: fn, args });
const nh = n => viem.namehash(n);
const decResolve = r => { try { const [b, res] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], r); const [s] = decodeAbiParameters([{ type: 'string' }], b); return JSON.stringify(s) + ' via ' + res; } catch (e) { return 'DECFAIL ' + r.slice(0, 80); } };

const TID = {};
for (const l of ['vet402', 'seller-a']) TID[l] = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B })).tokenId;

const SALT_U = BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
const SALT_A1 = BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));
const initU = ur('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }]]);
const POLICY = '{"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}';
const initA1 = pr('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', POLICY]),
  pr('setText', [dns('agent-1.vet402.eth'), 'class', 'x402-payer']),
  pr('setAddress', [dns('agent-1.vet402.eth'), 60n, K_AG1]),
]]);
const dep = (impl, salt, init) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [impl, salt, init] });
const U = '0xB093cEC6D1Cc355c40020f0df5103ecEFfD30dac';
const P_AG1 = '0xd3F4818c0bB93e54780525b21380D44D6D06bcd6';
const EXP = BigInt(NOW + 3600);
const SETUP = [
  { from: W_VET, to: A.vf, data: dep(UR_IMPL, SALT_U, initU) },
  { from: W_VET, to: A.er, data: er('setSubregistry', [TID['vet402'], U]) },
  { from: W_VET, to: A.vf, data: dep(A.impl, SALT_A1, initA1) },
  { from: W_VET, to: U, data: ur('register', ['agent-1', K_AG1, '0x0000000000000000000000000000000000000000', P_AG1, R_RENEW, EXP]) },
];
const simN = async (blocks) => {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: blocks, validation: false }, toHex(B)] };
  const j = await (await fetch(RPC_S, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (j.error) throw new Error('RPC ' + JSON.stringify(j.error).slice(0, 300));
  return j.result;
};
const show = (tag, names, calls) => calls.forEach((c, i) => {
  const ok = c.status === '0x1';
  console.log(tag, names[i], ok ? 'OK' : 'REVERT', 'gas=' + parseInt(c.gasUsed, 16), ok ? (names[i].includes('resolve') ? decResolve(c.returnData) : c.returnData.slice(0, 70)) : dec(c.error?.data ?? c.returnData));
});
const out = {};

// --- T1: 期限切れ（2段ブロック: 1段目で登録、2段目は +7200 秒）---
const READS = [
  ['findExactOwner', { from: W_VET, to: A.uh, data: uh('findExactOwner', [dns('agent-1.vet402.eth')]) }],
  ['findResolver', { from: W_VET, to: A.ur, data: urv('findResolver', [dns('agent-1.vet402.eth')]) }],
  ['resolve(text x402-policy)', { from: W_VET, to: A.ur, data: urv('resolve', [dns('agent-1.vet402.eth'), rd('text', [nh('agent-1.vet402.eth'), 'x402-policy'])]) }],
  ['getSubregistry(vet402)', { from: W_VET, to: A.er, data: er('getSubregistry', ['vet402']) }],
];
const t1 = await simN([
  { calls: [...SETUP, ...READS.map(r => r[1])] },
  { blockOverrides: { time: toHex(NOW + 7200) }, calls: READS.map(r => r[1]) },
]);
console.log('--- T1a 期限内 ---'); show('T1a', ['dep U', 'setSubregistry', 'dep P_AG1', 'register', ...READS.map(r => r[0])], t1[0].calls);
console.log('--- T1b 期限後(+7200s) ---'); show('T1b', READS.map(r => r[0]), t1[1].calls);
out.T1a = t1[0].calls.map(c => ({ status: c.status, gas: parseInt(c.gasUsed, 16), ret: c.returnData }));
out.T1b = t1[1].calls.map(c => ({ status: c.status, gas: parseInt(c.gasUsed, 16), ret: c.returnData }));

// --- T2: 取り消し（unregister）後の解決 ---
const TID_A1 = BigInt((await simN([{ calls: [...SETUP, { from: W_VET, to: U, data: ur('findTokenId', ['agent-1']) }] }]))[0].calls[4].returnData);
const t2 = await simN([{ calls: [...SETUP, { from: W_VET, to: U, data: ur('unregister', [TID_A1]) }, ...READS.map(r => r[1])] }]);
console.log('--- T2 unregister 後 ---'); show('T2', ['dep U', 'setSubregistry', 'dep P_AG1', 'register', 'unregister', ...READS.map(r => r[0])], t2[0].calls);
out.T2 = t2[0].calls.map(c => ({ status: c.status, gas: parseInt(c.gasUsed, 16), ret: c.returnData }));

// --- T3: namespace aliasing（seller-a.eth も同じ U へ）＋ record aliasing（linkToNode）---
const nodeVet = nh('agent-1.vet402.eth'), nodeSel = nh('agent-1.seller-a.eth');
const t3 = await simN([{
  calls: [...SETUP,
    { from: W_ENS, to: A.er, data: er('setSubregistry', [TID['seller-a'], U]) },
    ['a', { from: W_VET, to: A.ur, data: urv('findResolver', [dns('agent-1.seller-a.eth')]) }][1],
    { from: W_VET, to: A.ur, data: urv('resolve', [dns('agent-1.seller-a.eth'), rd('text', [nodeSel, 'x402-policy'])]) },
    { from: W_VET, to: P_AG1, data: pr('getRecordId', [nodeVet]) },
    { from: W_VET, to: P_AG1, data: pr('linkToNode', [dns('agent-1.seller-a.eth'), nodeVet]) },
    { from: W_VET, to: A.ur, data: urv('resolve', [dns('agent-1.seller-a.eth'), rd('text', [nodeSel, 'x402-policy'])]) },
  ]
}]);
console.log('--- T3 namespace aliasing + record aliasing ---');
show('T3', ['dep U', 'setSubregistry(vet402)', 'dep P_AG1', 'register', 'setSubregistry(seller-a→U)', 'findResolver(agent-1.seller-a.eth)', 'resolve(before link)', 'getRecordId(vet-node)', 'linkToNode(seller-node→vet-node)', 'resolve(after link)'], t3[0].calls);
out.T3 = t3[0].calls.map(c => ({ status: c.status, gas: parseInt(c.gasUsed, 16), ret: c.returnData }));

// --- T4: 資源ID の裏取り（委任がキー単位であること）---
out.keccak_x402policy = keccak256(toBytes('x402-policy'));
console.log('keccak("x402-policy") =', out.keccak_x402policy);
fs.writeFileSync(new URL('../../../out/d2_result.json', import.meta.url), JSON.stringify({ block: B.toString(), now: NOW, U, P_AG1, TID_A1: TID_A1.toString(), ...out }, null, 1));
