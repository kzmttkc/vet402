// Read-only JSON-RPC and eth_simulateV1 helpers. Nothing in this file signs or sends.
import { decodeErrorResult, toEventSelector, toHex, type Hex } from 'viem';
import { ALL_ERRORS, ALL_EVENTS } from './abi.ts';

const READ_ONLY = new Set([
  'eth_call', 'eth_simulateV1', 'eth_getCode', 'eth_gasPrice', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getBalance', 'eth_chainId', 'eth_estimateGas', 'eth_maxPriorityFeePerGas',
]);

export async function rpc<T = any>(url: string, method: string, params: unknown[], timeoutMs = 60_000): Promise<T> {
  if (!READ_ONLY.has(method)) throw new Error(`read-only helper refuses ${method}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result as T;
}

export async function pickRpc(urls: string[]): Promise<string> {
  const errs: string[] = [];
  for (const u of urls) {
    try { await rpc(u, 'eth_blockNumber', [], 20_000); return u; } catch (e: any) { errs.push(`${hostOf(u)}: ${String(e.message || e).slice(0, 120)}`); }
  }
  throw new Error('どの RPC も読めない: ' + errs.join(' / '));
}

/** Only the host is printed, so an API key in the path or query never reaches stdout. */
export const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return '(invalid url)'; } };

export type SimCall = { from: string; to: string; data?: Hex; value?: bigint };
export type SimBlock = { calls: SimCall[]; time?: number };
/** Per-call gas cap in simulations only (the largest K1 row uses ~0.92M). Never used for sending.
 *  Kept small because public RPCs cap the total gas of one eth_simulateV1 request (~50M on sentio):
 *  32 rows x 1.4M = 44.8M stays under it. */
export const SIM_CALL_GAS = 1_400_000;

export type SimResult = { status: 'OK' | 'REVERT'; gas: number; logs: string[]; error?: string; returnData: Hex };

export async function simulateBlocks(blocks: SimBlock[], blockNumber: bigint, urls: string[]): Promise<{ rpc: string; blocks: SimResult[][] }> {
  // Each call gets its own gas cap. Without it, a row that fails by burning all of its gas
  // (e.g. a CREATE2 re-deploy of a proxy that is already on chain) eats the whole block, and
  // every later call in the simulation dies with "intrinsic gas too low" (seen 2026-09-25 22:1x).
  const blockStateCalls = blocks.map(b => ({
    ...(b.time === undefined ? {} : { blockOverrides: { time: toHex(b.time) } }),
    calls: b.calls.map(c => ({ from: c.from, to: c.to, gas: toHex(SIM_CALL_GAS), ...(c.data ? { data: c.data } : {}), ...(c.value ? { value: toHex(c.value) } : {}) })),
  }));
  const errs: string[] = [];
  for (const u of urls) {
    try {
      const r: any[] = await rpc(u, 'eth_simulateV1', [{ blockStateCalls, validation: false }, toHex(blockNumber)]);
      return {
        rpc: u,
        blocks: r.map(b => b.calls.map((c: any): SimResult => {
          const ok = c.status === '0x1';
          return {
            status: ok ? 'OK' : 'REVERT',
            gas: parseInt(c.gasUsed, 16),
            logs: (c.logs || []).map((l: any) => EVENT_NAMES[l.topics?.[0]] ?? String(l.topics?.[0] ?? '').slice(0, 10)),
            error: ok ? undefined : decodeRevert(c.error?.data ?? c.returnData),
            returnData: c.returnData,
          };
        })),
      };
    } catch (e: any) { errs.push(`${hostOf(u)}: ${String(e.message || e).slice(0, 160)}`); }
  }
  throw new Error('eth_simulateV1 が全 RPC で失敗: ' + errs.join(' / '));
}

const EVENT_NAMES: Record<string, string> = {};
for (const e of ALL_EVENTS) { try { EVENT_NAMES[toEventSelector(e)] = e.name; } catch { /* skip */ } }

export function decodeRevert(data: unknown): string {
  if (typeof data !== 'string' || data === '0x') return 'revert (no data)';
  try {
    const d = decodeErrorResult({ abi: ALL_ERRORS, data: data as Hex });
    return d.errorName + '(' + (d.args || []).map(a => typeof a === 'bigint' ? '0x' + a.toString(16) : String(a)).join(',') + ')';
  } catch { return 'raw:' + data.slice(0, 138); }
}
