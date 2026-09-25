import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { createPublicClient, http, parseAbiItem, toEventSelector } = require('viem');
const { sepolia } = require('viem/chains');
const rpc = process.argv[2];
const c = createPublicClient({ chain: sepolia, transport: http(rpc) });
const abi = JSON.parse(fs.readFileSync('../ur/abi/new_ETHRegistry.json')).abi;
const ev = abi.filter(x=>x.type==='event');
for (const e of ev) console.log(e.name, toEventSelector(e));
const head = await c.getBlockNumber();
console.log('head', head);
const item = ev.find(e=>e.name==='LabelRegistered');
let from = head - 9000n; const out=[];
for (let b = from; b <= head; b += 1000n) {
  const logs = await c.getLogs({ address:'0x657ea849311d3d5823348dded7c2aaafb3ede09e', event:item, fromBlock:b, toBlock: b+999n>head?head:b+999n });
  for (const l of logs) out.push({blk:l.blockNumber, label:l.args.label, owner:l.args.owner, sender:l.args.sender});
}
console.log(out.length); console.log(JSON.stringify(out.slice(-15),(k,v)=>typeof v==='bigint'?v.toString():v,1));
