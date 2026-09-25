/* eslint-disable @typescript-eslint/no-explicit-any -- ETHGlobal Tokyo 2026: viem ABI helpers and JSON from RPCs are loosely typed here; behaviour is pinned by tests. */
// Load @vet402/sdk from this repo (packages/sdk/dist, committed) for the demo scripts and tests.
//
// Why a resolve hook: the SDK files live in packages/sdk, but viem is installed only in
// examples/tokyo-2026-demo/node_modules (npm ci here). A clean checkout has no node_modules at the
// repo root or in packages/sdk, so `import "viem"` from packages/sdk/dist/*.js fails with
// ERR_MODULE_NOT_FOUND (measured 2026-09-25 in the tokyo-2026-b4b worktree). The hook retries such an
// import from this package when, and only when, the SDK's own lookup fails. Nothing is symlinked.
//
// dist (plain JS) rather than src (.ts with .js specifiers) so that plain `node --test` can load it too.
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SDK_DIR = path.resolve(DEMO_DIR, '..', '..', 'packages', 'sdk');
const SDK_URL_PREFIX = pathToFileURL(SDK_DIR + path.sep).href;
const DEMO_PARENT_URL = pathToFileURL(path.join(DEMO_DIR, 'package.json')).href;

let installed = false;

/** Let packages/sdk resolve viem from this package's node_modules when it has none of its own. */
export function installSdkDepsResolver(): void {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromSdk = typeof context.parentURL === 'string' && context.parentURL.startsWith(SDK_URL_PREFIX);
      if (fromSdk && (specifier === 'viem' || specifier.startsWith('viem/'))) {
        try {
          return nextResolve(specifier, context);
        } catch (e: any) {
          if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
          return nextResolve(specifier, { ...context, parentURL: DEMO_PARENT_URL });
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

const sdkUrl = (file: string): string => pathToFileURL(path.join(SDK_DIR, 'dist', file)).href;

/** "@vet402/sdk/ens" (ENSIP-29 codec, ENS reads, checkEnsOffer, compareOfferToAccept). */
export async function loadEnsSdk(): Promise<any> {
  installSdkDepsResolver();
  return import(sdkUrl('ens.js'));
}

/** payOrRefuse and the chain-receipt floor constants. */
export async function loadPaySdk(): Promise<any> {
  installSdkDepsResolver();
  return import(sdkUrl('pay-or-refuse.js'));
}
