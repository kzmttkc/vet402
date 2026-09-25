// H13: U7 "namespace aliasing via a shared registry" を本番で打つ場合のコストと危険を測る
import fs from 'fs';
const SP='/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad';
const { viem, ABI, A, W_VET, W_ENS, RPC_S, dns, client, pr, ALL_ROLES, ATT_KEY } = await import(SP+'/e15/lib.mjs');
const { labelhash, namehash, keccak256, toBytes, toHex, encodeFunctionData, parseAbi, decodeAbiParameters, getEventSelector } = viem;
const UR_ABI=(()=>{const d=JSON.parse(fs.readFileSync(SP+'/e15/ref/abi/new_UserRegistryImpl.json'));return d.abi??d;})();
const UR_IMPL='0xa80338aaa8d23831cea25e858d1774534abb0263';
const R_SHARED='0x49f5022dDe516B92AC1609158bC6AdC772088055';
const K_AG1='0x41000000000000000000000000000000000000c1';
const ZERO='0x0000000000000000000000000000000000000000';
const R_RENEW=1n<<16n, R_SET_SUBREG=1n<<20n, R_SET_RESOLVER=1n<<24n, R_UNREGISTER=1n<<12n, R_UPGRADE=1n<<124n;
const UNEMANCIPATED = R_SET_SUBREG|(R_SET_SUBREG<<128n)|R_SET_RESOLVER|(R_SET_RESOLVER<<128n)|R_UNREGISTER|(R_UNREGISTER<<128n)|R_UPGRADE|(R_UPGRADE<<128n);
const c0=client(RPC_S);
const B = BigInt(process.env.FIXB);
const blk = await c0.getBlock({blockNumber:B});
const NOW=Number(blk.timestamp);
const ur=(f,a)=>encodeFunctionData({abi:UR_ABI,functionName:f,args:a});
const er=(f,a)=>encodeFunctionData({abi:ABI.ER,functionName:f,args:a});
const urv=(f,a)=>encodeFunctionData({abi:ABI.UR,functionName:f,args:a});
const uh=(f,a)=>encodeFunctionData({abi:ABI.UH,functionName:f,args:a});
const RD=parseAbi(['function text(bytes32 node,string key) view returns (string)','function addr(bytes32 node) view returns (address)']);
const rd=(f,a)=>encodeFunctionData({abi:RD,functionName:f,args:a});
const ALL_ERR=[...ABI.PR,...ABI.VF,...ABI.ER,...ABI.UH,...ABI.UR,...ABI.RG,...UR_ABI].filter(x=>x.type==='error');
const dec=d=>{try{const r=viem.decodeErrorResult({abi:ALL_ERR,data:d});return r.errorName+'('+(r.args||[]).map(a=>typeof a==='bigint'?'0x'+a.toString(16):String(a)).join(',')+')';}catch{return 'raw:'+String(d).slice(0,60);}};
const decText=r=>{try{const[b]=decodeAbiParameters([{type:'bytes'},{type:'address'}],r);const[s]=decodeAbiParameters([{type:'string'}],b);return JSON.stringify(s);}catch{return 'EMPTY';}};
const decAddr=r=>{try{const[b,res]=decodeAbiParameters([{type:'bytes'},{type:'address'}],r);const[a]=decodeAbiParameters([{type:'address'}],b);return a+' via '+res;}catch{return 'EMPTY';}};
const decRes=r=>{try{const[a]=decodeAbiParameters([{type:'address'},{type:'bytes32'},{type:'uint256'}],r);return a;}catch{return r.slice(0,42);}};

const TID={}; for(const l of ['vet402','seller-a']) TID[l]=(await c0.readContract({address:A.er,abi:ABI.ER,functionName:'getState',args:[BigInt(labelhash(l))],blockNumber:B})).tokenId;
const pre={};
pre.seller_a_subregistry = await c0.readContract({address:A.er,abi:ABI.ER,functionName:'getSubregistry',args:['seller-a'],blockNumber:B});
pre.seller_a_resolver = await c0.readContract({address:A.er,abi:ABI.ER,functionName:'getResolver',args:['seller-a'],blockNumber:B});
pre.W_ens_roles = '0x'+(await c0.readContract({address:A.er,abi:ABI.ER,functionName:'roles',args:[TID['seller-a'],W_ENS],blockNumber:B})).toString(16);
pre.W_ens_hasSetSubregistry = await c0.readContract({address:A.er,abi:ABI.ER,functionName:'hasRoles',args:[TID['seller-a'],R_SET_SUBREG,W_ENS],blockNumber:B});
pre.W_vet_hasSetSubregistry = await c0.readContract({address:A.er,abi:ABI.ER,functionName:'hasRoles',args:[TID['seller-a'],R_SET_SUBREG,W_VET],blockNumber:B});
pre.baseFeePerGas = blk.baseFeePerGas?.toString();
console.log('PRE', JSON.stringify(pre,null,1));

