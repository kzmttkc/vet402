# Human log: ETHGlobal Tokyo 2026

What I decided and what I did with my own hands, in time order. All times are JST. Hacking began on
2026-09-25 at 21:00.

Each row comes from a record written at the time: the run log of the live sends, the plan's decision
notes, or my message in the build session. Nothing here is reconstructed after the fact, and anything
without such a record is left out. Where a public trace exists (a block, a commit), it is given so the
time can be checked without trusting this file. The AI compiled this file from those records; the acts
are mine.

"Pressed `y`" means: the operator command waited at the terminal for a typed `y` before it sent
anything. The AI prepared and started the commands; each send happened only after my `y`.

## Before hacking began (the boundary)

| Time | What I did or decided | Public trace |
|---|---|---|
| 2026-09-25 18:05:10 | The pre-event planning files were committed | `751a1fe`, `docs/tokyo-2026/prework/` |
| 2026-09-25 18:05:43 | I created the boundary tag `pre-tokyo-2026` on that commit, and pushed it at 18:06 | tag object `3d4ba760` |

## During the event

| Time | What I did or decided | Public trace |
|---|---|---|
| 2026-09-25 21:01 | I checked on the ETHGlobal dashboard that the Continuity Track was selected and my entry was confirmed, and took a screenshot of it | outside git |
| 2026-09-25 21:30 to 21:39 | I chose ENS and Intercepta as the partners whose prizes this project is entered for | outside git (dashboard) |
| 2026-09-25 21:32 | I chose the submission type "Top 10 Finalist & Partner Prizes" | outside git (dashboard) |
| 2026-09-25 21:41 | I created the six testnet keys (`keys.ts init`, which prints addresses only) | outside git |
| 2026-09-25 21:41 to 22:24 | I pressed `y` on each of the 8 stages of the ENS setup: `register-d`, `k1a`, `deploy-resolvers`, `k1b`, `agents`, `agents --post`, `register-e`, `set-offer-e`. 32 Sepolia and 3 Base Sepolia transactions, 0 failed | Sepolia blocks 11779304 to 11779498; Base Sepolia blocks 47286745 to 47286905 |
| 2026-09-25 22:43 | I approved the four points of the review of the Base Sepolia change to the payment gate, as recommended: fix the test expectations and leave SDK behavior unchanged, allow `minChainReceipts` on Base Sepolia only, correct the error message, commit the built SDK | `bd4ee036`, `0bfec950` |
| 2026-09-26 06:50 to 06:59 | I pressed `y` on `admin.ts align-bc`, which made the offers of seller-b and seller-c match seller-a and added the missing endpoint record | Sepolia block 11782000 |
| 2026-09-26 06:57 | I handed the AI the `y` for the re-signing run of 2026-09-27 07:45 (see below) | `535bafd4` |
| 2026-09-26 07:03 to 07:14 | I pressed `y` on the first purchases from the four demo sellers (0.01 test USDC each, one retried after the facilitator failed to settle) and on publishing their attestations. The screen was recorded | Base Sepolia from block 47302765; Sepolia blocks 11782084 to 11782090 |
| 2026-09-26 07:15 to 07:26 | I pressed `y` on the scene runs: unlink and relink seller-b, link seller-c to the wrong record and back, unregister and re-register `agent-1.vet402.eth`, and the irreversible `revokeRootRoles` (`emancipate --irreversible`). The screen was recorded | Sepolia blocks 11782102 to 11782147 |
| 2026-09-26 07:30 | I pressed `y` on writing the observation log of a third-party seller under `obs.vet402.eth` | Sepolia block 11782167 |
| 2026-09-26 07:44 | I told the AI to make the video and the submission text a presentation in four parts (setup, answer, turn, close) that explains why ENS and Intercepta, how they work here, and how vet402 keeps using them, with the facts that actually ran kept short and exact | the video; outside git |
| 2026-09-26 09:29 to 09:36 | I pressed `y` on scene 2 of the video: pay while vet402's API is unreachable, change one character of the offer, the same payment is refused, change it back. The screen was recorded | Sepolia blocks 11782719 and 11782723 |
| 2026-09-26 09:40 to 09:49 | I recorded the narration of the video myself, in four recordings | the video |
| 2026-09-26 09:48 | I asked for English subtitles on the video | the video |
| 2026-09-26 10:23 | I asked for a heading card at the start of scene S06, the scene that explains why ENSv2 | the video |
| 2026-09-26 10:38 | I told the AI to take in every finding of an independent adversarial check, and handed it the `y` for a re-signing run on 2026-09-26 at 19:00 (see below) | `git log e572257c..tokyo-2026-submission` |

## Sends I handed to the AI

These run without my `y`. I decided to hand them over at the times given; the AI runs them.

| Delegated at | Runs at | What |
|---|---|---|
| 2026-09-26 06:57 | 2026-09-27 07:45 | Re-buy from the four demo sellers and re-publish their attestations, so the proofs stay fresh during judging |
| 2026-09-26 10:38 | 2026-09-26 19:00 | The same, as a safety run ahead of the 2026-09-27 run |

The AI also pressed the public `/tokyo` judge button on production to test it (2026-09-26, between 07:54
and 07:56 and again after 08:20). Those presses are not listed above because I did not make them.

## Not in this log

This file was compiled on 2026-09-26. The submission on the ETHGlobal dashboard and the judging on
2026-09-27 are not in it. The tag `tokyo-2026-submission` marks the commit I submit.
