import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { toFunctionSelector, createPublicClient, http } = require('viem'); const fmtT=p=>p.type.startsWith('tuple')?'('+p.components.map(fmtT).join(',')+')'+p.type.slice(5):p.type; const formatAbiItem=x=>x.name+'('+x.inputs.map(fmtT).join(',')+')';
const { sepolia } = require('viem/chains');
const c = createPublicClient({ chain: sepolia, transport: http('https://sepolia.rpc.sentio.xyz') });
const load = f => { try { return JSON.parse(fs.readFileSync(f)); } catch { return null; } };
const sigs = abi => new Map(abi.filter(x=>x.type==='function').map(x=>{const s=formatAbiItem(x).replace(/^function /,''); return [s, toFunctionSelector(x)];}));
function pushes(code){ const set=new Set(); const b=Buffer.from(code.slice(2),'hex'); for(let i=0;i<b.length;i++){const op=b[i]; if(op===0x63&&i+4<b.length){set.add('0x'+b.slice(i+1,i+5).toString('hex'));} if(op>=0x60&&op<=0x7f) i+=op-0x5f;} return set; }
const names = ['UniversalResolverV2','PermissionedResolverImpl','ETHRegistry','ETHRegistrar','VerifiableFactory','UniversalHelper'];
const interest = /^(findOwner|findExactOwner|findNearestOwner|findResolver|findRegistries|resolve|resolveWithGateways|reverse|reverseWithGateways|setText|setAddr|authorizeTextRoles|setAlias|deleteAlias|linkToNode|linkToRecord|clearRecords|grantRootRoles|revokeRootRoles|roles|hasRoles|setResolver|getState|getResolver|deployProxy|getSubregistry|ROOT_REGISTRY|isAvailable|register|commit|rentPrice|makeCommitment|MIN_REGISTER_DURATION|getOwner|ownerOf|latestOwnerOf|grantRoles|revokeRoles|setRecords|multicall|getTokenId|getExpiry|initialize|renew|MIN_COMMITMENT_AGE|MAX_COMMITMENT_AGE)\(/;
const out={};
for (const n of names){
  const nw=load(`abi/new_${n}.json`), od=load(`abi/old_${n}.json`);
  const ns = nw? sigs(nw.abi):new Map(), os = od? sigs(od.abi):new Map();
  const addrNew = nw?.address;
  const codeNew = addrNew? pushes(await c.getCode({address:addrNew})) : new Set();
  const addrOld = od?.address;
  const codeOld = addrOld? pushes(await c.getCode({address:addrOld})) : new Set();
  console.log(`\n## ${n} new=${addrNew} old=${addrOld}`);
  const all = new Set([...ns.keys(), ...os.keys()]);
  const removed=[...os.keys()].filter(k=>!ns.has(k)), added=[...ns.keys()].filter(k=>!os.has(k));
  console.log(' removed:', removed.join(' | '));
  console.log(' added:', added.join(' | '));
  for (const s of [...all].sort()) if (interest.test(s)) {
    const sel = ns.get(s)||os.get(s);
    console.log(`  ${s} ${sel} old:${os.has(s)?'abi':'-'}/${codeOld.has(sel)?'code':'-'} new:${ns.has(s)?'abi':'-'}/${codeNew.has(sel)?'code':'-'}`);
  }
}
