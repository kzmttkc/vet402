import fs from 'fs';
import { viem, ABI, A, R_VET, HCA_VET, W_VET, W_ENS, W_OP, W_OP_REAL, W_OBS, K_ATST, K_AG1, K_AG2,
  RPC_S, RPC_P, ZERO, ALL_ROLES, R_RENEW, R_CAN_TRANSFER_ADMIN, UNEMANCIPATED,
  dns, client, pr, usr, er, urv, uh, rd, ATT_KEY, OBS_KEYS, dec, simRaw } from './lib.mjs';
const { labelhash, namehash, keccak256, toBytes, toHex, encodeFunctionData } = viem;

const RPC = process.env.RPC === 'P' ? RPC_P : RPC_S;
const c0 = client(RPC);
const B = process.env.FIXB ? BigInt(process.env.FIXB) : (await c0.getBlockNumber()) - 3n;
const blk = await c0.getBlock({ blockNumber: B });
const NOW = Number(blk.timestamp);
const EXP = BigInt(NOW + 7 * 86400);
const OUT = { rpc: RPC, block: B.toString(), blockTs: NOW, baseFeePerGas: blk.baseFeePerGas?.toString() };

// ---------- 文字列（本物）----------
const USDC_BS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const mkOffer = (amount, payTo) => `{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"${USDC_BS}","amount":"${amount}","payTo":"${payTo}","output":{"required":["result","observed_at"]}}`;
const OFFER_A = mkOffer('10000', W_ENS);
const OFFER_A2 = mkOffer('10001', W_ENS);
const OFFER_B = mkOffer('20000', W_ENS);
const OFFER_C = mkOffer('30000', W_ENS);
const POLICY = '{"v":1,"network":"eip155:84532","trust":["atst.vet402.eth"],"floors":{"minEnsAttestations":1,"minChainReceipts":1},"requireVet402Allow":false,"max":"50000","maxAgeSeconds":86400}';
// ENSIP-29 envelope 79 バイト → base64 108 文字
const ENV = Buffer.from(Array.from({ length: 79 }, (_, i) => (i * 37 + 11) & 0xff)).toString('base64');
// 旧 sim の仮の値（再現確認用）
const OLD_OFFER_A = '{"v":1,"amount":"10000","asset":"USDC"}';
const OLD_OFFER_B = '{"v":1,"amount":"20000","asset":"USDC"}';
const OLD_OFFER_C = '{"v":1,"amount":"30000","asset":"USDC"}';
const OLD_POLICY = '{"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}';
OUT.strings = {
  OFFER_A: { s: OFFER_A, bytes: Buffer.byteLength(OFFER_A) },
  POLICY: { s: POLICY, bytes: Buffer.byteLength(POLICY) },
  ENVELOPE_b64: { s: ENV, bytes: Buffer.byteLength(ENV) },
  OLD_OFFER_A_bytes: Buffer.byteLength(OLD_OFFER_A), OLD_POLICY_bytes: Buffer.byteLength(OLD_POLICY),
};

const TID = {}; for (const l of ['vet402', 'seller-a', 'seller-b', 'seller-c'])
  TID[l] = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B })).tokenId;

const SALT_A = BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
const SALT_BC = BigInt(keccak256(toBytes('tokyo-2026/seller-bc.eth')));
const SALT_U = BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
const SALT_A1 = BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));
const dep = (impl, salt, init) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [impl, salt, init] });
const pre = async (from, impl, salt, init) => viem.getAddress('0x' + (await c0.call({ account: from, to: A.vf, data: dep(impl, salt, init), blockNumber: B })).data.slice(26));

