// D3: デモの詰め — 極短期限・renew・親支配の遮断・emancipation の実効性・委任 registrar
import fs from 'fs';
import { viem, ABI, A, W_VET, RPC_S, dns, client, pr, ALL_ROLES } from '../e15/lib.mjs';
const { labelhash, keccak256, toBytes, toHex, encodeFunctionData, decodeAbiParameters, parseAbi } = viem;
const UR_ABI = (() => { const d = JSON.parse(fs.readFileSync(new URL('../../../lib/abi/UserRegistryImpl.json', import.meta.url))); return d.abi ?? d; })();
const UR_IMPL = '0xa80338aaa8d23831cea25e858d1774534abb0263';
const K_AG1 = '0x00000000000000000000000000000000000000c1';
const K_AG2 = '0x00000000000000000000000000000000000000c2';
const K_BOT = '0x00000000000000000000000000000000000000d1'; // 委任した registrar の鍵
const R_REGISTRAR = 1n << 0n, R_UNREGISTER = 1n << 12n, R_RENEW = 1n << 16n;
const R_SET_SUBREG = 1n << 20n, R_SET_RESOLVER = 1n << 24n, R_UPGRADE = 1n << 124n;
const UNEMANCIPATED = R_SET_SUBREG | (R_SET_SUBREG << 128n) | R_SET_RESOLVER | (R_SET_RESOLVER << 128n)
  | R_UNREGISTER | (R_UNREGISTER << 128n) | R_UPGRADE | (R_UPGRADE << 128n);
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
const decResolve = r => { try { const [b, res] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], r); const [s] = decodeAbiParameters([{ type: 'string' }], b); return JSON.stringify(s).slice(0, 60) + ' via ' + res.slice(0, 10); } catch { return 'raw ' + r.slice(0, 40); } };
const TID_VET = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash('vet402'))], blockNumber: B })).tokenId;
const SALT_U = BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
const SALT_A1 = BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));
const initU = ur('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }]]);
const POLICY = '{"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}';
const initA1 = pr('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', POLICY]),
  pr('setAddress', [dns('agent-1.vet402.eth'), 60n, K_AG1]),
]]);
const dep = (impl, salt, init) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [impl, salt, init] });
const U = '0xB093cEC6D1Cc355c40020f0df5103ecEFfD30dac';
const P_AG1 = '0xd3F4818c0bB93e54780525b21380D44D6D06bcd6';
const simN = async blocks => {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: blocks, validation: false }, toHex(B)] };
  const j = await (await fetch(RPC_S, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (j.error) throw new Error('RPC ' + JSON.stringify(j.error).slice(0, 300)); return j.result;
};
const show = (tag, names, calls) => calls.map((c, i) => {
  const ok = c.status === '0x1'; const g = parseInt(c.gasUsed, 16);
  const v = ok ? (names[i].includes('resolve(') ? decResolve(c.returnData) : c.returnData.slice(0, 68)) : dec(c.error?.data ?? c.returnData);
  console.log(tag, names[i], ok ? 'OK' : 'REVERT', 'gas=' + g, v); return { id: names[i], status: ok ? 'OK' : 'REVERT', gas: g, v };
});
const out = {};
const BASE = [
  { from: W_VET, to: A.vf, data: dep(UR_IMPL, SALT_U, initU) },
  { from: W_VET, to: A.er, data: er('setSubregistry', [TID_VET, U]) },
  { from: W_VET, to: A.vf, data: dep(A.impl, SALT_A1, initA1) },
];
const BN = ['dep U', 'setSubregistry(vet402→U)', 'dep P_AG1'];

// T5: 120秒の名前 → 180秒後に切れる／renew で延びる
const REG120 = { from: W_VET, to: U, data: ur('register', ['agent-1', K_AG1, '0x0000000000000000000000000000000000000000', P_AG1, R_RENEW, BigInt(NOW + 120)]) };
const RES = { from: W_VET, to: A.ur, data: urv('resolve', [dns('agent-1.vet402.eth'), rd('text', [nh('agent-1.vet402.eth'), 'x402-policy'])]) };
const TIDA = BigInt((await simN([{ calls: [...BASE, REG120, { from: W_VET, to: U, data: ur('findTokenId', ['agent-1']) }] }]))[0].calls[4].returnData);
const t5 = await simN([
  { calls: [...BASE, REG120, RES] },
  { blockOverrides: { time: toHex(NOW + 180) }, calls: [RES, { from: W_VET, to: U, data: ur('getStatus', [TIDA]) }] },
  { blockOverrides: { time: toHex(NOW + 181) }, calls: [{ from: W_VET, to: U, data: ur('renew', [TIDA, BigInt(NOW + 9999)]) }, RES] },
]);
console.log('--- T5 120秒の名前 ---');
out.T5a = show('T5a(now)', [...BN, 'register(expiry=now+120)', 'resolve('], t5[0].calls);
out.T5b = show('T5b(+180s)', ['resolve(', 'getStatus'], t5[1].calls);
out.T5c = show('T5c(+181s renew)', ['renew(→now+9999)', 'resolve('], t5[2].calls);

// T6: vet402.eth の ROLE_SET_SUBREGISTRY を自分から剥がす → もう差し替えられない
const t6 = await simN([{ calls: [...BASE,
  { from: W_VET, to: A.er, data: er('revokeRoles', [TID_VET, R_SET_SUBREG | (R_SET_SUBREG << 128n), W_VET]) },
  { from: W_VET, to: A.er, data: er('setSubregistry', [TID_VET, '0x000000000000000000000000000000000000dEaD']) },
  { from: W_VET, to: A.er, data: er('hasRoles', [TID_VET, R_SET_SUBREG, W_VET]) },
] }]);
console.log('--- T6 親の差し替えを封じる ---');
out.T6 = show('T6', [...BN, 'revokeRoles(SET_SUBREGISTRY on vet402)', 'setSubregistry(→dead)', 'hasRoles'], t6[0].calls);

// T7: emancipation 後、親は取り消せない／登録はできる
const t7 = await simN([{ calls: [...BASE, REG120,
  { from: W_VET, to: U, data: ur('revokeRootRoles', [UNEMANCIPATED, W_VET]) },
  { from: W_VET, to: U, data: ur('isEmancipated', []) },
  { from: W_VET, to: U, data: ur('unregister', [TIDA]) },
  { from: W_VET, to: U, data: ur('setResolver', [TIDA, '0x000000000000000000000000000000000000dEaD']) },
  { from: W_VET, to: U, data: ur('register', ['agent-9', K_AG2, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', R_RENEW, BigInt(NOW + 9999)]) },
] }]);
console.log('--- T7 emancipation の実効性 ---');
out.T7 = show('T7', [...BN, 'register', 'revokeRootRoles(UNEMANCIPATED)', 'isEmancipated', 'unregister(親が)', 'setResolver(親が)', 'register(親が新規)'], t7[0].calls);

// T8: 委任 registrar（ROLE_REGISTRAR を bot 鍵へ）＝エージェントが自分で名前を取れる
const t8 = await simN([{ calls: [...BASE,
  { from: W_VET, to: U, data: ur('grantRootRoles', [R_REGISTRAR, K_BOT]) },
  { from: K_BOT, to: U, data: ur('register', ['agent-7', K_AG2, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', R_RENEW, BigInt(NOW + 9999)]) },
  { from: K_AG2, to: U, data: ur('register', ['agent-8', K_AG2, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', R_RENEW, BigInt(NOW + 9999)]) },
] }]);
console.log('--- T8 委任 registrar ---');
out.T8 = show('T8', [...BN, 'grantRootRoles(REGISTRAR→K_bot)', 'register(K_bot が)', 'register(権限なしの K_ag2 が)'], t8[0].calls);

// T9: 専用リゾルバが無いエージェント（agent-2）の鍵は、親のリゾルバに方針を書けるか
const t9 = await simN([{ calls: [...BASE,
  { from: W_VET, to: U, data: ur('register', ['agent-2', K_AG2, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', R_RENEW, BigInt(NOW + 9999)]) },
  { from: W_VET, to: '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391', data: pr('grantSetterRoles', [pr('setText', [dns('agent-2.vet402.eth'), 'x402-policy', '']), K_AG2]) },
  { from: K_AG2, to: '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391', data: pr('setText', [dns('agent-2.vet402.eth'), 'x402-policy', 'MINE']) },
  { from: K_AG2, to: '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391', data: pr('setText', [dns('vet402.eth'), 'x402-policy', 'HIJACK']) },
] }]);
console.log('--- T9 専用リゾルバが無い場合の漏れ ---');
out.T9 = show('T9', [...BN, 'register(agent-2, resolver=0)', 'R_vet.grantSetterRoles(x402-policy→K_ag2)', 'K_ag2 が agent-2 に書く', 'K_ag2 が vet402.eth(親) に書く'], t9[0].calls);

fs.writeFileSync(new URL('../../../out/d3_result.json', import.meta.url), JSON.stringify({ block: B.toString(), now: NOW, TIDA: TIDA.toString(), ...out }, null, 1));
