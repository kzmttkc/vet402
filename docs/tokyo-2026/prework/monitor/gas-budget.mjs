// ~/hackathon-monitor/gas-budget.mjs — **数字を1つも持たない。転送するだけ。**
//
// 正典は private リポの `rehearsal/lib/gas-budget.mjs` 1本だけ。
// ここに GAS_BUDGET を写すと、preflight と B0 と PLAN §4 の3か所で数字が割れる。
// 見つからなければ**黙って通さず throw する**（呼び手の preflight が1項目の NG として出す）。
//
// 置き場所を指す順番:
//   1. TOKYO_GAS_BUDGET       ファイルを直に指す
//   2. TOKYO_REHEARSAL_DIR    rehearsal/ のディレクトリを指す
//   3. ~/tokyo-2026/.company/departments/hackathon/tokyo-2026/rehearsal/lib/gas-budget.mjs
//      （会期用に固定した worktree。作り方は PLAN §5.5 の確定コマンド）
//   4. ~/Takeshi_Automation/.company/…/rehearsal/lib/gas-budget.mjs
//      （共有ツリーに kabau-trust-board が checkout されているときだけ在る）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REL = '.company/departments/hackathon/tokyo-2026/rehearsal/lib/gas-budget.mjs';
export const CANDIDATES = [
  process.env.TOKYO_GAS_BUDGET,
  process.env.TOKYO_REHEARSAL_DIR && path.join(process.env.TOKYO_REHEARSAL_DIR, 'lib/gas-budget.mjs'),
  path.join(os.homedir(), 'tokyo-2026', REL),
  path.join(os.homedir(), 'Takeshi_Automation', REL),
].filter(Boolean);

const found = CANDIDATES.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!found) {
  throw new Error('ガスの関門の正典が見つからない。TOKYO_GAS_BUDGET か TOKYO_REHEARSAL_DIR で指す。探した場所: ' + CANDIDATES.join(' / '));
}
export const CANON_PATH = found;

const m = await import(pathToFileURL(found).href);
export const GAS_BUDGET = m.GAS_BUDGET;
export const GAS_SAFETY = m.GAS_SAFETY;
export const PRESS_GAS = m.PRESS_GAS;
export const W_OP_FLOOR_WEI = m.W_OP_FLOOR_WEI;
export const BS03_WEI = m.BS03_WEI;
export const KEYS = m.KEYS;
export const needWei = m.needWei;
export const survivableGwei = m.survivableGwei;
export const reserveWei = m.reserveWei;
export const evaluateGasBudget = m.evaluateGasBudget;
export const readGasBudget = m.readGasBudget;
