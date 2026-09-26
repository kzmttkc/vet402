// Local env for the operator scripts (keys.ts, admin.ts).
// Everything secret or deployment-specific (RPC URLs, private keys, API keys) comes from
// examples/tokyo-2026-demo/.env.tokyo.local (mode 600, git-ignored). The only default URLs here are the public
// Sepolia pair of sepoliaRpcsOrPublic(), for commands that read or simulate only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Path of the local env file. TOKYO_ENV_FILE overrides it (used to test keys.ts in a temp dir). */
export const envFilePath = (): string => process.env.TOKYO_ENV_FILE || path.join(DEMO_DIR, '.env.tokyo.local');

/** Parse KEY=VALUE lines. Comments and blank lines are skipped. Quotes around the value are removed. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Load the env file into process.env without overriding values already set in the shell. */
export function loadEnvFile(file = envFilePath()): { file: string; loaded: boolean } {
  if (!fs.existsSync(file)) return { file, loaded: false };
  const kv = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(kv)) if (process.env[k] === undefined) process.env[k] = v;
  return { file, loaded: true };
}

export function requireEnv(name: string, why: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} が無い（${why}）。${envFilePath()} に ${name}=... を足してから打ち直す`);
  return v;
}

// ---- key names (keys.ts writes them, admin.ts reads them) ----
export type KeyId = 'K_atst' | 'W_obs' | 'W_op' | 'W_pay' | 'K_ag1' | 'K_ag2';
export const KEY_SPECS: ReadonlyArray<{ id: KeyId; pk: string; addr: string; role: string }> = [
  { id: 'K_atst', pk: 'TOKYO_K_ATST_PRIVATE_KEY', addr: 'TOKYO_K_ATST_ADDRESS', role: 'signs ENSIP-29 offer attestations (atst.vet402.eth addr)' },
  { id: 'W_obs', pk: 'TOKYO_W_OBS_PRIVATE_KEY', addr: 'TOKYO_W_OBS_ADDRESS', role: 'writes the 15 observation-log keys on R_vet' },
  // W_op keeps the production env name: the /tokyo judge button reads TOKYO_OPERATOR_PRIVATE_KEY.
  { id: 'W_op', pk: 'TOKYO_OPERATOR_PRIVATE_KEY', addr: 'TOKYO_W_OP_ADDRESS', role: 'may write x402-offer on P_a and P_d only' },
  { id: 'W_pay', pk: 'TOKYO_W_PAY_PRIVATE_KEY', addr: 'TOKYO_W_PAY_ADDRESS', role: 'Base Sepolia payer (USDC)' },
  { id: 'K_ag1', pk: 'TOKYO_K_AG1_PRIVATE_KEY', addr: 'TOKYO_K_AG1_ADDRESS', role: 'agent-1.vet402.eth key (x402-policy on P_AG1)' },
  { id: 'K_ag2', pk: 'TOKYO_K_AG2_PRIVATE_KEY', addr: 'TOKYO_K_AG2_ADDRESS', role: 'agent-2.vet402.eth key (control, no own resolver)' },
];

// Owner keys. Only `--live` reads them. keys.ts never creates them.
export const OWNER_PK_ENV = { W_vet: 'W_VET_PRIVATE_KEY', W_ens: 'W_ENS_PRIVATE_KEY' } as const;

// ---- RPC ----
// eth_simulateV1 is not served by ethpandaops (-32601, and it takes 25 s to fail) [rehearsal 2026-09-19].
const NO_SIMULATE = [/ethpandaops\.io/];

export function sepoliaRpcs(): { read: string[]; sim: string[] } {
  const read = ['ENS_SEPOLIA_RPC_URL', 'ENS_SEPOLIA_RPC_URL_2', 'ENS_SEPOLIA_RPC_URL_3']
    .map(k => process.env[k]).filter((x): x is string => !!x);
  if (!read.length) requireEnv('ENS_SEPOLIA_RPC_URL', 'Sepolia の読み取りと eth_simulateV1 に使う');
  const simEnv = process.env.TOKYO_SIM_RPC_URL ? [process.env.TOKYO_SIM_RPC_URL] : [];
  const sim = [...new Set([...simEnv, ...read.filter(u => !NO_SIMULATE.some(r => r.test(u)))])];
  if (!sim.length) throw new Error('eth_simulateV1 を受ける Sepolia RPC が env に無い（ethpandaops は受けない）。ENS_SEPOLIA_RPC_URL か TOKYO_SIM_RPC_URL を足す');
  return { read, sim };
}

/** The public Sepolia pair that `run.ts verify` defaults to (two different providers). */
export const PUBLIC_SEPOLIA_RPCS = ['https://sepolia.rpc.sentio.xyz', 'https://rpc.sepolia.ethpandaops.io'] as const;

/**
 * Like sepoliaRpcs(), but with no env it falls back to verify's public pair instead of stopping. For read-only
 * and simulate-only commands (observe.ts --check / --dry-run). Anything that sends keeps using sepoliaRpcs().
 */
export function sepoliaRpcsOrPublic(): { read: string[]; sim: string[]; source: 'env' | 'public defaults' } {
  if (['ENS_SEPOLIA_RPC_URL', 'ENS_SEPOLIA_RPC_URL_2', 'ENS_SEPOLIA_RPC_URL_3'].some(k => process.env[k])) return { ...sepoliaRpcs(), source: 'env' };
  const read = [...PUBLIC_SEPOLIA_RPCS];
  const simEnv = process.env.TOKYO_SIM_RPC_URL ? [process.env.TOKYO_SIM_RPC_URL] : [];
  const sim = [...new Set([...simEnv, ...read.filter(u => !NO_SIMULATE.some(r => r.test(u)))])];
  return { read, sim, source: 'public defaults' };
}

export const baseSepoliaRpc = (): string => requireEnv('BASE_SEPOLIA_RPC_URL', 'k1b の BS-01 / BS-02（Base Sepolia）に使う');

/**
 * Append KEY=VALUE to the env file (created with mode 600). Never rewrites existing lines.
 * Refuses when KEY is already present, so nothing already written can be replaced.
 */
export function appendEnvLine(key: string, value: string, file = envFilePath()): void {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (parseEnv(cur)[key] !== undefined) throw new Error(`${key} は ${file} に既にある。上書きしない`);
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, (cur && !cur.endsWith('\n') ? '\n' : '') + `${key}=${value}\n`); } finally { fs.closeSync(fd); }
  fs.chmodSync(file, 0o600);
}

/**
 * B5c (re-sign before the 09-27 09:00 deadline) runs unattended: the owner delegated the typed y for this one step
 * on 2026-09-26 06:57 JST. Only when TOKYO_B5C_AUTOCONFIRM equals the JST date 2026-09-27, and only for
 * `attester.ts --live-pay` and `admin.ts publish-attestations --live`. Every other gate still runs.
 */
export function b5cAutoConfirm(what: string): boolean {
  const jst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  // 2026-09-26 (the 19:00 JST safety re-sign, delegated 10:38 JST) and 2026-09-27 (B5c, delegated 06:57 JST) only.
  const day = process.env.TOKYO_B5C_AUTOCONFIRM;
  const ok = (day === '2026-09-26' || day === '2026-09-27') && jst === day;
  if (ok) console.log(`  auto-confirm (re-sign on ${day}, delegated by the owner): ${what}`);
  return ok;
}
