// H13: U7「共有レジストリ経由の名前空間の別名」を本番で打った場合のコストと危険を測る
// 元: hw/src/h13.mjs。確かめている中身は同じ。パスと入出力だけ直した。
// 読み取りのみ（eth_call / eth_simulateV1）。署名・送信はしない。
import {
  viem, ABI, A, W_VET, W_ENS, R_SHARED, UR_IMPL, K_AG1, ZERO,
  SIM_RPC_LIST, dns, client, pr, ALL_ROLES, ATT_KEY, simulate, pickRpc, decErr,
} from '../lib/common.mjs';

const { labelhash, namehash, keccak256, toBytes, encodeFunctionData, parseAbi, decodeAbiParameters } = viem;
const UR_ABI = ABI.URI;

const R_RENEW = 1n << 16n, R_SET_SUBREG = 1n << 20n, R_SET_RESOLVER = 1n << 24n, R_UNREGISTER = 1n << 12n, R_UPGRADE = 1n << 124n;
const UNEMANCIPATED = R_SET_SUBREG | (R_SET_SUBREG << 128n) | R_SET_RESOLVER | (R_SET_RESOLVER << 128n)
  | R_UNREGISTER | (R_UNREGISTER << 128n) | R_UPGRADE | (R_UPGRADE << 128n);

const ALL_ERR = [...ABI.PR, ...ABI.VF, ...ABI.ER, ...ABI.UH, ...ABI.UR, ...ABI.RG, ...UR_ABI].filter(x => x.type === 'error');
const dec = d => {
  try {
    const r = viem.decodeErrorResult({ abi: ALL_ERR, data: d });
    return r.errorName + '(' + (r.args || []).map(a => typeof a === 'bigint' ? '0x' + a.toString(16) : String(a)).join(',') + ')';
  } catch { return 'raw:' + String(d).slice(0, 60); }
};
const decText = r => { try { const [b] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], r); const [s] = decodeAbiParameters([{ type: 'string' }], b); return JSON.stringify(s); } catch { return 'EMPTY'; } };
const decAddr = r => { try { const [b, res] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], r); const [a] = decodeAbiParameters([{ type: 'address' }], b); return a + ' via ' + res; } catch { return 'EMPTY'; } };
const decRes = r => { try { const [a] = decodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }], r); return a; } catch { return r.slice(0, 42); } };

export const id = 'h13';
export const title = 'H13 / U7 共有レジストリ経由の別名（setSubregistry）のコストと危険';

