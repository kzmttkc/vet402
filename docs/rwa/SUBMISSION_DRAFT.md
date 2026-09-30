# Open House Singapore — submission form draft (vet402 /rwa)

Fields as measured on the HackQuest form (SPEC §13b patch 012). Contract and
chain filled 2026-09-28. The anchor tx was updated on 2026-09-30 to the
`rwa-recon-0.3` anchor in `fixtures/rwa/anchors/rwa-recon-0.3-76177721.json`
(`verify-record.mjs` printed `RESULT: MATCH`). The 0.1 anchor
(`fixtures/rwa/anchor.json`) still verifies and is kept as history. Every answer is
under the 300-character limit; the counts are checked by
`packages/rwa/test/submission-draft.test.ts`.

Claim scope: only `/rwa` is claimed. The parent vet402 is not presented as Buildathon work, and
nothing here mentions other hackathons' prizes.

## What is your contract address?

0x1955137e7773f2459eb75fb88842026c6517c22d (RwaAnchor on Robinhood Chain 4663)

## Which Prize Track

Overall Prize, Promising Products Track and Grants. /rwa is built only on Robinhood Chain, an Arbitrum Orbit chain.

## Link to frontend/UI/website

https://vet402.com/rwa/0xE9B08727131E34010b34006c660D4c1B436EC25f
Paid JSON for agents (x402, 0.01 USDG): https://vet402.com/api/v1/rwa/paid/facts/0xE9B08727131E34010b34006c660D4c1B436EC25f. First settlement, a test I paid myself: 0xeb26d1b5b0b1a12056ec8abd99640fcbb00860552b4c5a44d3e1b67b3da73760.

## List your Core Protocol / Smart Contract Addresses

RwaAnchor 0x1955137e7773f2459eb75fb88842026c6517c22d on Robinhood Chain, no owner, no upgrade path. It stores the hash of a whole record. Demo record (rwa-recon-0.3, realized −$273.01 on priced sales) anchored in tx 0x15f9ed8ae5dd466c2f35021c9f1291e7a624abbb52c8ac26b54d47442f585c7f.

## List your Factory/Pool Contracts (if applicable)

Not applicable: /rwa deploys no factory or pool. It reads the Uniswap v3 factory 0x1f7d7550b1b028f7571e69a784071f0205fd2efa and the v4 PoolManager 0x8366a39cc670b4001a1121b8f6a443a643e40951 on Robinhood Chain.

## List your Token Contract Address (if applicable)

Not applicable: no token is issued. /rwa reads the 195 canonical Stock Tokens in Robinhood's own list (NVDA is 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC) and the 33 Chainlink equity feeds on Robinhood Chain.

## Which parts of your code have been produced during the Buildathon?

All of /rwa, first code commit 2026-09-16 22:03 UTC: packages/rwa (classifier, FIFO, feed staleness, anchor), src/app/rwa, src/app/api/v1/rwa, fixtures/rwa, RwaAnchor.sol. The parent vet402 product predates the event and is not claimed.

## Which sponsor/partner technologies have you used?

Robinhood Chain, Paxos/USDG, Alchemy
