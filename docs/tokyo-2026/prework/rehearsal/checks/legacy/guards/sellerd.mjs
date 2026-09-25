import fs from 'fs';
import { viem, ABI, A, W_VET, W_ENS, W_OP, RPC_S, ZERO, ALL_ROLES, dns, client, pr, er, ATT_KEY, dec } from './lib.mjs';
const { labelhash, keccak256, toBytes, toHex, encodeFunctionData, parseAbi } = viem;
const c0 = client(RPC_S);
const B = process.env.FIXB ? BigInt(process.env.FIXB) : (await c0.getBlockNumber()) - 3n;
const blk = await c0.getBlock({ blockNumber: B }); const NOW = Number(blk.timestamp);
const MOCK_USDC = '0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e';
const out = { block: B.toString(), ts: NOW };
const rg = (f, a) => encodeFunctionData({ abi: ABI.RG, functionName: f, args: a });
out.isAvailable_seller_d = await c0.readContract({ address: A.rg, abi: ABI.RG, functionName: 'isAvailable', args: ['seller-d'], blockNumber: B });
out.minCommitAge = Number(await c0.readContract({ address: A.rg, abi: ABI.RG, functionName: 'MIN_COMMITMENT_AGE', args: [], blockNumber: B }));
const DUR = 31536000n; // 1年
try { const p = await c0.readContract({ address: A.rg, abi: ABI.RG, functionName: 'getRegisterPrice', args: ['seller-d', DUR, MOCK_USDC], blockNumber: B }); out.price_usdc = String(p); } catch (e) { out.price_usdc = 'ERR ' + String(e.shortMessage || e).slice(0, 120); }
try { const p = await c0.readContract({ address: A.rg, abi: ABI.RG, functionName: 'getRegisterPrice', args: ['seller-d', DUR, ZERO], blockNumber: B }); out.price_eth = String(p); } catch (e) { out.price_eth = 'ERR ' + String(e.shortMessage || e).slice(0, 120); }
out.usdc_bal_W_ens = String(await c0.readContract({ address: MOCK_USDC, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [W_ENS], blockNumber: B }));
out.usdc_allowance = String(await c0.readContract({ address: MOCK_USDC, abi: parseAbi(['function allowance(address,address) view returns (uint256)']), functionName: 'allowance', args: [W_ENS, A.rg], blockNumber: B }));

const SECRET = keccak256(toBytes('tokyo-2026/seller-d/secret'));
const REF = '0x' + '00'.repeat(32);
const USDC = MOCK_USDC;
const erc20 = (f, a) => encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)', 'function mint(address,uint256)']), functionName: f, args: a });
const commitment = await c0.readContract({ address: A.rg, abi: ABI.RG, functionName: 'makeCommitment', args: ['seller-d', W_ENS, SECRET, ZERO, ZERO, DUR, REF], blockNumber: B });

// 2 ブロックに分ける: 1) approve + commit  2) 時刻を +120s 進めて register + 後続
const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [
  { calls: [ { from: W_ENS, to: USDC, data: erc20('approve', [A.rg, (1n << 255n)]) },
             { from: W_ENS, to: A.rg, data: rg('commit', [commitment]) } ] },
  { blockOverrides: { time: toHex(NOW + 180) }, calls: [
      { from: W_ENS, to: A.rg, data: rg('register', ['seller-d', W_ENS, SECRET, ZERO, ZERO, DUR, USDC, REF]) } ] },
], validation: false }, toHex(B)] };
const j = await (await fetch(RPC_S, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
if (j.error) { out.register_sim = 'RPC ERROR ' + JSON.stringify(j.error).slice(0, 300); }
else {
  const b1 = j.result[0].calls, b2 = j.result[1].calls;
  out.register_sim = { approve: { s: b1[0].status, gas: parseInt(b1[0].gasUsed, 16), err: b1[0].status === '0x1' ? undefined : dec(b1[0].error?.data ?? b1[0].returnData) },
    commit: { s: b1[1].status, gas: parseInt(b1[1].gasUsed, 16), err: b1[1].status === '0x1' ? undefined : dec(b1[1].error?.data ?? b1[1].returnData) },
    register: { s: b2[0].status, gas: parseInt(b2[0].gasUsed, 16), err: b2[0].status === '0x1' ? undefined : dec(b2[0].error?.data ?? b2[0].returnData) } };
}
console.log(JSON.stringify(out, null, 1));

// ---- P_d（K1-04 と同型）・setResolver・grantSetterRoles・B5b-d を測る ----
const USDC_BS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const OFFER_D = `{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"${USDC_BS}","amount":"10000","payTo":"${W_ENS}","output":{"required":["result","observed_at"]}}`;
const ENV = Buffer.from(Array.from({ length: 79 }, (_, i) => (i * 37 + 11) & 0xff)).toString('base64');
const SALT_D = BigInt(keccak256(toBytes('tokyo-2026/seller-d.eth')));
const initD = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('seller-d.eth'), 'x402-offer', OFFER_D]),
  pr('setText', [dns('seller-d.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']),
  pr('setAddress', [dns('seller-d.eth'), 60n, W_ENS])]]);