const SALT_U=BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
const SALT_A1=BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));
const SALT_A=BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
const POLICY='{"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}';
const OFFER_A='{"v":1,"amount":"10000","asset":"USDC"}';
const initU=ur('initialize',[[{account:W_VET,roleBitmap:ALL_ROLES}]]);
const initA1=pr('initialize',[[{account:W_VET,roleBitmap:ALL_ROLES}],[
  pr('setText',[dns('agent-1.vet402.eth'),'x402-policy',POLICY]),
  pr('setText',[dns('agent-1.vet402.eth'),'class','x402-payer']),
  pr('setAddress',[dns('agent-1.vet402.eth'),60n,K_AG1])]]);
const initA=pr('initialize',[[{account:W_ENS,roleBitmap:ALL_ROLES}],[
  pr('setText',[dns('seller-a.eth'),'x402-offer',OFFER_A]),
  pr('setText',[dns('seller-a.eth'),'agent-endpoint[x402]','https://vet402.com/api/tokyo/seller']),
  pr('setText',[dns('seller-a.eth'),ATT_KEY,'ENVELOPE_A']),
  pr('setAddress',[dns('seller-a.eth'),60n,W_ENS])]]);
const dep=(i,s,d)=>encodeFunctionData({abi:ABI.VF,functionName:'deployProxy',args:[i,s,d]});
const pa=async(from,impl,salt,init)=>viem.getAddress('0x'+(await c0.call({account:from,to:A.vf,data:dep(impl,salt,init),blockNumber:B})).data.slice(26));
const U=await pa(W_VET,UR_IMPL,SALT_U,initU);
const P_AG1=await pa(W_VET,A.impl,SALT_A1,initA1);
const P_A=await pa(W_ENS,A.impl,SALT_A,initA);
console.log('U',U,'P_AG1',P_AG1,'P_A',P_A);
const EXP=BigInt(NOW+7*86400);

