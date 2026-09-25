// A3 段0: 候補の足切り（chainId・head・canary の getLogs）。読み取りだけ
import { writeFileSync } from 'node:fs';
const CANDS = `https://sepolia.gateway.tenderly.co
https://gateway.tenderly.co/public/sepolia
https://sepolia.drpc.org
https://1rpc.io/sepolia
https://public.1rpc.io/sepolia
https://eth-sepolia.public.blastapi.io
https://rpc.sepolia.org
https://rpc2.sepolia.org
https://rpc.sepolia.ethpandaops.io
https://ethereum-sepolia.rpc.subquery.network/public
https://eth-sepolia.g.alchemy.com/v2/demo
https://eth-sepolia-public.unifra.io
https://api.zan.top/eth-sepolia
https://eth-sepolia.api.onfinality.io/public
https://public.stackup.sh/api/v1/node/ethereum-sepolia
https://ethereum-sepolia-public.nodies.app
https://endpoints.omniatech.io/v1/eth/sepolia/public
https://0xrpc.io/sep
https://ethereum-sepolia.therpc.io
https://ethereum-sepolia.gateway.tatum.io/
https://eth-sepolia-testnet.api.pocket.network
https://sepolia.rpc.sentio.xyz
https://lb.routeme.sh/rpc/evm/11155111
https://xrpc.cl/sepolia
https://ethereum-sepolia.blockpi.network/v1/rpc/public
https://rpc.ankr.com/eth_sepolia
https://11155111.rpc.thirdweb.com
https://sphinx.shardeum.org/
https://dapps.shardeum.org/`.split('\n');
const ADDR_CHANGED='0x65412581168e88a1e60c6459d7f44ae83ad0832e670826c05a4e2476b57af752';
async function rpc(url, method, params){
  const t=Date.now();
  try{
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
    const txt=await r.text(); let j; try{ j=JSON.parse(txt);}catch{ return {ok:false,status:r.status,err:'non-json: '+txt.slice(0,120),ms:Date.now()-t}; }
    if(j.error) return {ok:false,status:r.status,err:JSON.stringify(j.error).slice(0,200),ms:Date.now()-t};
    return {ok:true,status:r.status,result:j.result,ms:Date.now()-t};
  }catch(e){ return {ok:false,status:0,err:String(e.message||e).slice(0,160),ms:Date.now()-t}; }
}
const hex=n=>'0x'+n.toString(16);
const out=await Promise.all(CANDS.map(async url=>{
  const cid=await rpc(url,'eth_chainId',[]);
  const bn=await rpc(url,'eth_blockNumber',[]);
  const lg=await rpc(url,'eth_getLogs',[{fromBlock:hex(11600002),toBlock:hex(11600002),topics:[ADDR_CHANGED]}]);
  return {url,chainId:cid.ok?parseInt(cid.result,16):null,cidErr:cid.ok?undefined:`${cid.status} ${cid.err}`,
    head:bn.ok?parseInt(bn.result,16):null,headErr:bn.ok?undefined:`${bn.status} ${bn.err}`,
    canary:lg.ok?lg.result.length:null,canaryErr:lg.ok?undefined:`${lg.status} ${lg.err}`,ms:[cid.ms,bn.ms,lg.ms]};
}));
writeFileSync(new URL('./logs/screen.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),out},null,1));
for(const o of out) console.log(JSON.stringify(o));