const dep = (i, s, d) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [i, s, d] });
const P_D = viem.getAddress('0x' + (await c0.call({ account: W_ENS, to: A.vf, data: dep(A.impl, SALT_D, initD), blockNumber: B })).data.slice(26));
const body2 = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [
  { calls: [ { from: W_ENS, to: USDC, data: erc20('approve', [A.rg, (1n << 255n)]) },
             { from: W_ENS, to: A.rg, data: rg('commit', [commitment]) } ] },
  { blockOverrides: { time: toHex(NOW + 180) }, calls: [
      { from: W_ENS, to: A.rg, data: rg('register', ['seller-d', W_ENS, SECRET, ZERO, ZERO, DUR, USDC, REF]) },
      { from: W_ENS, to: A.vf, data: dep(A.impl, SALT_D, initD) },
      { from: W_ENS, to: A.er, data: er('setResolver', [BigInt((await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash('seller-d'))], blockNumber: B })).tokenId), P_D]) },
      { from: W_ENS, to: P_D, data: pr('grantSetterRoles', [pr('setText', [dns('seller-d.eth'), 'x402-offer', '']), W_OP]) },
      { from: W_ENS, to: P_D, data: pr('setText', [dns('seller-d.eth'), ATT_KEY, ENV]) },
      { from: W_OP, to: P_D, data: pr('setText', [dns('seller-d.eth'), 'x402-offer', OFFER_D.replace('"10000"', '"10001"')]) },
  ] }], validation: false }, toHex(B)] };
const j2 = await (await fetch(RPC_S, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body2) })).json();
if (j2.error) console.log('ERR2', JSON.stringify(j2.error).slice(0, 300));
else {
  const names = ['approve', 'commit'], n2 = ['register', 'D-04 deployProxy(P_d)', 'D-05 setResolver', 'D-06 grantSetterRoles(W_op)', 'B5b-d setText(att)', 'D-1(seller-d) W_op setText'];
  const res = [];
  j2.result[0].calls.forEach((c, i) => res.push({ id: names[i], blk: 1, status: c.status, gas: parseInt(c.gasUsed, 16), err: c.status === '0x1' ? undefined : dec(c.error?.data ?? c.returnData) }));
  j2.result[1].calls.forEach((c, i) => res.push({ id: n2[i], blk: 2, status: c.status, gas: parseInt(c.gasUsed, 16), err: c.status === '0x1' ? undefined : dec(c.error?.data ?? c.returnData) }));
  res.forEach(r => console.log(' ', r.id, r.status === '0x1' ? 'OK' : 'REVERT', r.gas, r.err ?? ''));
  out.seller_d = { P_D, rows: res, total_W_ens: res.filter(r => r.status === '0x1' && r.id !== 'D-1(seller-d) W_op setText').reduce((s, r) => s + r.gas, 0) };
  console.log('seller-d の W_ens 合計', out.seller_d.total_W_ens);
}
fs.writeFileSync('./SELLER_D.json', JSON.stringify(out, null, 1));
