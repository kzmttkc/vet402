import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createPublicClient, http } = require('viem');
const { normalize } = require('viem/ens');
const { sepolia } = require('viem/chains');
console.log('viem', JSON.parse(fs.readFileSync(new URL('../../../node_modules/viem/package.json', import.meta.url),'utf8')).version, 'sepolia UR', sepolia.contracts?.ensUniversalResolver?.address);
for (const rpc of ['https://sepolia.rpc.sentio.xyz','https://rpc.sepolia.ethpandaops.io']) {
  const c = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const blockNumber = 11720074n;
  const r = async f => { try { return await f(); } catch (e) { return 'ERR:' + (e.shortMessage||e.message).split('\n')[0].slice(0,100); } };
  console.log(rpc, 'addr(pandas.eth)', await r(()=>c.getEnsAddress({ name: normalize('pandas.eth'), blockNumber })), 'text(pandas.eth,description)', await r(()=>c.getEnsText({ name: normalize('pandas.eth'), key:'description', blockNumber })), 'resolver', await r(()=>c.getEnsResolver({ name: normalize('pandas.eth'), blockNumber })), 'addr(ens.eth)', await r(()=>c.getEnsAddress({ name: 'ens.eth', blockNumber })));
}
