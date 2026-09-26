#!/usr/bin/env -S npx tsx
// gen-for-reviewers.ts: prints docs/tokyo-2026/for-reviewers.md for one frozen commit (PLAN_v4.3 section 8.3).
//
//   npx tsx src/gen-for-reviewers.ts --sha <commit> > ../../docs/tokyo-2026/for-reviewers.md
//
// Every line anchor is looked up at that commit with `git grep -n -F` when this runs. Nothing is copied by
// hand: a pattern that matches zero lines or more than one line stops the run (exit 1) instead of printing
// a link that points at the wrong line. The output goes to stdout only; this file writes nothing.
// Only erasable TypeScript is used, so `node src/gen-for-reviewers.ts` runs it too (Node 22.18 or later).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_URL = 'https://github.com/kzmttkc/vet402';
const SUBMISSION_TAG = 'tokyo-2026-submission';
const LIVE_URL = 'https://vet402.com/tokyo?name=seller-a.eth';
const ONE_LINE =
  `git clone --depth 1 --branch ${SUBMISSION_TAG} ${REPO_URL} && cd vet402/examples/tokyo-2026-demo && npm ci && npm run verify -- seller-a.eth`;

type Anchor = { label: string; file: string; pattern: string };

// ENS: what a reviewer for the ENS prizes should open, in reading order.
const ENS_ANCHORS: Anchor[] = [
  { label: 'The seven-step ENSIP-29 draft check that the CLI, /tokyo and the payment path all run', file: 'packages/sdk/src/ens-attestation.ts', pattern: 'export async function checkEnsOffer(' },
  { label: 'Step 7: one changed character in the offer gives a different signer, and the check refuses', file: 'packages/sdk/src/ens-attestation.ts', pattern: 'fail(7, "ens_attestation_signer_mismatch"' },
  { label: 'Every ENS read happens on two RPC providers at one pinned block', file: 'packages/sdk/src/ens-read.ts', pattern: 'export async function pinBlock(' },
  { label: 'The agent still asks vet402; only a transport error or a 5xx counts as unreachable', file: 'packages/sdk/src/pay-or-refuse.ts', pattern: 'if (!(mayWaiveUnreachable && response.status >= 500' },
  { label: 'When vet402 is unreachable, the waiver is written into the decision line', file: 'packages/sdk/src/pay-or-refuse.ts', pattern: 'waived = { source: "vet402_unreachable"' },
  { label: 'The agent\'s declared floor on valid ENS attestations', file: 'packages/sdk/src/pay-or-refuse.ts', pattern: 'const ensFloor = input.policy?.evidence?.minEnsAttestations;' },
  { label: 'Enhanced Access Control: the seller\'s server key (W_op) gets one text key on seller-d.eth\'s resolver', file: 'examples/tokyo-2026-demo/src/lib/k1.ts', pattern: "E('K1-D4'" },
  { label: 'The same key tries to write the attestation next to it, and the resolver reverts', file: 'src/app/api/tokyo/_lib/verify.ts', pattern: 'functionName: "setText", args: [NODE, ATTESTATION_KEY' },
  { label: 'The agent is a subname: agent-1.vet402.eth is registered in vet402\'s own UserRegistry', file: 'examples/tokyo-2026-demo/src/lib/k1.ts', pattern: "V('K1-13'" },
  { label: 'Revoking the agent\'s subname takes its policy away', file: 'examples/tokyo-2026-demo/src/admin.ts', pattern: "if (o.cmd === 'agent-off') return" },
  { label: 'The attester\'s six steps before it signs', file: 'examples/tokyo-2026-demo/src/attester.ts', pattern: '// Six steps per name.' },
  { label: 'The observation log is not a seller\'s name: no addr is ever written', file: 'examples/tokyo-2026-demo/src/observe.ts', pattern: '// under the reserved label `obs`, answered by R_vet. No addr' },
  { label: 'The judge button can reach only seller-d.eth: its resolver, name, key and two values are constants', file: 'src/app/api/tokyo/_lib/constants.ts', pattern: 'export const P_D =' },
];

