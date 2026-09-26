/* eslint-disable @typescript-eslint/no-explicit-any -- ETHGlobal Tokyo 2026: viem ABI helpers and JSON from RPCs are loosely typed here; behaviour is pinned by tests. */
// `run.ts pay <name>` (PLAN_v4.3 sections 3.8, 3.10, 3.3.3, 8.2): one line per stage, in the order the money
// path runs them.
//
//   S  screening   Intercepta quick-scan of the offer's payTo and of the payer (demo words only:
//                  payee_screening_blocked / payee_screening_unavailable / payee_unknown_needs_human). The
//                  payTo comes from the one ENS read this stage needs (x402-offer). A block or unavailable
//                  stops here: no proof is checked, no policy is read, vet402 is not asked.
//                  An unknown payTo (no risk record and no activity on Base mainnet) goes on only when the
//                  offer asks at most 0.01 USDC; otherwise it stops here with payee_unknown_needs_human. When
//                  it goes on, the SDK's ENS gate (payment by name) must say VALID before any signature, and
//                  maxPerTxUsd is capped at 0.01 for this payment. The [U] line says why it was paid.
//   P  policy      agent-1.vet402.eth x402-policy, read by payAsAgent (src/lib/agent.ts) through P_AG1
//   1-7 ENS        the ENSIP-29 draft's seven steps, as payOrRefuse ran them (decision.ens[0].trace)
//   D  vet402 API  what the SDK asked and what came back. "unreachable (asked, no answer)" only when the SDK
//                  did ask and got a transport error or 5xx; "not asked" when the ENS gate refused first
//   C  chain       the minChainReceipts floor on Base Sepolia (two readers)
//   Q  402         the live 402 against the attested offer
//   R  recheck     ENSIP-29 read again right before the signature
//   X  sign        dry-run: the payer here holds no key; the paid request is blocked before the network
//
// Nothing in this file reads a private key. The caller passes the payer (a dry payer, or the real W_pay
// account in --live after its own gates).
import { payAsAgent, type LocalAttester } from './agent.ts';
import { loadEnsSdk, loadPaySdk } from './sdk.ts';
import { parseOffer } from '../attester.ts';
import type { PaymentScreening } from '../screening.ts';

export const UNREACHABLE_LINE = 'vet402 API: unreachable (asked, no answer)';
export const DRY_SIGNATURE = ('0x' + '00'.repeat(65)) as `0x${string}`;
const RESOURCE_402_WORDS = new Set(['ens_offer_mismatch', 'payee_mismatch', 'price_above_declared', 'chain_or_asset_mismatch', 'no_eligible_accept', 'price_above_ceiling']);
/** The most an agent pays an unknown payee without a human: 0.01 USDC (6 decimals). */
export const UNKNOWN_PAYEE_MAX_UNITS = 10_000n;
const STEP_NAMES: Record<number, string> = { 1: 'envelope', 2: 'manager', 3: 'record value', 4: 'payload', 5: 'recover signer', 6: 'attester name', 7: 'compare' };

export type ApiCall = { path: string; outcome: string; unreachable: boolean };
export type Payer = { address: `0x${string}`; signTypedData: (td: any) => Promise<`0x${string}`> };

/** A payer with no key. It returns an all-zero "signature" so the SDK finishes its decision line; the request that
 *  would carry it never leaves the process (see guardedFetch). `asked` records what it would have signed. */
export function dryPayer(address: `0x${string}`): Payer & { asked: any[] } {
  const asked: any[] = [];
  return { address, asked, signTypedData: async (td: any) => { asked.push(td); return DRY_SIGNATURE; } };
}

const hasPaymentHeader = (init: any): boolean => {
  const h = init?.headers;
  if (!h) return false;
  const keys = typeof h.keys === 'function' ? [...h.keys()] : Object.keys(h);
  return keys.some((k: string) => ['payment-signature', 'x-payment'].includes(String(k).toLowerCase()));
};

/**
 * fetch for payOrRefuse. Records every call to the vet402 API (path only: the key travels in a header and is
 * never printed). In dry-run a request that carries a payment header throws before it reaches the network.
 */
