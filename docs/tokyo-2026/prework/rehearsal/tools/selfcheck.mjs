#!/usr/bin/env node
// 完成品の自己点検: 構文・import の解決・読むファイルの実在・セッション固有の絶対パスの残り。
// ネットワークには出ない。exit 0=問題なし / 2=問題あり
import fs from 'node:fs'; import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (e.name.endsWith('.mjs')) files.push(p); } };
walk(path.join(R, 'checks')); walk(path.join(R, 'lib')); walk(path.join(R, 'tools')); files.push(path.join(R, 'run.mjs'));
files.sort();

let bad = 0; const say = (...a) => { bad++; console.log('NG:', ...a); };
let nImports = 0, nReads = 0;
const BANNED = [/\/private\/tmp\/claude-\d+\//, /\/Users\/[a-z]+\/vouch/];

for (const f of files) {
  const rel = path.relative(R, f);
  const src = fs.readFileSync(f, 'utf8');
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { say(rel, '構文エラー', String(e.stderr).split('\n').slice(0, 3).join(' ')); continue; }
  for (const re of BANNED) if (re.test(src)) say(rel, 'セッション固有の絶対パスが残っている', src.match(re)[0]);
  const req = createRequire(f);
  for (const m of src.matchAll(/(?:^|\n)\s*import[^'"\n]*from\s*['"]([^'"]+)['"]/g)) {
    nImports++;
    const s = m[1];
    if (s.startsWith('.')) { if (!fs.existsSync(new URL(s, pathToFileURL(f)))) say(rel, '相対 import の先が無い ->', s); }
    else if (s.startsWith('node:')) { /* 組込み */ }
    else { try { req.resolve(s); } catch { say(rel, 'パッケージを解決できない ->', s); } }
  }
  // 読むファイルだけ実在を見る（書き先は走らせれば作られる）
  for (const m of src.matchAll(/readFileSync\(\s*new URL\(['"]([^'"]+)['"]\s*,\s*import\.meta\.url\)/g)) {
    nReads++;
    if (!fs.existsSync(new URL(m[1], pathToFileURL(f)))) say(rel, '読む先のファイルが無い ->', m[1]);
  }
  for (const m of src.matchAll(/const\s+\w+\s*=\s*new URL\(['"]([^'"]+\.jsonl?)['"]\s*,\s*import\.meta\.url\)/g)) {
    if (/readFileSync\(\s*LOG|readFileSync\(\s*OUT/.test(src)) { nReads++; if (!fs.existsSync(new URL(m[1], pathToFileURL(f)))) say(rel, '読む先のファイルが無い ->', m[1]); }
  }
}
console.log(`自己点検: ${files.length} 本 / import ${nImports} 件 / 読むファイル ${nReads} 件 / NG ${bad} 件`);
process.exit(bad ? 2 : 0);