// initA: mode 'old4'（旧 sim・4本・仮値） / 'new3'（計画どおり 3本・仮値） / 'real3'（3本・本物）
const initA_of = mode => {
  const calls = [];
  const off = mode === 'real3' ? OFFER_A : OLD_OFFER_A;
  calls.push(pr('setText', [dns('seller-a.eth'), 'x402-offer', off]));
  calls.push(pr('setText', [dns('seller-a.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']));
  if (mode === 'old4') calls.push(pr('setText', [dns('seller-a.eth'), ATT_KEY, 'ENVELOPE_A']));
  calls.push(pr('setAddress', [dns('seller-a.eth'), 60n, W_ENS]));
  return pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], calls]);
};
const initBC_of = (real, envReal) => pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('seller-b.eth'), 'x402-offer', real ? OFFER_B : OLD_OFFER_B]),
  pr('setText', [dns('seller-b.eth'), ATT_KEY, envReal ? ENV : 'ENVELOPE_B']),
  pr('setAddress', [dns('seller-b.eth'), 60n, W_ENS]),
  pr('setText', [dns('seller-c.eth'), 'x402-offer', real ? OFFER_C : OLD_OFFER_C]),
  pr('setText', [dns('seller-c.eth'), ATT_KEY, envReal ? ENV : 'ENVELOPE_C']),
  pr('setAddress', [dns('seller-c.eth'), 60n, W_ENS]),
]]);
const initU = usr('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }]]);
const initA1_of = (real, kag1) => pr('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }], [
  pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', real ? POLICY : OLD_POLICY]),
  pr('setText', [dns('agent-1.vet402.eth'), 'class', real ? 'x402-agent' : 'x402-agent']),
  pr('setAddress', [dns('agent-1.vet402.eth'), 60n, kag1]),
]]);

