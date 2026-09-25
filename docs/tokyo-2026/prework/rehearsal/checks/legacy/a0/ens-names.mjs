// Tokyo 2026 準備: Sepolia ENSv2 の名前が消えていないかを読む（読み取りだけ・署名なし）
// 使い方: node ~/hackathon-monitor/ens-names.mjs   → 1行 JSON。exit 0=全部そのまま / 2=変化あり / 1=読めない
import { createPublicClient, http, parseAbi } from 'viem';
import { sepolia } from 'viem/chains';
import { packetToBytes } from 'viem/ens';
const UR='0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const REGISTRAR='0xa88553f454b77203b0d036a05c894d555eaaa2cc';
// 期待する持ち主（登録済みの名前だけ）。未登録の候補は isAvailable を見る
const WE='0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
const EXPECT={ 'vet402.eth':'0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6', 'seller-a.eth':WE, 'seller-b.eth':WE, 'seller-c.eth':WE };
const CANDIDATES=(process.env.ENS_CANDIDATES||'').split(',').filter(Boolean);
const rpcs=['https://sepolia.gateway.tenderly.co','https://ethereum-sepolia-rpc.publicnode.com'];
const urAbi=parseAbi(['function findOwner(bytes name) view returns (address)']);
const regAbi=parseAbi(['function isAvailable(string label) view returns (bool)']);
const out={checked_at:new Date().toISOString(),names:{},candidates:{},rpc_agree:true};
let changed=false;
try{
  const cs=rpcs.map(u=>createPublicClient({chain:sepolia,transport:http(u)}));
  const bn=(await cs[0].getBlockNumber())-2n; out.block=bn.toString();
  for(const [name,want] of Object.entries(EXPECT)){
    const dns=`0x${Buffer.from(packetToBytes(name)).toString('hex')}`;
    const got=await Promise.all(cs.map(c=>c.readContract({address:UR,abi:urAbi,functionName:'findOwner',args:[dns],blockNumber:bn})));
    if(got[0].toLowerCase()!==got[1].toLowerCase()) out.rpc_agree=false;
    const ok=got[0].toLowerCase()===want.toLowerCase();
    out.names[name]={owner:got[0],ok}; if(!ok) changed=true;
  }
  for(const label of CANDIDATES){
    out.candidates[label+'.eth']=await cs[0].readContract({address:REGISTRAR,abi:regAbi,functionName:'isAvailable',args:[label],blockNumber:bn});
  }
}catch(e){ out.error=e.shortMessage||String(e); console.log(JSON.stringify(out)); process.exit(1); }
console.log(JSON.stringify(out)); process.exit(!out.rpc_agree?1:changed?2:0);
