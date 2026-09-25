// Tokyo 2026 会期前の最終確認（読み取りだけ・署名/送信なし）。node ~/hackathon-monitor/preflight-tokyo.mjs
// 出力は1行 JSON。exit 0=全部想定どおり / 2=想定と違う項目あり / 1=読めない
//
// 2026-09-19 の直し（PLAN_v4.3 §6.2 の表 ①）:
//   Sepolia の資金を `sepoliaETH >= 0.02` の固定額で見るのをやめ、**gas_budget（3鍵）**にそろえた。
//   関門の数字は `gas-budget.mjs`（＝ rehearsal/lib/gas-budget.mjs への転送）だけが持つ。ここには写さない。
//   `node run.mjs --b0` も同じ関数（evaluateGasBudget / readGasBudget）を呼ぶので、数字は1か所にしかない。
import { createPublicClient, http, parseAbi, labelhash } from 'viem';
import { sepolia, baseSepolia } from 'viem/chains';
import { spawnSync } from 'node:child_process';
const SEP=['https://sepolia.rpc.sentio.xyz','https://rpc.sepolia.ethpandaops.io'];
const W_VET='0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6', W_ENS='0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
const W_OP=process.env.TOKYO_W_OP_ADDRESS||null;   // 会期中に keys.ts init が作る。無ければ skipped
const PAYER='0xc9c7b38C0942914fC8EA12063BC92dcd3b581670';
const ROOT='0x9703DBD26dAB89504490994138cF2c575251a9cE';
const EVENT_START=process.env.TOKYO_EVENT_START||'2026-09-26T06:30:00Z';
const out={checked_at:new Date().toISOString(),items:{}};
let bad=0; let cs=null, usdcAbi=null, b=null; const put=(k,v,ok,note)=>{ out.items[k]={value:v,ok,...(note?{note}:{})}; if(!ok) bad++; };
const step=async (k,fn)=>{ try{ await fn(); }catch(e){ put(k,{error:String(e.shortMessage||e.message||e).slice(0,160)},false,'この項目だけ読めなかった'); } };
const fetchT=(u,ms=20000)=>fetch(u,{signal:AbortSignal.timeout(ms)});
try{
  // 1. 名前と配備（ens-names は異常時に非0で終了するので spawnSync で受ける・09-19 監査 D1）
  const r=spawnSync('node',[process.env.HOME+'/hackathon-monitor/ens-names.mjs'],{encoding:'utf8'});
  let names=null; try{ names=JSON.parse((r.stdout||'').trim()); }catch(e){}
  if(!names) put('names', {stderr:(r.stderr||'').slice(0,200), code:r.status}, false, 'ens-names の出力を読めない');
  else put('names', names.names, r.status===0, names.redeploy?'配備し直しあり':(names.error||undefined));
  await step('rpc_heads', async () => {
    // 2. RPC 2系統の一致（head の差）
    cs=SEP.map(u=>createPublicClient({chain:sepolia,transport:http(u)}));
    const heads=await Promise.all(cs.map(c=>c.getBlockNumber()));
    put('rpc_heads', heads.map(String), Math.abs(Number(heads[0]-heads[1]))<=3);
  });
  await step('gas_budget', async () => {
    // 3. **ガスの関門（3鍵とも ok でなければ K1 に入らない）**。数字は gas-budget.mjs だけが持つ
    //    正典が見つからなければここで throw → この項目だけ NG になる（他の項目は読める）
    const gb=await import('./gas-budget.mjs');
    const g=await gb.readGasBudget({
      rpcUrls: SEP,
      addresses: { W_vet: W_VET, W_ens: W_ENS, W_op: W_OP },
      bs03Sent: process.env.TOKYO_BS03_SENT==='1',
    });
    const brief=Object.fromEntries(Object.entries(g.per_key).map(([k,v])=>[k,{
      ok:v.ok, status:v.status, balance_eth:v.balance_eth??null, need_eth:v.need_eth??null,
      gas_budget:v.gas_budget??null, headroom_gwei:v.headroom_gwei }]));
    put('gas_budget', {ok:g.ok, gasPrice_gwei:g.gasPrice.gwei, safety:g.safety, canon:gb.CANON_PATH, per_key:brief}, g.ok,
      g.skipped.length ? `${g.skipped.join(',')} のアドレスが未確定（TOKYO_W_OP_ADDRESS）。BS-03 を打った直後にもう1回`
        : (g.ok ? undefined : 'faucet を先に回す。headroom_gwei は「残高が尽きる gwei」'));
  });
  await step('testnet_funds', async () => {
    // 4. testnet の資金。**Sepolia の ETH はここで判定しない**（関門は gas_budget 1か所）
    b=createPublicClient({chain:baseSepolia,transport:http('https://base-sepolia-rpc.publicnode.com')});
    usdcAbi=parseAbi(['function balanceOf(address) view returns (uint256)']);
    const bal={};
    for(const [k,a] of Object.entries({W_vet:W_VET,W_ens:W_ENS})){
      bal[k]={sepoliaETH:Number(await cs[0].getBalance({address:a}))/1e18, baseSepoliaETH:Number(await b.getBalance({address:a}))/1e18,
        baseSepoliaUSDC:Number(await b.readContract({address:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',abi:usdcAbi,functionName:'balanceOf',args:[a]}))/1e6};
    }
    put('testnet_funds', bal, bal.W_ens.baseSepoliaETH>0 && bal.W_ens.baseSepoliaUSDC>=5, 'Base 側だけを見る。Sepolia のガスは gas_budget');
  });
  await step('payer_usdc', async () => {
    // 5. 本番の購入元（場面1の前提）
    const mb=createPublicClient({chain:{...baseSepolia,id:8453,name:'base'},transport:http('https://base-mainnet.public.blastapi.io')});
    const payer=Number(await mb.readContract({address:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',abi:usdcAbi,functionName:'balanceOf',args:[PAYER]}))/1e6;
    put('payer_usdc', payer, payer>=20);
  });
  await step('recent_settled_2d', async () => {
    // 6. 直近の本番購入（settled が出ているか）。列が消えたのと本当に 0 件なのを分ける
    const csv=await (await fetchT('https://vet402.com/api/v1/observatory/export.csv?days=2')).text();
    const lines=csv.trim().split('\n'); const head=lines[0].split(','); const iStatus=head.indexOf('status'); const iAt=head.indexOf('attempted_at');
    const rows=lines.slice(1).map(l=>l.split(','));
    const settled=iStatus>=0 ? rows.filter(r=>r[iStatus]==='settled'||r[iStatus]==='settle_claimed').length : 0;
    put('recent_settled_2d', settled, settled>0 && iStatus>=0, iStatus>=0 ? rows.at(-1)?.[iAt] : 'status 列が無い（CSV の形が変わった）');
  });
  await step('ensip29', async () => {
    // 7. ENSIP-29 草案
    const prRes=await fetchT('https://api.github.com/repos/ensdomains/ensips/pulls/85'); const pr=await prRes.json();
    if(prRes.status!==200 || !pr.head?.sha) put('ensip29', {http:prRes.status, message:String(pr.message||'').slice(0,80)}, false, 'GitHub API を読めない（レート制限の可能性）。草案が変わったという意味ではない');
    else put('ensip29', {head:pr.head.sha.slice(0,8), updated:pr.updated_at, state:pr.state}, pr.head.sha.startsWith('e00c3453'), '変わっていたら証明の形を見直す');
  });
  await step('tokyo_page_status', async () => {
    // 8. 会期で使う面がまだ空いているか（反転は 2026-09-26T06:30:00Z・§6.2 の直し②）
    const t=await fetchT('https://vet402.com/tokyo');
    const beforeEvent = Date.now() < Date.parse(EVENT_START);
    put('tokyo_page_status', t.status, beforeEvent ? t.status===404 : t.status===200, beforeEvent?'会期前は 404 が正常':'会期後は 200 が正常');
  });
}catch(e){ out.error=String(e).slice(0,200); console.log(JSON.stringify(out)); process.exit(1); }
console.log(JSON.stringify(out,null,1)); process.exit(bad?2:0);
