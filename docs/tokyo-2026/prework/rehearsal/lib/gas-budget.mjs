// gas-budget.mjs — 会期のガスの関門。**数字はこのファイルにしか書かない。**
// 出典: guards/GAS.md（2026-09-19・eth_simulateV1 実測・block 11,735,920 / 11,735,943）と PLAN_v4.3 §4 / §6.2。
//
// ここを読むのは2つ:
//   1. rehearsal/checks/b0.mjs      （`node run.mjs --b0` の gas_budget 項目）
//   2. ~/hackathon-monitor/preflight-tokyo.mjs（転送だけの ~/hackathon-monitor/gas-budget.mjs 経由）
// どちらも同じ関数を呼ぶ。数字を写し取らない。
//
// **依存なし**（viem も要らない）。読み取りは素の JSON-RPC（eth_gasPrice / eth_getBalance）だけ。
// 署名・送信はしない。
//
// 単体でも打てる:
//   W_VET=0x… W_ENS=0x… TOKYO_W_OP_ADDRESS=0x… node lib/gas-budget.mjs
//   終了コード: 0 = 3鍵とも ok（skipped は ok 扱いにしない・下）/ 2 = 足りない鍵がある / 1 = 読めない

export const GAS_BUDGET = {
  W_vet: 4200000,   // 実測 2,998,514 ＋ K1-03(918,878) の打ち直し ＋ 戻し約 150k ＋ 端数
  W_ens: 4800000,   // 実測 3,546,604（seller-d 込み）＋ K1-07(861,493) の打ち直し ＋ 振れ 91.2k ＋ 戻し 160k
  W_op:  3300000,   // 押下1回 157,012 × 21（撮影の1往復 ＋ 審査員 20 回）
};
export const GAS_SAFETY     = 3;                  // 今日の 1.028 gwei の3倍（3.08 gwei）まで関門を緑にする
export const PRESS_GAS      = 157012;             // mutate 78,506 ＋ reset 78,506【実測】
export const W_OP_FLOOR_WEI = 5000000000000000n;  // 0.005 ETH（§3.7.1 W04 の床）
export const BS03_WEI       = 50000000000000000n; // W_ens → W_op 0.05 ETH（BS-03）
export const KEYS = ['W_vet', 'W_ens', 'W_op'];

export const needWei = (key, gasPriceWei) => BigInt(GAS_BUDGET[key]) * BigInt(gasPriceWei) * BigInt(GAS_SAFETY);

// 「残高が尽きる gwei」。ガスに使える分（＝残高 − 取り置き）を予算で割る。
export const survivableGwei = (key, balanceWei, reserveWei = 0n) => {
  const usable = BigInt(balanceWei) - BigInt(reserveWei);
  return usable <= 0n ? 0 : Number(usable) / GAS_BUDGET[key] / 1e9;
};

// 鍵ごとの取り置き（ガスとは別に持っていなければならない額）
//   W_ens: BS-03 でこれから W_op へ送る 0.05 ETH。送り終えたら bs03Sent=true で外す
//   W_op : 床 0.005 ETH（押し切っても床を割らない）
export const reserveWei = (key, { bs03Sent = false } = {}) =>
  key === 'W_ens' ? (bs03Sent ? 0n : BS03_WEI)
  : key === 'W_op' ? W_OP_FLOOR_WEI
  : 0n;

/**
 * 残高とガス価格から合否を出す。通信はしない（呼び手が読んだ値を渡す）。
 * @param {{gasPriceWei: bigint|string|number,
 *          balances: Record<string, bigint|string|null|undefined>,
 *          addresses?: Record<string, string|null>,
 *          bs03Sent?: boolean}} args
 * @returns {{ok: boolean, gasPrice: {wei: string, gwei: number}, safety: number,
 *            skipped: string[], per_key: Record<string, object>}}
 */
