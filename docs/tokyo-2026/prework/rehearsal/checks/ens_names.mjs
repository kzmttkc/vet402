// Sepolia ENSv2 の名前が消えていないか・配備し直しが起きていないかを読む（読み取りだけ・署名なし）
// 元: monitor/ens-names.mjs。spawnSync で別プロセスを呼ばれていたので、import できる形にした。
// 2026-09-17 改訂の中身はそのまま: UR.ROOT_REGISTRY → root.getSubregistry("eth") → ETHRegistry.getState(labelhash).latestOwner
import { viem, sepolia, RPC_LIST, W_VET, W_ENS, A } from '../lib/common.mjs';

const { createPublicClient, http, parseAbi, labelhash } = viem;
const UR = A.ur;
const EXPECT_ROOT = A.root; // 2026-09-15 の配備
// 期待する持ち主。ENS_EXPECT_UNREGISTERED=1 の間は「まだ取り直していない」前提で、未登録を変化として扱わない
const EXPECT = { 'vet402': W_VET, 'seller-a': W_ENS, 'seller-b': W_ENS, 'seller-c': W_ENS };

const urAbi = parseAbi(['function ROOT_REGISTRY() view returns (address)']);
const rootAbi = parseAbi(['function getSubregistry(string) view returns (address)']);
const regAbi = parseAbi(['function getState(uint256) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))']);
const same = (a, b) => JSON.stringify(a, (k, v) => typeof v === 'bigint' ? v.toString() : v).toLowerCase()
  === JSON.stringify(b, (k, v) => typeof v === 'bigint' ? v.toString() : v).toLowerCase();

// A3 で 20/20 の組。RPC_LIST の先頭2本を使う（3本目は片方が落ちたときの予備）
export async function readNames(rpcs = RPC_LIST.slice(0, 2)) {
  const PENDING = process.env.ENS_EXPECT_UNREGISTERED === '1';
  const out = { checked_at: new Date().toISOString(), rpc_agree: true, redeploy: false, names: {} };
  let changed = false;
  try {
    const cs = rpcs.map(u => createPublicClient({ chain: sepolia, transport: http(u, { timeout: 30000 }) }));
    const bn = (await cs[0].getBlockNumber()) - 3n; out.block = bn.toString();
    const read = p => Promise.all(cs.map(c => c.readContract({ ...p, blockNumber: bn })));
    const roots = await read({ address: UR, abi: urAbi, functionName: 'ROOT_REGISTRY' });
    if (!same(roots[0], roots[1])) out.rpc_agree = false;
    out.root = roots[0];
    if (roots[0].toLowerCase() !== EXPECT_ROOT.toLowerCase()) { out.redeploy = true; changed = true; }
    const eths = await read({ address: roots[0], abi: rootAbi, functionName: 'getSubregistry', args: ['eth'] });
    if (!same(eths[0], eths[1])) out.rpc_agree = false;
    out.eth_registry = eths[0];
    for (const [label, want] of Object.entries(EXPECT)) {
      const st = await read({ address: eths[0], abi: regAbi, functionName: 'getState', args: [BigInt(labelhash(label))] });
      if (!same(st[0], st[1])) out.rpc_agree = false;
      const s = st[0]; const owner = s.latestOwner;
      const registered = Number(s.status) !== 0 && owner !== '0x0000000000000000000000000000000000000000';
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const expired = s.expiry !== 0n && s.expiry < nowSec + 604800n; // 会期後 7 日以内に切れるものも警告（09-19 監査 D4）
      const ok = registered && owner.toLowerCase() === want.toLowerCase() && !expired;
      out.names[label + '.eth'] = { status: Number(s.status), owner, expiry: s.expiry.toString(), expires_at: s.expiry ? new Date(Number(s.expiry) * 1000).toISOString() : null, ok };
      if (!ok && !(PENDING && !registered)) changed = true;
    }
    out.pending_reregistration = PENDING;
  } catch (e) {
    out.error = e.shortMessage || String(e);
    return { out, code: 1 };
  }
  // 配備し直しは RPC 不一致より優先（09-19 監査 D5）
  return { out, code: out.redeploy ? 2 : !out.rpc_agree ? 1 : changed ? 2 : 0 };
}

// 単体で打ちたいとき: node checks/ens_names.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const { out, code } = await readNames();
  console.log(JSON.stringify(out));
  process.exit(code);
}
