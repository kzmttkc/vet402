# For reviewers: vet402 at ETHGlobal Tokyo 2026

Every code link on this page points at one frozen commit, `95abea47ad6ca52ecb2bc8abd06d24a634c90b6b`. This page was generated from that commit by `examples/tokyo-2026-demo/src/gen-for-reviewers.ts`, which looks up each line number with `git grep` at generation time.

**If you only look at one thing:** run the line below. It runs [`checkEnsOffer`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/packages/sdk/src/ens-attestation.ts#L296), the same check the agent runs before it pays, against live Sepolia data.

```
git clone --depth 1 --branch tokyo-2026-submission https://github.com/kzmttkc/vet402 && cd vet402/examples/tokyo-2026-demo && npm ci && npm run verify -- seller-a.eth
```

It reads only, needs no keys, and prints the seven steps. The folder's [README](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/README.md) lists every command.

## Live demo

- Page: https://vet402.com/tokyo?name=seller-a.eth. Any ENSv2 Sepolia name can be typed in, and the seven steps run on the current chain.
- **Change one character yourself.** The button on the page changes `amount` in `seller-d.eth`'s `x402-offer` from `10000` to `10001` in one Sepolia transaction and runs the same check again: step 7 turns red with `ens_attestation_signer_mismatch`. The offer goes back to `10000` with the "Put 10000 back" button, or on its own when someone opens the page 90 seconds or more after the change. Only `seller-d.eth` changes; `seller-a.eth` and the CLI example above are never touched.
- The button signs on the server with a testnet-only key (W_op). The key is not published, because it can also write `x402-offer` on `seller-a.eth`'s resolver, which the recorded demo uses. The button's code holds only `seller-d.eth`'s resolver, name, key and two values, as constants.

## ENS

**If you only look at one thing:** [`checkEnsOffer`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/packages/sdk/src/ens-attestation.ts#L296).

| What | Where |
|---|---|
| The seven-step ENSIP-29 draft check that the CLI, /tokyo and the payment path all run | [`packages/sdk/src/ens-attestation.ts#L296`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/packages/sdk/src/ens-attestation.ts#L296) |
| Step 7: one changed character in the offer gives a different signer, and the check refuses | [`packages/sdk/src/ens-attestation.ts#L433`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/packages/sdk/src/ens-attestation.ts#L433) |
| Every ENS read happens on two RPC providers at one pinned block | [`packages/sdk/src/ens-read.ts#L167`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/packages/sdk/src/ens-read.ts#L167) |
| The agent still asks vet402; only a transport error or a 5xx counts as unreachable | [`packages/sdk/src/pay-or-refuse.ts#L1062`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/packages/sdk/src/pay-or-refuse.ts#L1062) |
| When vet402 is unreachable, the waiver is written into the decision line | [`packages/sdk/src/pay-or-refuse.ts#L1172`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/packages/sdk/src/pay-or-refuse.ts#L1172) |
| The agent's declared floor on valid ENS attestations | [`packages/sdk/src/pay-or-refuse.ts#L1002`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/packages/sdk/src/pay-or-refuse.ts#L1002) |
| Enhanced Access Control: the seller's server key (W_op) gets one text key on seller-d.eth's resolver | [`examples/tokyo-2026-demo/src/lib/k1.ts#L290`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/lib/k1.ts#L290) |
| The same key tries to write the attestation next to it, and the resolver reverts | [`src/app/api/tokyo/_lib/verify.ts#L73`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/src/app/api/tokyo/_lib/verify.ts#L73) |
| The agent is a subname: agent-1.vet402.eth is registered in vet402's own UserRegistry | [`examples/tokyo-2026-demo/src/lib/k1.ts#L296`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/lib/k1.ts#L296) |
| Revoking the agent's subname takes its policy away | [`examples/tokyo-2026-demo/src/admin.ts#L161`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/admin.ts#L161) |
| The attester's six steps before it signs | [`examples/tokyo-2026-demo/src/attester.ts#L8`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/attester.ts#L8) |
| The observation log is not a seller's name: no addr is ever written | [`examples/tokyo-2026-demo/src/observe.ts#L10`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/observe.ts#L10) |
| The judge button can reach only seller-d.eth: its resolver, name, key and two values are constants | [`src/app/api/tokyo/_lib/constants.ts#L20`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/src/app/api/tokyo/_lib/constants.ts#L20) |

- What a second attester has to do: [`docs/tokyo-2026/attester-spec.md`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/docs/tokyo-2026/attester-spec.md)
- The trust list the agent keeps: [`examples/tokyo-2026-demo/trusted-attesters.json`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/trusted-attesters.json)

## Intercepta

**If you only look at one thing:** [the quick-scan request](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/screening.ts#L227).

| What | Where |
|---|---|
| The quick-scan request (screening.ts is the only file that calls the API) | [`examples/tokyo-2026-demo/src/screening.ts#L227`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/screening.ts#L227) |
| No risk record on the payee: ask Check Address Activity on Base mainnet (chainId 8453) | [`examples/tokyo-2026-demo/src/screening.ts#L212`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/screening.ts#L212) |
| The traits that block a payment on their own | [`examples/tokyo-2026-demo/src/screening.ts#L55`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/screening.ts#L55) |
| A 404 is "unavailable", and unavailable does not pay | [`examples/tokyo-2026-demo/src/screening.ts#L229`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/screening.ts#L229) |
| pay screens the payTo and the payer before any proof is checked | [`examples/tokyo-2026-demo/src/lib/pay-flow.ts#L146`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/lib/pay-flow.ts#L146) |
| An unknown payee above 0.01 USDC stops for a person | [`examples/tokyo-2026-demo/src/lib/pay-flow.ts#L153`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/lib/pay-flow.ts#L153) |
| A block or unavailable answer stops the payment there | [`examples/tokyo-2026-demo/src/lib/pay-flow.ts#L161`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/src/lib/pay-flow.ts#L161) |
| The /tokyo page and its API routes do not call Intercepta (test) | [`tests/tokyo-mutate.test.ts#L677`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/tests/tokyo-mutate.test.ts#L677) |

- Tests: [`examples/tokyo-2026-demo/test/screening.test.mjs`](https://github.com/kzmttkc/vet402/blob/95abea47ad6ca52ecb2bc8abd06d24a634c90b6b/examples/tokyo-2026-demo/test/screening.test.mjs)

## Requirements, one by one

Prize text quoted as published on the ENS and Intercepta prize pages (fetched 2026-09-26). All times UTC.

**Both ENS prizes: qualification**

1. "Project must be built on ENSv2 (Sepolia)" / "Integration must use ENSv2 on Sepolia and target an existing project's testnet deployment."
   Built on the ENSv2 Sepolia contracts deployed on 2026-09-15. Setup: 32 Sepolia and 3 Base Sepolia transactions on 2026-09-25 between 12:45 and 13:24, 0 failures (Sepolia blocks 11779304 to 11779498), and one follow-up at block 11782000. The existing project is @vet402/sdk (on npm since 2026-08-24, latest 0.6.0). In the repo its payOrRefuse gained a Base Sepolia profile and an ENSv2 read path. The demo seller https://vet402.com/api/tokyo/seller answers HTTP 402 on eip155:84532.
2. "ENSv2 features should be central to the product, not a cosmetic add-on" / "It should be clear how ENSv2 improves the project."
   At pre-tokyo-2026, payOrRefuse threw invalid_payee_address for any name ("ENS names are not resolved here", packages/sdk/src/pay-or-refuse.ts lines 634-635 at that tag). Now a caller can pass payeeName, and the gate pays only while the attestation on the seller's name holds. The 13 ens_* refusal reasons (packages/sdk/src/ens-reasons.ts) come only from ENS reads. The payee field still rejects names.
3. "Your demo must be functional and not just include hard-coded values."
   npm run verify -- <name> runs the seven steps on any ENSv2 Sepolia name at a live block.
   - Scene 2 on 2026-09-26: with vet402's API refusing connections, pay seller-a.eth --live returned ALLOW (vet402_unreachable, allowed_by_caller_policy) and paid, Base Sepolia tx 0x6511dfce566f5fea6e402253269cb39bd9b8be5589354a4f31c8851aeb14270e (block 47307144, 00:29:36). The seller's server key then changed one character of the offer (tx 0x714cb466b35e46cc46a42cc4e7fcda50df82c6e3f7e80acd297b18aa914c9995, Sepolia block 11782719). The same command refused at step 7 with ens_attestation_signer_mismatch and did not ask vet402. The offer was restored (tx 0x5a538a846d7b710080ba909ada1378f221515d9ba60bdc76f888db171f3c618d, block 11782723), and seller-a/b/c/d all returned VALID 7/7.
   - Scene 3 on 2026-09-25: unlink seller-b.eth, REFUSE ens_offer_missing (block 11782102); relink, VALID (11782104); link seller-c.eth to seller-b.eth's record, REFUSE ens_attestation_signer_mismatch (11782107); relink, VALID (11782110).
   - The /tokyo judge button on 2026-09-25 (22:54 to 23:21 UTC): mutate tx 0xa8be2cdc84a37ad42a8d7768c01dd46ffd8d9736f2ea655ccf9710eb9174ec11 (block 11782401) returned ens_attestation_signer_mismatch, and reset tx 0x49b42220b3a9a419bf9b3d73abc0a6f4f5587f32e25c92bd2be911be0d321fb8 (block 11782403) returned VALID when read at block 11782404. An earlier press: 0xb243a7560ac93f93fd9710a1da42f8dbc4d1c97eb8ff263d620e59c9de1aa0e1 (11782284) and 0xe35f0d840bd297fc7a101fa9efda9352758ce9f56c794791720e6e3e7d74df96 (11782289).
4. "must have a link to a live demo and the code needs to be open source."
   Live demo: https://vet402.com/tokyo (HTTP 200 on 2026-09-26). Code: https://github.com/kzmttkc/vet402/tree/tokyo-2026-submission (MIT).

**Best Use of ENSv2**

5. "hierarchical registry structure" / "deploy your own subname registry": a UserRegistry deployed (K1-10, 0x78e10e5bb7604f0e60570bffbb9959cd286578c815c1aa871ae83a08d02b3a8c) and set as vet402.eth's subregistry (K1-11, 0xb2598da990fc3e8974b2d53a5c288fc66abc46bec9da92bc839f697e20f2446e). agent-1 and agent-2 are registered in it.
6. "wildcard resolution": atst.vet402.eth and <resourceId>.obs.vet402.eth have no resolver of their own and are answered by vet402.eth's resolver. The observation log written at block 11782167 (tx 0x2ef443164641334fa9ccddb0f50562223bd6b10fb0be3dbcb1b6312c385154ec) was read back through that wildcard on two RPCs (match, no addr record).
7. "Enhanced Access Control ... edit only certain text records on a name": K1-06 (0x9a21df31028b54b14d94080ffc020601c99303d8102213cd4be29797bedd26e3) gave the seller's server key 0xE3BB99911A8037F22D4d6b3a4d955D1b02229080 the setter role for x402-offer on seller-a.eth's own Permissioned Resolver. At block 11782193, an eth_call from that key writing x402-offer succeeded, and writing attestations[x402-offer][atst.vet402.eth] reverted with EACUnauthorizedAccountRoles(0x2363e661…, 0x10, 0xE3BB…9080). The attestation cannot be forged anyway. What the split buys is least privilege: a leaked server key can change the price, and every agent then refuses, but it cannot restore an older offer together with the attestation that signed it. ENS support answered on 2026-09-23 and confirmed on 2026-09-25 that access on a Permissioned Resolver is set per record key across every name it serves, and that a separate resolver is the way to give one name its own access. The resolver shared by seller-b.eth and seller-c.eth delegates nothing.
8. "their own Permissioned Resolver": agent-1.vet402.eth has its own resolver (K1-12, 0xc54489b77729c42de0a33319771c91dd20cae4993fe304d4faea6a99a9e184ca) holding its 178-byte x402-policy, and only its key may set that record key (K1-14, 0x23832b0db7597989e54d591422da35f1c3bed3c97d4eb8569fb1256e0580fc40).
9. "record aliasing at the resolver level": item 3, scene 3 (block 11782107).
10. "namespace aliasing via a shared registry": K1-15c (0x7248bb40a3473b9e330b4fee31f9d0926af343e4df97f9295ba92aa18592d3ed) points seller-a.eth's subregistry at the same UserRegistry, and K1-15d (0xd6064fa4e71a08c714004be3b9b59e01e505fb7af5bfc58b5c6a226e15f9c6cc) links agent-1.seller-a.eth to agent-1.vet402.eth's record. Read on 2026-09-25 at 13:24 on two RPCs: both names return 0x9335dD17755C57db194Add4A1032aeFc7F717244. vet402.eth and seller-a.eth are held by two different wallets.
11. "expiring, revocable, non-transferable vs. transferable, even forever names with no parent control":
   - Revocable: agent-1 unregistered (0x78068693823fe667308062c38749fd3690cc6a52d2a85220dcd67136ad35fec5, block 11782115) and registered again (0x9e4b5ff4dceefce4eb440977d1aa0e98131e68ba74ccff4ec93185525abc386d, block 11782140).
   - Inside the UserRegistry the parent gave up unregistering or repointing agent names: revokeRootRoles(UNEMANCIPATED) (0x23b68ad0731939ba83058541a5ec85e40bbead2302ef2bcf8441df6a1964586b, block 11782147), after which isEmancipated() is true on both RPCs. These are not forever names: the owner of vet402.eth can still replace the subregistry.
   - Expiring: agent-tmp.vet402.eth registered with a 120-second expiry (0x7c57e819e7031c1462e93299277e87da1beb24e823a1daab5fd02daecc7c05f6, block 11783277). At block 11783287, at the expiry time, it reads AVAILABLE and resolves to no one.
   - Non-transferable: agent-1 was registered without CAN_TRANSFER_ADMIN. Transferring it from its own key reverts with TransferDisallowed (eth_call at block 11783268), while agent-2, registered with that role, transfers in the same call.
12. Bonus "agents as namespaces": while agent-1 was unregistered, the parent's wildcard resolver still answered a policy for it, and the gate refused with agent_policy_missing. After it was registered again, a dry run of paying seller-a.eth passed every gate and stopped at ALLOW before any signature. agent-context (ENSIP-26) on agent-1.vet402.eth (0xa5143e6e380da437c7591ab4a63270301a720d9837de357f45a10b25ec430299, block 11783275), written by the owner of vet402.eth; the agent's own key can write x402-policy but not agent-context (EACUnauthorizedAccountRoles). agent-2 has no resolver of its own: a dry run paying as agent-2 refuses with agent_policy_missing (block 11783288), because its policy was answered by the parent's resolver, not the one the agent pins.

**Best Integration of ENSv2 into an Existing Project**

13. "existing project's testnet deployment": item 1. 14. "how ENSv2 improves the project": item 2. 15. "agents their own namespace and delegated permissions": items 8 and 12.

**Intercepta: Safe Agent-to-Agent Payments with x402 ($2,000) and Add Payment Screening to Your Agent or x402 Service ($500, Continuity only)**

- "added to an existing product or repo ... new code is open source": examples/tokyo-2026-demo/src/screening.ts, added after pre-tokyo-2026. Tests: examples/tokyo-2026-demo/test/screening.test.mjs.
- "live Intercepta API call runs before a payment is signed ... its result decides what happens next": the attester screens before it buys from a seller that has no proof yet, so the screen alone decides whether it buys. Dry run of seller-a.eth at Sepolia block 11783180: with --no-screen it reaches the signature; with the screen it stops at gate 3, REFUSE payee_unknown_needs_human.
- "one payment that goes through and one that is blocked or held, with the reason visible": blocked, seller-e.eth's payee 0x098B716B8Aaf21512996dC57EB0615e2383E2f96 (toxicScore 100, sanction_address, known_scammer, blacklist; pay path dry run at Sepolia block 11782195, REFUSE payee_screening_blocked). Held or paid: a payee with no mainnet history returns toxicScore 0, read as no risk record; Check Address Activity marks it unknown, and vet402 pays only with a VALID proof and a price of 0.01 USDC or less, otherwise it hands the payment to a person. The attester goes further: it does not buy from an unknown payee unless --allow-unknown is given. The scheduled re-signs pass it: the demo payees have no mainnet history, so Intercepta rates them unknown, and the attester buys from them only because a person decided so, as recorded in docs/tokyo-2026/human-log.md. The paid run in scene 2 was screened first as well (its first line is the Intercepta result).
- "screen real mainnet addresses even when the payment runs on a testnet": the screened payee is a mainnet address. quick-scan takes no chain parameter.
- "README points to the files ... 3 to 5 lines of feedback": examples/tokyo-2026-demo/README.md, "Payment screening (Intercepta)". First call: 2026-09-24, about 0.44 s. What was missing: Scan Message lists no Base Sepolia (84532), so only addresses were screened, not what the payer signs; traits[].txsCount is required in the OpenAPI document but absent in live answers.

## Format note

Attestations follow the ENSIP-29 draft text at PR #85 commit e00c3453a4ce0fec8439e2aeeea4c47cb0604efe (envelope version 1, payload n, a, k, v, t). atst.me's SDK uses version 2 with p and h. vet402 reads both and signs the draft form. The draft leaves three things open, so vet402 decides them: (1) a is a CBOR byte string of exactly 20 bytes, not hex text. (2) n is the ENSIP-15 normalized name, and the same normalization runs before the DNS encoding used for the lookup. (3) The signature is EIP-191 over the 32-byte keccak256 of the encoded payload. For seller-a.eth's live offer the payload is 330 bytes and the envelope is 79 bytes (tag, version, t, 65-byte signature).

## The x402-offer record key

```
key:    x402-offer
value:  one line of JSON, signed byte for byte
        {"v":1,"resource":"<absolute https URL>","method":"GET"|"POST",
         "network":"eip155:84532","asset":"<0x… ERC-20>","amount":"<decimal minor units>",
         "payTo":"<0x…>","output":{"required":["result","observed_at"]}}
companion key: agent-endpoint[x402] = the same URL as "resource"
  (the agent-endpoint[<protocol>] form of ENSIP-26; that draft names MCP and A2A,
   and x402 is not one of the protocols it lists)
who writes it: the name's manager, or a key the manager delegated for this one record key
what an attestation over it means: the attester paid this exact offer at time t,
  and what came back matched the declaration
```

Not self-validating: no one can check it without paying the seller and comparing what arrives with the promise. On 2026-09-25 vet402 bought once from each of seller-a/b/c/d.eth for 0.01 USDC on Base Sepolia, and each response carried result and observed_at. The first try for seller-a.eth failed at the facilitator's settlement and moved no funds, so vet402 bought again. It then published four attestations (Sepolia blocks 11782084 to 11782090). Not impossible to verify: the verify command rebuilds the payload from live ENS data and recovers the signer.

## The mismatch rate

Read only from vet402's production purchase table (x402_l1_purchases, l2_schema in match or mismatch) on 2026-09-26: 30 days to 2026-09-16 15:00 UTC (2026-09-17 00:00 JST), 426 of 1,008 did not match (42.3%). 30 days to 2026-09-26 01:4x UTC, 533 of 1,349 (39.5%).

## What existed before

Boundary tag pre-tokyo-2026 (commit 751a1fe, tag created 2026-09-25 09:05:43). Before it: vet402's API and its purchase job, scheduled daily at 12:00 in vercel.json, which buys from x402 sellers on Base mainnet. @vet402/sdk on npm: 0.4.0 on 2026-08-24, latest 0.6.0 on 2026-09-12. The repo was at 0.7.0, which is not on npm. payOrRefuse and pay_if_trusted from my ETHOnline 2026 submission (tag ethonline-2026-submission, 2026-09-13). Four ENSv2 Sepolia names (vet402.eth, seller-a.eth, seller-b.eth, seller-c.eth) registered on 2026-09-17, carrying only the default address record and the app's resolver.

## What I built in this window

git log --oneline pre-tokyo-2026..tokyo-2026-submission over these paths and the lockfile and config changes they need: packages/sdk/src/ (atst-codec.ts, ens-read.ts, ens-attestation.ts, ens-reasons.ts, ens.ts, chain-profile.ts, and changes to pay-or-refuse.ts, x402-pay.ts, index.ts), examples/tokyo-2026-demo/, src/app/tokyo/, src/app/api/tokyo/, docs/tokyo-2026/attester-spec.md.
History: on 2026-09-25 at 22:31 UTC (2026-09-26 07:31 JST), and again on 2026-09-26 at 02:05 UTC for the last commits, the Tokyo commits were rebased into one flat line without changing their content. Committer dates show those times. Author dates show when the work was done.

## Not claimed

docs/tokyo-2026/prework/ (pre-existing planning and read-only rehearsal).

Commit `95abea47ad6c`.
