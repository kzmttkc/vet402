#!/usr/bin/env -S npx tsx
// keys.ts: the six testnet keys used during ETHGlobal Tokyo 2026 (PLAN_v4.3 section 10).
//
//   npx tsx src/keys.ts init        create K_atst, W_obs, W_op, W_pay, K_ag1, K_ag2 when missing
//   npx tsx src/keys.ts addresses   print the addresses only
//
// Private keys go to examples/tokyo-2026-demo/.env.tokyo.local (mode 600, git-ignored) and nowhere else:
// not stdout, not a log, not a commit. Only addresses are printed. A key already in the file is never
// replaced. W_vet and W_ens are not created here (they already exist and belong to the owner).
import fs from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { KEY_SPECS, envFilePath, parseEnv } from './lib/env.ts';

function readFileEnv(file: string): Record<string, string> {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
}

function appendLines(file: string, lines: string[]): void {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, (cur && !cur.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n'); } finally { fs.closeSync(fd); }
  fs.chmodSync(file, 0o600);
}

const addrOf = (pk: string): string => privateKeyToAccount((pk.startsWith('0x') ? pk : '0x' + pk) as `0x${string}`).address;

function init(): number {
  const file = envFilePath();
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  const before = readFileEnv(file);
  const header = fs.existsSync(file) ? [] : ['# ETHGlobal Tokyo 2026 testnet keys. mode 600. Never commit, never print.'];
  const lines: string[] = [...header];
  const report: string[] = [];
  for (const k of KEY_SPECS) {
    const pk = before[k.pk];
    if (pk) {
      const a = addrOf(pk);
      if (before[k.addr] && before[k.addr].toLowerCase() !== a.toLowerCase()) {
        report.push(`  ${k.id.padEnd(6)} ${a}  既にある（注意: ${k.addr} が鍵と違う値。手で直す）`);
      } else {
        if (!before[k.addr]) lines.push(`${k.addr}=${a}`);
        report.push(`  ${k.id.padEnd(6)} ${a}  既にある（上書きしない）`);
      }
      continue;
    }
    if (before[k.addr]) {
      report.push(`  ${k.id.padEnd(6)} ${before[k.addr]}  ${k.addr} だけがあり鍵が無い。上書きしないので止める`);
      process.exitCode = 2;
      continue;
    }
    const fresh = generatePrivateKey();
    const a = privateKeyToAccount(fresh).address;
    lines.push(`${k.pk}=${fresh}`, `${k.addr}=${a}`);
    report.push(`  ${k.id.padEnd(6)} ${a}  新しく作った（${k.role}）`);
  }
  if (lines.length > header.length || header.length) appendLines(file, lines);
  const mode = (fs.statSync(file).mode & 0o777).toString(8);
  console.log(`keys.ts init -> ${file} (mode ${mode})`);
  for (const r of report) console.log(r);
  console.log('秘密鍵はファイルにだけ書いた。控え: cp <file> ~/tokyo-keys-backup.env && chmod 600 ~/tokyo-keys-backup.env');
  return process.exitCode === 2 ? 2 : 0;
}

function addresses(): number {
  const file = envFilePath();
  const env = readFileEnv(file);
  console.log(`keys.ts addresses <- ${file}`);
  for (const k of KEY_SPECS) {
    const a = env[k.pk] ? addrOf(env[k.pk]) : env[k.addr];
    console.log(`  ${k.id.padEnd(6)} ${a ?? '(まだ無い)'}`);
  }
  return 0;
}

const cmd = process.argv[2];
try {
  if (cmd === 'init') process.exitCode = init();
  else if (cmd === 'addresses') process.exitCode = addresses();
  else {
    console.log('usage: npx tsx src/keys.ts <init|addresses>\n  init       create the six testnet keys that are missing (addresses only are printed)\n  addresses  print the addresses');
    process.exitCode = cmd === '--help' || cmd === '-h' ? 0 : 1;
  }
} catch (e: any) {
  // viem errors can quote their input. Print only the class of the failure, never the value.
  console.error(`keys.ts: ${e?.name ?? 'Error'}: 失敗した（詳細は秘密を含み得るので出さない）`);
  process.exitCode = 1;
}
