// D シリーズ: 案A（自前 subname registry = UserRegistry）の実現性を eth_call / eth_simulateV1 で確かめる。
// 読み取りと simulate のみ。署名 0・送信 0。
import fs from 'fs';
import { viem, ABI, A, W_VET, W_ENS, W_OP2, RPC_S, RPC_P, dns, client, pr, ALL_ROLES, decErr } from '/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad/e15/lib.mjs';
const { labelhash, keccak256, toBytes, toHex, encodeFunctionData, decodeFunctionResult, decodeAbiParameters, parseAbi, getEventSelector } = viem;

const UR_ABI = (() => { const d = JSON.parse(fs.readFileSync('/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad/e15/ref/abi/new_UserRegistryImpl.json')); return d.abi ?? d; })();
const UR_IMPL = '0xa80338aaa8d23831cea25e858d1774534abb0263'; // docs.ens.domains/learn/deployments（他6件が既知と一致）
const R_VET = '0x3368219eddfdd1fac6409fb9a1b8bf7d21598391';
const K_AG1 = '0x00000000000000000000000000000000000000c1'; // エージェント1の鍵（架空・from にのみ使う）
const K_AG2 = '0x00000000000000000000000000000000000000c2';

// RegistryRolesLib（contracts-v2 d9affea0）
const R_REGISTRAR = 1n << 0n, R_UNREGISTER = 1n << 12n, R_RENEW = 1n << 16n;
const R_SET_SUBREG = 1n << 20n, R_SET_RESOLVER = 1n << 24n, R_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;
const R_UPGRADE = 1n << 124n;
const UNEMANCIPATED = R_SET_SUBREG | (R_SET_SUBREG << 128n) | R_SET_RESOLVER | (R_SET_RESOLVER << 128n)
  | R_UNREGISTER | (R_UNREGISTER << 128n) | R_UPGRADE | (R_UPGRADE << 128n);

const RPC = process.env.RPC === 'P' ? RPC_P : RPC_S;
const FIXB = process.env.FIXB ? BigInt(process.env.FIXB) : null;
const c0 = client(RPC);
const B = FIXB ?? (await c0.getBlockNumber() - 3n);
const blk = await c0.getBlock({ blockNumber: B });
const NOW = Number(blk.timestamp);
const EVMAP = {}; for (const abi of [ABI.PR, ABI.ER, ABI.VF, UR_ABI]) for (const e of abi.filter(x => x.type === 'event')) { try { EVMAP[getEventSelector(e)] = e.name; } catch {} }
const ALL_ERR = [...ABI.PR, ...ABI.VF, ...ABI.ER, ...ABI.UH, ...ABI.UR, ...UR_ABI].filter(x => x.type === 'error');
const dec = d => { try { const r = viem.decodeErrorResult({ abi: ALL_ERR, data: d }); return r.errorName + '(' + (r.args || []).map(a => typeof a === 'bigint' ? '0x' + a.toString(16) : String(a)).join(',') + ')'; } catch { return 'raw:' + String(d).slice(0, 74); } };

const ur = (fn, args) => encodeFunctionData({ abi: UR_ABI, functionName: fn, args });
const er = (fn, args) => encodeFunctionData({ abi: ABI.ER, functionName: fn, args });
const uh = (fn, args) => encodeFunctionData({ abi: ABI.UH, functionName: fn, args });
const urv = (fn, args) => encodeFunctionData({ abi: ABI.UR, functionName: fn, args });
const RD = parseAbi(['function text(bytes32 node, string key) view returns (string)', 'function addr(bytes32 node) view returns (address)']);
const rd = (fn, args) => encodeFunctionData({ abi: RD, functionName: fn, args });
const nh = n => viem.namehash(n);

const TID = {};
for (const l of ['vet402', 'seller-a']) TID[l] = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B })).tokenId;

