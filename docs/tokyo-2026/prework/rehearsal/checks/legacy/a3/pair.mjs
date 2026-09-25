// A3 段2: 組ごとに 20 回、同じ固定ブロックで両方を読み比べる。
// node pair.mjs runs urlA,urlB urlC,urlD ...  （同じ呼び出しの中の組は並列。組どうしで URL を重ねないこと）
import { appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { client, head, readAt, TRES, W_VET, sleep, p50 } from './lib.mjs';
const RUNS=Number(process.argv[2]||20), GAP=5000;
const pairs=process.argv.slice(3).map(s=>s.split(','));
const KEYS=['owner','text','addr','urRoot','avail','resText','resAddr','blockHash','canary','canaryIds','eac','eacIds'];
const EXP={resText:'https://translator.nymspace.dev/mcp',resAddr:W_VET,canaryIds:'0xfdc96e99402c01a224b756002bdf0e2aa7338f4cee5a0773db7a6c790f0087b4:9149',eac:75};
const LOG=new URL('./pair.jsonl',import.meta.url);
const res=await Promise.all(pairs.map(async ([a,b])=>{
  const ca=client(a), cb=client(b); const rows=[];
  for(let i=0;i<RUNS;i++){
    const [ha,hb]=await Promise.all([head(a),head(b)]);
    const row={a,b,i,at:new Date().toISOString()}; const fail=[];
    if(!ha.ok) fail.push(`A head: ${ha.err}`); if(!hb.ok) fail.push(`B head: ${hb.err}`);
    if(ha.ok&&hb.ok){
      const d=ha.n>hb.n?ha.n-hb.n:hb.n-ha.n; row.headA=ha.n.toString(); row.headB=hb.n.toString(); row.headDiff=Number(d);
      if(d>3n) fail.push(`headDiff=${d}`);
      const B=(ha.n<hb.n?ha.n:hb.n)-5n; row.B=B.toString();
      const [ra,rb]=await Promise.all([readAt(a,ca,B,TRES),readAt(b,cb,B,TRES)]);
      for(const e of ra.errs) fail.push('A '+e); for(const e of rb.errs) fail.push('B '+e);
      for(const k of KEYS) if(JSON.stringify(ra[k])!==JSON.stringify(rb[k])) fail.push(`mismatch ${k}: ${JSON.stringify(ra[k])?.slice(0,60)} vs ${JSON.stringify(rb[k])?.slice(0,60)}`);
      for(const [k,v] of Object.entries(EXP)){ if(ra[k]!==v) fail.push(`A ${k} unexpected`); if(rb[k]!==v) fail.push(`B ${k} unexpected`); }
      row.a429=ra.has429; row.b429=rb.has429; row.readA_ms=ra.owner_ms; row.readB_ms=rb.owner_ms; row.eacA_ms=ra.eac_ms; row.eacB_ms=rb.eac_ms;
      row.vals={owner:ra.owner,text:ra.text,addr:ra.addr,urRoot:ra.urRoot,resText:ra.resText,resAddr:ra.resAddr,eac:[ra.eac,rb.eac],canary:[ra.canary,rb.canary]};
    }
    row.match=fail.length===0; row.fail=fail; rows.push(row); appendFileSync(LOG,JSON.stringify(row)+'\n');
    await sleep(GAP);
  }
  const reasons={}; for(const r of rows) for(const f of r.fail){ const k=f.replace(/: .*/,'').slice(0,60); reasons[k]=(reasons[k]||0)+1; }
  return {a,b,match:rows.filter(r=>r.match).length,runs:RUNS,maxHeadDiff:Math.max(...rows.map(r=>r.headDiff??-1)),p50HeadDiff:p50(rows.map(r=>r.headDiff)),any429:rows.some(r=>r.a429||r.b429),reasons};
}));
const OUT=new URL('./pair.json',import.meta.url);
const prev=existsSync(OUT)?JSON.parse(readFileSync(OUT,'utf8')):[];
writeFileSync(OUT,JSON.stringify([...prev,...res.map(r=>({at:new Date().toISOString(),...r}))],null,1));
for(const r of res) console.log(JSON.stringify(r));
