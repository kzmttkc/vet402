import fs from 'fs';
import { viem, ABI, A, W_VET, W_ENS, W_OP, W_OBS, K_ATST, RPC_S, dns, client, pr, ALL_ROLES, ATT_KEY, OBS_KEYS, decErr } from '../../../lib/common.mjs';
const { labelhash, namehash, keccak256, toBytes, toHex, encodeFunctionData, getEventSelector } = viem;
const c0 = client(RPC_S);
const B = await c0.getBlockNumber() - 3n;
const R_VET = '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
const R_SHARED = '0x49f5022dde516b92ac1609158bc6adc772088055';
const HCA_VET = '0xe96b16ab865aede373c6de768b3943fa615f173f';
const HCA_ENS = '0xd45a2e001a8e0681a7c4afa27fa88fff0fa1a5d9';
const EVMAP = {}; for (const abi of [ABI.PR, ABI.ER, ABI.VF]) for (const e of abi.filter(x => x.type === 'event')) { try { EVMAP[getEventSelector(e)] = e.name; } catch {} }
const TID = {}; for (const l of ['vet402','seller-a','seller-b','seller-c']) TID[l] = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B })).tokenId;
const setRes = (l, r) => encodeFunctionData({ abi: ABI.ER, functionName: 'setResolver', args: [TID[l], r] });
const SALT_A = BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
const SALT_BC = BigInt(keccak256(toBytes('tokyo-2026/seller-bc.eth')));
const initA = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('seller-a.eth'), 'x402-offer', '{"v":1,"amount":"10000","asset":"USDC"}']),
  pr('setText', [dns('seller-a.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']),
  pr('setText', [dns('seller-a.eth'), ATT_KEY, 'ENVELOPE_A']),
  pr('setAddress', [dns('seller-a.eth'), 60n, W_ENS]),
]]);
const initBC = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('seller-b.eth'), 'x402-offer', '{"v":1,"amount":"20000","asset":"USDC"}']),
  pr('setText', [dns('seller-b.eth'), ATT_KEY, 'ENVELOPE_B']),
  pr('setAddress', [dns('seller-b.eth'), 60n, W_ENS]),
  pr('setText', [dns('seller-c.eth'), 'x402-offer', '{"v":1,"amount":"30000","asset":"USDC"}']),
  pr('setText', [dns('seller-c.eth'), ATT_KEY, 'ENVELOPE_C']),
  pr('setAddress', [dns('seller-c.eth'), 60n, W_ENS]),
]]);
const dep = (salt, init) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [A.impl, salt, init] });
const P_A = '0xC54403186Db35B9D92cc393Ae665D3960117ac14';
const P_BC = '0xd6A089Fc08e5e97697a3293d02F40837CeA1d2bf';
const K1 = [
  ['K1-01', 'W_vet', R_VET,  'revokeRootRoles(ALL, HCA_vet)', pr('revokeRootRoles', [ALL_ROLES, HCA_VET]), 'app.ens.dev のスマートアカウントを R_vet の root から外す'],
  ['K1-02', 'W_vet', R_VET,  'multicall[setText(vet402.eth,agent-endpoint[x402]) / setText(vet402.eth,class) / setAddress(atst.vet402.eth,60,K_atst)]', pr('multicall', [[
        pr('setText', [dns('vet402.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo']),
        pr('setText', [dns('vet402.eth'), 'class', 'x402-verifier']),
        pr('setAddress', [dns('atst.vet402.eth'), 60n, K_ATST])]]), 'attester の鍵を ENS に置く。K1-01 の後'],
  ['K1-03', 'W_vet', R_VET,  'multicall[grantSetterRoles(setText(*,key_i,""), W_obs) ×15]', pr('multicall', [OBS_KEYS.map(k => pr('grantSetterRoles', [pr('setText', [dns('x.obs.vet402.eth'), k, '']), W_OBS]))]), '観測ログの 15 キーだけを W_obs に委任。ResourceArgument が 15 本残る'],
  ['K1-04', 'W_ens', A.vf,   'deployProxy(impl, SALT_A, initA)  → P_a', dep(SALT_A, initA), 'seller-a 専用リゾルバ。記録も initialize の calls で同時に置く。root は W_ens だけ'],
  ['K1-05', 'W_ens', A.er,   'setResolver(tokenId(seller-a), P_a)', setRes('seller-a', P_A), 'K1-04 に依存。アドレスは送り手＋salt で先に決まる'],
  ['K1-06', 'W_ens', P_A,    'grantSetterRoles(setText(dns("seller-a.eth"),"x402-offer",""), W_op)', pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), W_OP]), 'K1-04 に依存。initialize の calls に入れると revert（E12）'],
  ['K1-07', 'W_ens', A.vf,   'deployProxy(impl, SALT_BC, initBC) → P_bc', dep(SALT_BC, initBC), 'seller-b/c 共用。記録 ID は b=1・c=2 で確定（E9 実測）'],
  ['K1-08', 'W_ens', A.er,   'setResolver(tokenId(seller-b), P_bc)', setRes('seller-b', P_BC), 'K1-07 に依存'],
  ['K1-09', 'W_ens', A.er,   'setResolver(tokenId(seller-c), P_bc)', setRes('seller-c', P_BC), 'K1-07 に依存'],
];
const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: K1.map(r => ({ from: r[1] === 'W_vet' ? W_VET : W_ENS, to: r[2], data: r[4] })) }], validation: false }, toHex(B)] };
const j = await (await fetch(RPC_S, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
if (j.error) { console.log('RPC ERROR', JSON.stringify(j.error).slice(0, 400)); process.exit(1); }
let total = 0; const rows = [];
j.result[0].calls.forEach((cl, i) => {
  const [id, from, to, fn, , note] = K1[i]; const gas = parseInt(cl.gasUsed, 16); total += gas;
  const o = { id, from, to, fn, status: cl.status === '0x1' ? 'OK' : 'REVERT', gas, logs: (cl.logs || []).map(l => EVMAP[l.topics[0]] ?? l.topics[0].slice(0, 10)), note };
  if (cl.status !== '0x1') o.revert = decErr(cl.error?.data ?? cl.returnData);
  rows.push(o); console.log(id, from, o.status, 'gas=' + gas, o.revert ?? '', '[' + o.logs.join(',') + ']');
});
console.log('total gas', total, '/ tx 本数', rows.length);
fs.writeFileSync(new URL('../../../out/k1_result.json', import.meta.url), JSON.stringify({ block: B.toString(), totalGas: total, txCount: rows.length, P_A, P_BC, tokenIds: Object.fromEntries(Object.entries(TID).map(([k,v])=>[k,v.toString()])), rows }, null, 1));
