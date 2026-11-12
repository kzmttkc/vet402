// ============================================================
// E6 の試験用・軽量の保存。本番は後続で Postgres へ。追記と上書きは purchaseId 単位。
// ============================================================
import {
  mergeE6Record,
  emptyPayerLeg,
  emptySellerLeg,
  type E6Record,
} from "@/lib/observatory/e6-record";

export const E6_DEMO_PURCHASE_ID = "00000000-0000-4000-8000-000000000001";

export type E6Store = {
  get(purchaseId: string): Promise<E6Record | null>;
  put(record: E6Record): Promise<void>;
};

let activeStore: E6Store | null = null;
let defaultMemoryStore: (E6Store & { rows: Map<string, E6Record> }) | null = null;

export function demoE6Record(): E6Record {
  return mergeE6Record(null, {
    purchaseId: E6_DEMO_PURCHASE_ID,
    payer: { ...emptyPayerLeg(), paymentTx: "0x0", state: "settled" },
    seller: emptySellerLeg(),
  });
}

function ensureDefaultStore(): E6Store & { rows: Map<string, E6Record> } {
  if (!defaultMemoryStore) {
    defaultMemoryStore = memoryE6Store({ [E6_DEMO_PURCHASE_ID]: demoE6Record() });
  }
  return defaultMemoryStore;
}

export function getE6Store(): E6Store | null {
  return activeStore ?? ensureDefaultStore();
}

/** 試験だけ。本番の差し替えは後続。null で既定の単一インスタンスへ戻す。 */
export function setE6StoreForTests(store: E6Store | null): void {
  activeStore = store;
}

export function memoryE6Store(seed: Record<string, E6Record> = {}): E6Store & { rows: Map<string, E6Record> } {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    async get(purchaseId: string) {
      const r = rows.get(purchaseId);
      return r ? structuredClone(r) : null;
    },
    async put(record: E6Record) {
      rows.set(record.purchaseId, structuredClone(record));
    },
  };
}