export function guardedFetch(base: typeof fetch, apiUrl: string, live: boolean) {
  const api: ApiCall[] = [];
  let blocked = 0;
  let paymentsSent = 0;
  const apiPrefix = apiUrl.replace(/\/$/, '');
  const f = (async (input: any, init?: any) => {
    const url = String(input);
    const isApi = url.startsWith(apiPrefix);
    if (hasPaymentHeader(init)) {
      if (!live) { blocked++; throw new Error('dry_run_block: a request carrying a payment header was not sent (dry-run)'); }
      paymentsSent++;
    }
    if (!isApi) return base(input, init);
    const path = (() => { try { const u = new URL(url); return u.host + u.pathname; } catch { return '(invalid url)'; } })();
    try {
      const res = await base(input, init);
      const unreachable = res.status >= 500 && res.status <= 599;
      api.push({ path, outcome: `HTTP ${res.status}`, unreachable });
      return res;
    } catch (e: any) {
      const code = e?.cause?.code ?? e?.cause?.message ?? e?.code ?? e?.name ?? 'error';
      api.push({ path, outcome: `no answer (${code})`, unreachable: true });
      throw e;
    }
  }) as typeof fetch;
  return { fetch: f, api, blocked: () => blocked, paymentsSent: () => paymentsSent };
}

export type PayFlowInput = {
  name: string;
  agentName: string;
  expectedResolver: string;
  /** Two Sepolia readers (real, or simulated in dry-run with --test-attester). */
  ensClients: { primary: any; secondary: any };
  localAttesters: LocalAttester[];
  payer: Payer;
  /** Screening sees this address as the payer (W_pay). */
  payerAddress: string;
  screen: (a: { payTo: string; payer: string }) => Promise<PaymentScreening>;
  fetch: typeof fetch;
  apiUrl: string;
  apiKey?: string;
  chainReader: any;
  chainReaderCrossCheck: any;
  chainFromBlock?: bigint;
  live: boolean;
  print: (line: string) => void;
  /** Injected in tests; defaults to the SDK's payOrRefuse. */
  payOrRefuse?: (input: any) => Promise<any>;
};

export type PayFlowOutcome = {
  verdict: 'ALLOW' | 'REFUSE' | 'PAID' | 'FAILED';
  reasons: string[];
  stoppedAt: 'screening' | 'policy' | 'sdk' | 'sign' | 'paid';
  api: ApiCall[];
  screening: PaymentScreening | null;
  result: any | null;
  paymentBlocked: number;
  paymentsSent: number;
  lines: string[];
};

const tag = (s: string) => s.padEnd(11);

