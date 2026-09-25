// The K1 judgement line of `run.ts census` (PLAN_v4.3 section 4, "K1 の判定コマンド"). Read-only.
// Every read goes through the SDK's readBoth: both Sepolia RPCs at the pinned block, or it throws.
import fs from 'node:fs';
import path from 'node:path';
import { getAddress, keccak256, namehash, parseAbi, toBytes, type Address } from 'viem';
import { DEMO_DIR } from './env.ts';
import { ADDR, W_ENS, W_VET, mkOffer } from './k1.ts';

const EAC = parseAbi([
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function roleCount(uint256 resource) view returns (uint256)',
  'function getRecordId(bytes32 node) view returns (uint256)',
]);
const ALL = BigInt('0x' + '1'.repeat(64));
const ROLE_SET_TEXT = 0x10n;
// On chain since K1 (K1_LOG 2026-09-25). env overrides; the defaults let a reviewer run census without our env file.
const K1_ADDR = {
  P_a: '0xC54403186Db35B9D92cc393Ae665D3960117ac14',
  P_bc: '0xd6A089Fc08e5e97697a3293d02F40837CeA1d2bf',
  P_d: '0x9CF7990dAB364d1738ABB09532b953Ec48269831',
  P_AG1: '0xd3F4818c0bB93e54780525b21380D44D6D06bcd6',
  W_op: '0xE3BB99911A8037F22D4d6b3a4d955D1b02229080',
  K_ag2: '0x6a2bce08AB14123954168C8c030b88FF1c5Bfa97',
} as const satisfies Record<string, Address>;
const OFFERS: Array<[string, string]> = [['seller-a.eth', '10000'], ['seller-b.eth', '20000'], ['seller-c.eth', '30000'], ['seller-d.eth', '10000']];

export type K1Item = { label: string; ok: boolean; got: string };

function pinnedAttester(): Address {
  const f = path.join(DEMO_DIR, 'trusted-attesters.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const a = (j.trustedAttesters ?? []).find((x: any) => x.name === 'atst.vet402.eth');
  return getAddress(a?.address ?? process.env.TOKYO_K_ATST_ADDRESS ?? '0x0000000000000000000000000000000000000000');
}

export async function k1Items(ens: any, clients: any, B: bigint): Promise<K1Item[]> {
  const W_op = getAddress(process.env.TOKYO_W_OP_ADDRESS ?? K1_ADDR.W_op);
  const K_ag2 = getAddress(process.env.TOKYO_K_AG2_ADDRESS ?? K1_ADDR.K_ag2);
  const K_atst = pinnedAttester();
  const read = (to: Address, functionName: 'roles' | 'roleCount' | 'getRecordId', args: any[]) =>
    ens.readBoth(clients, (c: any) => c.readContract({ address: to, abi: EAC, functionName, args, blockNumber: B }), `${functionName}@${to}`) as Promise<bigint>;
  const hex = (x: bigint) => (x === ALL ? 'ALL' : '0x' + x.toString(16));
  const kOffer = BigInt(keccak256(toBytes('x402-offer')));
  const kPolicy = BigInt(keccak256(toBytes('x402-policy')));
  const items: K1Item[] = [];
  const push = (label: string, ok: boolean, got: string) => items.push({ label, ok, got });

  const rv = await read(ADDR.rVet, 'roles', [0n, W_VET]);
  push('root(R_vet) W_vet=ALL', rv === ALL, `W_vet=${hex(rv)} (K1-01 not sent: the pre-K1 smart account owned by W_vet keeps its roles)`);
  for (const p of ['P_a', 'P_bc', 'P_d'] as const) {
    const [e, v, o] = await Promise.all([read(K1_ADDR[p], 'roles', [0n, W_ENS]), read(K1_ADDR[p], 'roles', [0n, W_VET]), read(K1_ADDR[p], 'roles', [0n, W_op])]);
    push(`root(${p})=W_ens`, e === ALL && v === 0n && o === 0n, `W_ens=${hex(e)} W_vet=${hex(v)} W_op=${hex(o)}`);
  }
  for (const p of ['P_a', 'P_d'] as const) {
    const r = await read(K1_ADDR[p], 'roles', [kOffer, W_op]);
    push(`${p}.roles(keccak(x402-offer), W_op)=0x10`, r === ROLE_SET_TEXT, hex(r));
  }
  const cnt = await read(K1_ADDR.P_bc, 'roleCount', [kOffer]);
  push('P_bc.roleCount(keccak(x402-offer))=0', cnt === 0n, hex(cnt));
  const [ra, rb, rc] = await Promise.all([
    read(K1_ADDR.P_a, 'getRecordId', [namehash('seller-a.eth')]),
    read(K1_ADDR.P_bc, 'getRecordId', [namehash('seller-b.eth')]),
    read(K1_ADDR.P_bc, 'getRecordId', [namehash('seller-c.eth')]),
  ]);
  push('recordIds a/b/c distinct', ra > 0n && rb === 1n && rc === 2n, `a=P_a#${ra} b=P_bc#${rb} c=P_bc#${rc}`);
  const atst = await ens.resolveAddr(clients, B, 'atst.vet402.eth');
  push('atst.vet402.eth -> K_atst', atst.value === K_atst, `${atst.value ?? '(none)'} (pinned ${K_atst})`);
  const pol = await ens.resolveText(clients, B, 'agent-1.vet402.eth', 'x402-policy');
  push('agent-1 policy readable via P_AG1', !!pol.value && pol.resolver === getAddress(K1_ADDR.P_AG1), `${new TextEncoder().encode(pol.value).length} B via ${pol.resolver ?? '-'}`);
  const vp = await ens.resolveText(clients, B, 'vet402.eth', 'x402-policy');
  push('vet402.eth x402-policy empty', vp.value === '', JSON.stringify(vp.value.slice(0, 40)));
  const kag2 = await read(ADDR.rVet, 'roles', [kPolicy, K_ag2]);
  push('R_vet.roles(keccak(x402-policy), K_ag2)=0x10', kag2 === ROLE_SET_TEXT, hex(kag2));
  const obsName = keccak256(toBytes('x')).slice(2) + '.obs.vet402.eth';
  const obs = await ens.resolveText(clients, B, obsName, 'class');
  const viaRvet = atst.resolver === ADDR.rVet && obs.resolver === ADDR.rVet;
  push('atst/obs still resolve via R_vet', viaRvet, `atst via ${atst.resolver ?? '-'}, <hash>.obs via ${obs.resolver ?? '-'}`);
  const bad: string[] = [];
  for (const [n, amount] of OFFERS) {
    const v = await ens.resolveText(clients, B, n, 'x402-offer');
    if (v.value !== mkOffer(amount, W_ENS)) bad.push(n);
  }
  push('4 offers match on 2 RPCs', bad.length === 0, bad.length ? `differ: ${bad.join(', ')}` : 'a/b/c/d = the 266-byte offers (amount 10000/20000/30000/10000)');
  return items;
}

/** "K1 ok: …" when every item holds, else "K1 NG: …" naming the items that did not. */
export function k1Line(items: K1Item[]): string {
  const bad = items.filter(i => !i.ok);
  if (!bad.length) return `K1 ok: ${items.map(i => i.label).join(', ')}`;
  return `K1 NG: ${bad.map(i => `${i.label} (got ${i.got})`).join('; ')}`;
}
