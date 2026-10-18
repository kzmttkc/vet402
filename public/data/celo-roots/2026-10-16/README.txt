vet402 Celo export snapshot, Oct 11 to Oct 16, 2026 (UTC)

What this is
rows.json holds the 67 rows of vet402's public purchase export (https://vet402.com/api/v1/observatory/export.csv) whose network is eip155:42220 (Celo) and whose attempted_at falls between 2026-10-11 and 2026-10-16 UTC. 47 are settled and 20 are settle_failed. The rows are copied as published in the export fetched on 2026-10-18 around 11:05 UTC. Filtering the export the same way again on 2026-10-18 gave the same 67 rows. vet402 did not sign each row. The Merkle root on Celo fixes their content.

On chain
The Merkle root of all 67 rows (Oct 11 to Oct 16, six days in one root) was recorded on Celo in DeliveryRoots 0x2A180d0a3D6Bb0e3bFeFaFf90D577f55781D55fC, in the slot for day 20742 (2026-10-16), n = 67.
Deploy tx: 0x62a256815d5b4e7002836df9bcd32b551545864fbca5bd30adea0a00d978b384
Record tx: 0x012f0ff3a2ee82c2d9481de38b212907f9ebbcd149cf2c7595db00cf50d060b2
Root: 0xebe2b708cc93f76e96038ad4095cbb40ace2092789493f9c8336e485fe11cf03

How to recompute
1. Check the file: sha256 of rows.json is 0475f1c6c8878559c2f8973d5517b44118a94457850db7273dfc7374bd8d7bfb.
2. Run: npm i viem, then node compute_root.mjs rows.json. It prints n and root.
Leaves are taken in the order of rows.json, which is the export's order.
Rule: digest = keccak256(utf8(the row as canonical JSON)), with keys sorted and no whitespace. leaf = keccak256(0x00 || digest). node = keccak256(0x01 || min(a, b) || max(a, b)). An odd node is carried up.
3. Compare with rootOf(uint32 20742) on the contract above (the argument type is uint32).
