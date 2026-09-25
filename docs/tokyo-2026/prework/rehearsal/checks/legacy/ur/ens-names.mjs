// Tokyo 2026 準備: Sepolia ENSv2 の名前が消えていないか・配備し直しが起きていないかを読む（読み取りだけ・署名なし）
// 使い方: node ~/hackathon-monitor/ens-names.mjs   → 1行 JSON。exit 0=全部そのまま / 2=変化あり（名前・持ち主・配備） / 1=読めない・RPC 不一致
// 2026-09-17 改訂: 09-15 の配備し直しで UniversalResolver の findOwner が無くなったため、
//   UR.ROOT_REGISTRY → root.getSubregistry("eth") → ETHRegistry.getState(labelhash) の latestOwner を読む。
//   ROOT_REGISTRY が記録値と違えば「配備し直し」として exit 2。
import { createPublicClient, http, parseAbi, labelhash } from 'viem';
import { sepolia } from 'viem/chains';
const UR='0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const EXPECT_ROOT='0x9703DBD26dAB89504490994138cF2c575251a9cE'; // 2026-09-15 の配備
const WV='0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6', WE='0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
// 期待する持ち主。環境変数 ENS_EXPECT_UNREGISTERED=1 の間は「まだ取り直していない」前提で、未登録を変化として扱わない
const EXPECT={ 'vet402':WV, 'seller-a':WE, 'seller-b':WE, 'seller-c':WE };
const PENDING=process.env.ENS_EXPECT_UNREGISTERED==='1';
const rpcs=['https://sepolia.rpc.sentio.xyz','https://rpc.sepolia.ethpandaops.io']; // A3 で 20/20 の組
const urAbi=parseAbi(['function ROOT_REGISTRY() view returns (address)']);
const rootAbi=parseAbi(['function getSubregistry(string) view returns (address)']);
const regAbi=parseAbi(['function getState(uint256) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))']);
const out={checked_at:new Date().toISOString(),rpc_agree:true,redeploy:false,names:{}};
let changed=false;
const same=(a,b)=>JSON.stringify(a,(k,v)=>typeof v==='bigint'?v.toString():v).toLowerCase()===JSON.stringify(b,(k,v)=>typeof v==='bigint'?v.toString():v).toLowerCase();
try{
  const cs=rpcs.map(u=>createPublicClient({chain:sepolia,transport:http(u)}));
  const bn=(await cs[0].getBlockNumber())-3n; out.block=bn.toString();
  const read=(p)=>Promise.all(cs.map(c=>c.readContract({...p,blockNumber:bn})));
  const roots=await read({address:UR,abi:urAbi,functionName:'ROOT_REGISTRY'});
  if(!same(roots[0],roots[1])) out.rpc_agree=false;
  out.root=roots[0];
  if(roots[0].toLowerCase()!==EXPECT_ROOT.toLowerCase()){ out.redeploy=true; changed=true; }
  const eths=await read({address:roots[0],abi:rootAbi,functionName:'getSubregistry',args:['eth']});
  if(!same(eths[0],eths[1])) out.rpc_agree=false;
  out.eth_registry=eths[0];
  for(const [label,want] of Object.entries(EXPECT)){
    const st=await read({address:eths[0],abi:regAbi,functionName:'getState',args:[BigInt(labelhash(label))]});
    if(!same(st[0],st[1])) out.rpc_agree=false;
    const s=st[0]; const owner=s.latestOwner;
    const registered = Number(s.status)!==0 && owner!=='0x0000000000000000000000000000000000000000';
    const ok = registered && owner.toLowerCase()===want.toLowerCase();
    out.names[label+'.eth']={status:Number(s.status),owner,expiry:s.expiry.toString(),ok};
    if(!ok && !(PENDING && !registered)) changed=true;
  }
  out.pending_reregistration=PENDING;
}catch(e){ out.error=e.shortMessage||String(e); console.log(JSON.stringify(out)); process.exit(1); }
console.log(JSON.stringify(out)); process.exit(!out.rpc_agree?1:changed?2:0);