// Intercepta: the screening stage of `pay`.
const INTERCEPTA_ANCHORS: Anchor[] = [
  { label: 'The quick-scan request (screening.ts is the only file that calls the API)', file: 'examples/tokyo-2026-demo/src/screening.ts', pattern: 'const got = await getOnce(`${QUICK_SCAN_BASE}/${address}/quick-scan`' },
  { label: 'No risk record on the payee: ask Check Address Activity on Base mainnet (chainId 8453)', file: 'examples/tokyo-2026-demo/src/screening.ts', pattern: 'const got = await getOnce(`${CHECK_ACTIVITY_BASE}/${q.address}/check-activity' },
  { label: 'The traits that block a payment on their own', file: 'examples/tokyo-2026-demo/src/screening.ts', pattern: 'export const BLOCKING_TRAITS' },
  { label: 'A 404 is "unavailable", and unavailable does not pay', file: 'examples/tokyo-2026-demo/src/screening.ts', pattern: 'if (got.status === 404) return unavailable(' },
  { label: 'pay screens the payTo and the payer before any proof is checked', file: 'examples/tokyo-2026-demo/src/lib/pay-flow.ts', pattern: 'screening = await i.screen({ payTo: offer.payTo, payer: i.payerAddress });' },
  { label: 'An unknown payee above 0.01 USDC stops for a person', file: 'examples/tokyo-2026-demo/src/lib/pay-flow.ts', pattern: "return done({ verdict: 'REFUSE', reasons: ['payee_unknown_needs_human'], stoppedAt: 'screening'" },
  { label: 'A block or unavailable answer stops the payment there', file: 'examples/tokyo-2026-demo/src/lib/pay-flow.ts', pattern: "return done({ verdict: 'REFUSE', reasons: [r], stoppedAt: 'screening'" },
  { label: 'The /tokyo page and its API routes do not call Intercepta (test)', file: 'tests/tokyo-mutate.test.ts', pattern: 'test("/tokyo と /api/tokyo から Intercepta を呼ばない' },
];

// Files linked as a whole (no line anchor). Each must exist at the commit.
const WHOLE_FILES = {
  readme: 'examples/tokyo-2026-demo/README.md',
  attesterSpec: 'docs/tokyo-2026/attester-spec.md',
  trustList: 'examples/tokyo-2026-demo/trusted-attesters.json',
  screeningTest: 'examples/tokyo-2026-demo/test/screening.test.mjs',
};

function fail(msg: string): never {
  process.stderr.write(`gen-for-reviewers: ${msg}\n`);
  process.exit(1);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseArgs(argv: string[]): { sha: string } {
  let sha = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sha') sha = String(argv[++i] ?? '');
    else if (a.startsWith('--sha=')) sha = a.slice('--sha='.length);
    else fail(`unknown argument ${a}. usage: npx tsx src/gen-for-reviewers.ts --sha <commit>`);
  }
  if (!sha) fail('usage: npx tsx src/gen-for-reviewers.ts --sha <commit>');
  return { sha };
}

function resolveSha(root: string, ref: string): string {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
  } catch {
    return fail(`${ref} is not a commit in ${root}`);
  }
}

