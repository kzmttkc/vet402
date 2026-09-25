import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createPublicClient, http, keccak256, toHex } = require('viem');
const { sepolia } = require('viem/chains');
const rpc = process.argv[2] || 'https://sepolia.rpc.sentio.xyz';
const c = createPublicClient({ chain: sepolia, transport: http(rpc) });
const P='0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1';
const topicUp = keccak256(toHex('Upgraded(address)'));
const logs = await c.request({method:'eth_getLogs', params:[{address:P, fromBlock:'0x0', toBlock:'latest'}]});
for (const l of logs) {
  const b = await c.getBlock({blockNumber: BigInt(l.blockNumber)});
  console.log(parseInt(l.blockNumber), new Date(Number(b.timestamp)*1000).toISOString(), l.transactionHash, l.topics[0]===topicUp?'Upgraded':l.topics[0].slice(0,10), (l.topics[1]||'').slice(26), l.data.length>2? l.data.slice(0,130):'');
}
const slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
for (const bn of [11708896n,11708897n,11710192n,11710193n,undefined]) {
  console.log('slot@',bn??'latest', await c.getStorageAt({address:P, slot, blockNumber:bn}));
}
console.log('code 0x6d80 len', (await c.getCode({address:P})).length, 'code 0xeeee len', (await c.getCode({address:'0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe'})).length);
