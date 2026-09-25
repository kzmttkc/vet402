// gas: 鍵ごとのガスを `eth_simulateV1` で測り直し、lib/gas-budget.mjs の関門と突き合わせる。
// 元: guards/gas.mjs（＋ guards/lib.mjs）。**測っている中身は変えていない。**
// 直したのは置き場所だけ: viem と ABI を rehearsal 自身の依存から取り、絶対パスを消した。
//   旧 guards/lib.mjs は viem を ~/hackathon-monitor の node_modules から createRequire で借り、
//   ABI を調査用 scratchpad の ur/abi から読んでいた（＝その scratchpad が消えたら二度と測れない）。
// 読み取りのみ（eth_call / eth_simulateV1 / eth_gasPrice / eth_getBalance）。署名・送信はしない。
//
//   node run.mjs --gas          （`--all` には入らない。重いので明示で打つ）
//   FIXB=11735920 node run.mjs --gas
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  viem, ABI, A, UR_IMPL, R_VET, HCA_VET, W_VET, W_ENS, W_OP, W_OP_REAL, W_OBS, K_ATST, K_AG1, K_AG2,
  RPC_LIST, SIM_RPC_LIST, ZERO, ALL_ROLES, ROLE_RENEW, ROLE_CAN_TRANSFER_ADMIN, UNEMANCIPATED,
  dns, client, pr, usr, er, ATT_KEY, OBS_KEYS, decErr, simulate, simulateBlocks, pickRpc,
  mkOffer, mkPolicy, ENVELOPE_B64, OFFER_BYTES, POLICY_BYTES, ENVELOPE_B64_CHARS,
} from '../lib/common.mjs';
import { GAS_BUDGET, GAS_SAFETY, PRESS_GAS, W_OP_FLOOR_WEI, BS03_WEI, evaluateGasBudget, KEYS } from '../lib/gas-budget.mjs';

const { labelhash, namehash, keccak256, toBytes, toHex, encodeFunctionData, parseAbi } = viem;
// Sepolia の素の ETH 送金（BS-03）。EVM の intrinsic gas。
const BS03_TRANSFER_GAS = 21000;
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');

export const id = 'gas';
export const title = 'gas / 鍵ごとのガスの再測と関門（lib/gas-budget.mjs と突き合わせる）';

