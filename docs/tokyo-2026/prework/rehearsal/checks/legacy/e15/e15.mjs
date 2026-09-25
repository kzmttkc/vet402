import fs from 'fs';
import { viem, viemEns, viemVersion, sepolia as sepoliaChain, ABI, A, W_VET, W_ENS, W_OP, W_OP2, W_OBS, K_ATST, RPC_S, RPC_P, dns, J, client, pr, ALL_ROLES, ROLE_SET_TEXT, ROLE_LINK, RD, ATT_KEY, OBS_KEYS, decErr } from '../../../lib/common.mjs';
const { labelhash, namehash, keccak256, toBytes, toHex, encodeFunctionData, decodeFunctionResult, getEventSelector } = viem;

const c0 = client(RPC_S), c1 = client(RPC_P);
const B = (await Promise.all([c0.getBlockNumber(), c1.getBlockNumber()])).reduce((a, b) => a < b ? a : b) - 3n;
const out = { generated: new Date().toISOString(), block: B.toString(), viem: viemVersion, rpc: { sim: RPC_S, read: [RPC_S, RPC_P] }, E: {} };
console.log('block', B.toString(), 'viem', viemVersion);

// --- 実測の現状（census より）---
const R_VET = '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
const R_SHARED = '0x49f5022dde516b92ac1609158bc6adc772088055';
const HCA_VET = '0xe96b16ab865aede373c6de768b3943fa615f173f';
const HCA_ENS = '0xd45a2e001a8e0681a7c4afa27fa88fff0fa1a5d9';
const TOKEN = { 'vet402': 62442718561905417230530276091601288486512477373694512112238348556180211073024n };

// event topic0 -> name
const EVMAP = {};
for (const abi of [ABI.PR, ABI.ER, ABI.VF, ABI.ROOT]) for (const e of abi.filter(x => x.type === 'event')) {
  try { EVMAP[getEventSelector(e)] = e.name; } catch {}
}
const evName = t => EVMAP[t] ?? t.slice(0, 12);

const readBoth = async (label, address, abi, fn, args = [], account) => {
  const go = async c => { try { return J(await c.readContract({ address, abi, functionName: fn, args, blockNumber: B, ...(account ? { account } : {}) })); } catch (e) { return 'ERR:' + (e.shortMessage || e.message).split('\n')[0].slice(0, 160); } };
  const [a, b] = await Promise.all([go(c0), go(c1)]);
  console.log(' ', label, '|', a, a === b ? '[2系統一致]' : '| pandaops: ' + b);
  return { label, value: a, match: a === b, pandaops: a === b ? '(same)' : b };
};

