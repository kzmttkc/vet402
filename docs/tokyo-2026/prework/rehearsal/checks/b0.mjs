// B0: 会期開始直後（と 09-24 の卓上）の最終確認（読み取りだけ・署名/送信なし）
// 元: monitor/preflight-tokyo.mjs。
// 直したところ: ens-names を ~/hackathon-monitor から spawn せず import する／
//   usdcAbi と Sepolia client を先に作る（前の項目が落ちると後の項目まで巻き添えで落ちていた）／
//   **Sepolia のガスは固定額 0.02 ETH をやめ、lib/gas-budget.mjs の関門（3鍵）にそろえた**（§6.2 の直し①）。
import { viem, sepolia, RPC_LIST, W_VET, W_ENS, client } from '../lib/common.mjs';
import { readNames } from './ens_names.mjs';
import { readGasBudget } from '../lib/gas-budget.mjs';

const { createPublicClient, http, parseAbi } = viem;
const PAYER = '0xc9c7b38C0942914fC8EA12063BC92dcd3b581670';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://base-sepolia-rpc.publicnode.com';
const BASE_MAINNET_RPC = process.env.BASE_MAINNET_RPC || 'https://base-mainnet.public.blastapi.io';
const EVENT_START = process.env.TOKYO_EVENT_START || '2026-09-26T06:30:00Z';

