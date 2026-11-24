# Rules-only decision CLI

`scripts/decide-cli.ts` reads one JSON object from stdin and prints the result of `decidePayer` or `decidePayee` plus `rulesVersion` (`DECISION_RULES_VERSION` in `src/lib/decision/rules.ts`). The process does not open a database, the network, or the environment.

## Input

`role` is `payer` or `payee`. `facts` is `SellerFacts` or `BuyerFacts` from `src/lib/decision/types.ts`. Other fields are the arguments those functions take:

- payer: `now`, `callerDialect`, `allowWithoutL1`, `operatorBlacklist`, `dataDepth`, `l1NotCounted`, `l0UnverifiedCause`, `l1Timeline`, `l2ConformNoRequiredKeys`
- payee: `now` (required, ISO-8601), `operatorBlacklist`

Samples copied from the decision tests live in `fixtures/decide/`.

Stdout is one JSON object: `recommendation`, `reason_codes`, and `rulesVersion`.

## Build

From the repository root:

```bash
docker build -f Dockerfile.rules -t vet402-rules .
```

The image base is the tag `node:24-slim`. The Dockerfile installs only `tsx`, at the version recorded in `package-lock.json`. It copies `package.json`, `package-lock.json`, `tsconfig.json`, `src/lib/decision/rules.ts`, `src/lib/decision/types.ts`, and `scripts/decide-cli.ts`.

## Run

```bash
docker run --network none -i vet402-rules < fixtures/decide/payer-allow.json
```

`--network none` is safe: the entrypoint does not dial out. stdin is the fixture.

The same command works for every file in `fixtures/decide/`.

## Publish the image digest

A tag can move. Publish the digest of the bytes that were pushed.

```bash
docker build -f Dockerfile.rules -t example.invalid/vet402-rules:2026-11-13.1 .
docker push example.invalid/vet402-rules:2026-11-13.1
docker inspect --format '{{index .RepoDigests 0}}' example.invalid/vet402-rules:2026-11-13.1
```

Replace `example.invalid/vet402-rules` with the registry repository. Record the printed `repository@sha256:...` value. Pull that digest later:

```bash
docker pull example.invalid/vet402-rules@sha256:<digest>
```

## Reproduce verdicts from the published image (GHCR)

GitHub Actions workflow `.github/workflows/rules-image.yml` builds `Dockerfile.rules` and pushes to `ghcr.io/vet402/vet402-rules` with tag `DECISION_RULES_VERSION` and `sha-<commit>`. After a green run, copy the digest from the job summary into this section (replace `<digest>` below).

Pull the immutable image:

```bash
docker pull ghcr.io/vet402/vet402-rules@sha256:<digest>
```

Run offline with the same stdin shape as the unit tests (`fixtures/decide/*.json`). Example with `payer-allow.json`:

```bash
docker run --rm -i --network none ghcr.io/vet402/vet402-rules@sha256:<digest> < fixtures/decide/payer-allow.json
```

Expected stdout (single JSON line):

```json
{"recommendation":"ALLOW","reason_codes":["l0_pass","l1_delivered","l2_undeclared"],"rulesVersion":"2026-11-13.1"}
```

The other five fixtures under `fixtures/decide/` must match the host CLI (`scripts/decide-cli.ts`) the same way; CI runs all six inside the pushed image with `--network none`.

**Where to set the digest after build:** replace `<digest>` in the `docker pull` and `docker run` commands in this section only (the `sha256:` prefix stays; paste the hex digest from the workflow job summary, without the `sha256:` prefix if the summary already includes it on the `@sha256:...` line, use the full `ghcr.io/vet402/vet402-rules@sha256:...` reference as printed).
