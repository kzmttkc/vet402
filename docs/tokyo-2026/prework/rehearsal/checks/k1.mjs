// K1: K1-01〜K1-15 を「1本の eth_simulateV1」で通す（H2）＋ 命題3・命題4 の読み取りを同じ連鎖の末尾に付ける
// 元: hw/src/h1_k1.mjs（e15/k1.mjs の上位集合）。確かめている中身は同じ。パスと入出力だけ直した。
// 読み取りのみ（eth_call / eth_simulateV1）。署名・送信はしない。
import {
  viem, ABI, A, W_VET, W_ENS, W_OP, W_OBS, K_ATST, K_AG1, K_AG2, ZERO,
  R_VET, HCA_VET, UR_IMPL, SIM_RPC_LIST, dns, client, pr, ALL_ROLES, ATT_KEY, OBS_KEYS,
  ROLE_RENEW, ROLE_CAN_TRANSFER_ADMIN, eventSelector, simulate, pickRpc,
  mkOffer, mkPolicy, OFFER_BYTES, POLICY_BYTES,
} from '../lib/common.mjs';

const { labelhash, namehash, keccak256, toBytes, encodeFunctionData, parseAbi, decodeAbiParameters } = viem;
const UR_ABI = ABI.URI;

const ALL_ERR = [...ABI.PR, ...ABI.VF, ...ABI.ER, ...ABI.UH, ...ABI.UR, ...ABI.RG, ...UR_ABI].filter(x => x.type === 'error');
const dec = d => {
  try {
    const r = viem.decodeErrorResult({ abi: ALL_ERR, data: d });
    return r.errorName + '(' + (r.args || []).map(a => typeof a === 'bigint' ? '0x' + a.toString(16) : String(a)).join(',') + ')';
  } catch { return 'raw:' + String(d).slice(0, 74); }
};
const EVMAP = {};
for (const abi of [ABI.PR, ABI.ER, ABI.VF, UR_ABI]) for (const e of abi.filter(x => x.type === 'event')) { try { EVMAP[eventSelector(e)] = e.name; } catch { /* 引数に tuple を含む古い形は選択子を作れない */ } }

const decAddr = r => { try { const [b, res] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], r); const [a] = decodeAbiParameters([{ type: 'address' }], b); return a + ' via ' + res; } catch { return 'EMPTY/raw ' + r.slice(0, 50); } };
const decText = r => { try { const [b] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], r); const [s] = decodeAbiParameters([{ type: 'string' }], b); return JSON.stringify(s); } catch { return 'EMPTY/raw ' + r.slice(0, 50); } };

export const id = 'k1';
export const title = 'K1 / 会期前に打つ 16 本の tx（K1-01〜K1-15 ＋ K1-03b）と、命題3・4 の読み取り 25 本';

