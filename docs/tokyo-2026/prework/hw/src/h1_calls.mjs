// H1 二系統一致: eth_call だけで確かめられる全項目を sentio / ethpandaops の両方で打つ
import fs from 'fs';
const SP='/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad';
const { viem, ABI, A, W_VET, RPC_S, RPC_P, dns, client, pr, ALL_ROLES } = await import(SP+'/e15/lib.mjs');
const { labelhash, keccak256, toBytes, toHex, encodeFunctionData } = viem;
const UR_ABI = (()=>{const d=JSON.parse(fs.readFileSync(SP+'/e15/ref/abi/new_UserRegistryImpl.json'));return d.abi??d;})();
const UR_IMPL='0xa80338aaa8d23831cea25e858d1774534abb0263';
const R_VET='0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
const K_AG1='0x41000000000000000000000000000000000000c1';
const R_SET_SUBREG=1n<<20n;
const ur=(fn,args)=>encodeFunctionData({abi:UR_ABI,functionName:fn,args});
const B = BigInt(process.env.FIXB);
const POLICY='{"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}';
const SALT_U=BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
const SALT_A1=BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));
const initU=ur('initialize',[[{account:W_VET,roleBitmap:ALL_ROLES}]]);
const initA1=pr('initialize',[[{account:W_VET,roleBitmap:ALL_ROLES}],[
  pr('setText',[dns('agent-1.vet402.eth'),'x402-policy',POLICY]),
  pr('setText',[dns('agent-1.vet402.eth'),'class','x402-payer']),
  pr('setAddress',[dns('agent-1.vet402.eth'),60n,K_AG1])]]);
const dep=(impl,salt,init)=>encodeFunctionData({abi:ABI.VF,functionName:'deployProxy',args:[impl,salt,init]});

const tests = [];
const T=(id,fn)=>tests.push({id,fn});
T('C1 UR_IMPL code size', async c=>String(((await c.getBytecode({address:UR_IMPL,blockNumber:B}))??'0x').length/2-1));
T('C2 UR_IMPL.LABEL_STORE()', async c=>String(await c.readContract({address:UR_IMPL,abi:UR_ABI,functionName:'LABEL_STORE',args:[],blockNumber:B})));
T('C3 UR_IMPL.canUpgradeFrom(0)', async c=>String(await c.readContract({address:UR_IMPL,abi:UR_ABI,functionName:'canUpgradeFrom',args:['0x0000000000000000000000000000000000000000'],blockNumber:B})));
T('C4 ETHRegistry.getSubregistry("vet402")', async c=>String(await c.readContract({address:A.er,abi:ABI.ER,functionName:'getSubregistry',args:['vet402'],blockNumber:B})));
T('C5 ETHRegistry.roles(vet402,W_vet)', async c=>{const s=await c.readContract({address:A.er,abi:ABI.ER,functionName:'getState',args:[BigInt(labelhash('vet402'))],blockNumber:B});return '0x'+(await c.readContract({address:A.er,abi:ABI.ER,functionName:'roles',args:[s.tokenId,W_VET],blockNumber:B})).toString(16);});
T('C6 hasRoles(vet402,SET_SUBREGISTRY,W_vet)', async c=>{const s=await c.readContract({address:A.er,abi:ABI.ER,functionName:'getState',args:[BigInt(labelhash('vet402'))],blockNumber:B});return String(await c.readContract({address:A.er,abi:ABI.ER,functionName:'hasRoles',args:[s.tokenId,R_SET_SUBREG,W_VET],blockNumber:B}));});
for (const n of ['vet402.eth','atst.vet402.eth','x.obs.vet402.eth','agent-1.vet402.eth','agent-2.vet402.eth','seller-a.eth'])
  T('C7 findResolver('+n+')', async c=>{const r=await c.readContract({address:A.ur,abi:ABI.UR,functionName:'findResolver',args:[dns(n)],blockNumber:B});return JSON.stringify(r,(k,v)=>typeof v==='bigint'?v.toString():v);});
T('C8 予測 U (eth_call VF.deployProxy)', async c=>{const r=await c.call({account:W_VET,to:A.vf,data:dep(UR_IMPL,SALT_U,initU),blockNumber:B});return viem.getAddress('0x'+r.data.slice(26));});
T('C9 予測 P_AG1 (eth_call VF.deployProxy)', async c=>{const r=await c.call({account:W_VET,to:A.vf,data:dep(A.impl,SALT_A1,initA1),blockNumber:B});return viem.getAddress('0x'+r.data.slice(26));});
T('C10 keccak("x402-policy") = EAC resource', async ()=>keccak256(toBytes('x402-policy')));
T('C11 ETHRegistry.getResolver("vet402")', async c=>String(await c.readContract({address:A.er,abi:ABI.ER,functionName:'getResolver',args:['vet402'],blockNumber:B})));
for (const l of ['seller-a','seller-b','seller-c'])
  T('C12 ETHRegistry.getResolver("'+l+'")', async c=>String(await c.readContract({address:A.er,abi:ABI.ER,functionName:'getResolver',args:[l],blockNumber:B})));

const cS=client(RPC_S), cP=client(RPC_P);
const out=[];
for (const t of tests){
  let a,b;
  try{a=await t.fn(cS);}catch(e){a='ERR '+String(e).slice(0,90);}
  try{b=await t.fn(cP);}catch(e){b='ERR '+String(e).slice(0,90);}
  const m=a===b;
  out.push({id:t.id,sentio:a,pandaops:b,match:m});
  console.log((m?'一致  ':'不一致')+' | '+t.id+' | '+String(a).slice(0,110)+(m?'':' || P='+String(b).slice(0,110)));
}
console.log('一致', out.filter(x=>x.match).length, '/', out.length, 'block', B.toString());
fs.writeFileSync(SP+'/hw/h1_calls.json', JSON.stringify({block:B.toString(),rows:out},null,1));