const simulate = async (steps, label) => {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: steps.map(s => ({ from: s.from, to: s.to, data: s.data })) }], validation: false, traceTransfers: false }, toHex(B)] };
  const r = await (await fetch(RPC_S, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (r.error) { console.log(label, 'RPC ERROR', JSON.stringify(r.error).slice(0, 400)); return [{ ERR: r.error }]; }
  return r.result[0].calls.map((cl, i) => {
    const s = steps[i];
    const o = { step: s.label, from: s.from, to: s.to, sel: s.data.slice(0, 10), status: cl.status === '0x1' ? 'OK' : 'REVERT', gas: parseInt(cl.gasUsed, 16), logs: (cl.logs || []).map(l => evName(l.topics[0])) };
    if (cl.status === '0x1' && s.dec) { try { o.value = s.dec(cl.returnData); } catch (e) { o.value = 'decode-err:' + e.message.slice(0, 80); } }
    if (cl.status !== '0x1') o.revert = decErr(cl.error?.data ?? cl.returnData);
    o.expect = s.expect;
    o.ok = s.expect ? (s.expect.startsWith('REVERT') ? (o.status === 'REVERT' && (o.revert || '').startsWith(s.expect.slice(7))) : o.status === 'OK') : null;
    return o;
  });
};
const show = (k, rows) => { out.E[k] = rows; console.log('\n##', k); for (const r of rows) console.log('  ', r.step ?? r.label, '|', r.status ?? '', r.revert ?? (r.value !== undefined ? JSON.stringify(r.value) : ''), r.logs ? '[' + r.logs.join(',') + ']' : '', r.gas ? 'gas=' + r.gas : '', r.ok === false ? '  <<< 期待とちがう' : ''); };

const decStr = (fnAbi, fn, args) => data => { const inner = decodeFunctionResult({ abi: ABI.UR, functionName: 'resolve', data })[0]; return inner === '0x' ? '(empty)' : decodeFunctionResult({ abi: fnAbi, functionName: fn, args, data: inner }); };
const urText = name => ({ to: A.ur, data: encodeFunctionData({ abi: ABI.UR, functionName: 'resolve', args: [dns(name), encodeFunctionData({ abi: RD, functionName: 'text', args: [namehash(name), 'x402-offer'] })] }), dec: decStr(RD, 'text') });
const urTextKey = (name, key) => ({ to: A.ur, data: encodeFunctionData({ abi: ABI.UR, functionName: 'resolve', args: [dns(name), encodeFunctionData({ abi: RD, functionName: 'text', args: [namehash(name), key] })] }), dec: decStr(RD, 'text') });
const urAddr = name => ({ to: A.ur, data: encodeFunctionData({ abi: ABI.UR, functionName: 'resolve', args: [dns(name), encodeFunctionData({ abi: RD, functionName: 'addr', args: [namehash(name)] })] }), dec: decStr(RD, 'addr', [namehash(name)]) });

// ===== E1 =====
show('E1', await Promise.all([
  readBoth('UR.ROOT_REGISTRY()', A.ur, ABI.UR, 'ROOT_REGISTRY'),
  readBoth('UH.ROOT_REGISTRY()', A.uh, ABI.UH, 'ROOT_REGISTRY'),
  readBoth('Root.getSubregistry("eth")', A.root, ABI.ROOT, 'getSubregistry', ['eth']),
  readBoth('impl.supportsInterface(0x8c2427cc)', A.impl, ABI.PR, 'supportsInterface', ['0x8c2427cc']),
]));

// ===== E2 =====
const e2 = [];
for (const [l, o] of [['vet402', W_VET], ['seller-a', W_ENS], ['seller-b', W_ENS], ['seller-c', W_ENS]]) {
  e2.push(await readBoth(`isAvailable(${l})`, A.rg, ABI.RG, 'isAvailable', [l]));
  e2.push(await readBoth(`getState(${l})`, A.er, ABI.ER, 'getState', [BigInt(labelhash(l))]));
  e2.push(await readBoth(`findExactOwner(${l}.eth) 期待=${o}`, A.uh, ABI.UH, 'findExactOwner', [dns(l + '.eth')]));
}
show('E2', e2);

// ===== E3 =====
show('E3', [
  await readBoth('UH.findExactOwner(x.obs.vet402.eth)', A.uh, ABI.UH, 'findExactOwner', [dns('x.obs.vet402.eth')]),
  await readBoth('UH.findNearestOwner(x.obs.vet402.eth)', A.uh, ABI.UH, 'findNearestOwner', [dns('x.obs.vet402.eth')]),
  await readBoth('UH.findExactOwner(atst.vet402.eth)', A.uh, ABI.UH, 'findExactOwner', [dns('atst.vet402.eth')]),
]);

// ===== E4: 予定アドレス =====
const SALT_A = BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
const SALT_BC = BigInt(keccak256(toBytes('tokyo-2026/seller-bc.eth')));
const OFFER_A = '{"v":1,"amount":"10000","asset":"USDC"}';
const initA = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A]),
  pr('setText', [dns('seller-a.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']),
  pr('setAddress', [dns('seller-a.eth'), 60n, W_ENS]),
]]);
const initBC = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('seller-b.eth'), 'x402-offer', '{"v":1,"amount":"20000"}']),
  pr('setText', [dns('seller-b.eth'), ATT_KEY, 'ENVELOPE_B']),
  pr('setText', [dns('seller-c.eth'), 'x402-offer', '{"v":1,"amount":"30000"}']),
  pr('setText', [dns('seller-c.eth'), ATT_KEY, 'ENVELOPE_C']),
]]);
const initA_empty = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], []]);
const dep = (salt, init) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [A.impl, salt, init] });
const callAddr = async (from, data) => decodeFunctionResult({ abi: ABI.VF, functionName: 'deployProxy', data: (await c0.call({ account: from, to: A.vf, data, blockNumber: B })).data });
const P_A = await callAddr(W_ENS, dep(SALT_A, initA));
const P_A2 = await callAddr(W_ENS, dep(SALT_A, initA_empty));
const P_BC = await callAddr(W_ENS, dep(SALT_BC, initBC));
const P_A_from_vet = await callAddr(W_VET, dep(SALT_A, initA));
show('E4', [
  { step: 'deployProxy(impl,SALT_A,initA) from W_ens → P_a', status: 'OK', value: P_A },
  { step: 'deployProxy(impl,SALT_A,init空) from W_ens（initData 非依存の確認）', status: 'OK', value: P_A2, ok: P_A2 === P_A },
  { step: 'deployProxy(impl,SALT_BC,initBC) from W_ens → P_bc', status: 'OK', value: P_BC },
  { step: 'deployProxy(impl,SALT_A,initA) from W_vet（送り手で変わる確認）', status: 'OK', value: P_A_from_vet, ok: P_A_from_vet !== P_A },
]);
out.addresses = { P_A, P_BC, R_VET, R_SHARED, HCA_VET, HCA_ENS, SALT_A: '0x' + SALT_A.toString(16), SALT_BC: '0x' + SALT_BC.toString(16) };

