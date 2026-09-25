import { client, UR, DNS, TNAME, TKEY } from './lib.mjs';
import { parseAbi } from 'viem';
const c=client('https://sepolia.gateway.tenderly.co');
const abi=parseAbi(['function findOwner(bytes name) view returns (address)']);
const head=await c.getBlockNumber();
// 二分探索: findOwner が最後に成功したブロック
async function ok(b){ try{ await c.readContract({address:UR,abi,functionName:'findOwner',args:[DNS],blockNumber:b}); return true;}catch{return false;} }
console.log('11705616', await ok(11705616n), 'head', head, await ok(head));
let lo=11705616n, hi=head; if(await ok(lo) && !(await ok(hi))){ while(hi-lo>1n){ const m=(lo+hi)/2n; if(await ok(m)) lo=m; else hi=m; } console.log('last ok',lo,'first fail',hi); }
const slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
for(const b of [lo,hi]){ console.log(b, 'impl', await c.getStorageAt({address:UR,slot,blockNumber:b})); }
