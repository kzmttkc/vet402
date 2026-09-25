import { viem, ABI, A, W_VET, W_ENS, RPC_S, ZERO, ALL_ROLES, dns, client, pr, er, ATT_KEY, simRaw } from './lib.mjs';
const { labelhash, keccak256, toBytes, encodeFunctionData } = viem;
const c0 = client(RPC_S);
const B = process.env.FIXB ? BigInt(process.env.FIXB) : (await c0.getBlockNumber()) - 3n;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const mkOffer = (a) => `{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"${USDC}","amount":"${a}","payTo":"${W_ENS}","output":{"required":["result","observed_at"]}}`;
const TID = {}; for (const l of ['seller-b','seller-c']) TID[l]=(await c0.readContract({address:A.er,abi:ABI.ER,functionName:'getState',args:[BigInt(labelhash(l))],blockNumber:B})).tokenId;
const SALT_BC = BigInt(keccak256(toBytes('tokyo-2026/seller-bc.eth')));
const dep=(i,s,d)=>encodeFunctionData({abi:ABI.VF,functionName:'deployProxy',args:[i,s,d]});
const b64 = n => Buffer.from(Array.from({length:n},(_,i)=>(i*37+11)&0xff)).toString('base64');
const hexEnv = n => '0x'+Buffer.from(Array.from({length:n},(_,i)=>(i*37+11)&0xff)).toString('hex');
const rows=[];
for (const ph of ['', 'ENVELOPE_B', b64(79)]) {
  for (const [encName, val] of [['base64(79B)=108ch', b64(79)], ['hex(79B)=160ch', hexEnv(79)], ['base64 79ch', b64(79).slice(0,79)]]) {
    const initBC = pr('initialize', [[{account:W_ENS, roleBitmap:ALL_ROLES}], [
      pr('setText',[dns('seller-b.eth'),'x402-offer',mkOffer('20000')]),
      ...(ph===''?[]:[pr('setText',[dns('seller-b.eth'),ATT_KEY,ph])]),
      pr('setAddress',[dns('seller-b.eth'),60n,W_ENS]),
      pr('setText',[dns('seller-c.eth'),'x402-offer',mkOffer('30000')]),
      ...(ph===''?[]:[pr('setText',[dns('seller-c.eth'),ATT_KEY,ph])]),
      pr('setAddress',[dns('seller-c.eth'),60n,W_ENS])]]);
    const P_BC = viem.getAddress('0x'+(await c0.call({account:W_ENS,to:A.vf,data:dep(A.impl,SALT_BC,initBC),blockNumber:B})).data.slice(26));
    const calls=[{from:W_ENS,to:A.vf,data:dep(A.impl,SALT_BC,initBC)},
      {from:W_ENS,to:A.er,data:er('setResolver',[TID['seller-b'],P_BC])},
      {from:W_ENS,to:A.er,data:er('setResolver',[TID['seller-c'],P_BC])},
      {from:W_ENS,to:P_BC,data:pr('setText',[dns('seller-b.eth'),ATT_KEY,val])},
      {from:W_ENS,to:P_BC,data:pr('setText',[dns('seller-c.eth'),ATT_KEY,val])}];
    const r = await simRaw(RPC_S, calls, B);
    const g = r.map(x=>parseInt(x.gasUsed,16));
    rows.push({placeholder: ph===''?'(なし)':`"${ph.slice(0,12)}"(${ph.length}ch)`, enc:encName, K1_07:g[0], B5b_b:g[3], B5b_c:g[4], ok:r.every(x=>x.status==='0x1')});
    console.log(rows.at(-1));
  }
}
console.log('block', B.toString());
