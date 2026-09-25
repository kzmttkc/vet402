import { client, UR } from './lib.mjs';
import { parseAbi, toFunctionSelector } from '/Users/takeshi/vouch/node_modules/viem/_esm/index.js';
const c=client('https://sepolia.gateway.tenderly.co');
for(const [a,label] of [['0x4a1817d13e9cf196f471725176355c1234b63c70','old'],['0xc105976531cd90285b91fbef70ca7d8d6597095d','new']]){
  const code=await c.getCode({address:a});
  const sels={findOwner:toFunctionSelector('function findOwner(bytes)'),findResolver:toFunctionSelector('function findResolver(bytes)'),resolve:toFunctionSelector('function resolve(bytes,bytes)'),ROOT_REGISTRY:toFunctionSelector('function ROOT_REGISTRY()'),registry:toFunctionSelector('function registry()')};
  console.log(label,a,'len',(code.length-2)/2,Object.fromEntries(Object.entries(sels).map(([k,s])=>[k,code.includes(s.slice(2))])));
}
const reg=parseAbi(['function isAvailable(string label) view returns (bool)']);
const R='0xa88553f454b77203b0d036a05c894d555eaaa2cc';
for(const b of [11708896n, await c.getBlockNumber()]) console.log('isAvailable(vet402) @',b, await c.readContract({address:R,abi:reg,functionName:'isAvailable',args:['vet402'],blockNumber:b}).catch(e=>'ERR '+e.shortMessage));
for(const sig of ['function ROOT_REGISTRY() view returns (address)','function registry() view returns (address)']){
  const abi=parseAbi([sig]); const fn=abi[0].name;
  for(const b of [11708896n,11708897n]) console.log(fn,b,await c.readContract({address:UR,abi,functionName:fn,blockNumber:b}).catch(e=>'ERR '+e.shortMessage));
}
