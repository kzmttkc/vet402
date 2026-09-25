/* eslint-disable @typescript-eslint/no-explicit-any -- ETHGlobal Tokyo 2026: viem ABI helpers and JSON from RPCs are loosely typed here; behaviour is pinned by tests. */
// Dry-run worlds for mutate / reset / scene3 / pay --test-attester. Read-only: nothing here signs a transaction
// or sends one.
//
// simulatedEnsClients(): EnsRpc readers (the four methods the SDK's ENS gate uses) whose every readContract is an
// eth_simulateV1 of [pre-calls..., the read] on top of the pinned block. checkEnsOffer and payAsAgent run
// unchanged on "the chain after these transactions". Pre-calls come from the real signers' addresses with
// validation:false (the same way admin.ts --dry-run measures K1), so no key is involved.
//
// testAttesterFixture(): a simulation-only stand-in for B5b. anvil #0 (the well-known public test key, never a
// real key) is made the address of atst.vet402.eth on R_vet, and an ENSIP-29 draft envelope signed by it is put
// on each name's attestation key. The local trusted attester is pinned to anvil #0 for that run only. This is how
// the ALLOW path and the signer_mismatch refusals can be shown before the real envelopes are on chain (09:30).
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, namehash, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { PR } from './abi.ts';
import { ADDR, ATT_KEY, SELLER_ENDPOINT, W_ENS, W_VET, ZERO, dns, mkOffer } from './k1.ts';
import { simulateBlocks, type SimResult } from './rpc.ts';

/** anvil / hardhat account #0. Public test key: it appears in every Foundry and Hardhat install. */
export const ANVIL0_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const ANVIL0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

// On chain since K1 (K1_LOG 2026-09-25; the same values as src/lib/census.ts). run.ts checks them against the
// resolver the Universal Resolver reports before using them.
export const P_A: Address = '0xC54403186Db35B9D92cc393Ae665D3960117ac14';
export const P_BC: Address = '0xd6A089Fc08e5e97697a3293d02F40837CeA1d2bf';
export const P_D: Address = '0x9CF7990dAB364d1738ABB09532b953Ec48269831';
export const P_AG1: Address = '0xd3F4818c0bB93e54780525b21380D44D6D06bcd6';
export const W_OP_DEFAULT: Address = '0xE3BB99911A8037F22D4d6b3a4d955D1b02229080';

export type PreCall = { id: string; from: Address; to: Address; data: Hex; what: string };

const prd = (functionName: any, args: any): Hex => encodeFunctionData({ abi: PR, functionName, args } as any);

