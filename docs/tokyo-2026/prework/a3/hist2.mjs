import { client, UR, DNS } from './lib.mjs';
import { parseAbi } from '/Users/takeshi/vouch/node_modules/viem/_esm/index.js';
const c=client('https://sepolia.gateway.tenderly.co');
const slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const P='0x6d80f2172cfdec5730fe683860c33d26fc42e6f1';
for(const b of [11708896n,11708897n]){ const blk=await c.getBlock({blockNumber:b}); console.log(b,new Date(Number(blk.timestamp)*1000).toISOString(),'inner impl',await c.getStorageAt({address:P,slot,blockNumber:b})); }
const blk=await c.getBlock({blockNumber:11708897n,includeTransactions:true});
const lc=x=>x?.toLowerCase();
for(const tx of blk.transactions){ if([lc(UR),lc(P)].includes(lc(tx.to))) console.log('tx to UR/P',tx.hash,tx.from,tx.input.slice(0,10)); }
try{ await c.call({to:UR,data:'0x'+'00'.repeat(0),blockNumber:11708897n}); }catch(e){}
try{ const r=await c.call({to:UR,data:(await import('/Users/takeshi/vouch/node_modules/viem/_esm/index.js')).encodeFunctionData({abi:parseAbi(['function findOwner(bytes name) view returns (address)']),functionName:'findOwner',args:[DNS]}),blockNumber:11708897n}); console.log(r);}catch(e){ console.log('revert data', e.cause?.data||e.data||e.details||e.shortMessage); }
