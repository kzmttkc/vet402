// 審査員ボタンの差し替え口。route.ts は realButtonDeps()（deps.ts）を渡し、
// tests/tokyo-mutate.test.ts は署名・送信・DB を偽物に差し替えて同じ handle* を走らせる。
import type { KEY, NODE, P_D } from "./constants";
import type { HaltProbe } from "./halt";

export type Hex = `0x${string}`;

/** 書き込みの形はこれ1つ。宛先・関数・node・キーは型の上でも定数に縛る（W06）。 */
export type WriteRequest = {
  address: typeof P_D;
  functionName: "setText";
  args: readonly [typeof NODE, typeof KEY, string];
};

export type ReceiptStatus = "success" | "reverted" | "timeout";

export type MutationRow = {
  currentValue: string;
  generation: number;
  mutatedAt: Date | null;
  revertingUntil: Date | null;
  lastTx: string | null;
};

export type LogRow = { at: string; from: string; to: string; tx: string | null };

export type MutationStore = {
  /** tokyo_mutations の1行（id=1, current_value '10000'）が無ければ作る。 */
  ensureRow(): Promise<void>;
  readRow(): Promise<MutationRow>;
  /** 戻す権利を1文で取る。取れたら新しい generation、取れなければ null。 */
  claimRevert(): Promise<number | null>;
  /** generation が変わっていなければ 10000 に戻った記録を書く。書けたら true。 */
  finishRevert(generation: number, tx: string): Promise<boolean>;
  /** 戻す tx が失敗したとき、次の来訪者が取り直せるよう権利を手放す。 */
  releaseClaim(generation: number): Promise<void>;
  /** チェーンが既に 10000 のとき、tx を打たずに DB を合わせる。 */
  markClean(generation: number): Promise<void>;
  recordMutation(tx: string): Promise<void>;
  appendLog(from: string, to: string, tx: string | null): Promise<void>;
  recentLog(limit: number): Promise<LogRow[]>;
  /** その日の押下を1つ数える（INSERT … ON CONFLICT の1文に上限の比較が入っている）。上限なら null。 */
  consumeDaily(key: string, max: number, resetAt: Date): Promise<number | null>;
  peekDaily(key: string): Promise<number>;
  /** 同じ呼び手の間隔。通してよければ true。 */
  consumeInterval(key: string, windowMs: number): Promise<boolean>;
};

export type ButtonDeps = {
  envDisabled(): boolean;
  /** env の鍵から導いたアドレス。鍵が無い・形が違う → null。鍵の値そのものは deps の外へ出ない。 */
  operatorAddress(): Hex | null;
  getChainId(): Promise<number>;
  getBalance(address: Hex): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  /** seller-d.eth の x402-offer を今のブロックで読む（UniversalResolver 経由）。読めなければ throw。 */
  readOffer(): Promise<{ value: string; resolver: Hex | null }>;
  writeContract(request: WriteRequest): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<ReceiptStatus>;
  readHalt(): Promise<HaltProbe>;
  store: MutationStore;
  withLease<T>(fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
  now(): number;
};
