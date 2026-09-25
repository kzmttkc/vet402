// A3 共通: 読み取りだけ（eth_call・eth_blockNumber・eth_getLogs・eth_getBlockByNumber）
import { createPublicClient, http, parseAbi, toEventSelector, namehash } from '/Users/takeshi/vouch/node_modules/viem/_esm/index.js';
import { sepolia } from '/Users/takeshi/vouch/node_modules/viem/_esm/chains/index.js';
import { packetToBytes } from '/Users/takeshi/vouch/node_modules/viem/_esm/utils/ens/packetToBytes.js';
export const UR='0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
export const W_VET='0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6';
export const NAME='vet402.eth', TNAME='translator.nymspace.eth', TKEY='agent-endpoint[mcp]';
export const DNS=`0x${Buffer.from(packetToBytes(NAME)).toString('hex')}`;
export const T_ADDR=toEventSelector('event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress)');
export const T_EAC=toEventSelector('event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)');
export const CANARY_BLOCK=11600002n;
export const EAC_FROM=11383897n;           // REPRO §2 と同じ始点
export const EAC_TO=11719700n;             // 比べるために終点を固定（09-17 実測時点で確定済みのブロック）
export const EAC_STEP=10000n;              // REPRO §2 と同じ刻み
const urAbi=parseAbi(['function findOwner(bytes name) view returns (address)','function ROOT_REGISTRY() view returns (address)']);
export const TRES='0x45DaD53A7ad21fd62709DFa46e65C7501ed7C6eC';   // translator.nymspace.eth のリゾルバ（block 11708896 で UR から取得）
export const VRES='0xf8E7782d205fEf6f54767918534FF78B1d726Bfc';   // vet402.eth のリゾルバ（PLAN 追記 09-15）
export const REGISTRAR='0xa88553f454b77203b0d036a05c894d555eaaa2cc';
const resAbi=parseAbi(['function text(bytes32 node,string key) view returns (string)','function addr(bytes32 node) view returns (address)']);
const regAbi=parseAbi(['function isAvailable(string label) view returns (bool)']);
const hex=n=>'0x'+BigInt(n).toString(16);
export async function raw(url, method, params){
  const t=Date.now();
  try{
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(25000)});
    const txt=await r.text(); let j; try{ j=JSON.parse(txt);}catch{ return {ok:false,status:r.status,err:`HTTP ${r.status} non-json ${txt.slice(0,80)}`,ms:Date.now()-t}; }
    if(j.error) return {ok:false,status:r.status,err:`HTTP ${r.status} ${JSON.stringify(j.error).slice(0,160)}`,ms:Date.now()-t};
    if(r.status>=400) return {ok:false,status:r.status,err:`HTTP ${r.status}`,ms:Date.now()-t};
    return {ok:true,status:r.status,result:j.result,ms:Date.now()-t};
  }catch(e){ return {ok:false,status:0,err:String(e.message||e).slice(0,160),ms:Date.now()-t}; }
}
export function client(url){ return createPublicClient({chain:sepolia,transport:http(url,{retryCount:0,timeout:25000}),batch:false}); }
async function timed(p){ const t=Date.now(); try{ return {ok:true,v:await p,ms:Date.now()-t}; }catch(e){ const revert=!!(e.walk&&e.walk(x=>x?.name==='ContractFunctionRevertedError')); return {ok:false,revert,err:(e.shortMessage||String(e)).slice(0,160)+(e.status?` [HTTP ${e.status}]`:'')+(String(e.details||'').includes('429')?' [429]':''),status:e.status||0,ms:Date.now()-t}; } }
export async function head(url){ const r=await raw(url,'eth_blockNumber',[]); return r.ok?{...r,n:BigInt(r.result)}:r; }
// 固定ブロック B で全部読む
export async function readAt(url, c, B, resolver){
  const errs=[]; const rec={};
  const [own,txt,adr,blk,root,avail,rtext,raddr]=await Promise.all([
    timed(c.readContract({address:UR,abi:urAbi,functionName:'findOwner',args:[DNS],blockNumber:B})),
    timed(c.getEnsText({name:TNAME,key:TKEY,blockNumber:B,universalResolverAddress:UR})),
    timed(c.getEnsAddress({name:NAME,blockNumber:B,universalResolverAddress:UR})),
    raw(url,'eth_getBlockByNumber',[hex(B),false]),
    timed(c.readContract({address:UR,abi:urAbi,functionName:'ROOT_REGISTRY',blockNumber:B})),
    timed(c.readContract({address:REGISTRAR,abi:regAbi,functionName:'isAvailable',args:['vet402'],blockNumber:B})),
    timed(c.readContract({address:TRES,abi:resAbi,functionName:'text',args:[namehash(TNAME),TKEY],blockNumber:B})),
    timed(c.readContract({address:VRES,abi:resAbi,functionName:'addr',args:[namehash(NAME)],blockNumber:B})),
  ]);
  for(const [k,x] of [['owner',own],['text',txt],['addr',adr],['urRoot',root],['avail',avail],['resText',rtext],['resAddr',raddr]]){
    rec[k+'_ms']=x.ms;
    if(x.ok) rec[k]=x.v;
    else if(x.revert) rec[k]='REVERT';
    else { rec[k]=null; errs.push(`${k}: ${x.err}`); }
  }
  rec.blockHash=blk.ok?blk.result?.hash:null; if(!blk.ok) errs.push(`block: ${blk.err}`);
  const can=await raw(url,'eth_getLogs',[{fromBlock:hex(CANARY_BLOCK),toBlock:hex(CANARY_BLOCK),topics:[T_ADDR]}]);
  rec.canary_ms=can.ms;
  if(can.ok){ rec.canary=can.result.length; rec.canaryIds=can.result.map(l=>`${l.transactionHash}:${parseInt(l.logIndex,16)}`).sort().join(','); } else { rec.canary=null; errs.push(`canary: ${can.err}`); }
  // EAC: 固定範囲を 10,000 刻み。範囲エラーなら半分に割る（最小 500）
  let eac=0, eacIds=[], t0=Date.now(), minStep=EAC_STEP, calls=0, eacErr=null;
  const q=[]; for(let f=EAC_FROM; f<=EAC_TO; f+=EAC_STEP) q.push([f, f+EAC_STEP-1n>EAC_TO?EAC_TO:f+EAC_STEP-1n]);
  if(!resolver) q.length=0;
  while(q.length){
    const [f,t]=q.shift(); calls++;
    await sleep(100);
    const r=await raw(url,"eth_getLogs",[{address:resolver,fromBlock:hex(f),toBlock:hex(t),topics:[T_EAC]}]);
    if(r.ok){ eac+=r.result.length; for(const l of r.result) eacIds.push(`${l.transactionHash}:${parseInt(l.logIndex,16)}`); continue; }
    if(r.status!==429 && t-f+1n>500n){ const m=f+(t-f)/2n; q.unshift([f,m],[m+1n,t]); if(t-f+1n<=minStep*2n) minStep=(t-f+1n)/2n; continue; }
    eacErr=r.err; break;
  }
  rec.eac=!resolver?'skipped':eacErr?null:eac; rec.eacIds=eacIds.sort().join(','); rec.eac_ms=Date.now()-t0; rec.eac_calls=calls; rec.eac_minStep=Number(minStep);
  if(eacErr) errs.push(`eac: ${eacErr}`);
  rec.errs=errs; rec.has429=errs.some(e=>/429|Too Many|rate limit/i.test(e));
  return rec;
}
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const p50=a=>{ const s=a.filter(x=>x!=null).sort((x,y)=>x-y); return s.length?s[Math.floor((s.length-1)/2)]:null; };
