import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
const W='0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6', R='0xf8E7782d205fEf6f54767918534FF78B1d726Bfc';
const c=createPublicClient({chain:sepolia,transport:http('https://sepolia.gateway.tenderly.co')});
const head=await c.getBlockNumber();
const ev=parseAbiItem('event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)');
const logs=[]; for(let from=head-9000n; from<=head; from+=1000n){ logs.push(...await c.getLogs({address:R,event:ev,fromBlock:from,toBlock:from+999n>head?head:from+999n})); }
const abi=parseAbi(['function roles(uint256 resource, address account) view returns (uint256)']);
const accts=[...new Set(logs.map(l=>l.args.account))];
console.log('resolver EACRolesChanged logs:',logs.length);
for(const l of logs) console.log(' block',l.blockNumber.toString(),'resource',l.args.resource.toString(16).slice(0,12),'account',l.args.account,'new',l.args.newRoleBitmap.toString(16));
for(const a of new Set([...accts,W])){ const r=await c.readContract({address:R,abi,functionName:'roles',args:[0n,a],blockNumber:head}).catch(e=>'ERR '+e.shortMessage); console.log('roles(root,',a,') =',typeof r==='bigint'?'0x'+r.toString(16):r); }