/** The commit a tag points at, or null when the tag does not exist. */
function tagSha(root: string, tag: string): string | null {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

function existsAt(root: string, sha: string, file: string): boolean {
  try {
    git(root, ['cat-file', '-e', `${sha}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

/** The one line number where `pattern` occurs in `file` at `sha`. Zero or several matches stop the run. */
function lineOf(root: string, sha: string, a: Anchor): number {
  let out = '';
  try {
    out = git(root, ['grep', '-n', '-F', '-e', a.pattern, sha, '--', a.file]);
  } catch {
    return fail(`no line matches ${JSON.stringify(a.pattern)} in ${a.file} at ${sha}`);
  }
  const lines = out.split('\n').filter((l) => l.length > 0);
  if (lines.length !== 1) fail(`${lines.length} lines match ${JSON.stringify(a.pattern)} in ${a.file} at ${sha}; make the pattern unique`);
  const prefix = `${sha}:${a.file}:`;
  if (!lines[0].startsWith(prefix)) fail(`unexpected git grep output: ${lines[0].slice(0, 120)}`);
  const n = Number(lines[0].slice(prefix.length).split(':', 1)[0]);
  if (!Number.isInteger(n) || n < 1) fail(`could not read a line number from: ${lines[0].slice(0, 120)}`);
  return n;
}

const blob = (sha: string, file: string): string => `${REPO_URL}/blob/${sha}/${file}`;

function anchorRows(root: string, sha: string, list: Anchor[]): string[] {
  const rows = ['| What | Where |', '|---|---|'];
  for (const a of list) {
    const n = lineOf(root, sha, a);
    rows.push(`| ${a.label} | [\`${a.file}#L${n}\`](${blob(sha, a.file)}#L${n}) |`);
  }
  return rows;
}

function render(root: string, sha: string): string {
  for (const f of [WHOLE_FILES.readme, WHOLE_FILES.attesterSpec, WHOLE_FILES.trustList, WHOLE_FILES.screeningTest]) {
    if (!existsAt(root, sha, f)) fail(`${f} does not exist at ${sha}`);
  }
  const short = sha.slice(0, 12);
  const checkLine = lineOf(root, sha, ENS_ANCHORS[0]);
  const scanLine = lineOf(root, sha, INTERCEPTA_ANCHORS[0]);
  // The submission tag, when it exists, must be this commit. Before the tag is made, the page does not name it.
  const tagged = tagSha(root, SUBMISSION_TAG);
  if (tagged !== null && tagged !== sha) fail(`tag ${SUBMISSION_TAG} is ${tagged}, not --sha ${sha}`);
  const tagNote = tagged === null ? '' : ` (tag \`${SUBMISSION_TAG}\`)`;

  const out: string[] = [
    '# For reviewers: vet402 at ETHGlobal Tokyo 2026',
    '',
    `Every code link on this page points at one frozen commit, \`${sha}\`${tagNote}. This page was generated from that commit by \`examples/tokyo-2026-demo/src/gen-for-reviewers.ts\`, which looks up each line number with \`git grep\` at generation time.`,
    '',
    `**If you only look at one thing:** run the line below. It runs [\`checkEnsOffer\`](${blob(sha, ENS_ANCHORS[0].file)}#L${checkLine}), the same check the agent runs before it pays, against live Sepolia data.`,
    '',
    '```',
    ONE_LINE,
    '```',
    '',
    `It reads only, needs no keys, and prints the seven steps. The folder's [README](${blob(sha, WHOLE_FILES.readme)}) lists every command.`,
    '',
    '## Live demo',
    '',
    `- Page: ${LIVE_URL}. Any ENSv2 Sepolia name can be typed in, and the seven steps run on the current chain.`,
    '- **Change one character yourself.** The button on the page changes `amount` in `seller-d.eth`\'s `x402-offer` from `10000` to `10001` in one Sepolia transaction and runs the same check again: step 7 turns red with `ens_attestation_signer_mismatch`. The offer goes back to `10000` with the "Put 10000 back" button, or on its own when someone opens the page 90 seconds or more after the change. Only `seller-d.eth` changes; `seller-a.eth` and the CLI example above are never touched.',
    '- The button signs on the server with a testnet-only key (W_op). The key is not published, because it can also write `x402-offer` on `seller-a.eth`\'s resolver, which the recorded demo uses. The button\'s code holds only `seller-d.eth`\'s resolver, name, key and two values, as constants.',
    '',
    '## ENS',
    '',
    `**If you only look at one thing:** [\`checkEnsOffer\`](${blob(sha, ENS_ANCHORS[0].file)}#L${checkLine}).`,
    '',
    ...anchorRows(root, sha, ENS_ANCHORS),
    '',
    `- What a second attester has to do: [\`${WHOLE_FILES.attesterSpec}\`](${blob(sha, WHOLE_FILES.attesterSpec)})`,
    `- The trust list the agent keeps: [\`${WHOLE_FILES.trustList}\`](${blob(sha, WHOLE_FILES.trustList)})`,
    '',
    '## Intercepta',
    '',
    `**If you only look at one thing:** [the quick-scan request](${blob(sha, INTERCEPTA_ANCHORS[0].file)}#L${scanLine}).`,
    '',
    ...anchorRows(root, sha, INTERCEPTA_ANCHORS),
    '',
    `- Tests: [\`${WHOLE_FILES.screeningTest}\`](${blob(sha, WHOLE_FILES.screeningTest)})`,
    '',
    '## Also in the submission text',
    '',
    '- The map from each prize requirement to where this project meets it.',
    '- The K1 transactions on Sepolia and Base Sepolia: the count and the explorer links are in the submission text.',
    '',
    `Commit \`${short}\`.`,
    '',
  ];
  return out.join('\n');
}

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { sha: ref } = parseArgs(process.argv.slice(2));
const root = git(DEMO_DIR, ['rev-parse', '--show-toplevel']).trim();
const sha = resolveSha(root, ref);
process.stdout.write(render(root, sha));