export async function run({ log }) {
  const url = process.env.RPC_URL || await pickRpc();
  const c0 = client(url);
  const B = process.env.FIXB ? BigInt(process.env.FIXB) : (await c0.getBlockNumber()) - 3n;
  const NOW = Number((await c0.getBlock({ blockNumber: B })).timestamp);
  const EXP = BigInt(NOW + 7 * 86400);

  const ur = (fn, args) => encodeFunctionData({ abi: UR_ABI, functionName: fn, args });
  const er = (fn, args) => encodeFunctionData({ abi: ABI.ER, functionName: fn, args });
  const urv = (fn, args) => encodeFunctionData({ abi: ABI.UR, functionName: fn, args });
  const RD = parseAbi(['function addr(bytes32 node) view returns (address)', 'function text(bytes32 node, string key) view returns (string)']);
  const rd = (fn, args) => encodeFunctionData({ abi: RD, functionName: fn, args });

  const TID = {};
  for (const l of ['vet402', 'seller-a', 'seller-b', 'seller-c']) {
    TID[l] = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B })).tokenId;
  }
  const setRes = (l, r) => er('setResolver', [TID[l], r]);

  const SALT_A  = BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
  const SALT_BC = BigInt(keccak256(toBytes('tokyo-2026/seller-bc.eth')));
  const SALT_U  = BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
  const SALT_A1 = BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));

  // ---- 正典の文字列は lib/common.mjs から取る（PLAN_v4.3 §3.3.1 / §3.5.1）----
  // 旧版はここに 39 バイトの仮の約束（K1-04=448,516 / K1-07=539,375）と
  // 68 バイトの仮の方針（K1-12=393,345）を直書きしていた。
  const OFFER_A = mkOffer('10000', W_ENS);
  const OFFER_B = mkOffer('20000', W_ENS);
  const OFFER_C = mkOffer('30000', W_ENS);
  const POLICY  = mkPolicy('50000');
  // 証明（envelope）は購入の後にしか署名できないので K1 では仮値。本物は B5b で置く（§4）

  // K1-04 の calls は **3本**（§4: 証明キーは入れない）。4本目を足すと P_a の予定アドレスもガスも変わる。
  const initA = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
    pr('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A]),
    pr('setText', [dns('seller-a.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']),
    pr('setAddress', [dns('seller-a.eth'), 60n, W_ENS]),
  ]]);
  const initBC = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
    pr('setText', [dns('seller-b.eth'), 'x402-offer', OFFER_B]),
    pr('setText', [dns('seller-b.eth'), ATT_KEY, 'ENVELOPE_B']),
    pr('setAddress', [dns('seller-b.eth'), 60n, W_ENS]),
    pr('setText', [dns('seller-c.eth'), 'x402-offer', OFFER_C]),
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

  const rows = [];
  const push = (rid, status, value, gas) => { rows.push({ id: rid, status, value, ...(gas === undefined ? {} : { gas }) }); };
  // 正典の文字列が縮むと（＝また仮値に戻ると）ここで落ちる
  push('STR x402-offer bytes', Buffer.byteLength(OFFER_A) === OFFER_BYTES ? 'OK' : 'NG', String(Buffer.byteLength(OFFER_A)));
  push('STR x402-policy bytes', Buffer.byteLength(POLICY) === POLICY_BYTES ? 'OK' : 'NG', String(Buffer.byteLength(POLICY)));
  push('CD-K1-04 calldata keccak', 'OK', keccak256(dep(A.impl, SALT_A, initA)));
  push('CD-K1-07 calldata keccak', 'OK', keccak256(dep(A.impl, SALT_BC, initBC)));
  push('ADDR P_A', 'OK', P_A);
  push('ADDR P_BC', 'OK', P_BC);
  push('ADDR U', 'OK', U);
  push('ADDR P_AG1', 'OK', P_AG1);
  log(`predicted: P_A=${P_A} P_BC=${P_BC} U=${U} P_AG1=${P_AG1}`);

  const V = W_VET, E = W_ENS;
  const TX = [
    ['K1-01', V, R_VET, 'revokeRootRoles(ALL, HCA_vet)', pr('revokeRootRoles', [ALL_ROLES, HCA_VET])],
    ['K1-02', V, R_VET, 'multicall[setText x2 + setAddress(atst,60,K_atst)]', pr('multicall', [[
      pr('setText', [dns('vet402.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo']),
      pr('setText', [dns('vet402.eth'), 'class', 'x402-verifier']),
      pr('setAddress', [dns('atst.vet402.eth'), 60n, K_ATST])]])],
    ['K1-03', V, R_VET, 'multicall[grantSetterRoles(setText(*,key_i,""),W_obs) x15]', pr('multicall', [OBS_KEYS.map(k => pr('grantSetterRoles', [pr('setText', [dns('x.obs.vet402.eth'), k, '']), W_OBS]))])],
    ['K1-03b', W_OBS, R_VET, 'W_obs が R_vet に obs ラベルの class を書く（wildcard の実データ）', pr('setText', [dns(keccak256(toBytes('x')).slice(2, 66) + '.obs.vet402.eth'), 'class', 'x402-observation'])],
    ['K1-04', E, A.vf, 'deployProxy(impl, SALT_A, initA) -> P_a', dep(A.impl, SALT_A, initA)],
    ['K1-05', E, A.er, 'setResolver(seller-a, P_a)', setRes('seller-a', P_A)],
    ['K1-06', E, P_A, 'grantSetterRoles(setText(seller-a.eth,x402-offer,""), W_op)', pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), W_OP])],
    ['K1-07', E, A.vf, 'deployProxy(impl, SALT_BC, initBC) -> P_bc', dep(A.impl, SALT_BC, initBC)],
    ['K1-08', E, A.er, 'setResolver(seller-b, P_bc)', setRes('seller-b', P_BC)],
    ['K1-09', E, A.er, 'setResolver(seller-c, P_bc)', setRes('seller-c', P_BC)],
    ['K1-10', V, A.vf, 'deployProxy(UserRegistryImpl, SALT_U, initU) -> U', dep(UR_IMPL, SALT_U, initU)],
    ['K1-11', V, A.er, 'setSubregistry(vet402, U)', er('setSubregistry', [TID['vet402'], U])],
    ['K1-12', V, A.vf, 'deployProxy(impl, SALT_A1, initA1) -> P_AG1', dep(A.impl, SALT_A1, initA1)],
    ['K1-13', V, U, 'U.register("agent-1", K_ag1, 0, P_AG1, ROLE_RENEW, expiry)', ur('register', ['agent-1', K_AG1, ZERO, P_AG1, ROLE_RENEW, EXP])],
    ['K1-14', V, P_AG1, 'grantSetterRoles(setText(agent-1.vet402.eth,x402-policy,""), K_ag1)', pr('grantSetterRoles', [pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', '']), K_AG1])],
    ['K1-15', V, U, 'U.register("agent-2", K_ag2, 0, 0, RENEW|CAN_TRANSFER_ADMIN, expiry)', ur('register', ['agent-2', K_AG2, ZERO, ZERO, ROLE_RENEW | ROLE_CAN_TRANSFER_ADMIN, EXP])],
  ];

  // --- 命題3・4・案A の読み取り（同じ連鎖の続き。gas 合計には入れない）---
  const OBS = keccak256(toBytes('x')).slice(2, 66) + '.obs.vet402.eth';
  const CHK = [
    ['C-01 W_op が P_a で x402-offer を書ける', W_OP, P_A, pr('setText', [dns('seller-a.eth'), 'x402-offer', mkOffer('10001', W_ENS)])],
    ['C-02 W_op が P_a で 証明キーを書く', W_OP, P_A, pr('setText', [dns('seller-a.eth'), ATT_KEY, 'FORGED'])],
    ['C-03 W_op が P_bc で seller-b の x402-offer を書く', W_OP, P_BC, pr('setText', [dns('seller-b.eth'), 'x402-offer', mkOffer('1', W_ENS)])],
    ['C-04 W_op が P_a で 別の名前(sub)の x402-offer を書く', W_OP, P_A, pr('setText', [dns('x.seller-a.eth'), 'x402-offer', mkOffer('1', W_ENS)])],
    ['C-05 W_op が P_a で setAddress', W_OP, P_A, pr('setAddress', [dns('seller-a.eth'), 60n, W_OP])],
    ['C-06 W_vet(作者) が P_a で 証明キーを書く', V, P_A, pr('setText', [dns('seller-a.eth'), ATT_KEY, 'AUTHOR'])],
    ['C-07 W_vet(作者) が P_a で x402-offer を書く', V, P_A, pr('setText', [dns('seller-a.eth'), 'x402-offer', mkOffer('1', W_ENS)])],
    ['C-08 W_ens(売り手) が P_a で 証明キーを書く', E, P_A, pr('setText', [dns('seller-a.eth'), ATT_KEY, 'ENVELOPE_A2'])],
    ['C-09 W_obs が R_vet で atst.vet402.eth の class を書く', W_OBS, R_VET, pr('setText', [dns('atst.vet402.eth'), 'class', 'HIJACK'])],
    ['C-10 W_obs が R_vet で atst の addr を書く', W_OBS, R_VET, pr('setAddress', [dns('atst.vet402.eth'), 60n, W_OBS])],
    ['C-11 K1-11 後 resolve(addr atst.vet402.eth)', V, A.ur, urv('resolve', [dns('atst.vet402.eth'), rd('addr', [namehash('atst.vet402.eth')])])],
    ['C-12 K1-11 後 resolve(text obs class)', V, A.ur, urv('resolve', [dns(OBS), rd('text', [namehash(OBS), 'class'])])],
    ['C-13 resolve(text agent-1 x402-policy)', V, A.ur, urv('resolve', [dns('agent-1.vet402.eth'), rd('text', [namehash('agent-1.vet402.eth'), 'x402-policy'])])],
    ['C-14 resolve(addr agent-1)', V, A.ur, urv('resolve', [dns('agent-1.vet402.eth'), rd('addr', [namehash('agent-1.vet402.eth')])])],
    ['C-15 resolve(text agent-2 x402-policy) ＝ 対照(親 wildcard)', V, A.ur, urv('resolve', [dns('agent-2.vet402.eth'), rd('text', [namehash('agent-2.vet402.eth'), 'x402-policy'])])],
    ['C-16 K_ag1 が P_AG1 で agent-1 の方針を書ける', K_AG1, P_AG1, pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', mkPolicy('1')])],
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
  const { calls: res, rpc: usedRpc } = await simulate(calls, B, [url, ...SIM_RPC_LIST.filter(u => u !== url)]);

  let total = 0;
  TX.forEach((t, i) => {
    const cl = res[i]; const gas = parseInt(cl.gasUsed, 16); total += gas;
    const ok = cl.status === '0x1';
    const logs = (cl.logs || []).map(l => EVMAP[l.topics[0]] ?? l.topics[0].slice(0, 10));
    const v = ok ? '[' + logs.join(',') + ']' : dec(cl.error?.data ?? cl.returnData);
    log(`${t[0]} ${ok ? 'OK' : 'REVERT'} gas=${gas} ${v}`);
    push(t[0], ok ? 'OK' : 'REVERT', v, gas);
  });
  log(`=== K1 total gas ${total} / tx ${TX.length} / block ${B} ===`);
  push('K1 totalGas', 'OK', 'gas は鎖の状態で動くので合否には使わない', total);
  push('K1 txCount', 'OK', String(TX.length));

  CHK.forEach((t, i) => {
    const cl = res[TX.length + i]; const ok = cl.status === '0x1';
    let v;
    if (!ok) v = dec(cl.error?.data ?? cl.returnData);
    else if (t[0].includes('resolve(addr')) v = decAddr(cl.returnData);
    else if (t[0].includes('resolve(text')) v = decText(cl.returnData);
    else if (t[0].includes('findExactOwner')) v = cl.returnData.slice(0, 200);
    else if (t[0].includes('findResolver')) v = cl.returnData.slice(0, 200);
    else v = 'ok';
    log(`${ok ? 'OK    ' : 'REVERT'} | ${t[0]} | ${v}`);
    push(t[0], ok ? 'OK' : 'REVERT', v);
  });

  return { meta: { rpc: usedRpc, block: B.toString(), now: NOW, totalGas: total, txCount: TX.length }, rows };
}
