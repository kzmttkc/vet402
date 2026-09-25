import { createPublicClient, http, parseAbi, namehash } from 'viem';
import { sepolia } from 'viem/chains';
import { packetToBytes } from 'viem/ens';
const W='0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6';
const UR='0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const rpcs=['https://ethereum-sepolia-rpc.publicnode.com','https://sepolia.gateway.tenderly.co'];
const urAbi=parseAbi(['function findOwner(bytes name) view returns (address)']);
const rsAbi=parseAbi(['function supportsInterface(bytes4) view returns (bool)']);
for (const u of rpcs){
  const c=createPublicClient({chain:sepolia,transport:http(u)});
  const bn=await c.getBlockNumber();
  const name='vet402.eth';
  const dns=`0x${Buffer.from(packetToBytes(name)).toString('hex')}`;
  const owner=await c.readContract({address:UR,abi:urAbi,functionName:'findOwner',args:[dns],blockNumber:bn}).catch(e=>'ERR '+e.shortMessage);
  const resolver=await c.getEnsResolver({name,blockNumber:bn}).catch(e=>'ERR '+e.shortMessage);
  const addr=await c.getEnsAddress({name,blockNumber:bn}).catch(e=>'ERR '+e.shortMessage);
  let perm='-';
  if (typeof resolver==='string' && resolver.startsWith('0x')) perm=await c.readContract({address:resolver,abi:rsAbi,functionName:'supportsInterface',args:['0x91413117'],blockNumber:bn}).catch(e=>'ERR '+e.shortMessage);
  const wild=await c.getEnsResolver({name:'atst.vet402.eth',blockNumber:bn}).catch(e=>'ERR '+e.shortMessage);
  console.log(JSON.stringify({rpc:u,block:bn.toString(),owner,ownerIsW:String(owner).toLowerCase()===W.toLowerCase(),resolver,permissioned:perm,addr,wildcardResolver:wild}));
}
