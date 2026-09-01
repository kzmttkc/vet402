// ============================================================
// wash 分類に要る外部知識を DB から組み立てる（§7.2）。
//   testWallets   : 我々の L1 測定ウォレット（x402_l1_purchases.payer の全て）
//                   + OBSERVATORY_TEST_WALLETS（chain:address をカンマ区切り）
//   sameCluster   : funder_wallets で同じ funder を持つ（同一ファウンダー）
//                   ※ ERC-8004 owner の同一性は agent→wallet の解決が要るため
//                     ここでは扱わない（開示: census.definition に明記）
//   reverseWithin : settlements に逆方向（payee→payer）の行が窓内にある
// classifyWash は純関数のまま、DB 依存はこの閉包に閉じ込める。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { payeeId as toPartyId, parsePartyId } from "@/lib/ids/canonical";
import { classifyWash, type WashContext } from "./wash";
import type { WashFlag } from "./types";
import { rowsOf } from "./upsert";

export type WashClassifier = {
  classify: (s: { payerId: string | null; payeeId: string | null; blockTime: Date | null }) => Promise<WashFlag>;
  testWallets: ReadonlySet<string>;
};

export async function loadWashClassifier(): Promise<WashClassifier> {
  const db = getDb();
  if (!db) throw new Error("loadWashClassifier: DATABASE_URL is not configured");

  const testWallets = new Set<string>();
  const payers = rowsOf<{ network: string; payer: string }>(
    await db.execute(sql`
      SELECT DISTINCT network, payer FROM x402_l1_purchases
      WHERE payer IS NOT NULL AND network IS NOT NULL
    `),
  );
  for (const p of payers) testWallets.add(toPartyId(p.network, p.payer));
  for (const raw of (process.env.OBSERVATORY_TEST_WALLETS ?? "").split(",")) {
    const v = raw.trim();
    if (v && parsePartyId(v)) testWallets.add(v);
  }

  // funder_wallets は本番で十数行——全件を 1 回で読む。
  const funderOf = new Map<string, string>();
  const funders = rowsOf<{ funder: string; wallet: string }>(
    await db.execute(sql`SELECT lower(funder) AS funder, lower(wallet) AS wallet FROM funder_wallets`),
  );
  for (const f of funders) funderOf.set(f.wallet, f.funder);

  const addressOf = (id: string) => parsePartyId(id)?.address.toLowerCase() ?? null;
  const sameCluster = (payerId: string, payeeId: string) => {
    const a = addressOf(payerId);
    const b = addressOf(payeeId);
    if (!a || !b) return false;
    const fa = funderOf.get(a);
    const fb = funderOf.get(b);
    if (fa && fb && fa === fb) return true;
    // 片方がもう片方の funder そのもの（ファウンダーが自店で買う）
    return fa === b || fb === a;
  };

  const reverseWithin = async (payerId: string, payeeId: string, at: Date, hours: number) => {
    const rows = rowsOf(
      await db.execute(sql`
        SELECT 1 FROM settlements
        WHERE payer_id = ${payeeId} AND payee_id = ${payerId}
          AND block_time IS NOT NULL
          AND block_time BETWEEN ${at.toISOString()}::timestamptz - make_interval(hours => ${hours})
                             AND ${at.toISOString()}::timestamptz + make_interval(hours => ${hours})
        LIMIT 1
      `),
    );
    return rows.length > 0;
  };

  return {
    testWallets,
    classify: async (s) => {
      // 純関数に渡す前に、非同期の逆方向照会だけ先に済ませる（判定順序は classifyWash が持つ）。
      let reverse = false;
      if (s.payerId && s.payeeId && s.blockTime && !testWallets.has(s.payerId) && s.payerId !== s.payeeId) {
        if (!sameCluster(s.payerId, s.payeeId)) reverse = await reverseWithin(s.payerId, s.payeeId, s.blockTime, 24);
      }
      const ctx: WashContext = { testWallets, sameCluster, reverseWithinHours: () => reverse };
      return classifyWash(s, ctx);
    },
  };
}
