// The agent's policy on its own ENS name (PLAN_v4.3 sections 3.5.1-3.5.3), read before payOrRefuse is called.
//
//   payAsAgent({ agentName, clients, expectedResolver, localAttesters, payOrRefuse, request })
//
// The policy is the text record x402-policy of agentName, read through the Universal Resolver on two
// Sepolia RPCs at one block. It is used only when the resolver that answered is expectedResolver (the
// agent's own PermissionedResolver, P_AG1): after unregister, the parent's wildcard resolver could answer
// with an old value (section 3.5.3). Anything unreadable stops before payOrRefuse with agent_policy_missing,
// a word of this demo only (not in the SDK vocabulary).
//
// Clock: this read pins the block without a head-lag limit of its own. Freshness of the evidence is the
// payment gate's job (checkEnsOffer pins again with its own maxHeadLagSeconds and clock).
import { loadEnsSdk } from './sdk.ts';

export type AgentPolicy = {
  v: 1;
  network: 'eip155:84532';
  trust: string[];
  floors: { minEnsAttestations: number; minChainReceipts: number };
  requireVet402Allow: boolean;
  max: string;
  maxAgeSeconds: number;
};
export type LocalAttester = { name: string; address: string; recordKeys: string[] };

const POLICY_KEYS = ['v', 'network', 'trust', 'floors', 'requireVet402Allow', 'max', 'maxAgeSeconds'] as const;
const missing = (why: string): Error => new Error(`agent_policy_missing: ${why}`);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

/** Section 3.5.1, all rules. Throws agent_policy_missing on the first rule that fails. */
export function parseAgentPolicy(raw: string): AgentPolicy {
  if (!raw) throw missing('x402-policy is empty');
  let p: any;
  try { p = JSON.parse(raw); } catch { throw missing('x402-policy is not JSON'); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw missing('x402-policy is not a JSON object');
  const keys = Object.keys(p);
  const unknown = keys.filter(k => !(POLICY_KEYS as readonly string[]).includes(k));
  if (unknown.length) throw missing(`unknown key(s) ${unknown.join(', ')}`);
  const absent = POLICY_KEYS.filter(k => !(k in p));
  if (absent.length) throw missing(`missing key(s) ${absent.join(', ')}`);
  if (p.v !== 1) throw missing('v must be 1');
  if (p.network !== 'eip155:84532') throw missing('network must be eip155:84532');
  if (!Array.isArray(p.trust) || p.trust.length === 0 || !p.trust.every((t: unknown) => typeof t === 'string' && t.includes('.') && !/^0x[0-9a-fA-F]{40}$/.test(t))) {
    throw missing('trust must be a non-empty array of ENS names (no addresses)');
  }
  const f = p.floors;
  if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).length !== 2 || !isInt(f.minEnsAttestations) || !isInt(f.minChainReceipts) || f.minEnsAttestations < 0 || f.minChainReceipts < 0) {
    throw missing('floors must be exactly {minEnsAttestations, minChainReceipts} with integers >= 0');
  }
  if (typeof p.requireVet402Allow !== 'boolean') throw missing('requireVet402Allow must be a boolean');
  if (typeof p.max !== 'string' || !/^[0-9]{1,18}$/.test(p.max)) throw missing('max must be USDC base units as a decimal string');
  if (!isInt(p.maxAgeSeconds) || p.maxAgeSeconds < 60 || p.maxAgeSeconds > 604_800) throw missing('maxAgeSeconds must be an integer in 60..604800');
  return p as AgentPolicy;
}

export type PayAsAgentInput = {
  agentName: string;
  clients: { primary: any; secondary: any };
  expectedResolver: string;
  localAttesters: LocalAttester[];
  payOrRefuse: (input: any) => Promise<any>;
  request: { payeeName: string; resource: string; method?: string; amountUsd: number; fetch: typeof fetch; [k: string]: unknown };
};

/** Read the policy, map it one-to-one (section 3.5.2) and call payOrRefuse. Nothing else is taken from the name. */
export async function payAsAgent(i: PayAsAgentInput): Promise<any> {
  const ens = await loadEnsSdk();
  let raw: { value: string; resolver: string | null };
  try {
    const pin = await ens.pinBlock(i.clients, Number.MAX_SAFE_INTEGER);
    raw = await ens.resolveText(i.clients, pin.B, ens.normalizeName(i.agentName), 'x402-policy');
  } catch (e: any) {
    throw missing(`x402-policy of ${i.agentName} could not be read on two RPCs (${String(e?.message ?? e).slice(0, 160)})`);
  }
  if (!raw.resolver || raw.resolver.toLowerCase() !== String(i.expectedResolver).toLowerCase()) {
    throw missing(`x402-policy of ${i.agentName} was answered by ${raw.resolver ?? 'no resolver'}, not the agent's own resolver ${i.expectedResolver}`);
  }
  const policy = parseAgentPolicy(raw.value);
  const trusted = i.localAttesters.filter(a => policy.trust.includes(a.name));
  if (!trusted.length) throw missing(`none of trust [${policy.trust.join(', ')}] is in the local trusted attesters`);
  return i.payOrRefuse({
    ...i.request,
    payeeName: i.request.payeeName,
    resource: i.request.resource,
    network: 'base-sepolia',
    ens: {
      clients: i.clients,
      // Addresses always come from the local file, never from the name.
      policy: { trustedAttesters: trusted.map(a => ({ name: a.name, address: a.address, recordKeys: a.recordKeys })), maxAgeSeconds: policy.maxAgeSeconds },
    },
    policy: {
      maxPerTxUsd: Number(policy.max) / 1e6,
      requireVet402Allow: policy.requireVet402Allow,
      evidence: { minEnsAttestations: policy.floors.minEnsAttestations, minChainReceipts: policy.floors.minChainReceipts },
    },
  });
}
