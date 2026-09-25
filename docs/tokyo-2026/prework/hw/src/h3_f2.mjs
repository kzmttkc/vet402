// F2: clearRecords の後継（linkToRecord/linkToNode）が読み手に何を見せるか
import fs from 'fs';
const SP='/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad';
const { viem, ABI, A, W_ENS, RPC_S, dns, client, pr, ALL_ROLES, ATT_KEY, decErr } = await import(SP+'/e15/lib.mjs');
const { labelhash, namehash, keccak256, toBytes, toHex, encodeFunctionData, getEventSelector, parseAbi, decodeAbiParameters } = viem;
const B=BigInt(process.env.FIXB); const c0=client(RPC_S);
const EV={}; for(const e of ABI.PR.filter(x=>x.type==='event')){try{EV[getEventSelector(e)]=e.name;}catch{}}
const TID={}; for(const l of ['seller-a']) TID[l]=(await c0.readContract({address:A.er,abi:ABI.ER,functionName:'getState',args:[BigInt(labelhash(l))],blockNumber:B})).tokenId;
const SALT_A=BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
const initA=pr('initialize',[[{account:W_ENS,roleBitmap:ALL_ROLES}],[
  pr('setText',[dns('seller-a.eth'),'x402-offer','{"v":1,"amount":"10000","asset":"USDC"}']),
  pr('setText',[dns('seller-a.eth'),ATT_KEY,'ENVELOPE_A']),
  pr('setAddress',[dns('seller-a.eth'),60n,W_ENS])]]);
const dep=(i,s,d)=>encodeFunctionData({abi:ABI.VF,functionName:'deployProxy',args:[i,s,d]});
const P_A=viem.getAddress('0x'+(await c0.call({account:W_ENS,to:A.vf,data:dep(A.impl,SALT_A,initA),blockNumber:B})).data.slice(26));
const er=(f,a)=>encodeFunctionData({abi:ABI.ER,functionName:f,args:a});
const urv=(f,a)=>encodeFunctionData({abi:ABI.UR,functionName:f,args:a});
const RD=parseAbi(['function text(bytes32 node,string key) view returns (string)']);
const rd=(f,a)=>encodeFunctionData({abi:RD,functionName:f,args:a});
const decText=r=>{try{const[b]=decodeAbiParameters([{type:'bytes'},{type:'address'}],r);const[s]=decodeAbiParameters([{type:'string'}],b);return JSON.stringify(s);}catch{return 'EMPTY';}};
const L=[
 ['1 deployProxy → P_a', W_ENS, A.vf, dep(A.impl,SALT_A,initA)],
 ['2 setResolver(seller-a, P_a)', W_ENS, A.er, er('setResolver',[TID['seller-a'],P_A])],
 ['3 resolve(text x402-offer) 前', W_ENS, A.ur, urv('resolve',[dns('seller-a.eth'),rd('text',[namehash('seller-a.eth'),'x402-offer'])])],
 ['4 getRecordId(seller-a.eth)', W_ENS, P_A, pr('getRecordId',[namehash('seller-a.eth')])],
 ['5 linkToRecord(seller-a.eth, 0) = 記録を外す（clearRecords の後継）', W_ENS, P_A, pr('linkToRecord',[dns('seller-a.eth'),0n])],
 ['6 resolve(text x402-offer) 後', W_ENS, A.ur, urv('resolve',[dns('seller-a.eth'),rd('text',[namehash('seller-a.eth'),'x402-offer'])])],
 ['7 resolve(text 証明キー) 後', W_ENS, A.ur, urv('resolve',[dns('seller-a.eth'),rd('text',[namehash('seller-a.eth'),ATT_KEY])])],
 ['8 getRecordId(seller-a.eth) 後', W_ENS, P_A, pr('getRecordId',[namehash('seller-a.eth')])],
 ['9 linkToRecord(seller-a.eth, 1) で戻す', W_ENS, P_A, pr('linkToRecord',[dns('seller-a.eth'),1n])],
 ['10 resolve(text x402-offer) 戻した後', W_ENS, A.ur, urv('resolve',[dns('seller-a.eth'),rd('text',[namehash('seller-a.eth'),'x402-offer'])])],
];
const j=await(await fetch(RPC_S,{method:'POST',headers:{'content-type':'application/json'},
 body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_simulateV1',params:[{blockStateCalls:[{calls:L.map(r=>({from:r[1],to:r[2],data:r[3]}))}],validation:false},toHex(B)]})})).json();
const rows=j.result[0].calls.map((c,i)=>{
 const ok=c.status==='0x1'; const id=L[i][0];
 const logs=(c.logs||[]).map(l=>EV[l.topics[0]]??l.topics[0].slice(0,10));
 const v = !ok ? decErr(c.error?.data??c.returnData) : (id.includes('resolve(text')? decText(c.returnData) : (c.returnData||'').slice(0,66));
 console.log(`${ok?'OK    ':'REVERT'} gas ${String(parseInt(c.gasUsed,16)).padStart(7)} | ${id} | ${v} | logs=[${logs.join(',')}]`);
 return {id,status:ok?'OK':'REVERT',gas:parseInt(c.gasUsed,16),v,logs};
});
fs.writeFileSync(SP+'/hw/h3_f2.json',JSON.stringify({block:B.toString(),P_A,rows},null,1));
