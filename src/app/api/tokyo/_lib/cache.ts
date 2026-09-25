// ============================================================
// プロセス内の短い使い回し（TTL・件数上限つき LRU・読み込み中の相乗り）。
//
// /tokyo・/api/tokyo/verify・/api/tokyo/state は誰でも何回でも叩けるので、同じ読みを
// 短い間だけ使い回して Sepolia の RPC を守る。値はどれも「block N で読んだ」事実なので、
// 使い回しても嘘にはならない（画面は block と読んだ時刻を出す）。
//
//   - 読み込み中の同じ鍵は、同じ Promise に相乗りする（同時 20 本でも読むのは1回）
//   - 期限は読み終えた時刻 + ttlMs。読み込み中は期限切れにしない
//   - 失敗（reject）は残さない。次の呼び出しで読み直す
//   - forget(key) の後に、忘れる前の読み込みが終わっても入れ直さない
//
// 検証の使い回し（verifyCache）の置き場もここ。鍵は SDK の正規化（normalize）後の名前なので、
// 大文字・小文字などの書き方を変えても同じ名前は1つの鍵になる。button.ts は verify.ts を import しない
// （ボタンの経路に P_a 側の名前を置かない W06）ので、書いた後の忘れる・入れ直すはここから呼ぶ。
// ============================================================
import { normalizeName } from "@vet402/sdk/ens";
import { VERIFY_CACHE_MAX, VERIFY_CACHE_MS } from "./constants";

type Entry<T> = { promise: Promise<T>; expiresAt: number };

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** 読んだばかりの値で置き換える（期限は今から ttlMs）。 */
  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { promise: Promise.resolve(value), expiresAt: this.now() + this.ttlMs });
    this.trim();
  }

  private trim(): void {
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) {
      // 使った順へ並べ直す（Map の挿入順が LRU の順）。
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.promise;
    }
    if (hit) this.entries.delete(key);

    const entry: Entry<T> = { promise: Promise.resolve(), expiresAt: Number.POSITIVE_INFINITY } as unknown as Entry<T>;
    entry.promise = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (this.entries.get(key) === entry) entry.expiresAt = this.now() + this.ttlMs;
          return value;
        },
        (error: unknown) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw error;
        },
      );
    this.entries.set(key, entry);
    this.trim();
    return entry.promise;
  }
}

/** 名前ごとの検証結果（verify.ts が入れる。中身の型は verify.ts が持つ）。 */
export const verifyCache = new TtlCache<object>(VERIFY_CACHE_MS, VERIFY_CACHE_MAX);

/** 使い回しの鍵（SDK と同じ正規化）。正規化できない名前は null（SDK は RPC を読まずに段1で返す）。 */
export function verifyKey(name: string): string | null {
  try {
    return normalizeName(name);
  } catch {
    return null;
  }
}

/** 審査員ボタンが書いた後（書いたかもしれない例外の後を含む）に呼ぶ。次の読みを今のチェーンにする。 */
export function forgetVerified(name: string): void {
  const key = verifyKey(name);
  if (key !== null) verifyCache.forget(key);
}

/** 押した後に使い回しを通さず読んだ結果で、このプロセスの使い回しを置き換える。 */
export function rememberVerified(name: string, view: object): void {
  const key = verifyKey(name);
  if (key !== null) verifyCache.set(key, view);
}
