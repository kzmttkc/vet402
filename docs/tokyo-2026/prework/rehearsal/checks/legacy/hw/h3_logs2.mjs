import fs from 'fs';
const SP = new URL('../../../out', import.meta.url).pathname; // 旧: セッション固有の tmp
const { viem, ABI, A, RPC_S, RPC_P } = await import(new URL('../../../lib/common.mjs', import.meta.url).href);
const { getEventSelector, toHex } = viem;
const EAC = getEventSelector(ABI.PR.find(e=>e.type==='event'&&e.name==='EACRolesChanged'));
const R_VET='0x3368219eddfdd1fac6409fb9a1b8bf7d21598391', R_SHARED='0x49f5022dde516b92ac1609158bc6adc772088055';
const RPCS = { sentio: RPC_S, ethpandaops: RPC_P, publicnode: 'https://ethereum-sepolia-rpc.publicnode.com' };
const B = BigInt(process.env.FIXB);
const F=[
 ['G-1 ETHRegistry の EACRolesChanged / 40,000ブロック', {address:A.er,topics:[EAC],fromBlock:toHex(B-40000n),toBlock:toHex(B)}],
 ['G-2 ETHRegistry の EACRolesChanged / 9,000ブロック', {address:A.er,topics:[EAC],fromBlock:toHex(B-9000n),toBlock:toHex(B)}],
 ['G-3 R_vet の全ログ / 40,000ブロック', {address:R_VET,fromBlock:toHex(B-40000n),toBlock:toHex(B)}],
 ['G-4 R_vet+R_shared の EACRolesChanged / 40,000ブロック', {address:[R_VET,R_SHARED],topics:[EAC],fromBlock:toHex(B-40000n),toBlock:toHex(B)}],
];
const call=async(u,p)=>{try{const j=await(await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[p]})})).json();return j.error?'ERR:'+String(j.error.message).slice(0,60):j.result.length;}catch(e){return 'FETCH:'+String(e.message).slice(0,50);}};
const out=[];
for(const [n,f] of F) for(const [r,u] of Object.entries(RPCS)){
 const runs=[];for(let i=0;i<3;i++)runs.push(await call(u,f));
 out.push({filter:n,rpc:r,runs});console.log(n,'|',r,'|',JSON.stringify(runs));
}
fs.writeFileSync(SP+'/hw/h3_logs2.json',JSON.stringify({block:B.toString(),rows:out},null,1));
