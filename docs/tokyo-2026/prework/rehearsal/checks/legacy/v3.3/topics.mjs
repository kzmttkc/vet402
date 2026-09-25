import { createRequire } from 'module'; import fs from 'fs';
const require = createRequire(import.meta.url);
const { toEventSelector, formatAbiItem } = require('viem');
for (const f of ['old_PermissionedResolverImpl','new_PermissionedResolverImpl','old_ETHRegistry','new_ETHRegistry']) {
  const d = JSON.parse(fs.readFileSync(`../ur/abi/${f}.json`)); const a = d.abi ?? d;
  console.log('##', f);
  for (const e of a.filter(x=>x.type==='event')) console.log(' ', toEventSelector(e), e.name+'('+e.inputs.map(i=>i.type+(i.indexed?' indexed':'')+' '+i.name).join(', ')+')');
}
