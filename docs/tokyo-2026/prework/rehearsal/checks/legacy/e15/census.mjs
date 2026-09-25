import fs from 'fs';
import { viem, ABI, A, W_VET, W_ENS, RPC_S, RPC_P, dns, J, client, ALL_ROLES, RD } from '../../../lib/common.mjs';
const { labelhash, namehash, keccak256, toBytes, encodeFunctionData, decodeFunctionResult } = viem;

const c0 = client(RPC_S), c1 = client(RPC_P);
const B = (await Promise.all([c0.getBlockNumber(), c1.getBlockNumber()])).reduce((a, b) => a < b ? a : b) - 3n;
const out = { generated: new Date().toISOString(), block: B.toString(), rpc: [RPC_S, RPC_P], rows: [], names: {}, resolvers: {} };

const R = async (c, address, abi, functionName, args = [], account) => {
  try { return J(await c.readContract({ address, abi, functionName, args, blockNumber: B, ...(account ? { account } : {}) })); }
  catch (e) { return 'ERR:' + (e.shortMessage || e.message).split('\n')[0].slice(0, 160); }
};
const both = async (label, address, abi, fn, args = [], account) => {
  const [a, b] = await Promise.all([R(c0, address, abi, fn, args, account), R(c1, address, abi, fn, args, account)]);
  const row = { label, sentio: a, match: a === b, pandaops: a === b ? '(same)' : b };
  out.rows.push(row); console.log(label, '|', a, a === b ? '[2系統一致]' : '| pandaops: ' + b);
  return a;
};

// --- 配備の同定（E1）---
await both('UR.ROOT_REGISTRY()', A.ur, ABI.UR, 'ROOT_REGISTRY');
await both('UH.ROOT_REGISTRY()', A.uh, ABI.UH, 'ROOT_REGISTRY');
await both('Root.getSubregistry("eth")', A.root, ABI.ROOT, 'getSubregistry', ['eth']);
await both('impl.supportsInterface(0x8c2427cc)', A.impl, ABI.PR, 'supportsInterface', ['0x8c2427cc']);
await both('impl.supportsInterface(0x91413117 旧)', A.impl, ABI.PR, 'supportsInterface', ['0x91413117']);
await both('UR.isENSv2()', A.ur, ABI.UR, 'isENSv2');

const NAMES = [['vet402', W_VET], ['seller-a', W_ENS], ['seller-b', W_ENS], ['seller-c', W_ENS], ['pandas', null]];
for (const [label, expOwner] of NAMES) {
  const n = label + '.eth';
  const o = { name: n, expectedOwner: expOwner };
  o.isAvailable = await both(`registrar.isAvailable(${label})`, A.rg, ABI.RG, 'isAvailable', [label]);
  o.getState = await both(`ETHRegistry.getState(labelhash(${label}))`, A.er, ABI.ER, 'getState', [BigInt(labelhash(label))]);
  o.findExactOwner = await both(`UH.findExactOwner(${n})`, A.uh, ABI.UH, 'findExactOwner', [dns(n)]);
  o.findNearestOwner = await both(`UH.findNearestOwner(${n})`, A.uh, ABI.UH, 'findNearestOwner', [dns(n)]);
  o.resolver = await both(`ETHRegistry.getResolver("${label}")`, A.er, ABI.ER, 'getResolver', [label]);
  o.urFindResolver = await both(`UR.findResolver(${n})`, A.ur, ABI.UR, 'findResolver', [dns(n)]);
  try {
    const st = JSON.parse(o.getState);
    o.tokenId = st.tokenId ?? st[0]; o.resource = st.resource ?? st[1]; o.status = st.status; o.latestOwner = st.latestOwner; o.expiry = st.expiry;
    if (o.resource !== undefined && expOwner) {
      o.registryRolesOfOwner = await both(`ETHRegistry.roles(resource(${label}), owner)`, A.er, ABI.ER, 'roles', [BigInt(o.resource), expOwner]);
      o.registryRoleCount = await both(`ETHRegistry.roleCount(resource(${label}))`, A.er, ABI.ER, 'roleCount', [BigInt(o.resource)]);
      o.registryOnlyAssignee = await both(`ETHRegistry.isOnlyAssignee(resource(${label}), ALL, owner)`, A.er, ABI.ER, 'isOnlyAssignee', [BigInt(o.resource), ALL_ROLES, expOwner]);
    }
  } catch {}
  out.names[n] = o;
}

