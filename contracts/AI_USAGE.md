# AI usage: the Stellar contracts (contracts/)

This covers `contracts/stellar-roots` and `contracts/stellar-escrow`, built on 2026-10-20. The rest of the repository
has its own record in the top-level `AI_USAGE.md`.

## Who did what

| Part | Written by | Checked by | Decided by Takeshi |
|---|---|---|---|
| `stellar-roots` contract, tests, `tools/` (tree, day snapshot, daily commit job) | Claude (Anthropic) in Claude Code | Five independent Claude review agents in turn (scores 86, 89, 92, 93, then 96 on the final branch), each running the tests and probing the daily job against fake commands | to rebuild on Stellar and resubmit to the Stellar Community Fund, and to use AI agents to build it |
| `stellar-escrow` contract, tests, README | Grok Build (xAI), in an isolated scratch copy with no access to keys | Two independent Claude review agents (88, then 95), with mutation tests and attack tests run on a copy. Claude then added three tests and the README note that a release trusts the writer key | the same |
| Testnet deploys, the paid, refused and refunded escrow runs, the wasm hash checks | Claude, with testnet keys created for this work only | the final review read every transaction back from testnet | the same |

Every commit under `contracts/` carries `Co-Authored-By: Claude Opus 5.5`. No change to vet402's mainnet payment path
is in these commits. The contracts run on testnet only and hold testnet tokens only.

## How to check any of this yourself

```bash
git log --format='%h %ad %s' --date=short -- contracts/
git log --format='%(trailers:key=Co-Authored-By,valueonly)' -- contracts/ | sort | uniq -c
```

The wasm built from each directory matches the code on testnet (`README.md` in each directory has the hash and the
commands).