// tokenId は census の getState から
const st = async l => await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B });
const TID = {}; for (const l of ['vet402', 'seller-a', 'seller-b', 'seller-c']) TID[l] = (await st(l)).tokenId;
out.tokenIds = Object.fromEntries(Object.entries(TID).map(([k, v]) => [k, v.toString()]));
const setRes = (l, r) => encodeFunctionData({ abi: ABI.ER, functionName: 'setResolver', args: [TID[l], r] });

// ===== E5 =====
show('E5', await simulate([
  { label: 'W_ens setResolver(seller-a → P_a)', from: W_ENS, to: A.er, data: setRes('seller-a', P_A), expect: 'OK' },
  { label: 'W_op setResolver(seller-a → P_a)', from: W_OP, to: A.er, data: setRes('seller-a', P_A), expect: 'REVERT:EACUnauthorizedAccountRoles' },
]));

// ===== E6+E7+E8+E15: 1本の連鎖 =====
const chainA = [
  { label: 'E6-1 deployProxy(P_a)', from: W_ENS, to: A.vf, data: dep(SALT_A, initA), expect: 'OK' },
  { label: 'E6-2 setResolver(seller-a → P_a)', from: W_ENS, to: A.er, data: setRes('seller-a', P_A), expect: 'OK' },
  { label: 'E6-3 grantSetterRoles(setText(seller-a.eth,"x402-offer",""), W_op)', from: W_ENS, to: P_A, data: pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), W_OP]), expect: 'OK' },
  { label: 'E6-4 roles(keccak("x402-offer"), W_op)', from: W_ENS, to: P_A, data: pr('roles', [BigInt(keccak256(toBytes('x402-offer'))), W_OP]), dec: d => '0x' + BigInt(d).toString(16), expect: 'OK' },
  { label: 'E7-1 W_op setText(seller-a.eth,"x402-offer",...10001...)', from: W_OP, to: P_A, data: pr('setText', [dns('seller-a.eth'), 'x402-offer', '{"v":1,"amount":"10001","asset":"USDC"}']), expect: 'OK' },
  { label: 'E7-2 UR.resolve(seller-a.eth, text x402-offer)', from: W_ENS, ...urText('seller-a.eth'), expect: 'OK' },
  { label: 'E8-1 W_op setText(seller-a.eth, attestations[...])', from: W_OP, to: P_A, data: pr('setText', [dns('seller-a.eth'), ATT_KEY, 'x']), expect: 'REVERT:EACUnauthorizedAccountRoles' },
  { label: 'E8-2 W_op setText(seller-b.eth,"x402-offer") on 共有リゾルバ R_shared', from: W_OP, to: R_SHARED, data: pr('setText', [dns('seller-b.eth'), 'x402-offer', 'x']), expect: 'REVERT:EACUnauthorizedAccountRoles' },
  { label: 'E8-2a W_ens deployProxy(P_bc)（別リゾルバを立てる）', from: W_ENS, to: A.vf, data: dep(SALT_BC, initBC), expect: 'OK' },
  { label: 'E8-2b W_op setText(seller-b.eth,"x402-offer") on P_bc（配備済みの別リゾルバ）', from: W_OP, to: P_BC, data: pr('setText', [dns('seller-b.eth'), 'x402-offer', 'x']), expect: 'REVERT:EACUnauthorizedAccountRoles' },
  { label: 'E8-3 W_op linkToRecord(seller-a.eth, 0) on P_a', from: W_OP, to: P_A, data: pr('linkToRecord', [dns('seller-a.eth'), 0n]), expect: 'REVERT:EACUnauthorizedAccountRoles' },
  { label: 'E8-4 W_op grantSetterRoles(... , W_op2)', from: W_OP, to: P_A, data: pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), W_OP2]), expect: 'REVERT:EACCannotGrantRoles' },
  { label: 'E8-5 W_op grantRoles(keccak("x402-offer"),0x10,W_op2)', from: W_OP, to: P_A, data: pr('grantRoles', [BigInt(keccak256(toBytes('x402-offer'))), ROLE_SET_TEXT, W_OP2]), expect: 'REVERT:EACCannotGrantRoles' },
  { label: 'E8-6 W_op が同じリゾルバの別 node に書ける（開示の確認）', from: W_OP, to: P_A, data: pr('setText', [dns('zz.seller-a.eth'), 'x402-offer', 'leak']), expect: 'OK' },
  { label: 'E15-1 W_ens revokeRoles(keccak("x402-offer"),0x10,W_op)', from: W_ENS, to: P_A, data: pr('revokeRoles', [BigInt(keccak256(toBytes('x402-offer'))), ROLE_SET_TEXT, W_OP]), expect: 'OK' },
  { label: 'E15-2 W_op setText（取り消し後）', from: W_OP, to: P_A, data: pr('setText', [dns('seller-a.eth'), 'x402-offer', 'after-revoke']), expect: 'REVERT:EACUnauthorizedAccountRoles' },
];
show('E6_E7_E8_E15', await simulate(chainA));

