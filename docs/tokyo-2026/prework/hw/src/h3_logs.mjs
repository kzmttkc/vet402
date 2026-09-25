// H3 #3: publicnode が getLogs を黙って落とすか。同じ範囲・同じフィルタを各 RPC で3回。
import fs from 'fs';
const SP='/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad';
const { viem, ABI, A, RPC_S, RPC_P, client } = await import(SP+'/e15/lib.mjs');
const { getEventSelector, toHex } = viem;
const EAC = getEventSelector(ABI.PR.find(e=>e.type==='event'&&e.name==='EACRolesChanged'));
const R_VET='0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
const R_SHARED='0x49f5022dde516b92ac1609158bc6adc772088055';
const RPCS = { sentio: RPC_S, ethpandaops: RPC_P, publicnode: 'https://ethereum-sepolia-rpc.publicnode.com' };
const B = BigInt(process.env.FIXB);
const FROM = B - 40000n;
const filters = {
  'F-A すべてのログ(ETHRegistry+VF+R_vet+R_shared)': { address:[A.er,A.vf,R_VET,R_SHARED], fromBlock:toHex(FROM), toBlock:toHex(B) },
  'F-B EACRolesChanged 全アドレス': { topics:[EAC], fromBlock:toHex(FROM), toBlock:toHex(B) },
  'F-C R_shared の全ログ': { address:R_SHARED, fromBlock:toHex(FROM), toBlock:toHex(B) },
};
const call = async (url, params) => {
  const t0=Date.now();
  try {
    const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[params]})});
    const j = await r.json();
    if (j.error) return { err: String(j.error.message).slice(0,90), ms: Date.now()-t0 };
    return { n: j.result.length, ms: Date.now()-t0, firstBlk: j.result[0]?.blockNumber, lastBlk: j.result.at(-1)?.blockNumber };
  } catch(e){ return { err:'FETCH '+String(e.message).slice(0,70), ms: Date.now()-t0 }; }
};
const out=[];
for (const [fname,f] of Object.entries(filters)) {
  for (const [rname,url] of Object.entries(RPCS)) {
    const runs=[]; for(let i=0;i<3;i++) runs.push(await call(url,f));
    const row={filter:fname,rpc:rname,runs:runs.map(r=>r.err?('ERR:'+r.err):r.n),ms:runs.map(r=>r.ms),detail:runs};
    out.push(row);
    console.log(fname,'|',rname,'| 3回 =',JSON.stringify(row.runs),'| ms',JSON.stringify(row.ms));
  }
}
console.log('範囲', FROM.toString(),'..',B.toString(),'(', (B-FROM).toString(),'ブロック)','EAC topic0',EAC);
fs.writeFileSync(SP+'/hw/h3_logs.json',JSON.stringify({block:B.toString(),from:FROM.toString(),EAC,rows:out},null,1));
