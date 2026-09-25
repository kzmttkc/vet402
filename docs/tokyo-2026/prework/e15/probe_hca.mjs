import { viem, ABI, A, RPC_S, RPC_P, dns, J, client, pr, ALL_ROLES, ROLE_SET_TEXT, decErr, W_VET, W_ENS } from './lib.mjs';
const { keccak256, toBytes, toHex } = viem;
const c0 = client(RPC_S), c1 = client(RPC_P);
const B = await c0.getBlockNumber() - 3n;
const R_VET = '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
const R_SHARED = '0x49f5022dde516b92ac1609158bc6adc772088055';
const HCA_VET = '0xe96b16ab865aede373c6de768b3943fa615f173f';
const HCA_ENS = '0xd45a2e001a8e0681a7c4afa27fa88fff0fa1a5d9';
const KEY = BigInt(keccak256(toBytes('x402-offer')));
const rd = async (addr, fn, args) => { try { return J(await c0.readContract({ address: addr, abi: ABI.PR, functionName: fn, args, blockNumber: B })); } catch (e) { return 'ERR:' + (e.shortMessage||e.message).slice(0,120); } };
for (const [tag, r, h, o] of [['R_vet', R_VET, HCA_VET, W_VET], ['R_shared', R_SHARED, HCA_ENS, W_ENS]]) {
  console.log(tag, 'code(HCA).len', (await c0.getCode({ address: h }) ?? '0x').length, 'code(owner).len', (await c0.getCode({ address: o }) ?? '0x').length);
  console.log(' roles(0,HCA)      =', await rd(r, 'roles', [0n, h]));
  console.log(' hasRoles(key,0x10,HCA) =', await rd(r, 'hasRoles', [KEY, ROLE_SET_TEXT, h]));
  console.log(' hasRoles(key,0x10,owner)=', await rd(r, 'hasRoles', [KEY, ROLE_SET_TEXT, o]));
  console.log(' ROOT_RESOURCE     =', await rd(r, 'ROOT_RESOURCE', []));
  // eth_call（simulate ではなく）で setText を HCA/owner から
  for (const [who, from] of [['HCA', h], ['owner', o]]) {
    try { await c0.call({ account: from, to: r, data: pr('setText', [dns(tag==='R_vet'?'vet402.eth':'seller-b.eth'), 'x402-offer', 'probe']), blockNumber: B }); console.log(' eth_call setText from', who, '→ OK'); }
    catch (e) { console.log(' eth_call setText from', who, '→', (e.shortMessage||e.message).split('\n')[0].slice(0,140), e.cause?.data ? decErr(e.cause.data) : ''); }
  }
  // simulate でも同じか
  const body = { jsonrpc:'2.0', id:1, method:'eth_simulateV1', params:[{ blockStateCalls:[{ calls:[
    { from: h, to: r, data: pr('setText', [dns(tag==='R_vet'?'vet402.eth':'seller-b.eth'), 'x402-offer', 'probe']) },
    { from: o, to: r, data: pr('setText', [dns(tag==='R_vet'?'vet402.eth':'seller-b.eth'), 'x402-offer', 'probe2']) },
  ]}], validation:false }, toHex(B)] };
  const j = await (await fetch(RPC_S, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })).json();
  console.log(' simulate:', j.result?.[0]?.calls?.map(c => c.status === '0x1' ? 'OK' : decErr(c.error?.data ?? c.returnData)).join(' | '), j.error ? JSON.stringify(j.error).slice(0,200) : '');
}
