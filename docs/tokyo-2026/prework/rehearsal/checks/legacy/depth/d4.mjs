// D4: 案B（attester をサブ名レジストリへ）の成否 — 取り消し後に親の wildcard が古い鍵を蘇らせないか
//     ＋ EAC resource の版が上がって古い委任が死ぬか（ENSv2 でなければ書けない読み方）
import fs from 'fs';
import { viem, ABI, A, W_VET, RPC_S, dns, client, pr, ALL_ROLES, K_ATST } from '../e15/lib.mjs';
const { labelhash, keccak256, toBytes, toHex, encodeFunctionData, decodeAbiParameters, parseAbi } = viem;
const UR_ABI = (() => { const d = JSON.parse(fs.readFileSync(new URL('../../../lib/abi/UserRegistryImpl.json', import.meta.url))); return d.abi ?? d; })();
const UR_IMPL = '0xa80338aaa8d23831cea25e858d1774534abb0263';
const R_VET = '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
const K_NEW = '0x41000000000000000000000000000000000000b8'; // 乗っ取り後の鍵（架空）
const R_RENEW = 1n << 16n;
const c0 = client(RPC_S);
const B = await c0.getBlockNumber() - 3n;
const NOW = Number((await c0.getBlock({ blockNumber: B })).timestamp);
const ALL_ERR = [...ABI.PR, ...ABI.VF, ...ABI.ER, ...ABI.UH, ...ABI.UR, ...UR_ABI].filter(x => x.type === 'error');
const dec = d => { try { const r = viem.decodeErrorResult({ abi: ALL_ERR, data: d }); return r.errorName + '(' + (r.args || []).map(a => typeof a === 'bigint' ? '0x' + a.toString(16) : String(a)).join(',') + ')'; } catch { return 'raw:' + String(d).slice(0, 74); } };
const ur = (fn, args) => encodeFunctionData({ abi: UR_ABI, functionName: fn, args });
const er = (fn, args) => encodeFunctionData({ abi: ABI.ER, functionName: fn, args });
const urv = (fn, args) => encodeFunctionData({ abi: ABI.UR, functionName: fn, args });
const RD = parseAbi(['function addr(bytes32 node) view returns (address)', 'function text(bytes32 node, string key) view returns (string)']);
const rd = (fn, args) => encodeFunctionData({ abi: RD, functionName: fn, args });
const nh = n => viem.namehash(n);
const decAddr = r => { try { const [b, res] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], r); const [a] = decodeAbiParameters([{ type: 'address' }], b); return a + ' via ' + res.slice(0, 10); } catch { return 'EMPTY/raw ' + r.slice(0, 50); } };
const TID_VET = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash('vet402'))], blockNumber: B })).tokenId;
const SALT_U = BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
const SALT_AT = BigInt(keccak256(toBytes('tokyo-2026/atst.vet402.eth')));
const initU = ur('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }]]);
const initAT = pr('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }], [pr('setAddress', [dns('atst.vet402.eth'), 60n, K_ATST])]]);
const dep = (impl, salt, init) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [impl, salt, init] });
const pre = async (from, impl, salt, init) => viem.getAddress('0x' + (await c0.call({ account: from, to: A.vf, data: dep(impl, salt, init), blockNumber: B })).data.slice(26));
const U = await pre(W_VET, UR_IMPL, SALT_U, initU);
const P_AT = await pre(W_VET, A.impl, SALT_AT, initAT);
console.log('U=', U, 'P_AT=', P_AT);
const simN = async blocks => {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: blocks, validation: false }, toHex(B)] };
  const j = await (await fetch(RPC_S, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (j.error) throw new Error('RPC ' + JSON.stringify(j.error).slice(0, 300)); return j.result;
};
const show = (tag, names, calls) => calls.map((c, i) => {
  const ok = c.status === '0x1'; const g = parseInt(c.gasUsed, 16);
  const v = ok ? (names[i].includes('resolve(addr') ? decAddr(c.returnData) : c.returnData.slice(0, 68)) : dec(c.error?.data ?? c.returnData);
  console.log(tag, names[i], ok ? 'OK' : 'REVERT', 'gas=' + g, v); return { id: names[i], status: ok ? 'OK' : 'REVERT', gas: g, v };
});
const RESADDR = { from: W_VET, to: A.ur, data: urv('resolve', [dns('atst.vet402.eth'), rd('addr', [nh('atst.vet402.eth')])]) };
const SETUP = [
  { from: W_VET, to: A.vf, data: dep(UR_IMPL, SALT_U, initU) },
  { from: W_VET, to: A.er, data: er('setSubregistry', [TID_VET, U]) },
  { from: W_VET, to: A.vf, data: dep(A.impl, SALT_AT, initAT) },
  { from: W_VET, to: U, data: ur('register', ['atst', W_VET, '0x0000000000000000000000000000000000000000', P_AT, R_RENEW, BigInt(NOW + 9999)]) },
];
const SN = ['dep U', 'setSubregistry', 'dep P_AT', 'register(atst)'];
const TID_AT = BigInt((await simN([{ calls: [...SETUP, { from: W_VET, to: U, data: ur('findTokenId', ['atst']) }] }]))[0].calls[4].returnData);
const out = {};

// B1: 親のリゾルバに atst の addr を書かない場合 → 取り消しで解決不能になるか
const b1 = await simN([{ calls: [...SETUP, RESADDR, { from: W_VET, to: U, data: ur('unregister', [TID_AT]) }, RESADDR] }]);
console.log('--- B1 親に addr を書かない（推奨）---');
out.B1 = show('B1', [...SN, 'resolve(addr) 取消前', 'unregister(atst)', 'resolve(addr) 取消後'], b1[0].calls);

// B2: 親のリゾルバ R_vet にも atst の addr がある場合（= 今の K1-02 のまま）→ 罠
const b2 = await simN([{ calls: [...SETUP,
  { from: W_VET, to: R_VET, data: pr('setAddress', [dns('atst.vet402.eth'), 60n, K_ATST]) },
  RESADDR,
  { from: W_VET, to: U, data: ur('unregister', [TID_AT]) },
  RESADDR,
] }]);
console.log('--- B2 親にも addr がある（今の K1-02 のまま）---');
out.B2 = show('B2', [...SN, 'R_vet.setAddress(atst)', 'resolve(addr) 取消前', 'unregister(atst)', 'resolve(addr) 取消後'], b2[0].calls);

// B3: 取り消し→同じラベルを別の持ち主が再登録しても、古い委任は生き返らないか（EAC 版）
const b3 = await simN([{ calls: [...SETUP,
  { from: W_VET, to: U, data: ur('grantRoles', [TID_AT, R_RENEW, K_NEW]) },
  { from: W_VET, to: U, data: ur('hasRoles', [TID_AT, R_RENEW, K_NEW]) },
  { from: W_VET, to: U, data: ur('unregister', [TID_AT]) },
  { from: W_VET, to: U, data: ur('register', ['atst', K_NEW, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', R_RENEW, BigInt(NOW + 9999)]) },
  { from: W_VET, to: U, data: ur('hasRoles', [TID_AT, R_RENEW, K_NEW]) },
  { from: W_VET, to: U, data: ur('findTokenId', ['atst']) },
] }]);
console.log('--- B3 取り消し→再登録で EAC の版が上がるか ---');
out.B3 = show('B3', [...SN, 'grantRoles(RENEW→K_new)', 'hasRoles(旧 tokenId)', 'unregister', 're-register(K_new 所有)', 'hasRoles(旧 tokenId)', 'findTokenId(新)'], b3[0].calls);
console.log('旧 tokenId =', TID_AT.toString());
fs.writeFileSync(new URL('../../../out/d4_result.json', import.meta.url), JSON.stringify({ block: B.toString(), now: NOW, U, P_AT, TID_AT: TID_AT.toString(), ...out }, null, 1));