// ---- D0: 実装アドレスの裏取り（eth_call）----
const d0 = {};
d0.code = (await c0.getBytecode({ address: UR_IMPL, blockNumber: B }) ?? '0x').length / 2 - 1;
for (const [k, fn, args] of [['labelStore', 'LABEL_STORE', []], ['rootResource', 'ROOT_RESOURCE', []], ['canUpgradeFrom', 'canUpgradeFrom', ['0x0000000000000000000000000000000000000000']]]) {
  try { d0[k] = String(await c0.readContract({ address: UR_IMPL, abi: UR_ABI, functionName: fn, args, blockNumber: B })); } catch (e) { d0[k] = 'ERR ' + String(e).slice(0, 80); }
}
try { d0.vfVerify = await c0.readContract({ address: A.vf, abi: ABI.VF, functionName: 'verifyContract', args: [UR_IMPL], blockNumber: B }); } catch (e) { d0.vfVerify = 'ERR'; }
// 会期前の現状: vet402.eth の subregistry は？
d0.vet402_subregistry = await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getSubregistry', args: ['vet402'], blockNumber: B });
d0.vet402_roles_W_VET = '0x' + (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'roles', args: [TID['vet402'], W_VET], blockNumber: B })).toString(16);
d0.hasSetSubregistry = await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'hasRoles', args: [TID['vet402'], R_SET_SUBREG, W_VET], blockNumber: B });
// 現状の findResolver（subregistry を付ける前）
for (const n of ['vet402.eth', 'atst.vet402.eth', 'x.obs.vet402.eth', 'agent-1.vet402.eth']) {
  const r = await c0.readContract({ address: A.ur, abi: ABI.UR, functionName: 'findResolver', args: [dns(n)], blockNumber: B });
  d0['findResolver_before_' + n] = r[0];
}
console.log('D0', JSON.stringify(d0, null, 1));

// ---- D1..: eth_simulateV1 ----
const SALT_U = BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
const SALT_A1 = BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));
const initU = ur('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }]]);
const POLICY = '{"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}';
const initA1 = pr('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', POLICY]),
  pr('setText', [dns('agent-1.vet402.eth'), 'class', 'x402-payer']),
  pr('setAddress', [dns('agent-1.vet402.eth'), 60n, K_AG1]),
]]);
const dep = (impl, salt, init) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [impl, salt, init] });

// 予測アドレス（eth_call で先に取る）
const pre = async (from, impl, salt, init) => {
  const r = await c0.call({ account: from, to: A.vf, data: dep(impl, salt, init), blockNumber: B });
  return viem.getAddress('0x' + r.data.slice(26));
};
const U = await pre(W_VET, UR_IMPL, SALT_U, initU);
const P_AG1 = await pre(W_VET, A.impl, SALT_A1, initA1);
console.log('predicted U=', U, ' P_AG1=', P_AG1);

const EXPIRY_SHORT = BigInt(NOW + 3600);   // 1時間
const AGENT_ROLES = R_RENEW;               // 譲渡不可・自分では失効させられない（親だけ）
const AGENT_ROLES_XF = R_RENEW | R_CAN_TRANSFER_ADMIN; // 比較用: 譲渡可

const TOK = { agent1: null, agent2: null };
// tokenId は register の戻り値。simulate の returnData から取るので、後段は findTokenId で引く。
const S = [];
const P = (id, from, to, fn, data, note) => S.push({ id, from, to, fn, data, note });

