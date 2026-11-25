# Response signatures on vet402 judgment and public number routes

vet402 signs selected JSON API responses with Ed25519 so a third party can confirm later that the body came from vet402's signing key at the time of the call. The signature covers the response path, a UTC timestamp, and the JSON body using RFC 8785 canonicalization (JCS).

## Signed routes

These paths attach a `Vet402-Signature` response header when `VET402_RESPONSE_SIGNING_KEY` is configured:

- `GET /api/v1/check` and `GET /api/v1/decision` (same body)
- `GET /api/v1/find`
- `GET /api/v1/observatory/state`
- `GET /api/v1/observatory/anchors`
- `GET /api/v1/delivery/sellers.json`

When the key is unset or invalid, responses are unchanged and no header is sent.

## Header shape

```
Vet402-Signature: v=1; alg=ed25519; keyid=<kid>; signed_at=<ISO8601 UTC to whole seconds>; sig=<base64url>
```

`keyid` is the first 16 hex digits of SHA-256 over the raw 32-byte Ed25519 public key.

`signed_at` is the instant vet402 signed the response. On a cached response it may be earlier than the time you fetched it.

## Signed bytes

UTF-8 bytes of JCS of:

```json
{
  "v": 1,
  "path": "<pathname plus search of the request URL>",
  "signedAt": "<same instant as signed_at in the header>",
  "body": <the JSON response body>
}
```

The server signs the JSON body after one `JSON.stringify` and `JSON.parse` round trip (the same bytes the client receives). Object keys in `body` are serialized in UTF-16 code unit order. `undefined` object properties are dropped. Array entries that are `undefined` become `null`. Non-finite numbers and lone UTF-16 surrogates in strings are rejected during canonicalization (unsigned response if signing fails).

## Public keys (JWKS)

```
GET https://vet402.com/.well-known/vet402-keys.json
```

`Cache-Control: max-age=300`. When no signing key is configured, the document is `{"keys":[]}`.

Each active key is an OKP / Ed25519 JWK with `use: sig` and `alg: EdDSA`.

## Verification (Node.js)

```javascript
import { createPublicKey, verify } from "node:crypto";
import canonicalize from "canonicalize"; // RFC 8785 JCS (npm)

const jwks = await fetch("https://vet402.com/.well-known/vet402-keys.json").then((r) => r.json());
const res = await fetch("https://vet402.com/api/v1/observatory/state");
const raw = await res.text();
const body = JSON.parse(raw);
const hdr = res.headers.get("Vet402-Signature");
const fields = Object.fromEntries(hdr.split(";").map((p) => p.trim().split("=")));
const jwk = jwks.keys.find((k) => k.kid === fields.keyid);
const pub = createPublicKey({ key: jwk, format: "jwk" });
const msg = Buffer.from(
  canonicalize({ v: 1, path: "/api/v1/observatory/state", signedAt: fields.signed_at, body }),
  "utf8",
);
console.log(verify(null, msg, pub, Buffer.from(fields.sig, "base64url")));
```

Compare `path` to the pathname and query string of the URL that was fetched. Parse the response body from the raw JSON string you received, not from a prior in-memory object. Any change to one character of `body`, `path`, or `signedAt` breaks verification.

## Key rotation

Generate a new Ed25519 key pair. Update `VET402_RESPONSE_SIGNING_KEY` to the new PKCS#8 DER (base64). Only that private key signs new responses. Its public key is published in `vet402-keys.json` with a new `kid`.

Set `VET402_RESPONSE_SIGNING_PREVIOUS_PUBLIC_JWK` to the JSON of the retiring public JWK (OKP / Ed25519, including `kid` and `x`). While set, that JWK is appended as a second entry in `keys` so responses signed under the old key remain verifiable. Keep the previous JWK published for at least 30 days, then clear the variable.