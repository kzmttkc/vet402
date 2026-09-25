// H3: FINDINGS.md の5件を今日の事実で取り直す（#3 publicnode は別スクリプト h3_logs.mjs）
import fs from 'fs';
const SP = new URL('../../../out', import.meta.url).pathname; // 旧: セッション固有の tmp
const { viem, ABI, A, W_VET, W_ENS, W_OP, RPC_S, RPC_P, dns, client, pr, ALL_ROLES, ROLE_SET_TEXT, decErr } = await import(new URL('../../../lib/common.mjs', import.meta.url).href);
const { keccak256, toBytes, toHex, encodeFunctionData, labelhash, getEventSelector, decodeEventLog } = viem;
const B = BigInt(process.env.FIXB);
const cS = client(RPC_S), cP = client(RPC_P);
const R_VET='0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
const R_SHARED='0x49f5022dde516b92ac1609158bc6adc772088055';
const R_PANDAS='0xd2a36aedd9e926f3ae9e747dbc46e73b63d86cd2';
const HCA_VET='0xe96b16ab865aede373c6de768b3943fa615f173f';
const HCA_ENS='0xd45a2e001a8e0681a7c4afa27fa88fff0fa1a5d9';
const OLD_HCA='0x7070479db048594bea8ec9e61f3370558e96ada3';
const out={};

// ===== F1: root 権限の保持者が2者か =====
// EACRolesChanged(resource=0) のログを両 RPC で拾い、root 役の保持者を全部数える
const ev = ABI.PR.filter(x=>x.type==='event');
const sel = {}; for (const e of ev) { try{ sel[getEventSelector(e)] = e; }catch{} }
const evRoles = ev.find(e=>e.name==='EACRolesChanged');
console.log('EACRolesChanged topic0 =', getEventSelector(evRoles), JSON.stringify(evRoles.inputs.map(i=>i.name+':'+i.type)));
const f1=[];
for (const [tag, R, hca, owner] of [['vet402.eth→R_vet', R_VET, HCA_VET, W_VET], ['seller-a/b/c.eth→R_shared', R_SHARED, HCA_ENS, W_ENS]]) {
  const row = { tag, resolver: R };
  for (const [who, addr] of [['owner EOA', owner], ['HCA(app.ens.dev)', hca], ['旧HCA(FINDINGS記載)', OLD_HCA]]) {
    const rS = await cS.readContract({address:R,abi:ABI.PR,functionName:'roles',args:[0n,addr],blockNumber:B});
    const rP = await cP.readContract({address:R,abi:ABI.PR,functionName:'roles',args:[0n,addr],blockNumber:B});
    row[who] = { addr, roles:'0x'+rS.toString(16), match: rS===rP };
  }
  row.roleCount_root = '0x'+(await cS.readContract({address:R,abi:ABI.PR,functionName:'roleCount',args:[0n],blockNumber:B})).toString(16);
  row.isOnlyAssignee_owner_ALL = await cS.readContract({address:R,abi:ABI.PR,functionName:'isOnlyAssignee',args:[0n,ALL_ROLES,owner],blockNumber:B}).catch(e=>'ERR');
  // 全ログから root 役の保持者を列挙
  const logs = await cS.getLogs({address:R, fromBlock:B-90000n, toBlock:B});
  const holders = new Set();
  for (const l of logs) { const e = sel[l.topics[0]]; if (!e || e.name!=='EACRolesChanged') continue;
    try { const d = decodeEventLog({abi:[e],data:l.data,topics:l.topics}); if (String(d.args.resource)==='0') holders.add(String(d.args.account).toLowerCase()); } catch {} }
  row.root_role_holders_from_logs = [...holders];
  row.logCount = logs.length;
  f1.push(row); console.log('F1', JSON.stringify(row,null,1));
}
out.F1=f1;

// ===== F2: clearRecords / 記録の箱 =====
const names = ABI.PR.filter(x=>x.type==='function').map(x=>x.name);
const f2 = { has_clearRecords: names.includes('clearRecords'), has_linkToRecord: names.includes('linkToRecord'),
  has_linkToNode: names.includes('linkToNode'), has_getRecordId: names.includes('getRecordId'),
  has_recordVersions: names.includes('recordVersions'), has_setText_bytes: true };