// --- リゾルバごとの計数 ---
const resolverSet = {};
for (const [k, v] of Object.entries(out.names)) { const r = (v.resolver || '').replace(/"/g, ''); if (/^0x[0-9a-fA-F]{40}$/.test(r) && r !== '0x0000000000000000000000000000000000000000') (resolverSet[r.toLowerCase()] ??= []).push(k); }
out.resolverSharing = resolverSet;
console.log('\n--- リゾルバの共有 ---', JSON.stringify(resolverSet, null, 1));

const EAC = ABI.PR.find(x => x.type === 'event' && x.name === 'EACRolesChanged');
const RESARG = ABI.PR.find(x => x.type === 'event' && x.name === 'ResourceArgument');
const FROM_BLOCK = 11700000n;
const getLogsChunked = async (c, address, event, args, fromBlock) => {
  const res = []; const STEP = 20000n;
  for (let f = fromBlock; f <= B; f += STEP) {
    const t = (f + STEP - 1n) < B ? (f + STEP - 1n) : B;
    try { res.push(...await c.getLogs({ address, event, args, fromBlock: f, toBlock: t })); }
    catch (e) { res.push({ ERR: (e.shortMessage || e.message).slice(0, 120), range: [f.toString(), t.toString()] }); }
  }
  return res;
};

for (const r of Object.keys(resolverSet)) {
  const ro = { address: r, names: resolverSet[r] };
  ro.supportsInterface_new = await both(`resolver(${r}).supportsInterface(0x8c2427cc)`, r, ABI.PR, 'supportsInterface', ['0x8c2427cc']);
  ro.supportsInterface_old = await both(`resolver(${r}).supportsInterface(0x91413117)`, r, ABI.PR, 'supportsInterface', ['0x91413117']);
  ro.getRecordCount = await both(`resolver(${r}).getRecordCount()`, r, ABI.PR, 'getRecordCount');
  ro.rootRoleCount = await both(`resolver(${r}).roleCount(0)`, r, ABI.PR, 'roleCount', [0n]);
  ro.verifyContract = await both(`VF.verifyContract(${r})`, A.vf, ABI.VF, 'verifyContract', [r]);
  const logs = await getLogsChunked(c0, r, EAC, { resource: 0n }, FROM_BLOCK);
  ro.rootRoleLog = logs.map(l => l.ERR ? l : ({ block: l.blockNumber?.toString(), tx: l.transactionHash, account: l.args?.account, old: '0x' + (l.args?.oldRoleBitmap ?? 0n).toString(16), new: '0x' + (l.args?.newRoleBitmap ?? 0n).toString(16) }));
  const holders = [...new Set(logs.filter(l => l.args && l.args.newRoleBitmap > 0n).map(l => l.args.account))];
  ro.rootHoldersFromLogs = holders;
  ro.rootHoldersNow = {};
  for (const h of holders) ro.rootHoldersNow[h] = await R(c0, r, ABI.PR, 'roles', [0n, h]);
  const resArgLogs = await getLogsChunked(c0, r, RESARG, {}, FROM_BLOCK);
  ro.resourceArguments = resArgLogs.map(l => l.ERR ? l : ({ block: l.blockNumber?.toString(), resource: l.args?.resource?.toString(), arg: l.args?.arg }));
  const allEac = await getLogsChunked(c0, r, EAC, {}, FROM_BLOCK);
  ro.allEacRolesChanged = allEac.map(l => l.ERR ? l : ({ block: l.blockNumber?.toString(), resource: '0x' + (l.args?.resource ?? 0n).toString(16), account: l.args?.account, new: '0x' + (l.args?.newRoleBitmap ?? 0n).toString(16) }));
  for (const nm of resolverSet[r]) {
    ro[`getRecordId(${nm})`] = await both(`resolver(${r}).getRecordId(namehash(${nm}))`, r, ABI.PR, 'getRecordId', [namehash(nm)]);
  }
  out.resolvers[r] = ro;
}

// --- 既定で書かれている記録（UR 経由の resolve）---
const readVia = async (name, fn, args) => {
  const data = encodeFunctionData({ abi: RD, functionName: fn, args });
  try {
    const v = await c0.readContract({ address: A.ur, abi: ABI.UR, functionName: 'resolve', args: [dns(name), data], blockNumber: B });
    const inner = v[0];
    if (!inner || inner === '0x') return '(empty)';
    return J(decodeFunctionResult({ abi: RD, functionName: fn, args: fn === 'addr' ? args : undefined, data: inner }));
  } catch (e) { return 'ERR:' + (e.shortMessage || e.message).split('\n')[0].slice(0, 140); }
};
out.defaultRecords = {};
for (const [label] of NAMES) {
  const n = label + '.eth';
  out.defaultRecords[n] = {
    'addr(node)': await readVia(n, 'addr', [namehash(n)]),
    'text:x402-offer': await readVia(n, 'text', [namehash(n), 'x402-offer']),
    'text:description': await readVia(n, 'text', [namehash(n), 'description']),
    'text:avatar': await readVia(n, 'text', [namehash(n), 'avatar']),
  };
  console.log('records', n, JSON.stringify(out.defaultRecords[n]));
}

fs.writeFileSync(new URL('../../../out/census_result.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('\nwrote census_result.json  block=', B.toString());
