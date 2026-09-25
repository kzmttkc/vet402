/* eslint-disable @typescript-eslint/no-explicit-any -- ETHGlobal Tokyo 2026: viem ABI helpers and JSON from RPCs are loosely typed here; behaviour is pinned by tests. */
// K1 calldata. One place builds every tx that admin.ts can send, in the order a human sends them.
// Source of truth: PLAN_v4.3 section 4 (K1 table) and the rehearsal (rehearsal/checks/k1.mjs, gas.mjs),
// which simulates the same calldata with eth_simulateV1. Addresses, salts, strings and role bits are
// copied from there unchanged.
//
// Not here on purpose:
//   - K1-01 (removing root roles from our own smart account on R_vet) was dropped on 2026-09-24.
//   - grantSetterRoles inside initialize(): it reverts the whole deployment (sim E12). assertNoGrantInInit() refuses it.
//   - Any UserRegistry call other than register(): setResolver / unregister on the reserved labels
//     `atst` and `obs` would let the names resolve elsewhere. guardUserRegistryCall() refuses them.
import {
  createPublicClient, decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAddress, http, keccak256, labelhash, namehash,
  toBytes, toFunctionSelector, type Address, type Hex, type PublicClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import { ER, ERC20, PR, RG, UR, URI, VF } from './abi.ts';

// ---- ENSv2 Sepolia, 2026-09-15 deployment [AGENT_PROMPTS section 12 / PLAN section 10] ----
const A = (a: string): Address => getAddress(a.toLowerCase());
export const ADDR = {
  er: A('0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E'),
  rg: A('0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca'),
  impl: A('0x14F09Fd05d4585759e54844DC9B00147131Cf243'),
  vf: A('0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C'),
  ur: A('0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe'),
  userRegistryImpl: A('0xa80338aaa8d23831cea25e858d1774534abb0263'),
  mockUsdc: A('0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e'),
  rVet: A('0x3368219EDdFdd1faC6409Fb9A1b8bF7D21598391'),
} as const;

export const W_VET: Address = '0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6';
export const W_ENS: Address = '0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
/** seller-e.eth payTo. Intercepta returns toxicScore 100 / known_scammer for it [ORDERS_ADDENDUM_0925 B-5]. */
export const SELLER_E_PAYTO: Address = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';
export const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const ZERO: Address = '0x0000000000000000000000000000000000000000';
export const SEPOLIA_CHAIN_ID = 11155111;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

// Stand-in addresses used by dry-run only when keys.ts has not written the real ones yet.
// Same values as the rehearsal, so the dry-run gas is comparable. Never used by --live.
export const DUMMY = {
  K_atst: '0x41000000000000000000000000000000000000a7',
  W_obs: '0x00000000000000000000000000000000000000b1',
  W_op: '0x00000000000000000000000000000000000000a1',
  W_pay: '0x00000000000000000000000000000000000000c3',
  K_ag1: '0x41000000000000000000000000000000000000c1',
  K_ag2: '0x41000000000000000000000000000000000000c2',
} as const satisfies Record<string, Address>;
export type Roles = { -readonly [K in keyof typeof DUMMY]: Address };

// ---- roles ----
export const ALL_ROLES = BigInt('0x' + '1'.repeat(64));
export const ROLE_RENEW = 1n << 16n;
export const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;

// ---- strings (PLAN_v4.3 section 3.3.1: offer 266 bytes / section 3.5.1: policy 178 bytes) ----
export const OFFER_BYTES = 266;
export const POLICY_BYTES = 178;
export const ATT_KEY = 'attestations[x402-offer][atst.vet402.eth]';
export const SELLER_ENDPOINT = 'https://vet402.com/api/tokyo/seller';
export const mkOffer = (amount: string, payTo: Address): string =>
  `{"v":1,"resource":"${SELLER_ENDPOINT}","method":"GET","network":"eip155:84532","asset":"${USDC_BASE_SEPOLIA}","amount":"${amount}","payTo":"${payTo}","output":{"required":["result","observed_at"]}}`;
export const mkPolicy = (max = '50000', maxAgeSeconds = 86400): string =>
  `{"v":1,"network":"eip155:84532","trust":["atst.vet402.eth"],"floors":{"minEnsAttestations":1,"minChainReceipts":1},"requireVet402Allow":false,"max":"${max}","maxAgeSeconds":${maxAgeSeconds}}`;
export const OBS_KEYS = ['class', 'description', 'x402.resource', 'x402.method', 'x402.l2', 'x402.declaration-sha256', 'x402.response-sha256', 'x402.purchase', 'x402.purchase-block', 'x402.observed-at', 'x402.source', 'x402.rerun', 'x402.pipeline-commit', 'x402.attested-name', 'x402.attested-t'];
/** Same length as a real ENSIP-29 envelope (79 bytes -> 108 base64 chars). Dry-run only. */
export const DUMMY_ENVELOPE_B64 = Buffer.from(Array.from({ length: 79 }, (_, i) => (i * 37 + 11) & 0xff)).toString('base64');

export const RESERVED_LABELS = ['atst', 'obs'] as const;
export const REGISTRATION_SECONDS = 31_536_000n; // 1 year
export const COMMIT_WAIT_MARGIN_S = 5;
export const AGENT_EXPIRY_DAYS = 30;

// Amounts. Testnet only. Overridable from env so nobody edits code in the morning.
export const amounts = () => ({
  wObsFundWei: BigInt(process.env.TOKYO_K1A_W_OBS_FUND_WEI ?? '10000000000000000'),   // 0.01 Sepolia ETH
  bs03Wei: BigInt(process.env.TOKYO_BS03_WEI ?? '50000000000000000'),                  // 0.05 Sepolia ETH (BS-03)
  bs01UsdcUnits: BigInt(process.env.TOKYO_BS01_USDC_UNITS ?? '5000000'),               // 5 USDC (6 decimals)
  bs01EthWei: BigInt(process.env.TOKYO_BS01_ETH_WEI ?? '1000000000000000'),            // 0.001 Base Sepolia ETH
  bs02UsdcUnits: BigInt(process.env.TOKYO_BS02_USDC_UNITS ?? '10000'),                 // 0.01 USDC = SEED_TX
});

// ---- encoders ----
export const dns = (n: string): Hex => ('0x' + Buffer.concat([
  ...n.split('.').map(x => Buffer.concat([Buffer.from([Buffer.byteLength(x)]), Buffer.from(x)])), Buffer.from([0]),
]).toString('hex')) as Hex;
const pr = (functionName: any, args: any): Hex => encodeFunctionData({ abi: PR, functionName, args } as any);
const er = (functionName: any, args: any): Hex => encodeFunctionData({ abi: ER, functionName, args } as any);
const rg = (functionName: any, args: any): Hex => encodeFunctionData({ abi: RG, functionName, args } as any);
const usr = (functionName: any, args: any): Hex => encodeFunctionData({ abi: URI, functionName, args } as any);
export const urv = (functionName: any, args: any): Hex => encodeFunctionData({ abi: UR, functionName, args } as any);
const erc20 = (functionName: any, args: any): Hex => encodeFunctionData({ abi: ERC20, functionName, args } as any);

const GRANT_SELECTOR = toFunctionSelector('function grantSetterRoles(bytes setter, address account)');

/** A grantSetterRoles call inside initialize() reverts the whole deployment (sim E12). Refuse to build it. */
export function assertNoGrantInInit(calls: Hex[]): void {
  for (const c of calls) {
    if (c.slice(0, 10).toLowerCase() === GRANT_SELECTOR) throw new Error('grantSetterRoles を initialize の calls に入れない（配備ごと revert する・E12）');
    if (c.slice(0, 10).toLowerCase() === toFunctionSelector('function multicall(bytes[] calls)')) {
      const { args } = decodeFunctionData({ abi: PR, data: c });
      assertNoGrantInInit((args as any)[0] as Hex[]);
    }
  }
}
const resolverInit = (owner: Address, calls: Hex[]): Hex => {
  assertNoGrantInInit(calls);
  return pr('initialize', [[{ account: owner, roleBitmap: ALL_ROLES }], calls]);
};
const deployProxy = (impl: Address, salt: bigint, init: Hex): Hex => encodeFunctionData({ abi: VF, functionName: 'deployProxy', args: [impl, salt, init] });

/**
 * The only UserRegistry calls admin.ts may build are initialize() and register().
 * register() on a reserved label must be the reservation itself: owner W_vet, no subregistry, no resolver.
 */
export function guardUserRegistryCall(data: Hex): void {
  const { functionName, args } = decodeFunctionData({ abi: URI, data });
  if (functionName === 'initialize') return;
  if (functionName !== 'register') throw new Error(`UserRegistry への ${functionName} は admin.ts から打たない`);
  const [label, owner, registry, resolver] = args as unknown as [string, Address, Address, Address];
  if ((RESERVED_LABELS as readonly string[]).includes(label)) {
    const isReservation = owner.toLowerCase() === W_VET.toLowerCase() && registry === ZERO && resolver === ZERO;
    if (!isReservation) throw new Error(`"${label}" は予約ラベル。resolver=0・registry=0・owner=W_vet の予約以外で register しない`);
  }
}

// ---- the plan ----
export type Cmd = 'register-d' | 'k1a' | 'deploy-resolvers' | 'k1b' | 'agents' | 'agents-post' | 'register-e' | 'set-offer-e';
export type Step = {
  id: string;
  cmd: Cmd;
  signer: 'W_vet' | 'W_ens';
  from: Address;
  to: Address;
  data?: Hex;
  value?: bigint;
  /** 0 = first block, 1 = at least MIN_COMMITMENT_AGE later (after the commits). */
  block: 0 | 1;
  what: string;
};
/** A read placed inside the simulated chain. Checked, never sent, not counted in gas. */
export type Check = { id: string; afterStep: string; to: Address; data: Hex; expect: (ret: Hex) => string | null };

export type Ctx = {
  block: bigint;
  now: number;
  roles: Roles;
  rolesAreDummy: string[];
  tid: Record<string, bigint>;
  predicted: { P_a: Address; P_bc: Address; P_d: Address; U: Address; P_AG1: Address };
  commitment: { d: Hex; e: Hex };
  expiry: bigint;
  strings: { offerA: string; offerB: string; offerC: string; offerD: string; offerE: string; policy: string };
  init: { a: Hex; bc: Hex; d: Hex; u: Hex; ag1: Hex };
};

export const SALT = {
  a: BigInt(keccak256(toBytes('tokyo-2026/seller-a.eth'))),
  bc: BigInt(keccak256(toBytes('tokyo-2026/seller-bc.eth'))),
  d: BigInt(keccak256(toBytes('tokyo-2026/seller-d.eth'))),
  u: BigInt(keccak256(toBytes('tokyo-2026/agents.vet402.eth'))),
  ag1: BigInt(keccak256(toBytes('tokyo-2026/agent-1.vet402.eth'))),
};
export const COMMIT_SECRET = {
  d: keccak256(toBytes('tokyo-2026/seller-d/secret')),
  e: keccak256(toBytes('tokyo-2026/seller-e/secret')),
};

export const client = (url: string): PublicClient => createPublicClient({ chain: sepolia, transport: http(url, { timeout: 60_000 }) }) as PublicClient;

export async function buildCtx(c: PublicClient, roles: Roles, rolesAreDummy: string[], blockNumber?: bigint): Promise<Ctx> {
  const B = blockNumber ?? (await c.getBlockNumber()) - 3n;
  const now = Number((await c.getBlock({ blockNumber: B })).timestamp);
  const tid: Record<string, bigint> = {};
  for (const l of ['vet402', 'seller-a', 'seller-b', 'seller-c', 'seller-d', 'seller-e']) {
    tid[l] = (await c.readContract({ address: ADDR.er, abi: ER, functionName: 'getState', args: [BigInt(labelhash(l))], blockNumber: B }) as any).tokenId;
  }
  const strings = {
    offerA: mkOffer('10000', W_ENS), offerB: mkOffer('20000', W_ENS), offerC: mkOffer('30000', W_ENS),
    offerD: mkOffer('10000', W_ENS), offerE: mkOffer('10000', SELLER_E_PAYTO), policy: mkPolicy('50000'),
  };
  for (const [k, v] of Object.entries(strings)) {
    const want = k === 'policy' ? POLICY_BYTES : OFFER_BYTES;
    if (Buffer.byteLength(v) !== want) throw new Error(`${k} が ${Buffer.byteLength(v)} バイト（正典は ${want}）。ガスが本番と合わなくなる`);
  }
  const init = {
    // K1-04: 3 calls. No attestation key (it can only be signed after the purchase; B5b writes it).
    a: resolverInit(W_ENS, [
      pr('setText', [dns('seller-a.eth'), 'x402-offer', strings.offerA]),
      pr('setText', [dns('seller-a.eth'), 'agent-endpoint[x402]', SELLER_ENDPOINT]),
      pr('setAddress', [dns('seller-a.eth'), 60n, W_ENS]),
    ]),
    // K1-07: b and c. Record ids become b=1, c=2.
    bc: resolverInit(W_ENS, [
      pr('setText', [dns('seller-b.eth'), 'x402-offer', strings.offerB]),
      pr('setText', [dns('seller-b.eth'), ATT_KEY, 'ENVELOPE_B']),
      pr('setAddress', [dns('seller-b.eth'), 60n, W_ENS]),
      pr('setText', [dns('seller-c.eth'), 'x402-offer', strings.offerC]),
      pr('setText', [dns('seller-c.eth'), ATT_KEY, 'ENVELOPE_C']),
      pr('setAddress', [dns('seller-c.eth'), 60n, W_ENS]),
    ]),
    // K1-D2: same shape as K1-04.
    d: resolverInit(W_ENS, [
      pr('setText', [dns('seller-d.eth'), 'x402-offer', strings.offerD]),
      pr('setText', [dns('seller-d.eth'), 'agent-endpoint[x402]', SELLER_ENDPOINT]),
      pr('setAddress', [dns('seller-d.eth'), 60n, W_ENS]),
    ]),
    u: usr('initialize', [[{ account: W_VET, roleBitmap: ALL_ROLES }]]),
    // K1-12
    ag1: resolverInit(W_VET, [
      pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', strings.policy]),
      pr('setText', [dns('agent-1.vet402.eth'), 'class', 'x402-agent']),
      pr('setAddress', [dns('agent-1.vet402.eth'), 60n, roles.K_ag1]),
    ]),
  };
  // VerifiableFactory addresses depend on (sender, salt) only [sim E4].
  const pre = async (from: Address, impl: Address, salt: bigint, data: Hex): Promise<Address> => {
    const r = await c.call({ account: from, to: ADDR.vf, data: deployProxy(impl, salt, data), blockNumber: B }).catch(() => null);
    if (r?.data) return getAddress('0x' + r.data.slice(26));
    return predictFromCodeless(c, from, impl, salt, B);
  };
  const predicted = {
    P_a: await pre(W_ENS, ADDR.impl, SALT.a, init.a),
    P_bc: await pre(W_ENS, ADDR.impl, SALT.bc, init.bc),
    P_d: await pre(W_ENS, ADDR.impl, SALT.d, init.d),
    U: await pre(W_VET, ADDR.userRegistryImpl, SALT.u, init.u),
    P_AG1: await pre(W_VET, ADDR.impl, SALT.ag1, init.ag1),
  };
  const mk = (label: string, secret: Hex) => c.readContract({ address: ADDR.rg, abi: RG, functionName: 'makeCommitment', args: [label, W_ENS, secret, ZERO, ZERO, REGISTRATION_SECONDS, ('0x' + '00'.repeat(32)) as Hex], blockNumber: B }) as Promise<Hex>;
  const commitment = { d: await mk('seller-d', COMMIT_SECRET.d), e: await mk('seller-e', COMMIT_SECRET.e) };
  return { block: B, now, roles, rolesAreDummy, tid, predicted, commitment, expiry: BigInt(now + AGENT_EXPIRY_DAYS * 86400), strings, init };
}

/** When the proxy already exists, deployProxy reverts; re-derive the address by simulating with an empty init. */
async function predictFromCodeless(c: PublicClient, from: Address, impl: Address, salt: bigint, B: bigint): Promise<Address> {
  // Same (sender, salt) gives the same address, whatever the init data is [sim E4]. A deployed proxy makes
  // deployProxy revert, so fall back to the addresses fixed in PLAN section 10 when that happens.
  const known: Record<string, Address> = {
    [`${W_ENS}:${SALT.a}`]: '0xC54403186Db35B9D92cc393Ae665D3960117ac14',
    [`${W_ENS}:${SALT.bc}`]: '0xd6A089Fc08e5e97697a3293d02F40837CeA1d2bf',
    [`${W_ENS}:${SALT.d}`]: '0x9CF7990dAB364d1738ABB09532b953Ec48269831',
    [`${W_VET}:${SALT.u}`]: '0xB093cEC6D1Cc355c40020f0df5103ecEFfD30dac',
    [`${W_VET}:${SALT.ag1}`]: '0xd3F4818c0bB93e54780525b21380D44D6D06bcd6',
  };
  const k = `${from}:${salt}`;
  if (!known[k]) throw new Error(`予定アドレスを出せない (${from}, salt ${salt}) impl ${impl} block ${B}`);
  const code = await c.getCode({ address: known[k], blockNumber: B });
  if (!code || code === '0x') throw new Error(`deployProxy の eth_call が revert し、既知の番地 ${known[k]} にもコードが無い`);
  return known[k];
}

export function buildSteps(x: Ctx): Step[] {
  const { roles: R, predicted: P, tid, strings: S, init } = x;
  const a = amounts();
  const approveMax = erc20('approve', [ADDR.rg, 1n << 255n]);
  const REF = ('0x' + '00'.repeat(32)) as Hex;
  const reg = (label: string, secret: Hex) => rg('register', [label, W_ENS, secret, ZERO, ZERO, REGISTRATION_SECONDS, ADDR.mockUsdc, REF]);
  const V = (id: string, cmd: Cmd, block: 0 | 1, to: Address, data: Hex | undefined, what: string, value?: bigint): Step => ({ id, cmd, signer: 'W_vet', from: W_VET, to, data, block, what, ...(value ? { value } : {}) });
  const E = (id: string, cmd: Cmd, block: 0 | 1, to: Address, data: Hex | undefined, what: string, value?: bigint): Step => ({ id, cmd, signer: 'W_ens', from: W_ENS, to, data, block, what, ...(value ? { value } : {}) });

  const steps: Step[] = [
    // --- block 0: commits first, so the 60 s MIN_COMMITMENT_AGE runs while the rest is sent ---
    E('K1-D1a', 'register-d', 0, ADDR.mockUsdc, approveMax, 'MockUSDC.approve(ETHRegistrar, max)'),
    E('K1-D1b', 'register-d', 0, ADDR.rg, rg('commit', [x.commitment.d]), 'ETHRegistrar.commit(seller-d)'),
    E('K1-E1a', 'register-e', 0, ADDR.mockUsdc, approveMax, 'MockUSDC.approve(ETHRegistrar, max)'),
    E('K1-E1b', 'register-e', 0, ADDR.rg, rg('commit', [x.commitment.e]), 'ETHRegistrar.commit(seller-e)'),
    // k1a (W_vet). x402-policy is never written on R_vet (section 3.5.3 trap).
    V('K1-02', 'k1a', 0, ADDR.rVet, pr('multicall', [[
      pr('setText', [dns('vet402.eth'), 'agent-endpoint[x402]', 'https://vet402.com/api/tokyo']),
      pr('setText', [dns('vet402.eth'), 'class', 'x402-verifier']),
      pr('setAddress', [dns('atst.vet402.eth'), 60n, R.K_atst])]]), 'R_vet.multicall[setText x2, setAddress(atst.vet402.eth, 60, K_atst)]'),
    V('K1-03', 'k1a', 0, ADDR.rVet, pr('multicall', [OBS_KEYS.map(k => pr('grantSetterRoles', [pr('setText', [dns('x.obs.vet402.eth'), k, '']), R.W_obs]))]), 'R_vet.multicall[grantSetterRoles(setText(*, key_i), W_obs) x15]'),
    V('K1a-fund', 'k1a', 0, R.W_obs, undefined, `ETH ${fmtEth(a.wObsFundWei)} -> W_obs (gas for observation logs)`, a.wObsFundWei),
    // deploy-resolvers, part 1 (W_ens)
    E('K1-04', 'deploy-resolvers', 0, ADDR.vf, deployProxy(ADDR.impl, SALT.a, init.a), `deployProxy(impl, SALT_A) -> P_a ${P.P_a}`),
    E('K1-05', 'deploy-resolvers', 0, ADDR.er, er('setResolver', [tid['seller-a'], P.P_a]), 'ETHRegistry.setResolver(seller-a, P_a)'),
    E('K1-07', 'deploy-resolvers', 0, ADDR.vf, deployProxy(ADDR.impl, SALT.bc, init.bc), `deployProxy(impl, SALT_BC) -> P_bc ${P.P_bc}`),
    E('K1-08', 'deploy-resolvers', 0, ADDR.er, er('setResolver', [tid['seller-b'], P.P_bc]), 'ETHRegistry.setResolver(seller-b, P_bc)'),
    E('K1-09', 'deploy-resolvers', 0, ADDR.er, er('setResolver', [tid['seller-c'], P.P_bc]), 'ETHRegistry.setResolver(seller-c, P_bc)'),

    // --- block 1: after MIN_COMMITMENT_AGE ---
    E('K1-D1c', 'register-d', 1, ADDR.rg, reg('seller-d', COMMIT_SECRET.d), 'ETHRegistrar.register(seller-d, W_ens, 1y, MockUSDC)'),
    // deploy-resolvers, part 2 (needs seller-d registered)
    E('K1-D2', 'deploy-resolvers', 1, ADDR.vf, deployProxy(ADDR.impl, SALT.d, init.d), `deployProxy(impl, SALT_D) -> P_d ${P.P_d}`),
    E('K1-D3', 'deploy-resolvers', 1, ADDR.er, er('setResolver', [tid['seller-d'], P.P_d]), 'ETHRegistry.setResolver(seller-d, P_d)'),
    // k1b (W_ens). grantSetterRoles only after deployment, never inside initialize.
    E('K1-06', 'k1b', 1, P.P_a, pr('grantSetterRoles', [pr('setText', [dns('seller-a.eth'), 'x402-offer', '']), R.W_op]), 'P_a.grantSetterRoles(setText(seller-a.eth, x402-offer), W_op)'),
    E('K1-D4', 'k1b', 1, P.P_d, pr('grantSetterRoles', [pr('setText', [dns('seller-d.eth'), 'x402-offer', '']), R.W_op]), 'P_d.grantSetterRoles(setText(seller-d.eth, x402-offer), W_op)'),
    E('BS-03', 'k1b', 1, R.W_op, undefined, `ETH ${fmtEth(a.bs03Wei)} -> W_op (Sepolia)`, a.bs03Wei),
    // agents (W_vet)
    V('K1-10', 'agents', 1, ADDR.vf, deployProxy(ADDR.userRegistryImpl, SALT.u, init.u), `deployProxy(UserRegistryImpl, SALT_U) -> U ${P.U}`),
    V('K1-11', 'agents', 1, ADDR.er, er('setSubregistry', [tid['vet402'], P.U]), 'ETHRegistry.setSubregistry(vet402, U)'),
    V('K1-12', 'agents', 1, ADDR.vf, deployProxy(ADDR.impl, SALT.ag1, init.ag1), `deployProxy(impl, SALT_A1) -> P_AG1 ${P.P_AG1}`),
    V('K1-13', 'agents', 1, P.U, usr('register', ['agent-1', R.K_ag1, ZERO, P.P_AG1, ROLE_RENEW, x.expiry]), 'U.register(agent-1, K_ag1, 0, P_AG1, RENEW, expiry)'),
    V('K1-14', 'agents', 1, P.P_AG1, pr('grantSetterRoles', [pr('setText', [dns('agent-1.vet402.eth'), 'x402-policy', '']), R.K_ag1]), 'P_AG1.grantSetterRoles(setText(agent-1, x402-policy), K_ag1)'),
    V('K1-15', 'agents', 1, P.U, usr('register', ['agent-2', R.K_ag2, ZERO, ZERO, ROLE_RENEW | ROLE_CAN_TRANSFER_ADMIN, x.expiry]), 'U.register(agent-2, K_ag2, 0, 0, RENEW|CAN_TRANSFER_ADMIN, expiry)'),
    V('K1-15b', 'agents', 1, ADDR.rVet, pr('grantSetterRoles', [pr('setText', [dns('agent-2.vet402.eth'), 'x402-policy', '']), R.K_ag2]), 'R_vet.grantSetterRoles(setText(*, x402-policy), K_ag2)'),
    // agents --post (K1-post: W_vet and W_ens alternate)
    V('K1-post-1', 'agents-post', 1, P.U, usr('register', ['atst', W_VET, ZERO, ZERO, ROLE_RENEW, x.expiry]), 'U.register(atst, W_vet, 0, 0) reservation'),
    V('K1-post-2', 'agents-post', 1, P.U, usr('register', ['obs', W_VET, ZERO, ZERO, ROLE_RENEW, x.expiry]), 'U.register(obs, W_vet, 0, 0) reservation'),
    E('K1-15c', 'agents-post', 1, ADDR.er, er('setSubregistry', [tid['seller-a'], P.U]), 'ETHRegistry.setSubregistry(seller-a, U)  [signer W_ens]'),
    V('K1-15d', 'agents-post', 1, P.P_AG1, pr('linkToNode', [dns('agent-1.seller-a.eth'), namehash('agent-1.vet402.eth')]), 'P_AG1.linkToNode(agent-1.seller-a.eth -> agent-1.vet402.eth)'),
    // seller-e (Intercepta slot only). P_bc is reused, no new resolver, no attestation, no delegation.
    E('K1-E1c', 'register-e', 1, ADDR.rg, reg('seller-e', COMMIT_SECRET.e), 'ETHRegistrar.register(seller-e, W_ens, 1y, MockUSDC)'),
    E('K1-E2', 'set-offer-e', 1, ADDR.er, er('setResolver', [tid['seller-e'], P.P_bc]), 'ETHRegistry.setResolver(seller-e, P_bc)  (reuse, no new resolver)'),
    E('K1-E3', 'set-offer-e', 1, P.P_bc, pr('setText', [dns('seller-e.eth'), 'x402-offer', S.offerE]), `P_bc.setText(seller-e.eth, x402-offer, payTo ${SELLER_E_PAYTO})`),
  ];
  for (const s of steps) {
    if (s.to.toLowerCase() === P.U.toLowerCase() && s.data) guardUserRegistryCall(s.data);
    if (s.to.toLowerCase() === ADDR.rVet.toLowerCase() && s.data && writesPolicyOnRVet(s.data)) throw new Error(`${s.id}: R_vet に x402-policy を書かない（section 3.5.3）`);
  }
  return steps;
}

function writesPolicyOnRVet(data: Hex): boolean {
  const { functionName, args } = decodeFunctionData({ abi: PR, data });
  if (functionName === 'setText') return (args as any)[1] === 'x402-policy';
  if (functionName === 'multicall') return ((args as any)[0] as Hex[]).some(writesPolicyOnRVet);
  return false;
}

/** Reads placed in the chain. K1-11: atst / obs must still resolve through R_vet after setSubregistry. */
export function buildChecks(x: Ctx): Check[] {
  const obsName = keccak256(toBytes('x')).slice(2, 66) + '.obs.vet402.eth';
  const resolverIs = (want: Address) => (ret: Hex) => {
    const got = getAddress('0x' + ret.slice(26, 66));
    return got.toLowerCase() === want.toLowerCase() ? null : `resolver ${got}（期待 ${want}）`;
  };
  const textIs = (want: string) => (ret: Hex) => {
    const got = decodeResolvedText(ret);
    return got === want ? null : `text ${JSON.stringify(got)?.slice(0, 80)}（期待 ${JSON.stringify(want).slice(0, 80)}）`;
  };
  return [
    { id: 'CHK atst.vet402.eth -> R_vet (after K1-11)', afterStep: 'K1-11', to: ADDR.ur, data: urv('findResolver', [dns('atst.vet402.eth')]), expect: resolverIs(ADDR.rVet) },
    { id: 'CHK <hash>.obs.vet402.eth -> R_vet (after K1-11)', afterStep: 'K1-11', to: ADDR.ur, data: urv('findResolver', [dns(obsName)]), expect: resolverIs(ADDR.rVet) },
    { id: 'CHK atst.vet402.eth -> R_vet (after K1-post-2)', afterStep: 'K1-post-2', to: ADDR.ur, data: urv('findResolver', [dns('atst.vet402.eth')]), expect: resolverIs(ADDR.rVet) },
    { id: 'CHK <hash>.obs.vet402.eth -> R_vet (after K1-post-2)', afterStep: 'K1-post-2', to: ADDR.ur, data: urv('findResolver', [dns(obsName)]), expect: resolverIs(ADDR.rVet) },
    { id: 'CHK agent-1.seller-a.eth -> P_AG1 (after K1-15d)', afterStep: 'K1-15d', to: ADDR.ur, data: urv('findResolver', [dns('agent-1.seller-a.eth')]), expect: resolverIs(x.predicted.P_AG1) },
    { id: 'CHK seller-e.eth x402-offer (after K1-E3)', afterStep: 'K1-E3', to: ADDR.ur, data: resolveText('seller-e.eth', 'x402-offer'), expect: textIs(x.strings.offerE) },
    { id: 'CHK seller-b.eth x402-offer unchanged (after K1-E3)', afterStep: 'K1-E3', to: ADDR.ur, data: resolveText('seller-b.eth', 'x402-offer'), expect: textIs(x.strings.offerB) },
  ];
}

export const resolveText = (name: string, key: string): Hex => urv('resolve', [dns(name), encodeFunctionData({
  abi: [{ type: 'function', name: 'text', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'string' }], outputs: [{ type: 'string' }] }],
  functionName: 'text', args: [namehash(name), key],
})]);

export function decodeResolvedText(ret: Hex): string | undefined {
  try {
    const [b] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], ret);
    return decodeAbiParameters([{ type: 'string' }], b)[0] as string;
  } catch { return undefined; }
}

export const fmtEth = (wei: bigint): string => {
  const s = wei.toString().padStart(19, '0');
  return (s.slice(0, -18) + '.' + s.slice(-18)).replace(/\.?0+$/, '') + ' ETH';
};