// オンチェーンの selector で裏取り
const selOf = s => viem.toFunctionSelector(s);
for (const [k,sg] of [['clearRecords(bytes32)','function clearRecords(bytes32)'],['clearRecords(bytes)','function clearRecords(bytes)']]) {
  const d = selOf(sg);
  try { await cS.call({to:R_VET,data:d,blockNumber:B}); f2['call_'+k]='OK'; }
  catch(e){ f2['call_'+k]= (e.cause?.data ? decErr(e.cause.data) : (e.shortMessage||e.message).split('\n')[0]).slice(0,120); }
}
f2.getRecordCount_R_vet = String(await cS.readContract({address:R_VET,abi:ABI.PR,functionName:'getRecordCount',args:[],blockNumber:B}));
f2.getRecordId_vet402 = String(await cS.readContract({address:R_VET,abi:ABI.PR,functionName:'getRecordId',args:[viem.namehash('vet402.eth')],blockNumber:B}));
f2.getRecordId_atst = String(await cS.readContract({address:R_VET,abi:ABI.PR,functionName:'getRecordId',args:[viem.namehash('atst.vet402.eth')],blockNumber:B}));
f2.getRecordCount_R_shared = String(await cS.readContract({address:R_SHARED,abi:ABI.PR,functionName:'getRecordCount',args:[],blockNumber:B}));
for (const l of ['seller-a','seller-b','seller-c']) f2['getRecordId_'+l] = String(await cS.readContract({address:R_SHARED,abi:ABI.PR,functionName:'getRecordId',args:[viem.namehash(l+'.eth')],blockNumber:B}));
out.F2=f2; console.log('F2', JSON.stringify(f2,null,1));

// ===== F4: 同じリゾルバを複数の名前で共有 =====
const f4={};
for (const l of ['vet402','seller-a','seller-b','seller-c','pandas']) {
  const rS = await cS.readContract({address:A.er,abi:ABI.ER,functionName:'getResolver',args:[l],blockNumber:B});
  const rP = await cP.readContract({address:A.er,abi:ABI.ER,functionName:'getResolver',args:[l],blockNumber:B});
  const st = await cS.readContract({address:A.er,abi:ABI.ER,functionName:'getState',args:[BigInt(labelhash(l))],blockNumber:B});
  f4[l+'.eth']={resolver:rS,owner:st.latestOwner,match:rS===rP};
}
out.F4=f4; console.log('F4', JSON.stringify(f4,null,1));

// ===== F5: grantSetterRoles はリゾルバ単位のキー =====
// R_shared の上で、seller-b.eth の x402-offer を W_op に委任 → seller-a.eth / seller-c.eth も書けるか
const body = { jsonrpc:'2.0', id:1, method:'eth_simulateV1', params:[{ blockStateCalls:[{ calls:[
  { from: W_ENS, to: R_SHARED, data: pr('grantSetterRoles',[pr('setText',[dns('seller-b.eth'),'x402-offer','']), W_OP]) },
  { from: W_OP, to: R_SHARED, data: pr('setText',[dns('seller-b.eth'),'x402-offer','B']) },
  { from: W_OP, to: R_SHARED, data: pr('setText',[dns('seller-a.eth'),'x402-offer','A-HIJACK']) },
  { from: W_OP, to: R_SHARED, data: pr('setText',[dns('seller-c.eth'),'x402-offer','C-HIJACK']) },
  { from: W_OP, to: R_SHARED, data: pr('setText',[dns('never-registered.eth'),'x402-offer','X']) },
  { from: W_OP, to: R_SHARED, data: pr('setText',[dns('seller-a.eth'),'other-key','NO']) },
  { from: W_OP, to: R_VET,    data: pr('setText',[dns('vet402.eth'),'x402-offer','OTHER-RESOLVER']) },
]}], validation:false }, toHex(B)] };
const j = await (await fetch(RPC_S,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
const lbl=['G1 W_ens が seller-b.eth の x402-offer を W_op に委任','G2 W_op → seller-b.eth（意図どおり）','G3 W_op → seller-a.eth（同じリゾルバの別の名前）','G4 W_op → seller-c.eth（同上）','G5 W_op → never-registered.eth（未登録の名前）','G6 W_op → seller-a.eth の別のキー（対照）','G7 W_op → 別のリゾルバ R_vet の vet402.eth（対照）'];
const f5 = (j.result?.[0]?.calls||[]).map((c,i)=>({id:lbl[i],status:c.status==='0x1'?'OK':'REVERT',gas:parseInt(c.gasUsed,16),err:c.status==='0x1'?'':decErr(c.error?.data??c.returnData)}));
f5.forEach(r=>console.log('F5',r.status,r.id,r.err));
out.F5=f5;
out.resource_x402offer = keccak256(toBytes('x402-offer'));
fs.writeFileSync(SP+'/hw/h3.json', JSON.stringify({block:B.toString(),...out},(k,v)=>typeof v==='bigint'?v.toString():v,1));