const baseSepoliaChain = { id: 84532, name: 'base-sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [BASE_SEPOLIA_RPC] } } };
const baseMainnetChain = { id: 8453, name: 'base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [BASE_MAINNET_RPC] } } };
const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const fetchT = (u, ms = 20000) => fetch(u, { signal: AbortSignal.timeout(ms) });

export const id = 'b0';
export const title = 'B0 / 会期開始直後の最終確認（名前・RPC・ガスの関門・資金・草案・面）';

export async function run({ log }) {
  const rows = [];
  // status: 'OK' / 'NG' / 'SKIP'（SKIP はまだ測れないもの。緑にはしないが --all は落とさない）
  const put = (k, value, ok, note, status) => {
    const st = status || (ok ? 'OK' : 'NG');
    rows.push({ id: k, status: st, value: JSON.stringify(value), ...(note ? { note } : {}) });
    log(`${st.padEnd(4)} | ${k} | ${JSON.stringify(value).slice(0, 220)}${note ? ' | ' + note : ''}`);
  };
  const step = async (k, fn) => {
    try { await fn(); }
    catch (e) { put(k, { error: String(e.shortMessage || e.message || e).slice(0, 160) }, false, 'この項目だけ読めなかった'); }
  };

  // 前の項目が落ちても後ろが巻き添えにならないよう、client は先に作る
  const cs = RPC_LIST.slice(0, 2).map(u => client(u));
  const b = createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC, { timeout: 30000 }) });
  const mb = createPublicClient({ chain: baseMainnetChain, transport: http(BASE_MAINNET_RPC, { timeout: 30000 }) });

  // 1. 名前と配備
  await step('names', async () => {
    const { out, code } = await readNames();
    put('names', out.names, code === 0, out.redeploy ? '配備し直しあり' : (out.error || undefined));
  });
  // 2. RPC 2系統の一致（head の差）
  await step('rpc_heads', async () => {
    const heads = await Promise.all(cs.map(c => c.getBlockNumber()));
    put('rpc_heads', heads.map(String), Math.abs(Number(heads[0] - heads[1])) <= 3);
  });
  // 3. testnet の資金
  await step('testnet_funds', async () => {
    const bal = {};
    for (const [k, a] of Object.entries({ W_vet: W_VET, W_ens: W_ENS })) {
      bal[k] = {
        sepoliaETH: Number(await cs[0].getBalance({ address: a })) / 1e18,
        baseSepoliaETH: Number(await b.getBalance({ address: a })) / 1e18,
        baseSepoliaUSDC: Number(await b.readContract({ address: USDC_BASE_SEPOLIA, abi: usdcAbi, functionName: 'balanceOf', args: [a] })) / 1e6,
      };
    }
    // Sepolia の ETH はここで判定しない（**関門は gas_budget 1か所**。固定額の 0.02 と二重に持つと必ず割れる）
    put('testnet_funds', bal, bal.W_ens.baseSepoliaETH > 0 && bal.W_ens.baseSepoliaUSDC >= 5,
      'Base 側だけを見る。Sepolia のガスは gas_budget');
  });
  // 3b. ガスの関門（**3鍵とも ok でなければ K1 に入らない**・§6.2）。数字は lib/gas-budget.mjs だけが持つ
  await step('gas_budget', async () => {
    const g = await readGasBudget({
      rpcUrls: RPC_LIST,
      addresses: { W_vet: W_VET, W_ens: W_ENS, W_op: process.env.TOKYO_W_OP_ADDRESS || null },
      bs03Sent: process.env.TOKYO_BS03_SENT === '1',
    });
    const brief = Object.fromEntries(Object.entries(g.per_key).map(([k, v]) =>
      [k, { ok: v.ok, status: v.status, balance_eth: v.balance_eth ?? null, need_eth: v.need_eth ?? null, headroom_gwei: v.headroom_gwei }]));
    // 未確定の鍵だけが原因なら SKIP（会期の関門は preflight-tokyo.mjs が 3鍵とも ok を要求する）
    const onlySkipped = !g.ok && g.skipped.length > 0
      && Object.values(g.per_key).every(v => v.ok || v.status === 'skipped');
    put('gas_budget', { ok: g.ok, gasPrice_gwei: g.gasPrice.gwei, safety: g.safety, per_key: brief }, g.ok,
      g.skipped.length ? `${g.skipped.join(',')} のアドレスが未確定。BS-03 を打った直後にもう1回` : undefined,
      onlySkipped ? 'SKIP' : undefined);
  });

  // 4. 本番の購入元（場面1の前提）
  await step('payer_usdc', async () => {
    const payer = Number(await mb.readContract({ address: USDC_BASE_MAINNET, abi: usdcAbi, functionName: 'balanceOf', args: [PAYER] })) / 1e6;
    put('payer_usdc', payer, payer >= 20);
  });
  // 5. 直近の本番購入（settled が出ているか）
  await step('recent_settled_2d', async () => {
    const csv = await (await fetchT('https://vet402.com/api/v1/observatory/export.csv?days=2')).text();
    const lines = csv.trim().split('\n'); const head = lines[0].split(',');
    const iStatus = head.indexOf('status'); const iAt = head.indexOf('attempted_at');
    const rs = lines.slice(1).map(l => l.split(','));
    const settled = iStatus >= 0 ? rs.filter(r => r[iStatus] === 'settled' || r[iStatus] === 'settle_claimed').length : 0;
    put('recent_settled_2d', settled, settled > 0 && iStatus >= 0, iAt >= 0 ? rs.at(-1)?.[iAt] : 'attempted_at 列が無い');
  });
  // 6. ENSIP-29 草案
  await step('ensip29', async () => {
    const prRes = await fetchT('https://api.github.com/repos/ensdomains/ensips/pulls/85');
    const pr = await prRes.json();
    if (prRes.status !== 200 || !pr.head?.sha) put('ensip29', { http: prRes.status, message: String(pr.message || '').slice(0, 80) }, false, 'GitHub API を読めない（レート制限の可能性）。草案が変わったという意味ではない');
    else put('ensip29', { head: pr.head.sha.slice(0, 8), updated: pr.updated_at, state: pr.state }, pr.head.sha.startsWith('e00c3453'), '変わっていたら証明の形を見直す');
  });
  // 7. 会期で使う面がまだ空いているか
  await step('tokyo_page_status', async () => {
    const t = await fetchT('https://vet402.com/tokyo');
    const beforeEvent = Date.now() < Date.parse(EVENT_START);
    put('tokyo_page_status', t.status, beforeEvent ? t.status === 404 : t.status === 200, beforeEvent ? '会期前は 404 が正常' : '会期後は 200 が正常');
  });

  return { meta: { checked_at: new Date().toISOString(), event_start: EVENT_START }, rows };
}
