// TM-1: K1-01〜K1-15 を「1本の eth_simulateV1」で通す（H2）＋ 命題3・命題4 の読み取りを同じ連鎖の末尾に付ける
import fs from 'fs';
import { viem, ABI, A, W_VET, W_ENS, W_OP, W_OBS, K_ATST, RPC_S, RPC_P, dns, client, pr, ALL_ROLES, ATT_KEY, OBS_KEYS } from '/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad/e15/lib.mjs';
const { labelhash, namehash, keccak256, toBytes, toHex, encodeFunctionData, getEventSelector, parseAbi, decodeAbiParameters } = viem;

const UR_ABI = (() => { const d = JSON.parse(fs.readFileSync('/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad/ur/abi/new_UserRegistryImpl.json')); return d.abi ?? d; })();
const UR_IMPL = '0xa80338aaa8d23831cea25e858d1774534abb0263';
const R_VET = '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
const HCA_VET = '0xe96b16ab865aede373c6de768b3943fa615f173f';
const K_AG1 = '0x41000000000000000000000000000000000000c1';
const K_AG2 = '0x41000000000000000000000000000000000000c2';
const ROLE_RENEW = 1n << 16n;
const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;

const RPC = process.env.RPC === 'P' ? RPC_P : RPC_S;
const FIXB = process.env.FIXB ? BigInt(process.env.FIXB) : null;
const c0 = client(RPC);
const B = FIXB ?? (await c0.getBlockNumber() - 3n);
const NOW = Number((await c0.getBlock({ blockNumber: B })).timestamp);
const EXP = BigInt(NOW + 7 * 86400);

const ALL_ERR = [...ABI.PR, ...ABI.VF, ...ABI.ER, ...ABI.UH, ...ABI.UR, ...ABI.RG, ...UR_ABI].filter(x => x.type === 'error');
const dec = d => { try { const r = viem.decodeErrorResult({ abi: ALL_ERR, data: d }); return r.errorName + '(' + (r.args || []).map(a => typeof a === 'bigint' ? '0x' + a.toString(16) : String(a)).join(',') + ')'; } catch { return 'raw:' + String(d).slice(0, 74); } };
const EVMAP = {}; for (const abi of [ABI.PR, ABI.ER, ABI.VF, UR_ABI]) for (const e of abi.filter(x => x.type === 'event')) { try { EVMAP[getEventSelector(e)] = e.name; } catch {} }
const ur = (fn, args) => encodeFunctionData({ abi: UR_ABI, functionName: fn, args });
const er = (fn, args) => encodeFunctionData({ abi: ABI.ER, functionName: fn, args });
const urv = (fn, args) => encodeFunctionData({ abi: ABI.UR, functionName: fn, args });
const RD = parseAbi(['function addr(bytes32 node) view returns (address)', 'function text(bytes32 node, string key) view returns (string)']);
const rd = (fn, args) => encodeFunctionData({ abi: RD, functionName: fn, args });
const decAddr = r => { try { const [b, res] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], r); const [a] = decodeAbiParameters([{ type: 'address' }], b); return a + ' via ' + res; } catch { return 'EMPTY/raw ' + r.slice(0, 50); } };
const decText = r => { try { const [b] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], r); const [s] = decodeAbiParameters([{ type: 'string' }], b); return JSON.stringify(s); } catch { return 'EMPTY/raw ' + r.slice(0, 50); } };

const TID = {}; for (const l of ['vet402', 'seller-a', 'seller-b', 'seller-c']) TID[l] = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B })).tokenId;
const setRes = (l, r) => er('setResolver', [TID[l], r]);

const SALT_A = BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
const SALT_BC = BigInt(keccak256(toBytes('tokyo-2026/seller-bc.eth')));
const SALT_U = BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
const SALT_A1 = BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));

const OFFER_A = '{"v":1,"amount":"10000","asset":"USDC"}';
const POLICY = '{"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}';

