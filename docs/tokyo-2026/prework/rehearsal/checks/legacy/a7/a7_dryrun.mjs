// A7: K1 の書き込みを eth_call だけで練習する（署名・送信なし）。
// 使い方: node a7_dryrun.mjs  → 標準出力に表、a7_result.json に詳細
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, http, encodeFunctionData, decodeErrorResult, decodeFunctionResult,
  namehash, labelhash, keccak256, encodeAbiParameters, concat, getContractAddress, parseAbiItem,
} from 'viem';
import { packetToBytes } from 'viem/ens';
import { sepolia } from 'viem/chains';

const DIR = new URL('.', import.meta.url).pathname;
const abiOf = (n) => JSON.parse(readFileSync(DIR + 'abi/' + n + '.json', 'utf8'));
const FACT = abiOf('VerifiableFactory'), RES = abiOf('PermissionedResolverImpl'), REG = abiOf('ETHRegistry');
const ALL_ERR = [...RES.abi, ...REG.abi, ...FACT.abi].filter((x) => x.type === 'error');

const RPC = 'https://sepolia.gateway.tenderly.co';
const c = createPublicClient({ chain: sepolia, transport: http(RPC) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dns = (name) => '0x' + Buffer.from(packetToBytes(name)).toString('hex');

const W_vet = '0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6';
const W_ens = '0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
const HCA_vet = '0x7070479db048594BEa8eC9e61f3370558e96ADA3';
const R_vet = '0xf8E7782d205fEf6f54767918534FF78B1d726Bfc';
const R_sel = '0xea7705C3A68576EfD806D61CC57a67Fe49a6Be91';
const FACTORY = FACT.address, IMPL = RES.address, ETHREG = REG.address;
// 会期中に作る鍵の代わり（ロールを何も持たないダミー）
const K_atst = '0x000000000000000000000000000000000000a757';
const W_obs = '0x0000000000000000000000000000000000000b55';
const W_op = '0x0000000000000000000000000000000000000095';
const STRANGER = '0x00000000000000000000000000000000deadbeef';
const ALL_ROLES = BigInt('0x' + '1'.repeat(64));
const ROLE_SET_TEXT = 1n << 4n;
const SALT = BigInt(keccak256(new TextEncoder().encode('vet402-tokyo-2026-a7')));

const head = await c.getBlockNumber();
const block = await c.getBlock({ blockNumber: head });
console.log('rpc', RPC, 'block', head.toString(), new Date(Number(block.timestamp) * 1000).toISOString());

async function call({ to, from, data }) {
  await sleep(400);
  try {
    const r = await c.call({ to, account: from, data, blockNumber: head });
    return { ok: true, ret: r.data ?? '0x' };
  } catch (e) {
    let raw = e?.walk?.((x) => x?.data && typeof x.data === 'string')?.data ?? e?.cause?.data ?? null;
    if (raw && typeof raw === 'object') raw = raw.data;
    let name = null, args = null;
    if (typeof raw === 'string' && raw.length >= 10) {
      try { const d = decodeErrorResult({ abi: ALL_ERR, data: raw }); name = d.errorName; args = d.args?.map(String); } catch { name = 'undecoded:' + raw.slice(0, 10); }
    } else if (raw === '0x') name = 'empty revert (0x)';
    return { ok: false, raw, name, args, msg: e.shortMessage };
  }
}
async function read(to, abi, functionName, args) {
  await sleep(300);
  return c.readContract({ address: to, abi, functionName, args, blockNumber: head });
}

// ---- 現在値 ----
const state = {};
const vetState = await read(ETHREG, REG.abi, 'getState', [BigInt(labelhash('vet402'))]);
state.vet402 = { tokenId: vetState.tokenId.toString(16), resource: vetState.resource.toString(16), latestOwner: vetState.latestOwner, expiry: vetState.expiry.toString() };
state.vet402_resolver = await read(ETHREG, REG.abi, 'getResolver', ['vet402']);
state.sellerA_resolver = await read(ETHREG, REG.abi, 'getResolver', ['seller-a']);
state.rolesVetOnRegistry = '0x' + (await read(ETHREG, REG.abi, 'roles', [vetState.resource, W_vet])).toString(16);
state.rolesRootVet = '0x' + (await read(R_vet, RES.abi, 'roles', [0n, W_vet])).toString(16);
state.rolesRootHCAvet = '0x' + (await read(R_vet, RES.abi, 'roles', [0n, HCA_vet])).toString(16);
state.rolesRootEns = '0x' + (await read(R_sel, RES.abi, 'roles', [0n, W_ens])).toString(16);
// 売り手リゾルバの HCA の完全アドレス（EACRolesChanged を登録日前後から拾う）
const ev = parseAbiItem('event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)');
const logs = [];
for (let f = 11705000n; f < 11708000n; f += 1000n) { await sleep(400); logs.push(...(await c.getLogs({ address: R_sel, event: ev, fromBlock: f, toBlock: f + 999n }))); }
state.sellerResolverRootGrants = logs.filter((l) => l.args.resource === 0n).map((l) => ({ block: l.blockNumber.toString(), account: l.args.account, new: '0x' + l.args.newRoleBitmap.toString(16) }));
const HCA_sel = state.sellerResolverRootGrants.map((g) => g.account).find((a) => a.toLowerCase() !== W_ens.toLowerCase());
if (HCA_sel) state.rolesRootHCAsel = '0x' + (await read(R_sel, RES.abi, 'roles', [0n, HCA_sel])).toString(16);
const proxyLogic = await read(FACTORY, FACT.abi, 'proxyLogic', []);
const outerSalt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [W_vet, SALT]));
const predicted = getContractAddress({ bytecode: concat(['0x3d604d80600a3d3981f3363d3d373d3d3d363d73', proxyLogic, '0x5af43d82803e903d91602b57fd5bf3', outerSalt]), from: FACTORY, opcode: 'CREATE2', salt: outerSalt });
state.proxyLogic = proxyLogic; state.predictedProxy = predicted;
state.balances = { W_vet: (await c.getBalance({ address: W_vet, blockNumber: head })).toString(), W_ens: (await c.getBalance({ address: W_ens, blockNumber: head })).toString() };
console.log(JSON.stringify(state, null, 1));

