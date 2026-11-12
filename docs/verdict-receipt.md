# Verdict receipt

vet402 attaches a receipt to a successful verdict from GET /api/v1/check and GET /api/v1/resources/{resource_id}/decision when the environment variable VET402_RECEIPT_SIGNER_KEY holds a signing key. vet402 omits receipt when that variable is unset or unreadable, and the rest of the response stays as it is. vet402 does not create the key.

## Fields

receipt has five fields.

- input_sha256 is the lowercase hex sha256 of the canonical input below, as utf8.
- verdict is ALLOW, WARN, BLOCK, or NONE. NONE means GET /api/v1/check had no catalog row and recommendation is null. A decision verdict is ALLOW, WARN, or BLOCK, the same word as recommendation.
- as_of is the time of the verdict. On a check it is the as_of field. On a decision it is scoredAt. The shape is 2026-11-12T00:00:00.000Z.
- signer is the address of the key that signed.
- signature is the EIP-191 signature of the message below.

## Canonical input

Lines are joined by a newline. There is no newline after the last line. Empty values stay empty.

For a check, url is the url query value. method is the method query value in uppercase, or empty when the caller omitted method.

```
check
url:<url>
method:<method>
```

For a decision, allow_without_l1 is true only when the query says true. payer and caller_dialect are empty when the caller omitted them.

```
decision
resource_id:<resource_id>
role:<payer or payee>
payer:<payer or empty>
caller_dialect:<v1 or v2 or empty>
allow_without_l1:<true or false>
```

caller_policy and include_score are not part of the input. They do not change recommendation.

## Signed message

vet402 signs this text with EIP-191. Line breaks are newline characters.

```
vet402.com verdict receipt
domain: vet402.com
input sha256: <input_sha256>
verdict: <verdict>
as_of: <as_of>
This signature attests the verdict above for the input with this sha256. It moves no funds.
```

## How to check

POST /api/v1/receipts/verify with JSON of the five fields. No API key is required. A signature that matches returns HTTP 200 and ok true. A changed field returns HTTP 200 and ok false with error invalid_signature. A field vet402 cannot read returns HTTP 400 and error invalid_input. The route allows 30 requests per minute per IP.

A reader can also run verifyMessage on the message above, with address set to signer and signature set to signature. The check does not need the signing key. ok true means the signer named in the receipt signed those fields. The signer address is how a reader tells a vet402 receipt from a receipt signed by someone else.