export async function runPayFlow(i: PayFlowInput): Promise<PayFlowOutcome> {
  const lines: string[] = [];
  const out = (l: string) => { lines.push(l); i.print(l); };
  const ens = await loadEnsSdk();
  const g = guardedFetch(i.fetch, i.apiUrl, i.live);
  const done = (o: Omit<PayFlowOutcome, 'api' | 'lines' | 'paymentBlocked' | 'paymentsSent'>): PayFlowOutcome =>
    ({ ...o, api: g.api, lines, paymentBlocked: g.blocked(), paymentsSent: g.paymentsSent() });

  // ---- S: the payTo to screen is the offer's, read once from ENS (no proof checked yet) ----
  const name = ens.normalizeName(i.name);
  let offer: ReturnType<typeof parseOffer> = null;
  try {
    const pin = await ens.pinBlock(i.ensClients, 120);
    const v = await ens.resolveText(i.ensClients, pin.B, name, 'x402-offer');
    offer = parseOffer(v.value);
    if (!offer) out(`[S] ${tag('offer')}x402-offer of ${name} is ${v.value ? 'not an x402 offer' : 'empty'} at Sepolia block ${pin.B}: no payTo to screen; the ENS gate decides`);
    else out(`[S] ${tag('offer')}x402-offer of ${name} at Sepolia block ${pin.B}: payTo ${offer.payTo}, amount ${offer.amount} (read once for screening; the proof is checked below)`);
  } catch (e: any) {
    out(`[S] ${tag('screening')}cannot read x402-offer of ${name}: ${String(e?.message ?? e).slice(0, 160)}`);
    out('REFUSE payee_screening_unavailable');
    return done({ verdict: 'REFUSE', reasons: ['payee_screening_unavailable'], stoppedAt: 'screening', screening: null, result: null });
  }
  let screening: PaymentScreening | null = null;
  if (offer) {
    screening = await i.screen({ payTo: offer.payTo, payer: i.payerAddress });
    out(`[S] ${tag('screening')}${screening.line}`);
    if (screening.verdict === 'unknown') {
      const units = BigInt(offer.amount);
      if (units > UNKNOWN_PAYEE_MAX_UNITS) {
        out(`[S] ${tag('unknown')}the payTo is unknown and the offer asks ${Number(units) / 1e6} USDC, above the ${Number(UNKNOWN_PAYEE_MAX_UNITS) / 1e6} USDC an agent pays an unknown payee on its own`);
        out('REFUSE payee_unknown_needs_human  (stopped before any proof, policy or vet402 call; a person decides)');
        return done({ verdict: 'REFUSE', reasons: ['payee_unknown_needs_human'], stoppedAt: 'screening', screening, result: null });
      }
      out(`[S] ${tag('unknown')}the payTo is unknown; going on only because the offer asks ${Number(units) / 1e6} USDC (<= ${Number(UNKNOWN_PAYEE_MAX_UNITS) / 1e6}) and only if the ENS attestation below is VALID`);
    } else if (screening.verdict !== 'pass') {
      const r = screening.refuse!;
      const flagged = [screening.payTo, screening.payer].filter(s => s.verdict === 'block').flatMap(s => s.traits ?? []);
      if (flagged.length) out(`[S] ${tag('traits')}${flagged.map(t => `${t.name} (txsCount ${t.txsCount ?? 'n/a'})`).join(', ')} — ${flagged.length} trait(s)`);
      out(`REFUSE ${r}  (stopped before any proof, policy or vet402 call)`);
      return done({ verdict: 'REFUSE', reasons: [r], stoppedAt: 'screening', screening, result: null });
    }
  }

  // ---- P + SDK ----
  const pay = i.payOrRefuse ?? (await loadPaySdk()).payOrRefuse;
  let sent: any = null;
  const unknownPayee = screening?.verdict === 'unknown';
  const wrapped = async (input: any) => {
    // An unknown payee is paid by name only (the SDK's ENS gate refuses anything but VALID before the signature),
    // and never above 0.01 USDC, whatever the agent's own ceiling says.
    if (unknownPayee && !input.payeeName) throw new Error('unknown payee: payment by ENS name is required');
    const capped = unknownPayee
      ? { ...input, policy: { ...input.policy, maxPerTxUsd: Math.min(input.policy.maxPerTxUsd, Number(UNKNOWN_PAYEE_MAX_UNITS) / 1e6) } }
      : input;
    sent = capped;
    // chainFromBlock is where the caller starts counting receipts (a read range, like the RPCs), not a floor.
    // payAsAgent rebuilds `policy` from the name, so it is added here.
    const withRange = i.chainFromBlock === undefined ? capped
      : { ...capped, policy: { ...capped.policy, evidence: { ...capped.policy.evidence, chainFromBlock: i.chainFromBlock } } };
    return pay(withRange);
  };
  let result: any;
  try {
    result = await payAsAgent({
      agentName: i.agentName, clients: i.ensClients, expectedResolver: i.expectedResolver, localAttesters: i.localAttesters,
      payOrRefuse: wrapped,
      request: {
        payeeName: name, resource: offer?.resource ?? 'https://vet402.com/api/tokyo/seller', method: offer?.method ?? 'GET',
        amountUsd: offer ? Number(offer.amount) / 1e6 : 0.01,
        fetch: g.fetch, account: i.payer, apiUrl: i.apiUrl, ...(i.apiKey ? { apiKey: i.apiKey } : {}),
        source: 'tokyo-demo', chainReader: i.chainReader, chainReaderCrossCheck: i.chainReaderCrossCheck,
      },
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith('agent_policy_missing')) {
      out(`[P] ${tag('policy')}${msg.slice(0, 220)}`);
      out('REFUSE agent_policy_missing');
      return done({ verdict: 'REFUSE', reasons: ['agent_policy_missing'], stoppedAt: 'policy', screening, result: null });
    }
    throw e;
  }
  if (sent) {
    const p = sent.policy;
    out(`[P] ${tag('policy')}${i.agentName} x402-policy via ${i.expectedResolver}: trust ${sent.ens.policy.trustedAttesters.map((a: any) => `${a.name}=${a.address}`).join(', ')}; minEnsAttestations ${p.evidence.minEnsAttestations}, minChainReceipts ${p.evidence.minChainReceipts}, requireVet402Allow ${p.requireVet402Allow}, max ${p.maxPerTxUsd} USDC`);
  }

  const d = result.decision;
  const gate = (d.ens ?? []).find((e: any) => e.pass === 'gate');
  if (gate) {
    for (const s of gate.trace) {
      const t = s.status === 'ok' ? 'ok  ' : s.status === 'fail' ? 'FAIL' : 'skip';
      const det = Object.entries(s.detail).map(([k, v]) => `${k}=${v}`).join('  ');
      out(`[${s.step}] ${tag('ENS')}[${t}] ${STEP_NAMES[s.step].padEnd(14)} ${det}`);
    }
    out(`[E] ${tag('ENSIP-29')}${gate.ok ? `VALID (${gate.valid} valid attestation(s))` : `REFUSE ${gate.reason_codes.join(', ')}`}`);
  }

  // ---- D: what the SDK asked vet402 ----
  if (g.api.length === 0) {
    out(`[D] ${tag('vet402 API')}vet402 API: not asked (the payment stopped before the /decision call)`);
  } else if (g.api.some(c => c.unreachable) && (d.reason_codes.includes('vet402_unreachable') || d.reason_codes.includes('evidence_unavailable'))) {
    out(`[D] ${tag('vet402 API')}${UNREACHABLE_LINE}`);
    for (const c of g.api) out(`[D] ${tag('')}asked ${c.path} -> ${c.outcome}`);
  } else {
    const verdict = d.decision?.recommendation ?? d.payeeScore?.recommendation ?? null;
    out(`[D] ${tag('vet402 API')}answered: ${g.api.map(c => `${c.path} -> ${c.outcome}`).join(' ; ')}${verdict ? `  (verdict ${verdict}${d.payeeScore?.score != null ? ' score ' + d.payeeScore.score : ''})` : ''}`);
  }

  // ---- C: floors ----
  const met = d.policy_override?.floors_met ?? [];
  const chainRow = (d.evidence ?? []).find((r: any) => r.source === 'chain');
  if (met.length) out(`[C] ${tag('floors')}${met.map((m: any) => `${m.floor} ${m.observed}/${m.required} (${m.source})`).join(', ')}`);
  else if (chainRow) out(`[C] ${tag('chain')}${chainRow.receipts} receipt(s) to payTo on ${chainRow.url} up to block ${chainRow.block?.number}`);

  // ---- 4: the 402 ----
  if (result.challenge) {
    const a = result.challenge;
    const bad = d.reason_codes.filter((r: string) => RESOURCE_402_WORDS.has(r));
    out(`[Q] ${tag('402')}${bad.length ? `402 differs from the attested offer: ${bad.join(', ')}` : '402 matches the attested offer'} (amount ${a.amount}, payTo ${a.payTo}, ${a.network})`);
  }
  const recheck = (d.ens ?? []).find((e: any) => e.pass === 'recheck');
  if (recheck) out(`[R] ${tag('recheck')}ENSIP-29 read again before the signature: ${recheck.ok ? 'VALID, same offer' : 'REFUSE ' + recheck.reason_codes.join(', ')}`);

  // ---- U: why an unknown payee is paid ----
  if (unknownPayee && result.status !== 'refused') {
    if (!gate?.ok) throw new Error('unknown payee: the SDK went past the ENS gate without a VALID attestation');
    const amt = result.challenge?.amount ?? offer!.amount;
    out(`[U] ${tag('unknown')}paying an unknown payee because the ENS attestation is VALID (${gate.valid}) and the amount ${Number(amt) / 1e6} USDC <= ${Number(UNKNOWN_PAYEE_MAX_UNITS) / 1e6} USDC`);
  }

  // ---- X: verdict ----
  const reasons: string[] = d.reason_codes.filter((r: string) => r !== 'settle_failed');
  if (result.status === 'refused') {
    out(`REFUSE ${reasons.join(', ')}  (verdict_source ${d.verdict_source}; nothing signed)`);
    return done({ verdict: 'REFUSE', reasons, stoppedAt: 'sdk', screening, result });
  }
  if (!i.live) {
    // status "failed" with the dry payer: the SDK reached the signer, got no signature, and the request was blocked.
    const ok = g.blocked() > 0 && g.paymentsSent() === 0 && d.recommendation === 'ALLOW';
    if (!ok) throw new Error(`dry-run guard: unexpected SDK outcome ${result.status} (blocked ${g.blocked()}, sent ${g.paymentsSent()})`);
    const td = (i.payer as any).asked?.[0];
    const what = td ? `TransferWithAuthorization ${Number(td.message.value) / 1e6} USDC -> ${td.message.to} (chainId ${td.domain.chainId})` : 'the payment';
    out(`[X] ${tag('sign')}stopped before signing: the payer here holds no key (${what} was not signed; the paid request never left this process)`);
    out(`ALLOW ${reasons.join(', ')}  (verdict_source ${d.verdict_source}; dry-run: nothing signed, nothing sent)`);
    return done({ verdict: 'ALLOW', reasons, stoppedAt: 'sign', screening, result });
  }
  if (result.status === 'paid') {
    out(`[X] ${tag('paid')}Base Sepolia tx ${result.txHash}  https://sepolia.basescan.org/tx/${result.txHash}`);
    out(`ALLOW ${reasons.join(', ')}  (verdict_source ${d.verdict_source}; paid)`);
    return done({ verdict: 'PAID', reasons, stoppedAt: 'paid', screening, result });
  }
  out(`[X] ${tag('failed')}signed: ${result.signed}, tx ${result.txHash ?? '-'}, nonce ${result.nonce ?? '-'} (${d.reason_codes.join(', ')})`);
  out(`FAILED ${d.reason_codes.join(', ')}`);
  return done({ verdict: 'FAILED', reasons: d.reason_codes, stoppedAt: 'paid', screening, result });
}