// ===== E9: 新しい P_bc を作る道 =====
show('E9_newP_bc', await simulate([
  { label: 'E9-1 deployProxy(P_bc, initBC: b/c の記録)', from: W_ENS, to: A.vf, data: dep(SALT_BC, initBC), expect: 'OK' },
  { label: 'E9-2 setResolver(seller-b → P_bc)', from: W_ENS, to: A.er, data: setRes('seller-b', P_BC), expect: 'OK' },
  { label: 'E9-3 setResolver(seller-c → P_bc)', from: W_ENS, to: A.er, data: setRes('seller-c', P_BC), expect: 'OK' },
  { label: 'E9-4 getRecordId(namehash(seller-b.eth)) = R_b', from: W_ENS, to: P_BC, data: pr('getRecordId', [namehash('seller-b.eth')]), dec: d => BigInt(d).toString(), expect: 'OK' },
  { label: 'E9-5 getRecordId(namehash(seller-c.eth)) = R_c', from: W_ENS, to: P_BC, data: pr('getRecordId', [namehash('seller-c.eth')]), dec: d => BigInt(d).toString(), expect: 'OK' },
  { label: 'E9-6 linkToRecord(seller-b.eth, 0) 切り離し', from: W_ENS, to: P_BC, data: pr('linkToRecord', [dns('seller-b.eth'), 0n]), expect: 'OK' },
  { label: 'E9-7 UR.resolve(seller-b.eth, x402-offer) → ""', from: W_ENS, ...urText('seller-b.eth'), expect: 'OK' },
  { label: 'E9-7b UR.resolve(seller-b.eth, attestations[...]) → ""', from: W_ENS, ...urTextKey('seller-b.eth', ATT_KEY), expect: 'OK' },
  { label: 'E9-8 linkToRecord(seller-b.eth, 1) 戻す', from: W_ENS, to: P_BC, data: pr('linkToRecord', [dns('seller-b.eth'), 1n]), expect: 'OK' },
  { label: 'E9-9 UR.resolve(seller-b.eth, x402-offer) 戻った', from: W_ENS, ...urText('seller-b.eth'), expect: 'OK' },
  { label: 'E9-10 linkToRecord(seller-c.eth, R_b=1)', from: W_ENS, to: P_BC, data: pr('linkToRecord', [dns('seller-c.eth'), 1n]), expect: 'OK' },
  { label: 'E9-11 UR.resolve(seller-c.eth, x402-offer) = seller-b の値', from: W_ENS, ...urText('seller-c.eth'), expect: 'OK' },
  { label: 'E9-12 UR.resolve(seller-c.eth, attestations[...]) = ENVELOPE_B', from: W_ENS, ...urTextKey('seller-c.eth', ATT_KEY), expect: 'OK' },
  { label: 'E9-13 linkToRecord(seller-c.eth, R_c=2) 戻す', from: W_ENS, to: P_BC, data: pr('linkToRecord', [dns('seller-c.eth'), 2n]), expect: 'OK' },
  { label: 'E9-14 UR.resolve(seller-c.eth, x402-offer) 戻った', from: W_ENS, ...urText('seller-c.eth'), expect: 'OK' },
]));