const sim=async calls=>{
  const j=await(await fetch(RPC_S,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_simulateV1',params:[{blockStateCalls:[{calls}],validation:false},toHex(B)]})})).json();
  if(j.error) throw new Error(JSON.stringify(j.error).slice(0,300));
  return j.result[0].calls;
};
// K1 の土台（seller-a に専用リゾルバ P_a・U を配備・agent-1 を登録）
const BASE=[
 ['B1 VF.deployProxy(impl,SALT_A) → P_a', W_ENS, A.vf, dep(A.impl,SALT_A,initA)],
 ['B2 ETHRegistry.setResolver(seller-a, P_a)', W_ENS, A.er, er('setResolver',[TID['seller-a'],P_A])],
 ['B3 VF.deployProxy(UserRegistryImpl,SALT_U) → U', W_VET, A.vf, dep(UR_IMPL,SALT_U,initU)],
 ['B4 ETHRegistry.setSubregistry(vet402, U)', W_VET, A.er, er('setSubregistry',[TID['vet402'],U])],
 ['B5 VF.deployProxy(impl,SALT_A1) → P_AG1', W_VET, A.vf, dep(A.impl,SALT_A1,initA1)],
 ['B6 U.register("agent-1",K_ag1,0,P_AG1,RENEW,exp)', W_VET, U, ur('register',['agent-1',K_AG1,ZERO,P_AG1,R_RENEW,EXP])],
];
const mk=r=>({from:r[1],to:r[2],data:r[3]});
const T={};
const run=async(name,extra)=>{
  const calls=[...BASE.map(mk),...extra.map(mk)];
  const res=await sim(calls);
  const rows=res.slice(BASE.length).map((c,i)=>{
    const ok=c.status==='0x1';
    const id=extra[i][0]; const gas=parseInt(c.gasUsed,16);
    let v=''; if(!ok) v=dec(c.error?.data??c.returnData);
    else if(id.includes('resolve(text')) v=decText(c.returnData);
    else if(id.includes('resolve(addr')) v=decAddr(c.returnData);
    else if(id.includes('findResolver')) v=decRes(c.returnData);
    else v=(c.returnData||'').slice(0,66);
    console.log(`${name} | ${ok?'OK    ':'REVERT'} | gas ${String(gas).padStart(7)} | ${id} | ${v}`);
    return {id,status:ok?'OK':'REVERT',gas,v};
  });
  const pre=res.slice(0,BASE.length).map((c,i)=>({id:BASE[i][0],status:c.status==='0x1'?'OK':'REVERT',gas:parseInt(c.gasUsed,16),err:c.status==='0x1'?'':dec(c.error?.data??c.returnData)}));
  T[name]={base:pre,rows};
};
// U7-A: seller-a.eth の subregistry を U に向ける → seller-a.eth 自身の記録は無事か
await run('U7-A', [
 ['A1 ETHRegistry.setSubregistry(seller-a, U)', W_ENS, A.er, er('setSubregistry',[TID['seller-a'],U])],
 ['A2 findResolver(seller-a.eth)', W_ENS, A.ur, urv('findResolver',[dns('seller-a.eth')])],
 ['A3 resolve(text seller-a.eth x402-offer)', W_ENS, A.ur, urv('resolve',[dns('seller-a.eth'),rd('text',[namehash('seller-a.eth'),'x402-offer'])])],
 ['A4 resolve(text seller-a.eth 証明キー)', W_ENS, A.ur, urv('resolve',[dns('seller-a.eth'),rd('text',[namehash('seller-a.eth'),ATT_KEY])])],
 ['A5 resolve(addr seller-a.eth)', W_ENS, A.ur, urv('resolve',[dns('seller-a.eth'),rd('addr',[namehash('seller-a.eth')])])],
 ['A6 findResolver(agent-1.seller-a.eth)', W_ENS, A.ur, urv('findResolver',[dns('agent-1.seller-a.eth')])],
 ['A7 UH.findExactOwner(agent-1.seller-a.eth)', W_ENS, A.uh, uh('findExactOwner',[dns('agent-1.seller-a.eth')])],
 ['A8 resolve(text agent-1.seller-a.eth x402-policy)', W_ENS, A.ur, urv('resolve',[dns('agent-1.seller-a.eth'),rd('text',[namehash('agent-1.seller-a.eth'),'x402-policy'])])],
 ['A9 findResolver(x.seller-a.eth 未登録の子)', W_ENS, A.ur, urv('findResolver',[dns('x.seller-a.eth')])],
 ['A10 resolve(text vet402側 agent-1.vet402.eth)', W_VET, A.ur, urv('resolve',[dns('agent-1.vet402.eth'),rd('text',[namehash('agent-1.vet402.eth'),'x402-policy'])])],
]);
// U7-B: linkToNode を足すと seller-a 側でも同じ方針が読めるか
await run('U7-B', [
 ['B-1 ETHRegistry.setSubregistry(seller-a, U)', W_ENS, A.er, er('setSubregistry',[TID['seller-a'],U])],
 ['B-2 P_AG1.linkToNode(agent-1.seller-a.eth → node(agent-1.vet402.eth))', W_VET, P_AG1, pr('linkToNode',[dns('agent-1.seller-a.eth'),namehash('agent-1.vet402.eth')])],
 ['B-3 resolve(text agent-1.seller-a.eth x402-policy)', W_ENS, A.ur, urv('resolve',[dns('agent-1.seller-a.eth'),rd('text',[namehash('agent-1.seller-a.eth'),'x402-policy'])])],
 ['B-4 resolve(text seller-a.eth x402-offer) 影響なしか', W_ENS, A.ur, urv('resolve',[dns('seller-a.eth'),rd('text',[namehash('seller-a.eth'),'x402-offer'])])],
]);
// U7-C: 取り消せるか・誰が打てるか・emancipation 後は戻せるか
await run('U7-C', [
 ['C1 W_vet（他人）が setSubregistry(seller-a, U)', W_VET, A.er, er('setSubregistry',[TID['seller-a'],U])],
 ['C2 W_ens が setSubregistry(seller-a, U)', W_ENS, A.er, er('setSubregistry',[TID['seller-a'],U])],
 ['C3 W_ens が setSubregistry(seller-a, 0) で戻す', W_ENS, A.er, er('setSubregistry',[TID['seller-a'],ZERO])],
 ['C4 findResolver(agent-1.seller-a.eth) 戻した後', W_ENS, A.ur, urv('findResolver',[dns('agent-1.seller-a.eth')])],
]);
await run('U7-D', [
 ['D1 ETHRegistry.setSubregistry(seller-a, U)', W_ENS, A.er, er('setSubregistry',[TID['seller-a'],U])],
 ['D2 U.revokeRootRoles(UNEMANCIPATED, W_vet) = emancipation', W_VET, U, ur('revokeRootRoles',[UNEMANCIPATED,W_VET])],
 ['D3 emancipation 後に W_ens が setSubregistry(seller-a,0) で戻せるか', W_ENS, A.er, er('setSubregistry',[TID['seller-a'],ZERO])],
 ['D4 emancipation 後に W_vet が setSubregistry(vet402,0) で戻せるか', W_VET, A.er, er('setSubregistry',[TID['vet402'],ZERO])],
]);
fs.writeFileSync(SP+'/hw/h13.json',JSON.stringify({block:B.toString(),now:NOW,pre,U,P_AG1,P_A,T},(k,v)=>typeof v==='bigint'?v.toString():v,1));
