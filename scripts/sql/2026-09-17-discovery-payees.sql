-- 2026-09-17: 決済索引の受取人の出どころ（カタログの外）。
--
-- 事故の形（2026-09-15 公開データで実測）: Solana の決済索引が見る受取人は x402_endpoints の
-- network / pay_to（各リソースの先頭の accept だけ）で、PayAI facilitator の公開 discovery も
-- 取り込んでいなかった。Bazaar の Solana 受取人は 先頭だけ 33 / 全 accept 220、PayAI は 278（重なり 30）。
--
-- この表は索引の対象だけに使う。カタログの総数・L0・L1 の購入候補には入らない。
-- 書き手: src/lib/settlements/discovery-payees.ts（cron /api/cron/catalog-sync）。
-- 読み手: src/lib/settlements/index-solana.ts listPayees（last_seen_at が 14 日以内）。
-- 表が無い間は、書き手は skipped: table_missing を返し、読み手はカタログだけを読む。

CREATE TABLE IF NOT EXISTS x402_discovery_payees (
  chain          text NOT NULL,
  pay_to         text NOT NULL,
  source         text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, pay_to, source)
);

CREATE INDEX IF NOT EXISTS x402_discovery_payees_chain_seen_idx
  ON x402_discovery_payees (chain, last_seen_at);
