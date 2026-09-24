# Decision 010 — RwaAnchor read() for other contracts

Date: 2026-09-24
Status: rejected

Do not add a read function so other contracts can pull the anchor record.

Reason:
- SPEC §9 minimum is ownerless, non-upgradeable, anyone recomputes the hash off-chain and matches.
- A getter that other contracts call turns the instrument into an on-chain registry. No caller exists after Sunday.
- Open House reserved RH slot is won by using 4663, not by growing the ABI.
- Freeze is already on (2026-09-24 18:00 JST → 2026-09-27 15:00 JST). Do not widen the contract before first deploy.

In-spec, after thaw, in this order:
1. All Stock Tokens only if the demo address stays under 60s and r1 partial stays honest.
2. Blockscout source verify + `--verify match: true` (already in the 9/27 runbook).
3. Extra wallet records only as fixtures. Do not add a second public URL. A remains formula-only.

Not in-spec: Sushi/fee-104 decoder, opinion language, new cron, migration, parent-chain exclusivity, ETHOnline prize in OH copy.