export function evaluateGasBudget({ gasPriceWei, balances, addresses = {}, bs03Sent = false }) {
  const gp = BigInt(gasPriceWei);
  const per_key = {};
  const skipped = [];
  let ok = true;
  for (const key of KEYS) {
    const addr = addresses[key] ?? null;
    const bal = balances?.[key];
    if (bal === null || bal === undefined) {
      // アドレスが未確定（W_op は会期中に keys.ts init が作る）。**ok:true にしない。**
      per_key[key] = { addr, balance: null, need: null, headroom_gwei: null, ok: false, status: 'skipped',
        note: 'アドレス未確定（TOKYO_W_OP_ADDRESS が無い）。BS-03 を打った直後にもう1回' };
      skipped.push(key);
      continue;
    }
    const balance = BigInt(bal);
    const reserve = reserveWei(key, { bs03Sent });
    const need = needWei(key, gp) + reserve;
    const keyOk = balance >= need;
    if (!keyOk) ok = false;
    per_key[key] = {
      addr,
      balance: balance.toString(),
      balance_eth: Number(balance) / 1e18,
      need: need.toString(),
      need_eth: Number(need) / 1e18,
      gas_budget: GAS_BUDGET[key],
      reserve_wei: reserve.toString(),
      headroom_gwei: +survivableGwei(key, balance, reserve).toFixed(2), // 残高が尽きる gwei
      ok: keyOk,
      status: keyOk ? 'ok' : 'low',
    };
  }
  // skipped が1つでもあれば「3鍵とも ok」ではない
  if (skipped.length) ok = false;
  return { ok, gasPrice: { wei: gp.toString(), gwei: Number(gp) / 1e9 }, safety: GAS_SAFETY, skipped, per_key };
}

// ---- 読み取り（依存なしの JSON-RPC。eth_gasPrice と eth_getBalance だけ）----
const ALLOWED = new Set(['eth_gasPrice', 'eth_getBalance']);
async function rpc(url, method, params, timeoutMs = 20000) {
  if (!ALLOWED.has(method)) throw new Error(`読み取り以外の RPC は打たない: ${method}`);
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method} RPC ERROR ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

/**
 * RPC から価格と残高を読んで合否まで出す。読めなければ throw（＝終了コード 1 の側）。
 * @param {{rpcUrls: string[], addresses: Record<string,string|null>, bs03Sent?: boolean}} args
 */
export async function readGasBudget({ rpcUrls, addresses, bs03Sent = false }) {
  const errs = [];
  for (const url of rpcUrls) {
    try {
      const gasPriceWei = BigInt(await rpc(url, 'eth_gasPrice', []));
      const balances = {};
      for (const key of KEYS) {
        const a = addresses[key];
        balances[key] = a ? BigInt(await rpc(url, 'eth_getBalance', [a, 'latest'])) : null;
      }
      return { rpc: url, ...evaluateGasBudget({ gasPriceWei, balances, addresses, bs03Sent }) };
    } catch (e) { errs.push(`${url}: ${String(e.message || e).slice(0, 160)}`); }
  }
  throw new Error('ガス価格・残高をどの RPC でも読めない: ' + errs.join(' / '));
}

// ---- 単体で打たれたとき ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const addresses = {
    W_vet: process.env.W_VET || null,
    W_ens: process.env.W_ENS || null,
    W_op: process.env.TOKYO_W_OP_ADDRESS || null,
  };
  const rpcUrls = (process.env.SEPOLIA_RPCS || [
    process.env.RPC_S || 'https://sepolia.rpc.sentio.xyz',
    process.env.RPC_P || 'https://rpc.sepolia.ethpandaops.io',
    process.env.RPC_3 || 'https://0xrpc.io/sep',
  ].join(',')).split(',').map(s => s.trim()).filter(Boolean);
  if (!addresses.W_vet || !addresses.W_ens) {
    console.error('W_VET と W_ENS を env で渡す（W_op は TOKYO_W_OP_ADDRESS）');
    process.exit(1);
  }
  try {
    const out = await readGasBudget({ rpcUrls, addresses, bs03Sent: process.env.TOKYO_BS03_SENT === '1' });
    console.log(JSON.stringify(out));
    process.exit(out.ok ? 0 : 2);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }));
    process.exit(1);
  }
}