const initA = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A]),
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
const initU = ur('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }]]);
const initA1 = pr('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', POLICY]),
  pr('setText', [dns('agent-1.vet402.eth'), 'class', 'x402-agent']),
  pr('setAddress', [dns('agent-1.vet402.eth'), 60n, K_AG1]),
]]);
const dep = (impl, salt, init) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [impl, salt, init] });
const pre = async (from, impl, salt, init) => viem.getAddress('0x' + (await c0.call({ account: from, to: A.vf, data: dep(impl, salt, init), blockNumber: B })).data.slice(26));

const P_A = await pre(W_ENS, A.impl, SALT_A, initA);
const P_BC = await pre(W_ENS, A.impl, SALT_BC, initBC);
const U = await pre(W_VET, UR_IMPL, SALT_U, initU);
const P_AG1 = await pre(W_VET, A.impl, SALT_A1, initA1);
console.log('CD-K1-04', keccak256(dep(A.impl, SALT_A, initA)), 'CD-K1-07', keccak256(dep(A.impl, SALT_BC, initBC)));
console.log('predicted: P_A=', P_A, 'P_BC=', P_BC, 'U=', U, 'P_AG1=', P_AG1);

const V = W_VET, E = W_ENS;
const TX = [
  ['K1-01', V, R_VET, 'revokeRootRoles(ALL, HCA_vet)', pr('revokeRootRoles', [ALL_ROLES, HCA_VET])],
  ['K1-02', V, R_VET, 'multicall[setText x2 + setAddress(atst,60,K_atst)]', pr('multicall', [[
    pr('setText', [dns('vet402.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo']),
    pr('setText', [dns('vet402.eth'), 'class', 'x402-verifier']),
    pr('setAddress', [dns('atst.vet402.eth'), 60n, K_ATST])]])],
  ['K1-03', V, R_VET, 'multicall[grantSetterRoles(setText(*,key_i,""),W_obs) x15]', pr('multicall', [OBS_KEYS.map(k => pr('grantSetterRoles', [pr('setText', [dns('x.obs.vet402.eth'), k, '']), W_OBS]))])],
  ['K1-03b', W_OBS, R_VET, 'W_obs が R_vet に obs ラベルの class を書く（wildcard の実データ）', pr('setText', [dns(keccak256(toBytes('x')).slice(2,66)+'.obs.vet402.eth'), 'class', 'x402-observation'])],
  ['K1-04', E, A.vf, 'deployProxy(impl, SALT_A, initA) -> P_a', dep(A.impl, SALT_A, initA)],
  ['K1-05', E, A.er, 'setResolver(seller-a, P_a)', setRes('seller-a', P_A)],
  ['K1-06', E, P_A, 'grantSetterRoles(setText(seller-a.eth,x402-offer,""), W_op)', pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), W_OP])],
  ['K1-07', E, A.vf, 'deployProxy(impl, SALT_BC, initBC) -> P_bc', dep(A.impl, SALT_BC, initBC)],
  ['K1-08', E, A.er, 'setResolver(seller-b, P_bc)', setRes('seller-b', P_BC)],
  ['K1-09', E, A.er, 'setResolver(seller-c, P_bc)', setRes('seller-c', P_BC)],
  ['K1-10', V, A.vf, 'deployProxy(UserRegistryImpl, SALT_U, initU) -> U', dep(UR_IMPL, SALT_U, initU)],
  ['K1-11', V, A.er, 'setSubregistry(vet402, U)', er('setSubregistry', [TID['vet402'], U])],
  ['K1-12', V, A.vf, 'deployProxy(impl, SALT_A1, initA1) -> P_AG1', dep(A.impl, SALT_A1, initA1)],
  ['K1-13', V, U, 'U.register("agent-1", K_ag1, 0, P_AG1, ROLE_RENEW, expiry)', ur('register', ['agent-1', K_AG1, '0x0000000000000000000000000000000000000000', P_AG1, ROLE_RENEW, EXP])],
  ['K1-14', V, P_AG1, 'grantSetterRoles(setText(agent-1.vet402.eth,x402-policy,""), K_ag1)', pr('grantSetterRoles', [pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', '']), K_AG1])],
  ['K1-15', V, U, 'U.register("agent-2", K_ag2, 0, 0, RENEW|CAN_TRANSFER_ADMIN, expiry)', ur('register', ['agent-2', K_AG2, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', ROLE_RENEW | ROLE_CAN_TRANSFER_ADMIN, EXP])],
];

// --- 命題3・4・案A の読み取り（同じ連鎖の続き。gas 合計には入れない）---
const OBS = keccak256(toBytes('x')).slice(2, 66) + '.obs.vet402.eth';
const CHK = [
  ['C-01 W_op が P_a で x402-offer を書ける', W_OP, P_A, pr('setText', [dns('seller-a.eth'), 'x402-offer', '{"v":1,"amount":"99999"}'])],
  ['C-02 W_op が P_a で 証明キーを書く', W_OP, P_A, pr('setText', [dns('seller-a.eth'), ATT_KEY, 'FORGED'])],
  ['C-03 W_op が P_bc で seller-b の x402-offer を書く', W_OP, P_BC, pr('setText', [dns('seller-b.eth'), 'x402-offer', '{"v":1,"amount":"1"}'])],
  ['C-04 W_op が P_a で 別の名前(sub)の x402-offer を書く', W_OP, P_A, pr('setText', [dns('x.seller-a.eth'), 'x402-offer', '{"v":1}'])],
  ['C-05 W_op が P_a で setAddress', W_OP, P_A, pr('setAddress', [dns('seller-a.eth'), 60n, W_OP])],
  ['C-06 W_vet(作者) が P_a で 証明キーを書く', V, P_A, pr('setText', [dns('seller-a.eth'), ATT_KEY, 'AUTHOR'])],
  ['C-07 W_vet(作者) が P_a で x402-offer を書く', V, P_A, pr('setText', [dns('seller-a.eth'), 'x402-offer', '{"v":1,"amount":"1"}'])],
  ['C-08 W_ens(売り手) が P_a で 証明キーを書く', E, P_A, pr('setText', [dns('seller-a.eth'), ATT_KEY, 'ENVELOPE_A2'])],
  ['C-09 W_obs が R_vet で atst.vet402.eth の class を書く', W_OBS, R_VET, pr('setText', [dns('atst.vet402.eth'), 'class', 'HIJACK'])],
  ['C-10 W_obs が R_vet で atst の addr を書く', W_OBS, R_VET, pr('setAddress', [dns('atst.vet402.eth'), 60n, W_OBS])],
  ['C-11 K1-11 後 resolve(addr atst.vet402.eth)', V, A.ur, urv('resolve', [dns('atst.vet402.eth'), rd('addr', [namehash('atst.vet402.eth')])])],
  ['C-12 K1-11 後 resolve(text obs class)', V, A.ur, urv('resolve', [dns(OBS), rd('text', [namehash(OBS), 'class'])])],
  ['C-13 resolve(text agent-1 x402-policy)', V, A.ur, urv('resolve', [dns('agent-1.vet402.eth'), rd('text', [namehash('agent-1.vet402.eth'), 'x402-policy'])])],
  ['C-14 resolve(addr agent-1)', V, A.ur, urv('resolve', [dns('agent-1.vet402.eth'), rd('addr', [namehash('agent-1.vet402.eth')])])],
  ['C-15 resolve(text agent-2 x402-policy) ＝ 対照(親 wildcard)', V, A.ur, urv('resolve', [dns('agent-2.vet402.eth'), rd('text', [namehash('agent-2.vet402.eth'), 'x402-policy'])])],
  ['C-16 K_ag1 が P_AG1 で agent-1 の方針を書ける', K_AG1, P_AG1, pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', '{"v":1,"trust":[],"floor":"l2_match","max":"1"}'])],
  ['C-17 K_ag1 が R_vet で 親 vet402.eth の x402-policy を書く', K_AG1, R_VET, pr('setText', [dns('vet402.eth'), 'x402-policy', 'HIJACK'])],
  ['C-18 K_ag2 が R_vet で 親 vet402.eth の x402-policy を書く（対照）', K_AG2, R_VET, pr('setText', [dns('vet402.eth'), 'x402-policy', 'HIJACK2'])],
  ['C-19 resolve(text seller-a x402-offer)', V, A.ur, urv('resolve', [dns('seller-a.eth'), rd('text', [namehash('seller-a.eth'), 'x402-offer'])])],
  ['C-20 UH.findExactOwner(seller-a.eth)', V, A.uh, encodeFunctionData({ abi: ABI.UH, functionName: 'findExactOwner', args: [dns('seller-a.eth')] })],
  ['C-21 UH.findExactOwner(agent-1.vet402.eth)', V, A.uh, encodeFunctionData({ abi: ABI.UH, functionName: 'findExactOwner', args: [dns('agent-1.vet402.eth')] })],
  ['C-11b K1-11 後 resolve(text vet402.eth class) 親本体', V, A.ur, urv('resolve', [dns('vet402.eth'), rd('text', [namehash('vet402.eth'), 'class'])])],
  ['C-12b K1-11 後 UR.findResolver(obs ラベル)', V, A.ur, urv('findResolver', [dns(OBS)])],
  ['C-12c K1-11 後 UR.findResolver(atst.vet402.eth)', V, A.ur, urv('findResolver', [dns('atst.vet402.eth')])],
  ['C-22 UH.findExactOwner(atst.vet402.eth)', V, A.uh, encodeFunctionData({ abi: ABI.UH, functionName: 'findExactOwner', args: [dns('atst.vet402.eth')] })],
];

const calls = [...TX.map(r => ({ from: r[1], to: r[2], data: r[4] })), ...CHK.map(r => ({ from: r[1], to: r[2], data: r[3] }))];
const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls }], validation: false, traceTransfers: false }, toHex(B)] };
const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
if (j.error) { console.log('RPC ERROR', JSON.stringify(j.error).slice(0, 600)); process.exit(1); }
const res = j.result[0].calls;
let total = 0; const rows = [];
TX.forEach((t, i) => {
  const cl = res[i]; const gas = parseInt(cl.gasUsed, 16); total += gas;
  const ok = cl.status === '0x1';
  const o = { id: t[0], fn: t[3], status: ok ? 'OK' : 'REVERT', gas, logs: (cl.logs || []).map(l => EVMAP[l.topics[0]] ?? l.topics[0].slice(0, 10)) };
  if (!ok) o.revert = dec(cl.error?.data ?? cl.returnData);
  rows.push(o); console.log(o.id, o.status, 'gas=' + gas, o.revert ?? '', '[' + o.logs.join(',') + ']');
});
console.log('=== K1 total gas', total, '/ tx', TX.length, '/ block', B.toString(), '===');
const chk = [];
CHK.forEach((t, i) => {
  const cl = res[TX.length + i]; const ok = cl.status === '0x1';
  let v = '';
  if (!ok) v = dec(cl.error?.data ?? cl.returnData);
  else if (t[0].includes('resolve(addr')) v = decAddr(cl.returnData);
  else if (t[0].includes('resolve(text')) v = decText(cl.returnData);
  else if (t[0].includes('findExactOwner')) v = cl.returnData.slice(0, 200);
  else v = 'gas=' + parseInt(cl.gasUsed, 16);
  chk.push({ id: t[0], status: ok ? 'OK' : 'REVERT', v });
  console.log((ok ? 'OK    ' : 'REVERT') + ' | ' + t[0] + ' | ' + v);
});
fs.writeFileSync('/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad/hw/h1_k1_'+(process.env.RPC==='P'?'pandaops':'sentio')+'.json', JSON.stringify({ block: B.toString(), now: NOW, totalGas: total, txCount: TX.length, P_A, P_BC, U, P_AG1, rows, chk }, null, 1));
