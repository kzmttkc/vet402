import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createPublicClient, http, parseAbi, toFunctionSelector } = require('viem');
const { sepolia } = require('viem/chains');
for (const url of ['https://sepolia.rpc.sentio.xyz','https://rpc.sepolia.ethpandaops.io']) {
  const c = createPublicClient({ chain: sepolia, transport: http(url) });
  const B = await c.getBlockNumber();
  const avail = {};
  for (const l of ['vet402','seller-a','seller-b','seller-c']) avail[l] = await c.readContract({ address: '0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca', abi: parseAbi(['function isAvailable(string) view returns (bool)']), functionName: 'isAvailable', args: [l], blockNumber: B });
  const code = (await c.getCode({ address: '0x14F09Fd05d4585759e54844dc9b00147131Cf243', blockNumber: B })).toLowerCase();
  const sel = {};
  for (const [n, s] of Object.entries({ 'setAlias': '0x291770ae', 'clearRecords': '0x3603d758', 'authorizeTextRoles': '0xf2d1eb25', 'setText(bytes32,string,string)': '0x10f13a8c', 'setText(bytes,string,string)': '0xc7279f88', 'grantRootRoles': '0x072d5d77', 'revokeRootRoles': '0xce156e82' })) sel[n] = code.includes(s.slice(2));
  const ens = await c.getEnsAddress({ name: 'ens.eth', universalResolverAddress: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe', blockNumber: B }).catch(e => 'ERR ' + e.shortMessage);
  console.log(url.split('/')[2], B.toString(), JSON.stringify({ avail, sel, ens }));
}
