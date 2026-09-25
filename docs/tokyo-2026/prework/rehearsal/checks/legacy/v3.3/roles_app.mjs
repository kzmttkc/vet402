import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { createPublicClient, http, parseAbiItem } = require('viem');
const { sepolia } = require('viem/chains');
const c = createPublicClient({ chain: sepolia, transport: http('https://rpc.sepolia.ethpandaops.io') });
const res = '0xD2A36AeDd9E926F3aE9e747Dbc46e73B63d86cd2';
const ev = parseAbiItem('event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)');
const lk = parseAbiItem('event Linked(uint256 indexed recordId, bytes32 indexed node, bytes name)');
const head = 11720074n; const out=[]; const links=[];
for (let b = 11708800n; b <= head; b += 1000n) {
  const to = b+999n>head?head:b+999n;
  for (const l of await c.getLogs({ address: res, event: ev, fromBlock: b, toBlock: to })) out.push([l.blockNumber, l.args.resource.toString(16).slice(0,8), l.args.account, l.args.newRoleBitmap.toString(16)]);
  for (const l of await c.getLogs({ address: res, event: lk, fromBlock: b, toBlock: to })) links.push([l.blockNumber, l.args.recordId, l.args.name]);
}
console.log(JSON.stringify(out,(k,v)=>typeof v==='bigint'?v.toString():v)); console.log(JSON.stringify(links,(k,v)=>typeof v==='bigint'?v.toString():v));