// ===== E9b: いまの共有リゾルバ R_shared をそのまま使う道 =====
show('E9b_existingShared', await simulate([
  { label: 'E9b-0 W_ens setText(seller-b.eth, x402-offer) on R_shared', from: W_ENS, to: R_SHARED, data: pr('setText', [dns('seller-b.eth'), 'x402-offer', '{"v":1,"amount":"20000"}']), expect: 'OK' },
  { label: 'E9b-0b W_ens setText(seller-b.eth, attestations[...]) on R_shared', from: W_ENS, to: R_SHARED, data: pr('setText', [dns('seller-b.eth'), ATT_KEY, 'ENVELOPE_B']), expect: 'OK' },
  { label: 'E9b-0c W_ens setText(seller-c.eth, x402-offer) on R_shared', from: W_ENS, to: R_SHARED, data: pr('setText', [dns('seller-c.eth'), 'x402-offer', '{"v":1,"amount":"30000"}']), expect: 'OK' },
  { label: 'E9b-1 getRecordId(seller-b.eth) 実測 R_b', from: W_ENS, to: R_SHARED, data: pr('getRecordId', [namehash('seller-b.eth')]), dec: d => BigInt(d).toString(), expect: 'OK' },
  { label: 'E9b-2 getRecordId(seller-c.eth) 実測 R_c', from: W_ENS, to: R_SHARED, data: pr('getRecordId', [namehash('seller-c.eth')]), dec: d => BigInt(d).toString(), expect: 'OK' },
  { label: 'E9b-3 linkToRecord(seller-b.eth, 0)', from: W_ENS, to: R_SHARED, data: pr('linkToRecord', [dns('seller-b.eth'), 0n]), expect: 'OK' },
  { label: 'E9b-4 UR.resolve(seller-b.eth, x402-offer)', from: W_ENS, ...urText('seller-b.eth'), expect: 'OK' },
  { label: 'E9b-4b UR.resolve(seller-b.eth, addr) 切り離し後', from: W_ENS, ...urAddr('seller-b.eth'), expect: 'OK' },
  { label: 'E9b-5 linkToRecord(seller-b.eth, 2) 戻す', from: W_ENS, to: R_SHARED, data: pr('linkToRecord', [dns('seller-b.eth'), 2n]), expect: 'OK' },
  { label: 'E9b-6 linkToRecord(seller-c.eth, 2) = seller-b の箱', from: W_ENS, to: R_SHARED, data: pr('linkToRecord', [dns('seller-c.eth'), 2n]), expect: 'OK' },
  { label: 'E9b-7 UR.resolve(seller-c.eth, x402-offer) = b の値', from: W_ENS, ...urText('seller-c.eth'), expect: 'OK' },
  { label: 'E9b-7b UR.resolve(seller-c.eth, attestations[...]) = ENVELOPE_B', from: W_ENS, ...urTextKey('seller-c.eth', ATT_KEY), expect: 'OK' },
  { label: 'E9b-8 linkToRecord(seller-c.eth, 3) 戻す', from: W_ENS, to: R_SHARED, data: pr('linkToRecord', [dns('seller-c.eth'), 3n]), expect: 'OK' },
  { label: 'E9b-9 UR.resolve(seller-c.eth, x402-offer) 戻った', from: W_ENS, ...urText('seller-c.eth'), expect: 'OK' },
  { label: 'E9b-10 W_ens が R_shared で seller-a も書ける（分離できていない確認）', from: W_ENS, to: R_SHARED, data: pr('setText', [dns('seller-a.eth'), 'x402-offer', 'cross']), expect: 'OK' },
]));

