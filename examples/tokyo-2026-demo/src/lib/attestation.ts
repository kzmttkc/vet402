/* eslint-disable @typescript-eslint/no-explicit-any -- ETHGlobal Tokyo 2026: viem ABI helpers and JSON from RPCs are loosely typed here; behaviour is pinned by tests. */
// Check an ENSIP-29 envelope against the chain before it is published (admin.ts publish-attestations).
// Same reconstruction as the draft's verification steps 1-7: the payload is rebuilt from ENS data
// (manager from findExactOwner, value from x402-offer) and the envelope's t; the signature must recover to
// the pinned attester address, and atst.vet402.eth must resolve to that same address. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { getAddress, keccak256, recoverMessageAddress, type Address } from 'viem';
import { DEMO_DIR } from './env.ts';

export type EnvelopeCheck = { name: string; ok: boolean; why: string; t: number | null; ageSeconds: number | null; recovered: string | null };

export function pinnedAttesterPolicy(): { name: string; address: Address; maxAgeSeconds: number } {
  const j = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'trusted-attesters.json'), 'utf8'));
  const a = (j.trustedAttesters ?? []).find((x: any) => x.name === 'atst.vet402.eth');
  if (!a) throw new Error('trusted-attesters.json に atst.vet402.eth が無い');
  return { name: a.name, address: getAddress(a.address), maxAgeSeconds: typeof j.maxAgeSeconds === 'number' ? j.maxAgeSeconds : 86_400 };
}

export async function checkEnvelopeOnChain(ens: any, clients: any, B: bigint, blockTs: number, name: string, envelope: string, futureSkew = 300): Promise<EnvelopeCheck> {
  const att = pinnedAttesterPolicy();
  const fail = (why: string, t: number | null = null, recovered: string | null = null): EnvelopeCheck =>
    ({ name, ok: false, why, t, ageSeconds: t === null ? null : blockTs - t, recovered });
  const d = ens.decodeEnvelope(envelope);
  if ('error' in d) return fail(d.error);
  if (d.version !== 1) return fail(`envelope version ${d.version} (publish only the draft's version 1)`);
  const manager = await ens.findExactOwner(clients, B, name);
  if (!manager) return fail(`findExactOwner(${name}) is 0x0`, d.t);
  const v = (await ens.resolveText(clients, B, name, 'x402-offer')).value;
  if (!v) return fail(`x402-offer of ${name} is empty`, d.t);
  const payload = ens.encodePayload({ n: ens.normalizeName(name), a: manager, k: 'x402-offer', v, t: d.t }, 'ensip29-draft');
  const recovered = await recoverMessageAddress({ message: { raw: keccak256(payload) }, signature: d.sig });
  if (recovered !== att.address) return fail(`signature recovers to ${recovered}, not ${att.name}=${att.address} (the offer or the owner changed after signing, or another key signed)`, d.t, recovered);
  const onChain = (await ens.resolveAddr(clients, B, att.name)).value;
  if (onChain !== att.address) return fail(`${att.name} resolves to ${onChain ?? '(none)'}, not the pinned ${att.address}`, d.t, recovered);
  const age = blockTs - d.t;
  if (d.t > blockTs + futureSkew) return fail(`t=${d.t} is ${d.t - blockTs}s in the future`, d.t, recovered);
  if (age > att.maxAgeSeconds) return fail(`t=${d.t} is ${age}s old (trusted-attesters.json maxAgeSeconds ${att.maxAgeSeconds})`, d.t, recovered);
  return { name, ok: true, why: `recovers to ${att.name}=${recovered}; t=${d.t} (${new Date(d.t * 1000).toISOString()}), ${age}s old, valid for ${att.maxAgeSeconds - age}s more`, t: d.t, ageSeconds: age, recovered };
}
