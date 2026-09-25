// eth_simulateV1（sentio）で 09-15 配備の PermissionedResolver を「署名なし・送信なし」で通しで動かす
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const v = require('viem');
const { createPublicClient, http, encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, namehash, labelhash, packetToBytes, toHex, keccak256, toBytes, parseAbi, encodeAbiParameters } = v;
const { sepolia } = require('viem/chains');
const RPC = 'https://sepolia.rpc.sentio.xyz';
const c = createPublicClient({ chain: sepolia, transport: http(RPC) });
const L = n => { const d = JSON.parse(fs.readFileSync(`../ur/abi/new_${n}.json`)); return d.abi ?? d; };
const PR = L('PermissionedResolverImpl'), VF = L('VerifiableFactory'), UH = L('UniversalHelper'), ER = L('ETHRegistry'), UR = L('UniversalResolverV2');
const TEXT = parseAbi(['function text(bytes32 node, string key) view returns (string)']);
const ALLERR = [...PR, ...ER, ...UR, ...VF].filter(x => x.type === 'error');
const A = { impl:'0x14f09fd05d4585759e54844dc9b00147131cf243', vf:'0x9e726eb570beb6bceb495ab8cda7df517d4e841c', uh:'0x33f571aa8a160a21b877cf6e0fb8806692b97df5', er:'0x657ea849311d3d5823348dded7c2aaafb3ede09e', ur:'0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe' };
const X = '0xb60EA8C853e8ea9369C372ABEA4Ed4330fbC20A9';   // pandas.eth / sharks.eth の持ち主（実在・なりすましは simulate の中だけ）
const OP = '0x0000000000000000000000000000000000000Op1'.replace('Op1','0a1');
const OP2 = '0x00000000000000000000000000000000000000a2';
const dns = n => '0x' + Buffer.concat([...n.split('.').map(x => Buffer.concat([Buffer.from([Buffer.byteLength(x)]), Buffer.from(x)])), Buffer.from([0])]).toString('hex');
const ALL = BigInt('0x' + '1'.repeat(64));
const ROLE_SET_TEXT = 1n << 4n;
const KEY = 'x402-offer', ATK = 'attestations[x402-offer][atst.vet402.eth]';
const OFFER = '{"v":1,"amount":"10000"}', OFFER1 = '{"v":1,"amount":"10001"}';
const block = await c.getBlockNumber();
const initData = encodeFunctionData({ abi: PR, functionName: 'initialize', args: [[{ account: X, roleBitmap: ALL }], []] });
const salt = BigInt(keccak256(initData));
const deployData = encodeFunctionData({ abi: VF, functionName: 'deployProxy', args: [A.impl, salt, initData] });
const P = decodeFunctionResult({ abi: VF, functionName: 'deployProxy', data: (await c.call({ account: X, to: A.vf, data: deployData, blockNumber: block })).data });
const st = async l => c.readContract({ address: A.er, abi: ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: block });
const sp = await st('pandas'), ss = await st('sharks');
const pr = (fn, args) => encodeFunctionData({ abi: PR, functionName: fn, args });
const urText = (name, key) => encodeFunctionData({ abi: UR, functionName: 'resolve', args: [dns(name), encodeFunctionData({ abi: TEXT, functionName: 'text', args: [namehash(name), key] })] });
const steps = [];
const S = (label, from, to, data, kind) => steps.push({ label, call: { from, to, data }, kind });
S('01 X deployProxy(impl, salt, initialize([(X,ALL_ROLES)],[]))', X, A.vf, deployData, 'vf:deployProxy');
S('02 X ETHRegistry.setResolver(pandas tokenId, P)', X, A.er, encodeFunctionData({ abi: ER, functionName: 'setResolver', args: [sp.tokenId, P] }));
S('03 X ETHRegistry.setResolver(sharks tokenId, P)', X, A.er, encodeFunctionData({ abi: ER, functionName: 'setResolver', args: [ss.tokenId, P] }));
S('04 X multicall[setText(pandas,x402-offer),setText(pandas,attestations…)]', X, P, pr('multicall', [[pr('setText', [dns('pandas.eth'), KEY, OFFER]), pr('setText', [dns('pandas.eth'), ATK, 'ENV_A'])]]));
S('05 X setText(sharks, x402-offer, B)', X, P, pr('setText', [dns('sharks.eth'), KEY, 'OFFER_B']));
S('06 X grantSetterRoles(setText(pandas.eth,"x402-offer",""), OP)', X, P, pr('grantSetterRoles', [pr('setText', [dns('pandas.eth'), KEY, '']), OP]));
S('07 view roles(keccak("x402-offer"), OP)', X, P, pr('roles', [BigInt(keccak256(toBytes(KEY))), OP]), 'pr:roles');
S('08 OP setText(pandas, x402-offer, 10001)', OP, P, pr('setText', [dns('pandas.eth'), KEY, OFFER1]));
S('09 OP setText(sharks, x402-offer, HIJACK)  ← 別の名前', OP, P, pr('setText', [dns('sharks.eth'), KEY, 'HIJACK']));
S('10 OP setText(zz.pandas.eth, x402-offer, W) ← 未登録のサブ名', OP, P, pr('setText', [dns('zz.pandas.eth'), KEY, 'W']));
S('11 OP setText(pandas, attestations…)', OP, P, pr('setText', [dns('pandas.eth'), ATK, 'EVIL']));
S('12 OP grantSetterRoles(setText x402-offer, OP2)', OP, P, pr('grantSetterRoles', [pr('setText', [dns('pandas.eth'), KEY, '']), OP2]));
S('13 OP linkToRecord(pandas, 0)', OP, P, pr('linkToRecord', [dns('pandas.eth'), 0n]));
S('14 UR text(pandas, x402-offer)', X, A.ur, urText('pandas.eth', KEY), 'ur');
S('15 UR text(sharks, x402-offer)', X, A.ur, urText('sharks.eth', KEY), 'ur');
S('16 UR text(zz.pandas.eth, x402-offer)', X, A.ur, urText('zz.pandas.eth', KEY), 'ur');
S('17 UR text(yy.pandas.eth, x402-offer)', X, A.ur, urText('yy.pandas.eth', KEY), 'ur');
S('18 view getRecordId(pandas)', X, P, pr('getRecordId', [namehash('pandas.eth')]), 'pr:getRecordId');
S('19 X linkToNode(sharks, namehash(pandas))', X, P, pr('linkToNode', [dns('sharks.eth'), namehash('pandas.eth')]));
S('20 UR text(sharks, x402-offer) after link', X, A.ur, urText('sharks.eth', KEY), 'ur');
S('21 UR text(sharks, attestations…) after link', X, A.ur, urText('sharks.eth', ATK), 'ur');
S('22 OP setText(sharks, x402-offer, VIA_LINK)', OP, P, pr('setText', [dns('sharks.eth'), KEY, 'VIA_LINK']));
S('23 UR text(pandas, x402-offer) after write via sharks', X, A.ur, urText('pandas.eth', KEY), 'ur');
S('24 X linkToRecord(sharks, 0)', X, P, pr('linkToRecord', [dns('sharks.eth'), 0n]));
S('25 UR text(sharks, x402-offer) after unlink', X, A.ur, urText('sharks.eth', KEY), 'ur');
S('26 X linkToRecord(pandas, 0)  ← clearRecords の代わり', X, P, pr('linkToRecord', [dns('pandas.eth'), 0n]));
S('27 UR text(pandas, x402-offer) after unlink', X, A.ur, urText('pandas.eth', KEY), 'ur');
S('28 UR text(pandas, attestations…) after unlink', X, A.ur, urText('pandas.eth', ATK), 'ur');
S('29 X linkToRecord(pandas, 1)  ← 元に戻す', X, P, pr('linkToRecord', [dns('pandas.eth'), 1n]));
S('30 UR text(pandas, attestations…) after relink', X, A.ur, urText('pandas.eth', ATK), 'ur');
S('31 X linkToNode(sharks, namehash(nonexist.eth))', X, P, pr('linkToNode', [dns('sharks.eth'), namehash('nonexist.eth')]));
S('32 X revokeRoles(keccak(x402-offer), ROLE_SET_TEXT, OP)', X, P, pr('revokeRoles', [BigInt(keccak256(toBytes(KEY))), ROLE_SET_TEXT, OP]));
S('33 OP setText(pandas, x402-offer) after revoke', OP, P, pr('setText', [dns('pandas.eth'), KEY, 'AFTER']));
S('34 X grantRoles(keccak(x402-offer), ROLE_SET_TEXT, OP) ← 無効化された形', X, P, pr('grantRoles', [BigInt(keccak256(toBytes(KEY))), ROLE_SET_TEXT, OP]));
S('35 X grantRootRoles(ROLE_SET_TEXT, OP)', X, P, pr('grantRootRoles', [ROLE_SET_TEXT, OP]));
S('36 OP setText(pandas, attestations…) with root SET_TEXT', OP, P, pr('setText', [dns('pandas.eth'), ATK, 'ROOTWRITE']));
S('37 helper findExactOwner(pandas.eth)', X, A.uh, encodeFunctionData({ abi: UH, functionName: 'findExactOwner', args: [dns('pandas.eth')] }), 'uh:findExactOwner');
S('38 helper findExactOwner(zz.pandas.eth)', X, A.uh, encodeFunctionData({ abi: UH, functionName: 'findExactOwner', args: [dns('zz.pandas.eth')] }), 'uh:findExactOwner');
S('39 helper findNearestOwner(zz.pandas.eth)', X, A.uh, encodeFunctionData({ abi: UH, functionName: 'findNearestOwner', args: [dns('zz.pandas.eth')] }), 'uh:findNearestOwner');
const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: steps.map(s => s.call) }], validation: false }, toHex(block)] };
const res = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
if (res.error) { console.log(JSON.stringify(res.error).slice(0, 800)); process.exit(1); }
const calls = res.result[0].calls;
const evAbi = [...PR, ...ER, ...VF].filter(x => x.type === 'event');
const out = { rpc: RPC, block: block.toString(), P, pandasTokenId: sp.tokenId.toString(), sharksTokenId: ss.tokenId.toString(), steps: [] };
steps.forEach((s, i) => {
  const r = calls[i]; const o = { step: s.label, status: r.status };
  if (r.status === '0x1') {
    try {
      if (s.kind === 'ur') { const [b, resolver] = decodeFunctionResult({ abi: UR, functionName: 'resolve', data: r.returnData }); o.value = decodeFunctionResult({ abi: TEXT, functionName: 'text', data: b }); o.resolver = resolver; }
      else if (s.kind?.startsWith('pr:')) o.value = String(decodeFunctionResult({ abi: PR, functionName: s.kind.slice(3), data: r.returnData }));
      else if (s.kind?.startsWith('uh:')) o.value = String(decodeFunctionResult({ abi: UH, functionName: s.kind.slice(3), data: r.returnData }));
    } catch (e) { o.decodeErr = e.shortMessage; }
    o.events = (r.logs || []).map(l => { try { const d = decodeEventLog({ abi: evAbi, data: l.data, topics: l.topics }); return `${d.eventName} topic0=${l.topics[0].slice(0, 10)} ${JSON.stringify(d.args, (k, x) => typeof x === 'bigint' ? (x > 2n**64n ? '0x' + x.toString(16).slice(0, 12) + '…' : x.toString()) : x)}`; } catch { return `? ${l.topics[0]}`; } });
  } else {
    try { const d = decodeErrorResult({ abi: ALLERR, data: r.error?.data ?? r.returnData }); o.revert = `${d.errorName}(${d.args?.map(a => typeof a === 'bigint' ? '0x' + a.toString(16).slice(0, 12) + (a > 2n**48n ? '…' : '') : a).join(',')})`; } catch { o.revert = JSON.stringify(r.error ?? r.returnData).slice(0, 160); }
  }
  out.steps.push(o);
});
fs.writeFileSync('sim_result.json', JSON.stringify(out, null, 1));
for (const o of out.steps) console.log(o.status, o.step, o.value !== undefined ? '=> ' + JSON.stringify(o.value) : '', o.revert ? 'REVERT ' + o.revert : '', o.events?.length ? '\n     ' + o.events.join('\n     ') : '');
console.log('block', block, 'P', P);