// ===== E10 =====
show('E10', await simulate([
  { label: 'E10-1 linkToRecord(seller-b.eth, 0)', from: W_ENS, to: R_SHARED, data: pr('linkToRecord', [dns('seller-b.eth'), 0n]), expect: 'OK' },
  { label: 'E10-2 linkToNode(seller-c.eth, namehash(seller-b.eth))', from: W_ENS, to: R_SHARED, data: pr('linkToNode', [dns('seller-c.eth'), namehash('seller-b.eth')]), expect: 'REVERT:InvalidRecord' },
  { label: 'E10-3 逆順: linkToNode(seller-c.eth, namehash(seller-b.eth)) を先に', from: W_ENS, to: R_SHARED, data: pr('linkToNode', [dns('seller-c.eth'), namehash('seller-b.eth')]), expect: 'REVERT' },
]));

// ===== E11 =====
show('E11', await simulate([
  { label: 'E11-1 W_vet setAddress(atst.vet402.eth, 60, K_atst) on R_vet', from: W_VET, to: R_VET, data: pr('setAddress', [dns('atst.vet402.eth'), 60n, K_ATST]), expect: 'OK' },
  { label: 'E11-2 W_vet multicall(grantSetterRoles ×15 obs keys → W_obs)', from: W_VET, to: R_VET, data: pr('multicall', [OBS_KEYS.map(k => pr('grantSetterRoles', [pr('setText', [dns('x.obs.vet402.eth'), k, '']), W_OBS]))]), expect: 'OK' },
  { label: 'E11-3 W_obs setText(a1.obs.vet402.eth, "x402.l2", "conform")', from: W_OBS, to: R_VET, data: pr('setText', [dns('a1.obs.vet402.eth'), 'x402.l2', 'conform']), expect: 'OK' },
  { label: 'E11-4 W_obs setAddress(atst.vet402.eth, 60, W_obs) ← 守られる', from: W_OBS, to: R_VET, data: pr('setAddress', [dns('atst.vet402.eth'), 60n, W_OBS]), expect: 'REVERT:EACUnauthorizedAccountRoles' },
  { label: 'E11-5 W_obs setText(vet402.eth, "x402.l2") ← 同じキーは名前を問わず書ける（開示）', from: W_OBS, to: R_VET, data: pr('setText', [dns('vet402.eth'), 'x402.l2', 'leak']), expect: 'OK' },
  { label: 'E11-6 UR.resolve(atst.vet402.eth, addr) = K_atst', from: W_VET, ...urAddr('atst.vet402.eth'), expect: 'OK' },
]));

// ===== E12 =====
const initBad = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), W_OP])]]);
show('E12', await simulate([
  { label: 'E12 deployProxy(initialize の calls に grantSetterRoles)', from: W_ENS, to: A.vf, data: dep(BigInt(keccak256(toBytes('tokyo-2026/grant-in-init'))), initBad), expect: 'REVERT:EACCannotGrantRoles' },
]));

