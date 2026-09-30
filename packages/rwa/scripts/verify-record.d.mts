// Types for verify-record.mjs, which stays plain JavaScript so it runs with no install.
export const RWA_ANCHOR_ADDRESS: string;
export const CHAIN_ID: number;
export const RUNTIME_KECCAK: string;
export const ANCHORED_TOPIC: string;
export function keccak256(input: Uint8Array | string): string;
export function hexToBytes(hex: string): Uint8Array;
export function canonicalJson(v: unknown): string;
export function methodVersionNumber(mv: string): number;
export function commitment(facts: unknown): { material: 1 | 2; preimage: string; hash: string; factsJsonKeccak: string | null };
export function subjectHash(address: string): string;
export type AnchoredLog = { address: string; subject: string; factsHash: string; anchoredBy: string; methodVersion: number; asOf: bigint };
export function anchoredLogs(receipt: unknown): AnchoredLog[];
export type Row = { name: string; ok: boolean; detail: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function checkRecord(input: { record: any; receipt: any; code: string | null; operator?: string; contract?: string }): {
  ok: boolean;
  rows: Row[];
  facts: unknown;
  commitment?: { material: 1 | 2; preimage: string; hash: string; factsJsonKeccak: string | null };
  log?: AnchoredLog;
};
