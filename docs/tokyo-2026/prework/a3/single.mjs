// A3 段1: 候補ごとに単独 20 回。node single.mjs [runs] → logs/single.json
import { writeFileSync, appendFileSync } from 'node:fs';
import { client, head, readAt, TRES, W_VET, sleep, p50 } from './lib.mjs';
const CANDS=['https://sepolia.gateway.tenderly.co','https://1rpc.io/sepolia','https://rpc.sepolia.ethpandaops.io','https://ethereum-sepolia-public.nodies.app','https://0xrpc.io/sep','https://ethereum-sepolia.gateway.tatum.io/','https://sepolia.rpc.sentio.xyz','https://11155111.rpc.thirdweb.com','https://eth-sepolia-testnet.api.pocket.network','https://xrpc.cl/sepolia'];
if(process.env.CANDS) CANDS.splice(0,CANDS.length,...process.env.CANDS.split(','));
const NO_EAC=!!process.env.NO_EAC; const TAG=process.env.TAG||'single';
const RUNS=Number(process.argv[2]||20), GAP=5000;
const EXP={owner:'REVERT',text:null,addr:null,avail:false,resText:'https://translator.nymspace.dev/mcp',resAddr:W_VET,canaryIds:'0xfdc96e99402c01a224b756002bdf0e2aa7338f4cee5a0773db7a6c790f0087b4:9149',eac:75};
if(NO_EAC) delete EXP.eac;
const LOG=new URL(`./logs/${TAG}.jsonl`,import.meta.url);
await sleep(Number(process.env.START_DELAY||0));
const summary=await Promise.all(CANDS.map(async url=>{
  const c=client(url); const rows=[];
  for(let i=0;i<RUNS;i++){
    const t0=Date.now(); const h=await head(url);
    let row={url,i,at:new Date().toISOString(),head_ms:h.ms};
    if(!h.ok){ row={...row,errs:[`head: ${h.err}`],has429:/429|rate/i.test(h.err)}; }
    else { const B=h.n-5n; row={...row,head:h.n.toString(),B:B.toString(),...(await readAt(url,c,B,NO_EAC?null:TRES))}; }
    const bad=[...(row.errs||[])];
    if(row.head) for(const [k,v] of Object.entries(EXP)) if(row[k]!==v) bad.push(`${k}=${JSON.stringify(row[k])?.slice(0,80)}`);
    row.pass=bad.length===0; row.bad=bad; row.total_ms=Date.now()-t0;
    rows.push(row); appendFileSync(LOG,JSON.stringify(row)+'\n');
    await sleep(GAP);
  }
  const readMs=rows.map(r=>r.owner_ms!=null?Math.max(r.owner_ms,r.text_ms,r.addr_ms,r.resText_ms,r.resAddr_ms,r.avail_ms,r.urRoot_ms):null);
  return {url,pass:rows.filter(r=>r.pass).length,runs:RUNS,
    canaryOk:rows.filter(r=>r.canaryIds===EXP.canaryIds).length, canaryVals:[...new Set(rows.map(r=>r.canary))],
    eacVals:[...new Set(rows.map(r=>r.eac))], eacOk:rows.filter(r=>r.eac===75).length,
    p50_head_ms:p50(rows.map(r=>r.head_ms)), p50_read_ms:p50(readMs), p50_canary_ms:p50(rows.map(r=>r.canary_ms)), p50_eac_ms:p50(rows.map(r=>r.eac_ms)),
    runs429:rows.filter(r=>r.has429).length, urRoots:[...new Set(rows.map(r=>r.urRoot))],
    badSamples:[...new Set(rows.flatMap(r=>r.bad))].slice(0,6)};
}));
writeFileSync(new URL(`./logs/${TAG}.json`,import.meta.url),JSON.stringify({at:new Date().toISOString(),summary},null,1));
for(const s of summary) console.log(JSON.stringify(s));