// ===== E13 =====
const e13reads = [
  await readBoth('R_vet.isOnlyAssignee(0, ALL, W_vet)', R_VET, ABI.PR, 'isOnlyAssignee', [0n, ALL_ROLES, W_VET]),
  await readBoth('R_vet.hasRootRoles(ALL, HCA_vet)', R_VET, ABI.PR, 'hasRootRoles', [ALL_ROLES, HCA_VET]),
  await readBoth('R_shared.isOnlyAssignee(0, ALL, W_ens)', R_SHARED, ABI.PR, 'isOnlyAssignee', [0n, ALL_ROLES, W_ENS]),
  await readBoth('R_shared.hasRootRoles(ALL, HCA_ens)', R_SHARED, ABI.PR, 'hasRootRoles', [ALL_ROLES, HCA_ENS]),
];
const e13sim = await simulate([
  { label: 'E13-0a HCA_vet setText on R_vet（剥がす前）', from: HCA_VET, to: R_VET, data: pr('setText', [dns('vet402.eth'), 'x402-offer', 'hca-can-write']), expect: 'OK' },
  { label: 'E13-0b HCA_ens setText on R_shared（剥がす前）', from: HCA_ENS, to: R_SHARED, data: pr('setText', [dns('seller-b.eth'), 'x402-offer', 'hca-can-write']), expect: 'OK' },
  { label: 'E13-1 W_vet revokeRootRoles(ALL, HCA_vet) on R_vet', from: W_VET, to: R_VET, data: pr('revokeRootRoles', [ALL_ROLES, HCA_VET]), expect: 'OK' },
  { label: 'E13-2 R_vet.isOnlyAssignee(0, ALL, W_vet) 剥がした後', from: W_VET, to: R_VET, data: pr('isOnlyAssignee', [0n, ALL_ROLES, W_VET]), dec: d => BigInt(d) === 1n, expect: 'OK' },
  { label: 'E13-3 W_ens revokeRootRoles(ALL, HCA_ens) on R_shared', from: W_ENS, to: R_SHARED, data: pr('revokeRootRoles', [ALL_ROLES, HCA_ENS]), expect: 'OK' },
  { label: 'E13-4 R_shared.isOnlyAssignee(0, ALL, W_ens) 剥がした後', from: W_ENS, to: R_SHARED, data: pr('isOnlyAssignee', [0n, ALL_ROLES, W_ENS]), dec: d => BigInt(d) === 1n, expect: 'OK' },
  { label: 'E13-5 HCA_vet setText on R_vet（剥がした後）', from: HCA_VET, to: R_VET, data: pr('setText', [dns('vet402.eth'), 'x402-offer', 'after-revoke']), expect: 'REVERT:EACUnauthorizedAccountRoles' },
  { label: 'E13-6 HCA_ens setText on R_shared（剥がした後）', from: HCA_ENS, to: R_SHARED, data: pr('setText', [dns('seller-b.eth'), 'x402-offer', 'after-revoke']), expect: 'REVERT:EACUnauthorizedAccountRoles' },
]);
show('E13', [...e13reads, ...e13sim]);

// ===== E14 =====
const e14 = { viem: viemVersion, sepoliaUR: sepoliaChain?.contracts?.ensUniversalResolver?.address, rows: [] };
for (const [rpcTag, c] of [['sentio', c0], ['pandaops', c1]]) {
  for (const n of ['vet402.eth', 'seller-a.eth', 'seller-b.eth', 'seller-c.eth']) {
    const r = async f => { try { return await f(); } catch (e) { return 'ERR:' + (e.shortMessage || e.message).split('\n')[0].slice(0, 90); } };
    e14.rows.push({ rpc: rpcTag, name: n,
      resolver: await r(() => c.getEnsResolver({ name: viemEns.normalize(n), blockNumber: B })),
      addr: await r(() => c.getEnsAddress({ name: viemEns.normalize(n), blockNumber: B })),
      text: await r(() => c.getEnsText({ name: viemEns.normalize(n), key: 'x402-offer', blockNumber: B })) });
  }
}
const LR = ABI.ER.find(x => x.type === 'event' && x.name === 'LabelRegistered');
for (const [tag, c] of [['sentio', c0], ['pandaops', c1]]) {
  try { const lg = await c.getLogs({ address: A.er, event: LR, fromBlock: 11721400n, toBlock: 11721700n }); e14.rows.push({ rpc: tag, canary: 'LabelRegistered 11721400-11721700', count: lg.length, labels: lg.map(l => l.args.label + '@' + l.blockNumber) }); }
  catch (e) { e14.rows.push({ rpc: tag, canary: 'ERR:' + (e.shortMessage || e.message).slice(0, 120) }); }
}
out.E.E14 = e14; console.log('\n## E14'); for (const r of e14.rows) console.log('  ', JSON.stringify(r));

out.accountCode = { W_vet: (await c0.getCode({ address: W_VET }) ?? '0x').length, W_ens: (await c0.getCode({ address: W_ENS }) ?? '0x').length, HCA_vet: (await c0.getCode({ address: HCA_VET }) ?? '0x').length, HCA_ens: (await c0.getCode({ address: HCA_ENS }) ?? '0x').length };
console.log('\naccountCode hexlen', JSON.stringify(out.accountCode));
fs.writeFileSync(new URL('../../../out/e15_result.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('\nwrote e15_result.json');
