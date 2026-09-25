# What a second attester has to do

vet402 is the only attester in this demo (`atst.vet402.eth`). A consumer that trusts one attester is trusting one company, so this page states what any other attester must do before its signature over an `x402-offer` record means the same thing as vet402's. I did not build a second attester myself. Anyone can become one by following these steps and publishing a name.

## The record being attested

```
key:    x402-offer
value:  one line of JSON, signed byte for byte
        {"v":1,"resource":"<absolute https URL>","method":"GET"|"POST",
         "network":"eip155:84532","asset":"<0x… ERC-20>","amount":"<decimal minor units>",
         "payTo":"<0x…>","output":{"required":["result","observed_at"]}}
companion key: agent-endpoint[x402] = the same URL as "resource"
```

An attestation over this value means: the attester paid this exact offer at time `t`, and what came back matched the declaration.

## The six steps (all must pass, or nothing is signed)

1. **The manager proves control.** The attester asks the current manager of the name to sign a fresh challenge (EIP-191) and recovers the address `a` from it.
2. **The chain agrees.** `UniversalHelper.findExactOwner(dns(normalize(n)))` returns the same `a`, read at one pinned Sepolia block on two independent RPC providers that must return the same bytes.
3. **The attester buys.** It requests `resource` with `method`, reads the 402, and requires every field of the chosen accept to equal the offer (`network`, `asset`, `amount`, `payTo`), and `agent-endpoint[x402]` to equal `resource`. Then it pays that exact amount.
4. **The delivery matches.** The paid response body carries every key in `output.required` (here `result` and `observed_at`) at the top level.
5. **Nothing moved underneath.** `(n, a, v)` is read again at a later block and is unchanged.
6. **Sign.** The attester fixes `t` (unix seconds) and signs.

## Signature format

Attestations follow the ENSIP-29 draft text at PR #85 commit `e00c3453a4ce0fec8439e2aeeea4c47cb0604efe` (envelope version 1, payload `n, a, k, v, t`). The draft leaves three things open, and vet402 resolves them like this:

1. `a` is a CBOR byte string of exactly 20 bytes, not a hex text string.
2. `n` is the ENSIP-15 normalized name, and the same normalization runs before the DNS encoding used for the lookup.
3. The signature is EIP-191 over the 32-byte keccak256 of the encoded payload: `"\x19Ethereum Signed Message:\n32" ‖ keccak256(payload)`.

With these choices the payload is 330 bytes and the envelope is 79 bytes for the demo offer. The envelope is stored under the text key `attestations[x402-offer][<attester name>]`, in base64 or `0x` hex. A verifier also reads the atst.me reference format (envelope version 2, payload `n, a, p, h, t`).

## Naming

The attester publishes its signing address as the `addr` record of its own ENS name, for example `atst.<attester>.eth`. Rotating the key means changing that record, and consumers who pinned the old address will refuse (`ens_attester_unpinned`) until they update their pin on purpose.

## What the consumer keeps (not the attester)

- **The trust list is the consumer's file**, a list of `(name, address)` pairs per record key. See `examples/tokyo-2026-demo/trusted-attesters.json`. The address always comes from the local file; the name's current `addr` must match it.
- **How fresh is fresh enough** is the consumer's choice. The public verifier in this repo accepts attestations up to 7 days old. The demo agent's own policy (`x402-policy` on `agent-1.vet402.eth`) accepts 24 hours.
- **How many attesters must agree** (`minValid`) is the consumer's choice too. It defaults to 1.

## Check it yourself

```
git clone --depth 1 --branch tokyo-2026-submission https://github.com/kzmttkc/vet402
cd vet402/examples/tokyo-2026-demo && npm ci && npm run verify -- seller-a.eth
```

The command rebuilds the payload from live ENS data, recovers the signer, and prints each of the seven steps.