P('D-01', W_VET, A.vf, `deployProxy(UserRegistryImpl, SALT_U, initialize([(W_vet,ALL)])) → U`, dep(UR_IMPL, SALT_U, initU), '自前のサブ名レジストリを配備');
P('D-02', W_VET, A.er, `ETHRegistry.setSubregistry(tokenId(vet402.eth), U)`, er('setSubregistry', [TID['vet402'], U]), 'vet402.eth の下を自前レジストリに委ねる＝階層レジストリ');
P('D-03', W_VET, A.vf, `deployProxy(PermissionedResolverImpl, SALT_A1, initialize(...)) → P_AG1`, dep(A.impl, SALT_A1, initA1), 'エージェント専用リゾルバ。方針・class・addr を同時に置く');
P('D-04', W_VET, U, `U.register("agent-1", K_AG1, 0, P_AG1, ROLE_RENEW, now+3600)`, ur('register', ['agent-1', K_AG1, '0x0000000000000000000000000000000000000000', P_AG1, AGENT_ROLES, EXPIRY_SHORT]), '期限つき・譲渡不可（ROLE_CAN_TRANSFER_ADMIN 無し）のサブ名を発行');
P('D-05', W_VET, P_AG1, `P_AG1.grantSetterRoles(setText(*, "x402-policy", ""), K_AG1)`, pr('grantSetterRoles', [pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', '']), K_AG1]), 'エージェントの鍵に自分の方針キーだけを委任');
P('D-06', K_AG1, P_AG1, `K_AG1 が自分の方針を書き換え`, pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', '{"v":2,"max":"9000"}']), '期待: OK');
P('D-07', K_AG1, P_AG1, `K_AG1 が自分のリゾルバで addr を書く`, pr('setAddress', [dns('agent-1.vet402.eth'), 60n, K_AG2]), '期待: REVERT（方針キーしか委任していない）');
P('D-08', K_AG1, R_VET, `K_AG1 が親のリゾルバ R_vet に x402-policy を書く`, pr('setText', [dns('vet402.eth'), 'x402-policy', 'HACK']), '期待: REVERT（委任は自分のリゾルバの中だけ）');
P('D-09', W_VET, A.ur, `UR.resolve(agent-1.vet402.eth, text("x402-policy"))`, urv('resolve', [dns('agent-1.vet402.eth'), rd('text', [nh('agent-1.vet402.eth'), 'x402-policy'])]), '解決できるか（P_AG1 が leaf resolver）');
P('D-10', W_VET, A.ur, `UR.findResolver(atst.vet402.eth)`, urv('findResolver', [dns('atst.vet402.eth')]), '既存の wildcard が subregistry 追加後も壊れないか（= R_vet のままか）');
P('D-11', W_VET, A.ur, `UR.findResolver(x.obs.vet402.eth)`, urv('findResolver', [dns('x.obs.vet402.eth')]), '同上（観測ログの4ラベル）');
P('D-12', W_VET, A.uh, `UH.findExactOwner(agent-1.vet402.eth)`, uh('findExactOwner', [dns('agent-1.vet402.eth')]), '期待: K_AG1（サブ名に持ち主がいる）');
P('D-13', K_AG1, U, `K_AG1 が agent-1 を他人へ譲渡`, ur('unsafeTransfer', [W_OP2, 0n, '0x']), '期待: REVERT（tokenId はこの後 findTokenId で差し替え）');
P('D-14', W_VET, U, `U.register("agent-2", K_AG2, 0, 0, ROLE_RENEW|ROLE_CAN_TRANSFER_ADMIN, now+3600)`, ur('register', ['agent-2', K_AG2, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', AGENT_ROLES_XF, EXPIRY_SHORT]), '比較: 譲渡可・専用リゾルバ無し（親の wildcard に落ちる）');
P('D-15', W_VET, A.ur, `UR.findResolver(agent-2.vet402.eth)`, urv('findResolver', [dns('agent-2.vet402.eth')]), '期待: R_vet（親のリゾルバに wildcard で落ちる）');
P('D-16', W_VET, U, `U.unregister(agent-1)`, ur('unregister', [0n]), '取り消し（tokenId は後で差し替え）');
P('D-17', W_VET, A.uh, `UH.findExactOwner(agent-1.vet402.eth)`, uh('findExactOwner', [dns('agent-1.vet402.eth')]), '期待: 0x0（取り消し後）');
P('D-18', W_VET, A.ur, `UR.resolve(agent-1.vet402.eth, text("x402-policy"))`, urv('resolve', [dns('agent-1.vet402.eth'), rd('text', [nh('agent-1.vet402.eth'), 'x402-policy'])]), '取り消し後に方針がどう見えるか');
P('D-19', W_VET, U, `U.revokeRootRoles(UNEMANCIPATED_ROLE_BITMAP, W_vet)`, ur('revokeRootRoles', [UNEMANCIPATED, W_VET]), '親の支配を外す＝emancipation');
P('D-20', W_VET, U, `U.isEmancipated()`, ur('isEmancipated', []), '期待: true');

// tokenId が要る呼び出しは、simulate を2段に分ける（1段目で register して findTokenId を読む）
const sim = async (calls, timeOverride) => {
  const bsc = { calls };
  if (timeOverride) bsc.blockOverrides = { time: toHex(timeOverride) };
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [bsc], validation: false, traceTransfers: false }, toHex(B)] };
  const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (j.error) throw new Error('RPC ' + JSON.stringify(j.error).slice(0, 300));
  return j.result[0].calls;
};

// 段1: D-01..D-04 + findTokenId
const pass1 = await sim([...S.slice(0, 4).map(x => ({ from: x.from, to: x.to, data: x.data })), { from: W_VET, to: U, data: ur('findTokenId', ['agent-1']) }]);
pass1.forEach((c, i) => console.log('pass1', i, c.status, parseInt(c.gasUsed, 16), c.status === '0x1' ? '' : dec(c.error?.data ?? c.returnData)));
const TID_A1 = BigInt(pass1[4].returnData);
console.log('tokenId(agent-1) =', TID_A1.toString());
S[12].data = ur('unsafeTransfer', [W_OP2, TID_A1, '0x']);
S[15].data = ur('unregister', [TID_A1]);

const calls = S.map(x => ({ from: x.from, to: x.to, data: x.data }));
const res = await sim(calls);
let total = 0; const rows = [];
res.forEach((c, i) => {
  const s = S[i]; const gas = parseInt(c.gasUsed, 16);
  const ok = c.status === '0x1';
  if (ok && s.to !== A.ur && s.to !== A.uh) total += gas;
  const o = { id: s.id, from: s.from === W_VET ? 'W_vet' : s.from === K_AG1 ? 'K_ag1' : s.from, fn: s.fn, status: ok ? 'OK' : 'REVERT', gas, note: s.note };
  if (!ok) o.revert = dec(c.error?.data ?? c.returnData);
  else { o.ret = c.returnData; o.logs = (c.logs || []).map(l => EVMAP[l.topics[0]] ?? l.topics[0].slice(0, 10)); }
  rows.push(o);
  console.log(o.id, o.status, 'gas=' + gas, o.revert ?? (o.ret ?? '').slice(0, 90), '[' + (o.logs || []).join(',') + ']');
});

// 段3: 期限切れ（時刻を +7200 に飛ばす）
const expCalls = [
  ...S.slice(0, 5).map(x => ({ from: x.from, to: x.to, data: x.data })), // D-01..D-05
];
const pass3 = await sim([...expCalls,
  { from: W_VET, to: A.uh, data: uh('findExactOwner', [dns('agent-1.vet402.eth')]) },
  { from: W_VET, to: A.ur, data: urv('findResolver', [dns('agent-1.vet402.eth')]) },
  { from: W_VET, to: A.ur, data: urv('resolve', [dns('agent-1.vet402.eth'), rd('text', [nh('agent-1.vet402.eth'), 'x402-policy'])]) },
  { from: W_VET, to: U, data: ur('getStatus', [TID_A1]) },
], NOW + 7200);
const expNames = ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'X-findExactOwner', 'X-findResolver', 'X-resolve(text)', 'X-getStatus'];
const expRows = pass3.map((c, i) => {
  const ok = c.status === '0x1';
  const o = { id: expNames[i], status: ok ? 'OK' : 'REVERT', gas: parseInt(c.gasUsed, 16) };
  if (!ok) o.revert = dec(c.error?.data ?? c.returnData); else o.ret = (c.returnData || '').slice(0, 200);
  console.log('EXPIRED(+7200s)', o.id, o.status, o.revert ?? (o.ret || '').slice(0, 90));
  return o;
});

// 段4: namespace aliasing — seller-a.eth の subregistry も同じ U に向ける
const pass4 = await sim([
  ...S.slice(0, 5).map(x => ({ from: x.from, to: x.to, data: x.data })),
  { from: W_ENS, to: A.er, data: er('setSubregistry', [TID['seller-a'], U]) },
  { from: W_VET, to: A.ur, data: urv('findResolver', [dns('agent-1.seller-a.eth')]) },
  { from: W_VET, to: A.uh, data: uh('findExactOwner', [dns('agent-1.seller-a.eth')]) },
  { from: W_VET, to: A.ur, data: urv('resolve', [dns('agent-1.seller-a.eth'), rd('text', [nh('agent-1.seller-a.eth'), 'x402-policy'])]) },
]);
const alNames = ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'N-setSubregistry(seller-a→U)', 'N-findResolver(agent-1.seller-a.eth)', 'N-findExactOwner', 'N-resolve(text)'];
const alRows = pass4.map((c, i) => {
  const ok = c.status === '0x1';
  const o = { id: alNames[i], status: ok ? 'OK' : 'REVERT', gas: parseInt(c.gasUsed, 16) };
  if (!ok) o.revert = dec(c.error?.data ?? c.returnData); else o.ret = (c.returnData || '').slice(0, 260);
  console.log('ALIAS', o.id, o.status, 'gas=' + o.gas, o.revert ?? (o.ret || '').slice(0, 120));
  return o;
});

console.log('\n書き込み tx の合計 gas（D-01..D-20 のうち成功した書き込み）=', total);
fs.writeFileSync('/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad/hw/h1_d_'+(process.env.RPC==='P'?'pandaops':'sentio')+'.json', JSON.stringify({ block: B.toString(), now: NOW, UR_IMPL, U, P_AG1, tokenId_agent1: TID_A1.toString(), d0, rows, expRows, alRows, totalWriteGas: total }, (k, v) => typeof v === 'bigint' ? v.toString() : v, 1));
