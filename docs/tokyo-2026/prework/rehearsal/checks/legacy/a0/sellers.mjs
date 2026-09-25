import { createPublicClient, http, parseAbi, parseAbiItem, erc20Abi } from 'viem';
import { sepolia, baseSepolia } from 'viem/chains';
import { packetToBytes } from 'viem/ens';
const WE='0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6', WV='0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6';
const UR='0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const urAbi=parseAbi(['function findOwner(bytes name) view returns (address)']);
const rs=parseAbi(['function supportsInterface(bytes4) view returns (bool)','function roles(uint256 resource, address account) view returns (uint256)']);
const ev=parseAbiItem('event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)');
const cs=['https://sepolia.gateway.tenderly.co','https://ethereum-sepolia-rpc.publicnode.com'].map(u=>createPublicClient({chain:sepolia,transport:http(u)}));
const head=(await cs[0].getBlockNumber())-2n;
for(const name of ['seller-a.eth','seller-b.eth','seller-c.eth','vet402.eth']){
  const dns=`0x${Buffer.from(packetToBytes(name)).toString('hex')}`;
  const owners=await Promise.all(cs.map(c=>c.readContract({address:UR,abi:urAbi,functionName:'findOwner',args:[dns],blockNumber:head})));
  const resolver=await cs[0].getEnsResolver({name,blockNumber:head});
  const perm=await cs[0].readContract({address:resolver,abi:rs,functionName:'supportsInterface',args:['0x91413117'],blockNumber:head});
  const addr=await cs[0].getEnsAddress({name,blockNumber:head});
  const logs=[]; for(let f=head-20000n; f<=head; f+=1000n){ logs.push(...await cs[0].getLogs({address:resolver,event:ev,fromBlock:f,toBlock:f+999n>head?head:f+999n})); }
  const rootHolders=[...new Set(logs.filter(l=>l.args.resource===0n).map(l=>l.args.account))];
  const held=[]; for(const a of rootHolders){ const r=await cs[0].readContract({address:resolver,abi:rs,functionName:'roles',args:[0n,a],blockNumber:head}); if(r>0n) held.push(a.slice(0,6)+'…'+a.slice(-4)); }
  console.log(JSON.stringify({name,owner:owners[0],rpcAgree:owners[0]===owners[1],ownerIs:owners[0]===WE?'W_ens':owners[0]===WV?'W_vet':'OTHER',resolver,permissioned:perm,addr,rootHolders:held}));
}
const b=createPublicClient({chain:baseSepolia,transport:http('https://sepolia.base.org')});
const USDC='0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const bal=await b.readContract({address:USDC,abi:erc20Abi,functionName:'balanceOf',args:[WE]});
console.log(JSON.stringify({W_ens_baseSepolia_ETH:Number(await b.getBalance({address:WE}))/1e18, W_ens_baseSepolia_USDC:Number(bal)/1e6, W_ens_sepolia_ETH:Number(await cs[0].getBalance({address:WE}))/1e18, W_vet_sepolia_ETH:Number(await cs[0].getBalance({address:WV}))/1e18}));
