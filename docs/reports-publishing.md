# Monthly ledger freeze — external publish runbook (I6)

vet402 builds upload bundles under `dist/reports/{month}/` with `npx tsx scripts/reports/package-month.ts {month} --fetch`. That script only reads public URLs. It does not upload. First publication on each platform needs owner approval (C4).

## Inputs (public, no database)

| Resource | URL |
| --- | --- |
| Summary JSON | `GET https://vet402.com/api/v1/reports/{month}.json` |
| CSV body (no header row) | `GET https://vet402.com/api/v1/reports/{month}.csv` |

The CLI verifies `x-vet402-content-sha256` when present. Bundle CSV files add the frozen header row from `EXPORT_CSV_COLUMNS`. KPI and revenue fields are not included (C2).

## Local build

```bash
npx tsx scripts/reports/package-month.ts 2026-10 --fetch
# optional: --origin https://vet402.com  --out dist/reports
```

If the month is not frozen yet, the process prints `未凍結` and exits 0 without writing files.

Output layout:

- `dist/reports/{month}/zenodo/` — `metadata.json`, `README.md`, `vet402-ledger-{month}.csv`, `SHA256SUMS`
- `dist/reports/{month}/huggingface/` — `README.md` (dataset card), `vet402-ledger-{month}.csv`
- `dist/reports/{month}/dune/` — `DESCRIPTION.md`, `vet402-ledger-{month}.csv`

## Zenodo

**Credentials (owner only, not in repo):** `ZENODO_ACCESS_TOKEN` — personal access token from https://zenodo.org/account/settings/applications/tokens/new (or sandbox equivalent).

**API:** REST deposition API v1 — https://developers.zenodo.org/#deposition-actions

Typical flow (owner):

1. Create a new version under concept DOI `10.5281/zenodo.24195171` (observatory dataset), or create a new deposition if vet402 starts a separate concept for monthly freezes.
2. `POST /api/deposit/depositions` with JSON body merging `zenodo/metadata.json` from the bundle.
3. `PUT /api/deposit/depositions/{id}/files/{filename}` for each file except `metadata.json` and `SHA256SUMS` (or upload all data files listed in `SHA256SUMS`).
4. `POST /api/deposit/depositions/{id}/submit` then `POST .../publish` after review.

**CLI helpers:** none in-repo; use `curl` or Zenodo web UI. Optional: `pip install zenodo-upload` (third party; verify before use).

## Hugging Face Datasets

**Credentials (owner only):** `HF_TOKEN` with write access — https://huggingface.co/settings/tokens

**CLI:** Hugging Face Hub — https://huggingface.co/docs/huggingface_hub/guides/cli

```bash
# Example (owner adjusts repo id and visibility)
export HF_TOKEN=...   # owner sets locally; never commit
huggingface-cli repo create vet402-monthly-ledger-2026-10 --type dataset --private
huggingface-cli upload vet402/vet402-monthly-ledger-2026-10 dist/reports/2026-10/huggingface/. --repo-type dataset
```

Dataset card is `README.md` in the bundle. License tag `cc-by-4.0`.

## Dune

**Credentials (owner only):** Dune API key — https://dune.com/settings/api (for scripted upload if used)

**Import (manual, usual path):**

1. Dune web UI → create table / upload CSV.
2. Upload `dune/vet402-ledger-{month}.csv` from the bundle.
3. Follow `dune/DESCRIPTION.md` for column semantics (`attempted_at`, micro-unit amounts).

Dune has no single mandated CLI in this repo. Owners may use Dune API v1 (`POST /api/v1/table/upload/csv`) with `DUNE_API_KEY` when approved.

## Checks before publish

1. Run `npx tsx scripts/reports/package-month.ts {month} --fetch` and keep the printed `fileSha256` line in the handoff.
2. Confirm `contentSha256` matches `GET /api/v1/reports/{month}.json` and the daily anchor line `monthly-freeze:v1:{month}:{sha256}` when present.
3. Owner approval before any first-time deposition, dataset repo, or Dune table made public (C4).