export async function run({ log }) {
  const url = process.env.RPC_URL || await pickRpc();
  const c0 = client(url);
  const B = process.env.FIXB ? BigInt(process.env.FIXB) : (await c0.getBlockNumber()) - 3n;
  const blk = await c0.getBlock({ blockNumber: B });
  const NOW = Number(blk.timestamp);
  const EXP = BigInt(NOW + 7 * 86400);

  const rows = [];
  const push = (rid, status, value, gas) => { rows.push({ id: rid, status, value, ...(gas === undefined ? {} : { gas }) }); };
  const OUT = { rpc: url, block: B.toString(), blockTs: NOW, baseFeePerGas: blk.baseFeePerGas?.toString() };

  // ---------- 文字列（本物。正典は lib/common.mjs＝PLAN_v4.3 §3.3.1 / §3.5.1）----------
  const OFFER_A = mkOffer('10000', W_ENS), OFFER_A2 = mkOffer('10001', W_ENS);
  const OFFER_B = mkOffer('20000', W_ENS), OFFER_C = mkOffer('30000', W_ENS);
  const POLICY = mkPolicy('50000');
  const ENV = ENVELOPE_B64;
  // 旧 sim の仮の値（再現確認用。**これで測ると K1-04/07/12 が小さく出る**）
  const OLD_OFFER_A = '{"v":1,"amount":"10000","asset":"USDC"}';
  const OLD_OFFER_B = '{"v":1,"amount":"20000","asset":"USDC"}';
  const OLD_OFFER_C = '{"v":1,"amount":"30000","asset":"USDC"}';
  const OLD_POLICY = '{"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}';
  OUT.strings = { OFFER_A_bytes: Buffer.byteLength(OFFER_A), POLICY_bytes: Buffer.byteLength(POLICY),
    ENVELOPE_b64_chars: Buffer.byteLength(ENV), OLD_OFFER_A_bytes: Buffer.byteLength(OLD_OFFER_A), OLD_POLICY_bytes: Buffer.byteLength(OLD_POLICY) };
  push('STR x402-offer bytes', Buffer.byteLength(OFFER_A) === OFFER_BYTES ? 'OK' : 'NG', String(Buffer.byteLength(OFFER_A)));
  push('STR x402-policy bytes', Buffer.byteLength(POLICY) === POLICY_BYTES ? 'OK' : 'NG', String(Buffer.byteLength(POLICY)));
  push('STR envelope b64 chars', Buffer.byteLength(ENV) === ENVELOPE_B64_CHARS ? 'OK' : 'NG', String(Buffer.byteLength(ENV)));

  const TID = {};
  for (const l of ['vet402', 'seller-a', 'seller-b', 'seller-c'])
    TID[l] = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B })).tokenId;

  const SALT_A = BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth')));
  const SALT_BC = BigInt(keccak256(toBytes('tokyo-2026/seller-bc.eth')));
  const SALT_U = BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth')));
  const SALT_A1 = BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth')));
  const dep = (impl, salt, init) => encodeFunctionData({ abi: ABI.VF, functionName: 'deployProxy', args: [impl, salt, init] });
  const pre = async (from, impl, salt, init) => viem.getAddress('0x' + (await c0.call({ account: from, to: A.vf, data: dep(impl, salt, init), blockNumber: B })).data.slice(26));

  // initA: 'old4' = 旧 sim（4本・仮値）／'new3' = 計画どおり3本だが仮値／'real3' = 3本・本物
  const initA_of = mode => {
    const calls = [];
    calls.push(pr('setText', [dns('seller-a.eth'), 'x402-offer', mode === 'real3' ? OFFER_A : OLD_OFFER_A]));
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
    pr('setText', [dns('agent-1.vet402.eth'), 'class', 'x402-agent']),
    pr('setAddress', [dns('agent-1.vet402.eth'), 60n, kag1]),
  ]]);

  async function buildK1({ mode, real, envReal, kag1, kag2, wop }) {
    const initA = initA_of(mode), initBC = initBC_of(real, envReal ?? real), initA1 = initA1_of(real, kag1);
    const P_A = await pre(W_ENS, A.impl, SALT_A, initA);
    const P_BC = await pre(W_ENS, A.impl, SALT_BC, initBC);
    const U = await pre(W_VET, UR_IMPL, SALT_U, initU);
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
      ['K1-10', W_VET, A.vf, dep(UR_IMPL, SALT_U, initU)],
      ['K1-11', W_VET, A.er, er('setSubregistry', [TID['vet402'], U])],
      ['K1-12', W_VET, A.vf, dep(A.impl, SALT_A1, initA1)],
      ['K1-13', W_VET, U, usr('register', ['agent-1', kag1, ZERO, P_AG1, ROLE_RENEW, EXP])],
      ['K1-14', W_VET, P_AG1, pr('grantSetterRoles', [pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', '']), kag1])],
      ['K1-15', W_VET, U, usr('register', ['agent-2', kag2, ZERO, ZERO, ROLE_RENEW | ROLE_CAN_TRANSFER_ADMIN, EXP])],
    ];
    return { TX, P_A, P_BC, U, P_AG1 };
  }

  const runRows = async labelled => {
    const { calls } = await simulate(labelled.map(r => ({ from: r[1], to: r[2], data: r[3] })), B, [url, ...SIM_RPC_LIST.filter(u => u !== url)]);
    return calls.map((c, i) => ({ id: labelled[i][0], status: c.status === '0x1' ? 'OK' : 'REVERT',
      gas: parseInt(c.gasUsed, 16), revert: c.status === '0x1' ? undefined : decErr(c.error?.data ?? c.returnData) }));
  };
  const sum = rs => rs.reduce((s, r) => s + r.gas, 0);
  const allOk = rs => rs.every(r => r.status === 'OK');

  // ===== 1. 旧 sim の再現（仮値・4本）=====
  {
    const { TX } = await buildK1({ mode: 'old4', real: false, kag1: K_AG1, kag2: K_AG2, wop: W_OP });
    const rs = await runRows(TX);
    OUT.repro_old_sim = { rows: rs, total: sum(rs) };
    log(`1. 旧 sim 再現（仮値）total=${sum(rs)} K1-04=${rs[3].gas} K1-07=${rs[6].gas} K1-12=${rs[11].gas}`);
    push('OLD placeholder K1 total', allOk(rs) ? 'OK' : 'REVERT', String(sum(rs)), sum(rs));
  }
  // ===== 2. 計画どおり3本だが仮値 =====
  {
    const { TX } = await buildK1({ mode: 'new3', real: false, kag1: K_AG1, kag2: K_AG2, wop: W_OP });
    const rs = await runRows(TX);
    OUT.k1_3calls_placeholder = { rows: rs, total: sum(rs) };
    log(`2. 3本・仮値 total=${sum(rs)} K1-04=${rs[3].gas} K1-12=${rs[11].gas}`);
    push('OLD placeholder 3calls K1 total', allOk(rs) ? 'OK' : 'REVERT', String(sum(rs)), sum(rs));
  }
  // ===== 3. 本物の文字列・ダミー鍵（**これが正典**）=====
  let REAL = null;
  {
    const b = await buildK1({ mode: 'real3', real: true, envReal: false, kag1: K_AG1, kag2: K_AG2, wop: W_OP });
    const rs = await runRows(b.TX);
    REAL = { ...b, rows: rs };
    OUT.k1_real_dummykeys = { rows: rs, total: sum(rs), P_A: b.P_A, P_BC: b.P_BC, U: b.U, P_AG1: b.P_AG1 };
    log(`3. 本物の文字列 total=${sum(rs)} / P_A=${b.P_A} P_BC=${b.P_BC} P_AG1=${b.P_AG1}`);
    push('ADDR P_a', 'OK', b.P_A); push('ADDR P_bc', 'OK', b.P_BC); push('ADDR P_AG1', 'OK', b.P_AG1);
  }
  // ===== 4. 実鍵に近いダミー（非ゼロバイト 20 本）との差 =====
  {
    const b = await buildK1({ mode: 'real3', real: true, envReal: false,
      kag1: '0x9f2a7c41bd85e306ac1f94d2b7e58a03cd61f7b2', kag2: '0x3ea61b04c9d7582fa1bc6e39d04f7a2851ce9db6', wop: W_OP_REAL });
    const rs = await runRows(b.TX);
    const d = sum(rs) - OUT.k1_real_dummykeys.total;
    OUT.k1_real_realishkeys = { rows: rs, total: sum(rs), diff: d };
    log(`4. 実鍵風ダミー total=${sum(rs)} diff=${d}`);
    push('KEY-SHAPE diff (realish - dummy)', Math.abs(d) < 20000 ? 'OK' : 'NG', String(d));
  }

  // ===== 5. 本番の全チェーン（K1 + 15b/15c/15d + K1-post + B5b + D + T7）=====
  const perKeyGas = { W_vet: 0, W_ens: 0, W_op: 0 };
  {
    const { TX, P_A, P_BC, U, P_AG1 } = REAL;
    const p1 = await simulate([...TX.map(r => ({ from: r[1], to: r[2], data: r[3] })),
      { from: W_VET, to: U, data: usr('findTokenId', ['agent-1']) }], B, [url, ...SIM_RPC_LIST.filter(u => u !== url)]);
    const TID_A1 = BigInt(p1.calls[15].returnData);
    OUT.tokenId_agent1 = TID_A1.toString();

    const EXT = [
      ...TX,
      ['K1-15b', W_VET, R_VET, pr('grantSetterRoles', [pr('setText', [dns('agent-2.vet402.eth'), 'x402-policy', '']), K_AG2])],
      ['K1-15c', W_ENS, A.er, er('setSubregistry', [TID['seller-a'], U])],
      ['K1-15d', W_VET, P_AG1, pr('linkToNode', [dns('agent-1.seller-a.eth'), namehash('agent-1.vet402.eth')])],
      ['K1-post-1', W_VET, U, usr('register', ['atst', W_VET, ZERO, ZERO, ROLE_RENEW, EXP])],
      ['K1-post-2', W_VET, U, usr('register', ['obs', W_VET, ZERO, ZERO, ROLE_RENEW, EXP])],
      ['B5b-a', W_ENS, P_A, pr('setText', [dns('seller-a.eth'), ATT_KEY, ENV])],
      ['B5b-b', W_ENS, P_BC, pr('setText', [dns('seller-b.eth'), ATT_KEY, ENV])],
      ['B5b-c', W_ENS, P_BC, pr('setText', [dns('seller-c.eth'), ATT_KEY, ENV])],
      ['D-1', W_OP, P_A, pr('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A2])],
      ['D-1r', W_OP, P_A, pr('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A])],
      ['D-2', W_ENS, P_BC, pr('linkToRecord', [dns('seller-b.eth'), 0n])],
      ['D-3', W_ENS, P_BC, pr('linkToRecord', [dns('seller-b.eth'), 1n])],
      ['D-4', W_ENS, P_BC, pr('linkToRecord', [dns('seller-c.eth'), 1n])],
      ['D-5', W_ENS, P_BC, pr('linkToRecord', [dns('seller-c.eth'), 2n])],
      ['D-6a', W_VET, U, usr('unregister', [TID_A1])],
      ['D-6b', W_VET, U, usr('register', ['agent-1', K_AG1, ZERO, P_AG1, ROLE_RENEW, EXP])],
      ['T7', W_VET, U, usr('revokeRootRoles', [UNEMANCIPATED, W_VET])],
    ];
    const rs = await runRows(EXT);
    OUT.full_chain = rs;
    const fromOf = Object.fromEntries(EXT.map(r => [r[0], r[1].toLowerCase()]));
    rs.forEach(r => {
      log(`   ${r.id} ${r.status} gas=${r.gas} ${r.revert ?? ''}`);
      push(r.id, r.status, r.revert ?? 'ok', r.gas);
      const f = fromOf[r.id];
      if (f === W_VET.toLowerCase()) perKeyGas.W_vet += r.gas;
      else if (f === W_ENS.toLowerCase()) perKeyGas.W_ens += r.gas;
      else if (f === W_OP.toLowerCase()) perKeyGas.W_op += r.gas;
    });
    // D-1 + D-1r ＝ 審査員ボタンの押下1回
    const press = (rs.find(r => r.id === 'D-1')?.gas ?? 0) + (rs.find(r => r.id === 'D-1r')?.gas ?? 0);
    OUT.press_gas_measured = press;
    push('PRESS gas (D-1 + D-1r)', press === PRESS_GAS ? 'OK' : 'NG', `${press} / 正典 ${PRESS_GAS}`, press);
  }

  // ===== 5b. seller-d 一式（K1-D1〜K1-D5・§4）と BS-03 の送金 =====
  // 元: guards/sellerd.mjs。**W_ens の関門はこれを足さないと 1,178,390 ぶん少なく見える。**
  {
    const MOCK_USDC = '0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e';
    const DUR = 31536000n; // 1年
    const SECRET = keccak256(toBytes('tokyo-2026/seller-d/secret'));
    const REF = '0x' + '00'.repeat(32);
    const rg = (f, a) => encodeFunctionData({ abi: ABI.RG, functionName: f, args: a });
    const erc20 = (f, a) => encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: f, args: a });
    const commitment = await c0.readContract({ address: A.rg, abi: ABI.RG, functionName: 'makeCommitment', args: ['seller-d', W_ENS, SECRET, ZERO, ZERO, DUR, REF], blockNumber: B });
    const isAvail = await c0.readContract({ address: A.rg, abi: ABI.RG, functionName: 'isAvailable', args: ['seller-d'], blockNumber: B });
    const minAge = Number(await c0.readContract({ address: A.rg, abi: ABI.RG, functionName: 'MIN_COMMITMENT_AGE', args: [], blockNumber: B }));
    const OFFER_D = mkOffer('10000', W_ENS);
    const SALT_D = BigInt(keccak256(toBytes('tokyo-2026/seller-d.eth')));
    const initD = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
      pr('setText', [dns('seller-d.eth'), 'x402-offer', OFFER_D]),
      pr('setText', [dns('seller-d.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']),
      pr('setAddress', [dns('seller-d.eth'), 60n, W_ENS])]]);
    const P_D = viem.getAddress('0x' + (await c0.call({ account: W_ENS, to: A.vf, data: dep(A.impl, SALT_D, initD), blockNumber: B })).data.slice(26));
    const TID_D = (await c0.readContract({ address: A.er, abi: ABI.ER, functionName: 'getState', args: [BigInt(labelhash('seller-d'))], blockNumber: B })).tokenId;
    push('ADDR P_d', 'OK', P_D);
    push('SELLER-D isAvailable', isAvail ? 'OK' : 'NG', String(isAvail));
    push('SELLER-D MIN_COMMITMENT_AGE', minAge === 60 ? 'OK' : 'NG', String(minAge));
    // commit と register は別ブロック（MIN_COMMITMENT_AGE = 60 秒）
    const ids = [['K1-D1 approve', 'K1-D1 commit'],
      ['K1-D1 register', 'K1-D2 deployProxy(P_d)', 'K1-D3 setResolver', 'K1-D4 grantSetterRoles(W_op)', 'K1-D5 B5b-d setText(att)']];
    const { blocks } = await simulateBlocks([
      { calls: [{ from: W_ENS, to: MOCK_USDC, data: erc20('approve', [A.rg, (1n << 255n)]) },
        { from: W_ENS, to: A.rg, data: rg('commit', [commitment]) }] },
      { blockOverrides: { time: toHex(NOW + 180) }, calls: [
        { from: W_ENS, to: A.rg, data: rg('register', ['seller-d', W_ENS, SECRET, ZERO, ZERO, DUR, MOCK_USDC, REF]) },
        { from: W_ENS, to: A.vf, data: dep(A.impl, SALT_D, initD) },
        { from: W_ENS, to: A.er, data: er('setResolver', [TID_D, P_D]) },
        { from: W_ENS, to: P_D, data: pr('grantSetterRoles', [pr('setText', [dns('seller-d.eth'), 'x402-offer', '']), W_OP]) },
        { from: W_ENS, to: P_D, data: pr('setText', [dns('seller-d.eth'), ATT_KEY, ENV]) }] },
    ], B, [url, ...SIM_RPC_LIST.filter(u => u !== url)]);
    let dTotal = 0;
    const dRows = [];
    blocks.forEach((blkRes, bi) => blkRes.calls.forEach((c, i) => {
      const gas = parseInt(c.gasUsed, 16);
      const ok = c.status === '0x1';
      const rid = ids[bi][i];
      if (ok) dTotal += gas;
      log(`   ${rid} ${ok ? 'OK' : 'REVERT'} gas=${gas} ${ok ? '' : decErr(c.error?.data ?? c.returnData)}`);
      push(rid, ok ? 'OK' : 'REVERT', ok ? 'ok' : decErr(c.error?.data ?? c.returnData), gas);
      dRows.push({ id: rid, status: ok ? 'OK' : 'REVERT', gas });
    }));
    push('BS-03 W_ens→W_op 0.05 ETH 送金', 'OK', String(BS03_TRANSFER_GAS), BS03_TRANSFER_GAS);
    perKeyGas.W_ens += dTotal + BS03_TRANSFER_GAS;
    OUT.seller_d = { P_D, isAvailable: isAvail, minCommitmentAge: minAge, rows: dRows, total_W_ens: dTotal };
    log(`5b. seller-d 一式 合計 ${dTotal}（＋ BS-03 ${BS03_TRANSFER_GAS}）`);
    push('SELLER-D 合計', 'OK', String(dTotal), dTotal);
  }

  // ===== 6. 1バイトあたりの感度（K1-04）=====
  {
    const sens = [];
    for (const extra of [0, 1, 8, 16, 32, 64]) {
      const off = mkOffer('10000', W_ENS).replace('"observed_at"', '"observed_at' + 'x'.repeat(extra) + '"');
      const init = pr('initialize', [[{ account: W_ENS, roleBitmap: ALL_ROLES }], [
        pr('setText', [dns('seller-a.eth'), 'x402-offer', off]),
        pr('setText', [dns('seller-a.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo/seller']),
        pr('setAddress', [dns('seller-a.eth'), 60n, W_ENS])]]);
      const { calls } = await simulate([{ from: W_ENS, to: A.vf, data: dep(A.impl, SALT_A, init) }], B, [url, ...SIM_RPC_LIST.filter(u => u !== url)]);
      sens.push({ offerBytes: Buffer.byteLength(off), gas: parseInt(calls[0].gasUsed, 16), status: calls[0].status });
    }
    OUT.sensitivity_K1_04 = sens;
    log(`6. K1-04 の長さ感度 ${JSON.stringify(sens.map(x => [x.offerBytes, x.gas]))}`);
    push('SENS K1-04 (266B)', sens[0].status === '0x1' ? 'OK' : 'REVERT', sens.map(x => `${x.offerBytes}B:${x.gas}`).join(' '));
  }

  // ===== 7. ガス価格・残高・関門 =====
  {
    const gasPriceWei = await c0.getGasPrice();
    const balances = {
      W_vet: await c0.getBalance({ address: W_VET }),
      W_ens: await c0.getBalance({ address: W_ENS }),
      W_op: process.env.TOKYO_W_OP_ADDRESS ? await c0.getBalance({ address: process.env.TOKYO_W_OP_ADDRESS }) : null,
    };
    const g = evaluateGasBudget({ gasPriceWei, balances,
      addresses: { W_vet: W_VET, W_ens: W_ENS, W_op: process.env.TOKYO_W_OP_ADDRESS || null },
      bs03Sent: process.env.TOKYO_BS03_SENT === '1' });
    OUT.gas_budget = g;
    OUT.per_key_measured = perKeyGas;
    log(`7. gasPrice=${g.gasPrice.gwei} gwei / 関門 ok=${g.ok} / 実測合計 ${JSON.stringify(perKeyGas)}`);
    push('GASPRICE gwei', 'OK', String(g.gasPrice.gwei));
    // 実測合計が関門を超えていないか（**関門の数字は lib/gas-budget.mjs だけが持つ**）
    for (const k of KEYS) {
      const measured = perKeyGas[k];
      const within = measured <= GAS_BUDGET[k];
      push(`BUDGET ${k} measured<=budget`, within ? 'OK' : 'NG', `${measured} <= ${GAS_BUDGET[k]}`, measured);
      const pk = g.per_key[k];
      push(`BUDGET ${k} balance`, pk.ok ? 'OK' : (pk.status === 'skipped' ? 'SKIP' : 'NG'),
        pk.status === 'skipped' ? 'skipped（アドレス未確定）' : `残高 ${pk.balance_eth} ETH / 必要 ${pk.need_eth} ETH / 尽きる ${pk.headroom_gwei} gwei`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'gas.json'), JSON.stringify(OUT, (k, v) => typeof v === 'bigint' ? v.toString() : v, 1) + '\n');
  log(`out/gas.json に書いた`);

  return {
    meta: { rpc: url, block: B.toString(), now: NOW,
      real_k1_total: OUT.k1_real_dummykeys.total, old_k1_total: OUT.repro_old_sim.total,
      per_key_measured: perKeyGas, gas_budget_ok: OUT.gas_budget.ok, gasPrice_gwei: OUT.gas_budget.gasPrice.gwei,
      safety: GAS_SAFETY, w_op_floor_wei: W_OP_FLOOR_WEI.toString(), bs03_wei: BS03_WEI.toString() },
    rows,
  };
}