// ---------- K1 の組み立て ----------
async function buildK1({ mode, real, envReal, kag1, kag2, wop }) {
  const initA = initA_of(mode), initBC = initBC_of(real, envReal ?? real), initA1 = initA1_of(real, kag1);
  const P_A = await pre(W_ENS, A.impl, SALT_A, initA);
  const P_BC = await pre(W_ENS, A.impl, SALT_BC, initBC);
  const U = await pre(W_VET, A.usrImpl, SALT_U, initU);
  const P_AG1 = await pre(W_VET, A.impl, SALT_A1, initA1);
  const TX = [
    ['K1-01', W_VET, R_VET, pr('revokeRootRoles', [ALL_ROLES, HCA_VET])],
    ['K1-02', W_VET, R_VET, pr('multicall', [[
      pr('setText', [dns('vet402.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo']),
      pr('setText', [dns('vet402.eth'), 'class', 'x402-verifier']),
      pr('setAddress', [dns('atst.vet402.eth'), 60n, K_ATST])]])],
    ['K1-03', W_VET, R_VET, pr('multicall', [OBS_KEYS.map(k => pr('grantSetterRoles', [pr('setText', [dns('x.obs.vet402.eth'), k, '']), W_OBS]))])],
    ['K1-04', W_ENS, A.vf, dep(A.impl, SALT_A, initA)],
    ['K1-05', W_ENS, A.er, er('setResolver', [TID['seller-a'], P_A])],
    ['K1-06', W_ENS, P_A, pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), wop])],
    ['K1-07', W_ENS, A.vf, dep(A.impl, SALT_BC, initBC)],
    ['K1-08', W_ENS, A.er, er('setResolver', [TID['seller-b'], P_BC])],
    ['K1-09', W_ENS, A.er, er('setResolver', [TID['seller-c'], P_BC])],
    ['K1-10', W_VET, A.vf, dep(A.usrImpl, SALT_U, initU)],
    ['K1-11', W_VET, A.er, er('setSubregistry', [TID['vet402'], U])],
    ['K1-12', W_VET, A.vf, dep(A.impl, SALT_A1, initA1)],
    ['K1-13', W_VET, U, usr('register', ['agent-1', kag1, ZERO, P_AG1, R_RENEW, EXP])],
    ['K1-14', W_VET, P_AG1, pr('grantSetterRoles', [pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', '']), kag1])],
    ['K1-15', W_VET, U, usr('register', ['agent-2', kag2, ZERO, ZERO, R_RENEW | R_CAN_TRANSFER_ADMIN, EXP])],
  ];
  return { TX, P_A, P_BC, U, P_AG1 };
}

const runRows = async (labelled, blockOverrides) => {
  const res = await simRaw(RPC, labelled.map(r => ({ from: r[1], to: r[2], data: r[3] })), B, blockOverrides);
  return res.map((c, i) => ({ id: labelled[i][0], status: c.status === '0x1' ? 'OK' : 'REVERT',
    gas: parseInt(c.gasUsed, 16), ret: c.returnData,
    revert: c.status === '0x1' ? undefined : dec(c.error?.data ?? c.returnData) }));
};

// ===== 1. 旧 sim の再現（h1_k1.mjs と同じ入力）=====
{
  const { TX } = await buildK1({ mode: 'old4', real: false, kag1: K_AG1, kag2: K_AG2, wop: W_OP });
  const rows = await runRows(TX);
  OUT.repro_old_sim = { rows, total: rows.reduce((s, r) => s + r.gas, 0) };
  console.log('=== 1. 旧 sim 再現 total', OUT.repro_old_sim.total);
  rows.forEach(r => console.log('  ', r.id, r.status, r.gas, r.revert ?? ''));
}
// ===== 2. 計画どおり K1-04 が3本（仮値）=====
{
  const { TX } = await buildK1({ mode: 'new3', real: false, kag1: K_AG1, kag2: K_AG2, wop: W_OP });
  const rows = await runRows(TX);
  OUT.k1_3calls_placeholder = { rows, total: rows.reduce((s, r) => s + r.gas, 0) };
  console.log('=== 2. K1-04 3本・仮値 total', OUT.k1_3calls_placeholder.total, '/ K1-04', rows[3].gas, '/ K1-12', rows[11].gas);
}
// ===== 3. 本物の文字列（K1-04 は3本）・ダミー鍵 =====
let REAL = null;
{
  const b = await buildK1({ mode: 'real3', real: true, envReal: false, kag1: K_AG1, kag2: K_AG2, wop: W_OP });
  const rows = await runRows(b.TX);
  REAL = { ...b, rows };
  OUT.k1_real_dummykeys = { rows, total: rows.reduce((s, r) => s + r.gas, 0), P_A: b.P_A, P_BC: b.P_BC, U: b.U, P_AG1: b.P_AG1 };
  console.log('=== 3. 本物の文字列・ダミー鍵 total', OUT.k1_real_dummykeys.total);
  rows.forEach(r => console.log('  ', r.id, r.status, r.gas, r.revert ?? ''));
}
// ===== 4. 本物の文字列・実鍵に近いダミー（非ゼロバイト 20）=====
{
  const K1r = '0x9f2a7c41bd85e306ac1f94d2b7e58a03cd61f7b2';
  const K2r = '0x3ea61b04c9d7582fa1bc6e39d04f7a2851ce9db6';
  const b = await buildK1({ mode: 'real3', real: true, envReal: false, kag1: K1r, kag2: K2r, wop: W_OP_REAL });
  const rows = await runRows(b.TX);
  OUT.k1_real_realishkeys = { rows, total: rows.reduce((s, r) => s + r.gas, 0) };
  console.log('=== 4. 本物の文字列・実鍵風ダミー total', OUT.k1_real_realishkeys.total,
    'diff', OUT.k1_real_realishkeys.total - OUT.k1_real_dummykeys.total);
}

// ===== 5. 本番の全チェーン（K1 + 15b/15c/15d + K1-post + B5b + D + T7）=====
{
  const { TX, P_A, P_BC, U, P_AG1 } = REAL;
  // tokenId(agent-1) を取るための先行 sim
  const p1 = await simRaw(RPC, [...TX.map(r => ({ from: r[1], to: r[2], data: r[3] })),
    { from: W_VET, to: U, data: usr('findTokenId', ['agent-1']) }], B);
  const TID_A1 = BigInt(p1[15].returnData);
  OUT.tokenId_agent1 = TID_A1.toString();

  const EXT = [
    ...TX,
    ['K1-15b', W_VET, R_VET, pr('grantSetterRoles', [pr('setText', [dns('agent-2.vet402.eth'), 'x402-policy', '']), K_AG2])],
    ['K1-15c', W_ENS, A.er, er('setSubregistry', [TID['seller-a'], U])],
    ['K1-15d', W_VET, P_AG1, pr('linkToNode', [dns('agent-1.seller-a.eth'), namehash('agent-1.vet402.eth')])],
    ['K1-post-1', W_VET, U, usr('register', ['atst', W_VET, ZERO, ZERO, R_RENEW, EXP])],
    ['K1-post-2', W_VET, U, usr('register', ['obs', W_VET, ZERO, ZERO, R_RENEW, EXP])],
    // B5b: 本物の envelope（base64 108 文字）を3名に置く
    ['B5b-a', W_ENS, P_A, pr('setText', [dns('seller-a.eth'), ATT_KEY, ENV])],
    ['B5b-b', W_ENS, P_BC, pr('setText', [dns('seller-b.eth'), ATT_KEY, ENV])],
    ['B5b-c', W_ENS, P_BC, pr('setText', [dns('seller-c.eth'), ATT_KEY, ENV])],
    // D-1: W_op が 1 文字変える（本物の文字列）／ D-1r: 戻す
    ['D-1', W_OP, P_A, pr('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A2])],
    ['D-1r', W_OP, P_A, pr('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A])],
    ['D-2', W_ENS, P_BC, pr('linkToRecord', [dns('seller-b.eth'), 0n])],
    ['D-3', W_ENS, P_BC, pr('linkToRecord', [dns('seller-b.eth'), 1n])],
    ['D-4', W_ENS, P_BC, pr('linkToRecord', [dns('seller-c.eth'), 1n])],
    ['D-5', W_ENS, P_BC, pr('linkToRecord', [dns('seller-c.eth'), 2n])],
    ['D-6a', W_VET, U, usr('unregister', [TID_A1])],
    ['D-6b', W_VET, U, usr('register', ['agent-1', K_AG1, ZERO, P_AG1, R_RENEW, EXP])],
    ['T7', W_VET, U, usr('revokeRootRoles', [UNEMANCIPATED, W_VET])],
  ];
  const rows = await runRows(EXT);
  OUT.full_chain = rows;
  console.log('=== 5. 本番の全チェーン ===');
  rows.forEach(r => console.log('  ', r.id, r.status, r.gas, r.revert ?? ''));
}

// ===== 5b. 対照: K1-07 で本物の envelope を先に置いた場合 =====
{
  const b = await buildK1({ mode: 'real3', real: true, envReal: true, kag1: K_AG1, kag2: K_AG2, wop: W_OP });
  const rows = await runRows(b.TX);
  const ext = [...b.TX,
    ['B5b-a', W_ENS, b.P_A, pr('setText', [dns('seller-a.eth'), ATT_KEY, ENV])],
    ['B5b-b', W_ENS, b.P_BC, pr('setText', [dns('seller-b.eth'), ATT_KEY, ENV])],
    ['B5b-c', W_ENS, b.P_BC, pr('setText', [dns('seller-c.eth'), ATT_KEY, ENV])]];
  const r2 = await runRows(ext);
  OUT.variant_env_in_K1_07 = { k1_total: rows.reduce((s, r) => s + r.gas, 0), rows: r2.slice(-4) , K1_07: rows[6].gas};
  console.log('=== 5b. K1-07 に本物 envelope: K1-07', rows[6].gas, 'B5b', r2.slice(-3).map(x => x.gas).join('+'));
}

// ===== 6. 1バイトあたりの感度（K1-04 と D-1）=====
{
  const sens = [];
  for (const extra of [0, 1, 8, 16, 32, 64]) {
    const off = mkOffer('10000', W_ENS).replace('"observed_at"', '"observed_at' + 'x'.repeat(extra) + '"');
    const calls = [pr('setText', [dns('seller-a.eth'), 'x402-offer', off]),
      pr('setText', [dns('seller-a.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']),
      pr('setAddress', [dns('seller-a.eth'), 60n, W_ENS])];
    const init = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], calls]);
    const r = await simRaw(RPC, [{ from: W_ENS, to: A.vf, data: dep(A.impl, SALT_A, init) }], B);
    sens.push({ offerBytes: Buffer.byteLength(off), gas: parseInt(r[0].gasUsed, 16), status: r[0].status });
  }
  OUT.sensitivity_K1_04 = sens;
  console.log('=== 6. K1-04 の長さ感度', JSON.stringify(sens));
}

// ===== 7. ガス価格と残高 =====
{
  const gp = await c0.getGasPrice();
  const fh = await c0.request({ method: 'eth_feeHistory', params: ['0x14', 'latest', [10, 50, 90]] });
  const bals = {};
  for (const [k, a] of Object.entries({ W_vet: W_VET, W_ens: W_ENS })) bals[k] = (await c0.getBalance({ address: a })).toString();
  const base = fh.baseFeePerGas.map(x => Number(BigInt(x)) / 1e9);
  const tips = fh.reward.map(r => r.map(x => Number(BigInt(x)) / 1e9));
  OUT.gas_market = { gasPrice_wei: gp.toString(), gasPrice_gwei: Number(gp) / 1e9,
    baseFee_gwei_last20: base, tip_gwei_p10_p50_p90_last20: tips,
    head: Number(BigInt(fh.oldestBlock)) + base.length - 1, balances_wei: bals,
    balances_eth: Object.fromEntries(Object.entries(bals).map(([k, v]) => [k, Number(v) / 1e18])) };
  console.log('=== 7. gasPrice', Number(gp) / 1e9, 'gwei / baseFee last', base.at(-1), '/ balances', OUT.gas_market.balances_eth);
}

fs.writeFileSync('./GAS.json', JSON.stringify(OUT, (k, v) => typeof v === 'bigint' ? v.toString() : v, 1));
console.log('written GAS.json');