// ---- 8関数 + 追加 ----
const enc = (abi, functionName, args) => encodeFunctionData({ abi, functionName, args });
const initData = enc(RES.abi, 'initialize', [W_vet, ALL_ROLES, []]);
const offer = JSON.stringify({ v: 1, resource: 'https://vet402.com/api/tokyo/seller', method: 'GET', network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '10000', payTo: W_ens });
const cases = [
  { id: '1 deployProxy', to: FACTORY, from: W_vet, data: enc(FACT.abi, 'deployProxy', [IMPL, SALT, initData]), who: 'W_vet' },
  { id: '2 setResolver', to: ETHREG, from: W_vet, data: enc(REG.abi, 'setResolver', [vetState.tokenId, predicted]), who: 'W_vet' },
  { id: '3 grantRootRoles(代用 R_vet)', to: R_vet, from: W_vet, data: enc(RES.abi, 'grantRootRoles', [ROLE_SET_TEXT, W_obs]), who: 'W_vet' },
  { id: '4 setAddr(bytes32,address)', to: R_vet, from: W_vet, data: encodeFunctionData({ abi: RES.abi, functionName: 'setAddr', args: [namehash('atst.vet402.eth'), K_atst] }), who: 'W_vet' },
  { id: '4b setAddr(bytes32,uint256,bytes)', to: R_vet, from: W_vet, data: encodeFunctionData({ abi: RES.abi, functionName: 'setAddr', args: [namehash('atst.vet402.eth'), 60n, K_atst] }), who: 'W_vet' },
  { id: '5 setText', to: R_sel, from: W_ens, data: enc(RES.abi, 'setText', [namehash('seller-a.eth'), 'x402-offer', offer]), who: 'W_ens' },
  { id: '5b multicall(setAddr+setText)', to: R_sel, from: W_ens, data: enc(RES.abi, 'multicall', [[encodeFunctionData({ abi: RES.abi, functionName: 'setAddr', args: [namehash('seller-a.eth'), W_ens] }), enc(RES.abi, 'setText', [namehash('seller-a.eth'), 'x402-offer', offer])]]), who: 'W_ens' },
  { id: '6 authorizeTextRoles', to: R_sel, from: W_ens, data: enc(RES.abi, 'authorizeTextRoles', [dns('seller-a.eth'), 'x402-offer', W_op, true]), who: 'W_ens' },
  { id: '7 setAlias', to: R_sel, from: W_ens, data: enc(RES.abi, 'setAlias', [dns('seller-c.eth'), dns('c-v2.eth')]), who: 'W_ens' },
  { id: '8 clearRecords', to: R_sel, from: W_ens, data: enc(RES.abi, 'clearRecords', [namehash('seller-b.eth')]), who: 'W_ens' },
  // 追記 09-15 の K1 の最初（own-resolver の代わり）
  { id: '+ revokeRootRoles(HCA_vet)', to: R_vet, from: W_vet, data: enc(RES.abi, 'revokeRootRoles', [ALL_ROLES, HCA_vet]), who: 'W_vet' },
  ...(HCA_sel ? [{ id: '+ revokeRootRoles(HCA_sel)', to: R_sel, from: W_ens, data: enc(RES.abi, 'revokeRootRoles', [ALL_ROLES, HCA_sel]), who: 'W_ens' }] : []),
];
// 計器の確かめ: 同じ calldata を権限の無い from で当てて revert するか／W_op（委任前）で setText
const negatives = [
  ...cases.map((k) => ({ ...k, id: 'NEG ' + k.id, from: STRANGER, who: 'STRANGER' })),
  { id: 'NEG W_op setText x402-offer (委任前)', to: R_sel, from: W_op, data: enc(RES.abi, 'setText', [namehash('seller-a.eth'), 'x402-offer', offer]), who: 'W_op' },
];
const out = [];
for (const k of [...cases, ...negatives]) {
  const r = await call(k);
  let ret = null;
  if (r.ok && k.id.startsWith('1 ')) ret = decodeFunctionResult({ abi: FACT.abi, functionName: 'deployProxy', data: r.ret });
  if (r.ok && /grantRootRoles|authorizeTextRoles|revokeRootRoles/.test(k.id)) ret = r.ret === '0x' ? '0x' : BigInt(r.ret) !== 0n;
  const row = { id: k.id, to: k.to, from: k.who, selector: k.data.slice(0, 10), ok: r.ok, ret: ret === null ? (r.ok ? r.ret.slice(0, 66) : null) : String(ret), error: r.name, errorArgs: r.args, msg: r.ok ? null : r.msg };
  out.push(row);
  console.log([row.id, row.to.slice(0, 8), row.from, row.selector, row.ok ? 'OK' : 'REVERT', row.ok ? row.ret : row.error, row.errorArgs ? row.errorArgs.join(',') : ''].join(' | '));
}
writeFileSync(DIR + 'a7_result.json', JSON.stringify({ rpc: RPC, block: head.toString(), timestamp: block.timestamp.toString(), salt: '0x' + SALT.toString(16), state, rows: out }, null, 1));