// ---------------------------------------------------------------- the demo transactions (PLAN_v4.3 section 4)
export const OFFER_A = mkOffer('10000', W_ENS);
export const OFFER_A_1CHAR = mkOffer('10001', W_ENS);
export function demoTx(id: 'D-1' | 'D-1r' | 'D-2' | 'D-3' | 'D-4' | 'D-5', wOp: Address): PreCall {
  switch (id) {
    case 'D-1': return { id, from: wOp, to: P_A, data: prd('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A_1CHAR]), what: 'P_a.setText(seller-a.eth, x402-offer, …"amount":"10001"…)' };
    case 'D-1r': return { id, from: wOp, to: P_A, data: prd('setText', [dns('seller-a.eth'), 'x402-offer', OFFER_A]), what: 'P_a.setText(seller-a.eth, x402-offer, …"amount":"10000"…)  (back to the K1-04 bytes)' };
    case 'D-2': return { id, from: W_ENS, to: P_BC, data: prd('linkToRecord', [dns('seller-b.eth'), 0n]), what: 'P_bc.linkToRecord(seller-b.eth, 0)  unlink b' };
    case 'D-3': return { id, from: W_ENS, to: P_BC, data: prd('linkToRecord', [dns('seller-b.eth'), 1n]), what: 'P_bc.linkToRecord(seller-b.eth, 1)  b back' };
    case 'D-4': return { id, from: W_ENS, to: P_BC, data: prd('linkToRecord', [dns('seller-c.eth'), 1n]), what: "P_bc.linkToRecord(seller-c.eth, 1)  c onto b's record" };
    case 'D-5': return { id, from: W_ENS, to: P_BC, data: prd('linkToRecord', [dns('seller-c.eth'), 2n]), what: 'P_bc.linkToRecord(seller-c.eth, 2)  c back (clean-up)' };
  }
}

/** BC-1 of admin.ts align-bc (b/c offers to amount 10000 + agent-endpoint[x402]); dry-run projection of 07:00. */
export function alignBcCall(): PreCall {
  const calls = (['seller-b.eth', 'seller-c.eth'] as const).flatMap(n => [
    prd('setText', [dns(n), 'x402-offer', OFFER_A]),
    prd('setText', [dns(n), 'agent-endpoint[x402]', SELLER_ENDPOINT]),
  ]);
  return { id: 'BC-1', from: W_ENS, to: P_BC, data: prd('multicall', [calls]), what: 'align-bc (projection): b/c offer amount 10000 + agent-endpoint[x402]' };
}

// ---------------------------------------------------------------- simulated readers
type Memo = Map<string, Promise<unknown>>;

class RevertLike extends Error {
  raw: string;
  constructor(raw: string) { super(`simulated read reverted (${raw.slice(0, 18)})`); this.name = 'ContractFunctionRevertedError'; this.raw = raw; }
}

/**
 * Two EnsRpc readers over one eth_simulateV1 RPC. getBlock / getBlockNumber / getChainId come from the real
 * primary reader, so the SDK pins the same block as on the real chain. Both sides share one memo: this is a
 * projection, not the two-provider evidence the real gate uses, and run.ts says so on screen.
 */
export function simulatedEnsClients(real: { primary: any }, simUrl: string, pre: PreCall[]) {
  const memo: Memo = new Map();
  let calls = 0;
  const mkReader = () => ({
    chain: sepolia,
    async readContract(a: any) {
      const data = encodeFunctionData({ abi: a.abi, functionName: a.functionName, args: a.args } as any);
      const key = `${a.blockNumber}|${String(a.address).toLowerCase()}|${data}`;
      if (!memo.has(key)) {
        memo.set(key, (async () => {
          calls++;
          const r = await simulateBlocks([{ calls: [...pre.map(p => ({ from: p.from, to: p.to, data: p.data })), { from: ZERO, to: a.address, data }] }], BigInt(a.blockNumber), [simUrl]);
          const res: SimResult[] = r.blocks[0];
          res.slice(0, pre.length).forEach((x, idx) => {
            if (x.status !== 'OK') throw new Error(`simulated pre-state does not hold: ${pre[idx].id} ${pre[idx].what} reverted (${x.error})`);
          });
          return res[res.length - 1];
        })());
      }
      const last = (await memo.get(key)) as SimResult;
      if (last.status !== 'OK') throw new RevertLike(String(last.returnData ?? '0x'));
      return decodeFunctionResult({ abi: a.abi, functionName: a.functionName, data: last.returnData } as any);
    },
    getBlock: (x?: any) => real.primary.getBlock(x),
    getBlockNumber: (x?: any) => real.primary.getBlockNumber(x),
    getChainId: () => real.primary.getChainId(),
  });
  // Two objects (the SDK refuses the same reader twice), one simulation RPC and one memo behind both.
  return { clients: { primary: mkReader(), secondary: mkReader() }, calls: () => calls };
}

/** Run the pre-calls once as a block and return each result (status, gas, event names). */
export async function simulateSequence(pre: PreCall[], block: bigint, simUrls: string[]): Promise<SimResult[]> {
  const r = await simulateBlocks([{ calls: pre.map(p => ({ from: p.from, to: p.to, data: p.data })) }], block, simUrls);
  return r.blocks[0];
}

// ---------------------------------------------------------------- the test attester (simulation only)
export type FixtureName = { name: string; resolver: Address; manager: Address; offerRaw: string };

export async function testAttesterFixture(ens: any, names: FixtureName[], t: number): Promise<{ pre: PreCall[]; attester: { name: string; address: Address; recordKeys: string[] } }> {
  const acct = privateKeyToAccount(ANVIL0_PK);
  const pre: PreCall[] = [{
    id: 'FX-atst', from: W_VET, to: ADDR.rVet,
    data: prd('setAddress', [dns('atst.vet402.eth'), 60n, acct.address]),
    what: 'R_vet.setAddress(atst.vet402.eth, 60, anvil#0)  (simulation only)',
  }];
  for (const n of names) {
    const payload: Uint8Array = ens.encodePayload({ n: ens.normalizeName(n.name), a: getAddress(n.manager), k: 'x402-offer', v: n.offerRaw, t }, 'ensip29-draft');
    const sig = await acct.signMessage({ message: { raw: keccak256(payload) } });
    const envelope: string = ens.encodeEnvelope({ version: 1, t, sig }, 'base64');
    pre.push({ id: `FX-${n.name}`, from: W_ENS, to: n.resolver, data: prd('setText', [dns(n.name), ATT_KEY, envelope]), what: `setText(${n.name}, ${ATT_KEY}, <anvil#0 envelope t=${t}>)  (simulation only)` });
  }
  return { pre, attester: { name: 'atst.vet402.eth', address: acct.address, recordKeys: ['x402-offer'] } };
}

export const recordIdCall = (resolver: Address, name: string) => ({
  address: resolver,
  abi: [{ type: 'function', name: 'getRecordId', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'uint256' }] }] as const,
  functionName: 'getRecordId' as const,
  args: [namehash(name)] as const,
});
