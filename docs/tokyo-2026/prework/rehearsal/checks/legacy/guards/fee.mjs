import { client, RPC_S, RPC_P, W_VET, W_ENS, viem } from './lib.mjs';
const out = {};
for (const [name, rpc] of [['sentio', RPC_S], ['pandaops', RPC_P]]) {
  try {
    const c = client(rpc);
    const head = await c.getBlockNumber();
    const gp = await c.getGasPrice();
    let base = [];
    let blk = 'latest';
    for (let i = 0; i < 8; i++) {   // 8 x 128 = 1024 ブロック（約 3.4 時間）
      const fh = await c.request({ method: 'eth_feeHistory', params: ['0x80', blk, [50]] });
      const b = fh.baseFeePerGas.map(x => Number(BigInt(x)) / 1e9);
      base = b.concat(base);
      blk = viem.toHex(BigInt(fh.oldestBlock) - 1n);
    }
    base.sort((a, b) => a - b);
    const q = p => base[Math.min(base.length - 1, Math.floor(base.length * p))];
    out[name] = { head: head.toString(), gasPrice_gwei: Number(gp) / 1e9, n: base.length,
      min: base[0], p50: q(0.5), p90: q(0.9), p99: q(0.99), max: base.at(-1) };
    if (name === 'sentio') {
      out.balances = {};
      for (const [k, a] of Object.entries({ W_vet: W_VET, W_ens: W_ENS })) {
        const w = await c.getBalance({ address: a });
        out.balances[k] = { wei: w.toString(), eth: Number(w) / 1e18 };
      }
      const blkN = await c.getBlock({ blockNumber: head });
      out.head_baseFee_gwei = Number(blkN.baseFeePerGas) / 1e9;
      out.head_block = head.toString();
      out.head_ts = new Date(Number(blkN.timestamp) * 1000).toISOString();
    }
  } catch (e) { out[name] = { error: String(e).slice(0, 200) }; }
}
console.log(JSON.stringify(out, null, 1));