export async function run({ log }) {
  const url = process.env.RPC_URL || await pickRpc();
  const c0 = client(url);
  const B = process.env.FIXB ? BigInt(process.env.FIXB) : (await c0.getBlockNumber()) - 3n;
  const blk = await c0.getBlock({ blockNumber: B });
  const NOW = Number(blk.timestamp);

  const ur = (f, a) => encodeFunctionData({ abi: UR_ABI, functionName: f, args: a });
  const er = (f, a) => encodeFunctionData({ abi: ABI.ER, functionName: f, args: a });
  const urv = (f, a) => encodeFunctionData({ abi: ABI.UR, functionName: f, args: a });
  const uh = (f, a) => encodeFunctionData({ abi: ABI.UH, functionName: f, args: a });
  const RD = parseAbi(['function text(bytes32 node,string key) view returns (string)', 'function addr(bytes32 node) view returns (address)']);
  const rd = (f, a) => encodeFunctionData({ abi: RD, functionName: f, args: a });

  const TID = {};
  for (const l of ['vet402', 'seller-a']) {
    TID[l] = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B })).tokenId;
  }

  const rows = [];
  const push = (rid, status, value, gas) => { rows.push({ id: rid, status, value, ...(gas === undefined ? {} : { gas }) }); };

  // --- PRE: 今の鎖の状態（ここが変わっていたら会期の前提が崩れている） ---
  const rd1 = async (fn, args) => c0.readContract({ address: A.er, abi: ABI.ER, functionName: fn, args, blockNumber: B });
  push('PRE seller-a.subregistry', 'OK', String(await rd1('getSubregistry', ['seller-a'])).toLowerCase());
  push('PRE seller-a.resolver', 'OK', String(await rd1('getResolver', ['seller-a'])).toLowerCase());
  push('PRE W_ens.roles(seller-a)', 'OK', '0x' + (await rd1('roles', [TID['seller-a'], W_ENS])).toString(16));
  push('PRE W_ens.hasSetSubregistry', 'OK', String(await rd1('hasRoles', [TID['seller-a'], R_SET_SUBREG, W_ENS])));
  push('PRE W_vet.hasSetSubregistry', 'OK', String(await rd1('hasRoles', [TID['seller-a'], R_SET_SUBREG, W_VET])));

  const SALT_U  = BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
  const SALT_A1 = BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));
  const SALT_A  = BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
  const POLICY  = '{"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}';
  const OFFER_A = '{"v":1,"amount":"10000","asset":"USDC"}';
  const initU  = ur('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }]]);
  const initA1 = pr('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }], [
    pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', POLICY]),
    pr('setText', [dns('agent-1.vet402.eth'), 'class', 'x402-payer']),
    pr('setAddress', [dns('agent-1.vet402.eth'), 60n, K_AG1])]]);
  const initA = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
    pr('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A]),
    pr('setText', [dns('seller-a.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']),
    pr('setText', [dns('seller-a.eth'), ATT_KEY, 'ENVELOPE_A']),
    pr('setAddress', [dns('seller-a.eth'), 60n, W_ENS])]]);
  const dep = (i, s, d) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [i, s, d] });
  const pa = async (from, impl, salt, init) => viem.getAddress('0x' + (await c0.call({ account: from, to: A.vf, data: dep(impl, salt, init), blockNumber: B })).data.slice(26));

  const U = await pa(W_VET, UR_IMPL, SALT_U, initU);
  const P_AG1 = await pa(W_VET, A.impl, SALT_A1, initA1);
  const P_A = await pa(W_ENS, A.impl, SALT_A, initA);
  push('ADDR U', 'OK', U);
  push('ADDR P_AG1', 'OK', P_AG1);
  push('ADDR P_A', 'OK', P_A);

  const EXP = BigInt(NOW + 7 * 86400);
  // K1 の土台（seller-a に専用リゾルバ P_a・U を配備・agent-1 を登録）
  const BASE = [
    ['B1 VF.deployProxy(impl,SALT_A) → P_a', W_ENS, A.vf, dep(A.impl, SALT_A, initA)],
    ['B2 ETHRegistry.setResolver(seller-a, P_a)', W_ENS, A.er, er('setResolver', [TID['seller-a'], P_A])],
    ['B3 VF.deployProxy(UserRegistryImpl,SALT_U) → U', W_VET, A.vf, dep(UR_IMPL, SALT_U, initU)],
    ['B4 ETHRegistry.setSubregistry(vet402, U)', W_VET, A.er, er('setSubregistry', [TID['vet402'], U])],
    ['B5 VF.deployProxy(impl,SALT_A1) → P_AG1', W_VET, A.vf, dep(A.impl, SALT_A1, initA1)],
    ['B6 U.register("agent-1",K_ag1,0,P_AG1,RENEW,exp)', W_VET, U, ur('register', ['agent-1', K_AG1, ZERO, P_AG1, R_RENEW, EXP])],
  ];
  const mk = r => ({ from: r[1], to: r[2], data: r[3] });

  const runCase = async (name, extra) => {
    const { calls: res } = await simulate([...BASE.map(mk), ...extra.map(mk)], B, [url, ...SIM_RPC_LIST.filter(u => u !== url)]);
    res.slice(0, BASE.length).forEach((c, i) => {
      const ok = c.status === '0x1';
      push(`${name} base ${BASE[i][0]}`, ok ? 'OK' : 'REVERT', ok ? '' : dec(c.error?.data ?? c.returnData), parseInt(c.gasUsed, 16));
    });
    res.slice(BASE.length).forEach((c, i) => {
      const ok = c.status === '0x1';
      const rid = extra[i][0];
      const gas = parseInt(c.gasUsed, 16);
      let v;
      if (!ok) v = dec(c.error?.data ?? c.returnData);
      else if (rid.includes('resolve(text')) v = decText(c.returnData);
      else if (rid.includes('resolve(addr')) v = decAddr(c.returnData);
      else if (rid.includes('findResolver')) v = decRes(c.returnData);
      else v = (c.returnData || '').slice(0, 66);
      log(`${name} | ${ok ? 'OK    ' : 'REVERT'} | gas ${String(gas).padStart(7)} | ${rid} | ${v}`);
      push(`${name} ${rid}`, ok ? 'OK' : 'REVERT', v, gas);
    });
  };

  // U7-A: seller-a.eth の subregistry を U に向ける → seller-a.eth 自身の記録は無事か
  await runCase('U7-A', [
    ['A1 ETHRegistry.setSubregistry(seller-a, U)', W_ENS, A.er, er('setSubregistry', [TID['seller-a'], U])],
    ['A2 findResolver(seller-a.eth)', W_ENS, A.ur, urv('findResolver', [dns('seller-a.eth')])],
    ['A3 resolve(text seller-a.eth x402-offer)', W_ENS, A.ur, urv('resolve', [dns('seller-a.eth'), rd('text', [namehash('seller-a.eth'), 'x402-offer'])])],
    ['A4 resolve(text seller-a.eth 証明キー)', W_ENS, A.ur, urv('resolve', [dns('seller-a.eth'), rd('text', [namehash('seller-a.eth'), ATT_KEY])])],
    ['A5 resolve(addr seller-a.eth)', W_ENS, A.ur, urv('resolve', [dns('seller-a.eth'), rd('addr', [namehash('seller-a.eth')])])],
    ['A6 findResolver(agent-1.seller-a.eth)', W_ENS, A.ur, urv('findResolver', [dns('agent-1.seller-a.eth')])],
    ['A7 UH.findExactOwner(agent-1.seller-a.eth)', W_ENS, A.uh, uh('findExactOwner', [dns('agent-1.seller-a.eth')])],
    ['A8 resolve(text agent-1.seller-a.eth x402-policy)', W_ENS, A.ur, urv('resolve', [dns('agent-1.seller-a.eth'), rd('text', [namehash('agent-1.seller-a.eth'), 'x402-policy'])])],
    ['A9 findResolver(x.seller-a.eth 未登録の子)', W_ENS, A.ur, urv('findResolver', [dns('x.seller-a.eth')])],
    ['A10 resolve(text vet402側 agent-1.vet402.eth)', W_VET, A.ur, urv('resolve', [dns('agent-1.vet402.eth'), rd('text', [namehash('agent-1.vet402.eth'), 'x402-policy'])])],
  ]);
  // U7-B: linkToNode を足すと seller-a 側でも同じ方針が読めるか
  await runCase('U7-B', [
    ['B-1 ETHRegistry.setSubregistry(seller-a, U)', W_ENS, A.er, er('setSubregistry', [TID['seller-a'], U])],
    ['B-2 P_AG1.linkToNode(agent-1.seller-a.eth → node(agent-1.vet402.eth))', W_VET, P_AG1, pr('linkToNode', [dns('agent-1.seller-a.eth'), namehash('agent-1.vet402.eth')])],
    ['B-3 resolve(text agent-1.seller-a.eth x402-policy)', W_ENS, A.ur, urv('resolve', [dns('agent-1.seller-a.eth'), rd('text', [namehash('agent-1.seller-a.eth'), 'x402-policy'])])],
    ['B-4 resolve(text seller-a.eth x402-offer) 影響なしか', W_ENS, A.ur, urv('resolve', [dns('seller-a.eth'), rd('text', [namehash('seller-a.eth'), 'x402-offer'])])],
  ]);
  // U7-C: 取り消せるか・誰が打てるか
  await runCase('U7-C', [
    ['C1 W_vet（他人）が setSubregistry(seller-a, U)', W_VET, A.er, er('setSubregistry', [TID['seller-a'], U])],
    ['C2 W_ens が setSubregistry(seller-a, U)', W_ENS, A.er, er('setSubregistry', [TID['seller-a'], U])],
    ['C3 W_ens が setSubregistry(seller-a, 0) で戻す', W_ENS, A.er, er('setSubregistry', [TID['seller-a'], ZERO])],
    ['C4 findResolver(agent-1.seller-a.eth) 戻した後', W_ENS, A.ur, urv('findResolver', [dns('agent-1.seller-a.eth')])],
  ]);
  // U7-D: emancipation 後は戻せるか
  await runCase('U7-D', [
    ['D1 ETHRegistry.setSubregistry(seller-a, U)', W_ENS, A.er, er('setSubregistry', [TID['seller-a'], U])],
    ['D2 U.revokeRootRoles(UNEMANCIPATED, W_vet) = emancipation', W_VET, U, ur('revokeRootRoles', [UNEMANCIPATED, W_VET])],
    ['D3 emancipation 後に W_ens が setSubregistry(seller-a,0) で戻せるか', W_ENS, A.er, er('setSubregistry', [TID['seller-a'], ZERO])],
    ['D4 emancipation 後に W_vet が setSubregistry(vet402,0) で戻せるか', W_VET, A.er, er('setSubregistry', [TID['vet402'], ZERO])],
  ]);

  return { meta: { rpc: url, block: B.toString(), now: NOW, R_SHARED }, rows };
}
