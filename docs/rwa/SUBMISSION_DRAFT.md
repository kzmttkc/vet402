# Open House Singapore — submission form draft (vet402 /rwa)

Fields as measured on the HackQuest form (SPEC §13b patch 012). Contract,
anchor tx and chain filled 2026-09-28 from `fixtures/rwa/anchor.json`
(source verified on Blockscout, `--verify` printed `match: true`). Every answer is
under the 300-character limit; the counts are checked by
`packages/rwa/test/submission-draft.test.ts`.

Claim scope (memory `openhouse-claim-only-rwa-parent-stays-multichain`): only
`/rwa` is claimed. The parent vet402 is not presented as Buildathon work, and
nothing here mentions other hackathons' prizes.

## What is your contract address?

0x1955137e7773f2459eb75fb88842026c6517c22d (RwaAnchor on Robinhood Chain 4663)

## Which Prize Track

Overall Prize and Promising Products Track. /rwa is built only on Robinhood Chain, an Arbitrum Orbit chain.

## Link to frontend/UI/website

https://vet402.com/rwa/0xE9B08727131E34010b34006c660D4c1B436EC25f
Agents can buy the same JSON over x402 for 0.01 USDG: /api/v1/rwa/paid/facts/<address>. First settlement tx 0xeb26d1b5b0b1a12056ec8abd99640fcbb00860552b4c5a44d3e1b67b3da73760.

## List your Core Protocol / Smart Contract Addresses

RwaAnchor 0x1955137e7773f2459eb75fb88842026c6517c22d on Robinhood Chain: an ownerless, non-upgradeable contract that records keccak256 commitments to published reconstructions. Anchor tx: 0x9b776d6a4670768e3e85261fcf3a5fc02012668e3323fee7211b07d8deca72d7.

## List your Factory/Pool Contracts (if applicable)

Not applicable: /rwa deploys no factory or pool. It reads the Uniswap v3 factory 0x1f7d7550b1b028f7571e69a784071f0205fd2efa and the v4 PoolManager 0x8366a39cc670b4001a1121b8f6a443a643e40951 on Robinhood Chain.

## List your Token Contract Address (if applicable)

Not applicable: no token is issued. /rwa reads the canonical NVDA Stock Token 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC and its Chainlink feed 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15.

## Which parts of your code have been produced during the Buildathon?

All of /rwa, first code commit 2026-09-16 22:03 UTC: packages/rwa (classifier, FIFO, feed staleness, anchor), src/app/rwa, src/app/api/v1/rwa, fixtures/rwa, RwaAnchor.sol. The parent vet402 product predates the event and is not claimed.

## Which sponsor/partner technologies have you used?

Robinhood Chain, Paxos/USDG
