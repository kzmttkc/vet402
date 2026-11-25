# Bazaar `delivery` field

Optional object explorers attach to each CDP x402 Bazaar discovery item. Values come from the same in memory snapshot as `GET /api/v1/delivery/sellers.json` (cached for 300 seconds). Absence of a matching feed row is `delivery: null`, not zero counts.

`sellers.json` lists only **active** endpoints that have at least one **signed** purchase attempt in the last `window_days`. Endpoints outside that set return `delivery: null` on by resource and annotate even when vet402 has older or unsigned history.

Machine readable schema: [bazaar-delivery-field.schema.json](./schemas/bazaar-delivery-field.schema.json).

## Field shape

```json
"delivery": {
  "paidAttempts30d": 12,
  "delivered30d": 8,
  "settledNotDelivered30d": 2,
  "deliveryRateLowerBps30d": 5200,
  "deliveryRateBand30d": "provisional",
  "lastAttemptAt30d": "2026-11-20T14:02:11Z",
  "lastDeliveredAt30d": "2026-11-19T10:00:00Z",
  "recordUrl": "https://vet402.com/observatory/e/00000000-0000-0000-0000-000000000001",
  "network": "eip155:8453"
}
```

The HTTP response also includes `as_of` (snapshot time), `window_days` (30), `rate_formula` (`v1.0-wilson95`, same string as `sellers.json`), and `rules_version`.

## Mapping to `sellers.json` row fields

Each `delivery` property is the camelCase name of the matching public row column on `sellers.json`.

| `delivery` field | `sellers.json` row field |
| --- | --- |
| `paidAttempts30d` | `paid_attempts_30d` |
| `delivered30d` | `delivered_30d` |
| `settledNotDelivered30d` | `settled_not_delivered_30d` |
| `deliveryRateLowerBps30d` | `delivery_rate_lower_bps_30d` |
| `deliveryRateBand30d` | `delivery_rate_band_30d` |
| `lastAttemptAt30d` | `last_attempt_at_30d` |
| `lastDeliveredAt30d` | `last_delivered_at_30d` |
| `recordUrl` | `record_url` |
| `network` | `network` |

Price, listing source, and Bazaar payer counts stay on `sellers.json` only. The delivery object does not repeat them.

## URL and method matching

Lookups canonicalize the Bazaar `resource` URL with the same rules vet402 uses to key its catalog (HTTPS only, lowercase host, no trailing slash on the path, volatile query keys stripped, remaining query sorted). The HTTP method comes from `extensions.bazaar.info.input.method` when present, otherwise `GET`. Methods outside the catalog probe set are treated as `GET`, the same rule as catalog import.

`GET /api/v1/delivery/by-resource` without a `method` query tries `GET` then `POST` on the snapshot index. Optional `method` narrows to one verb.

## Network when several feed rows share URL and method

Feed rows are keyed by canonical URL and method. Multiple networks for the same pair appear as separate rows in `sellers.json`.

- **Annotate:** vet402 reads the Bazaar item primary accept network (`accepts[0].network`, same as catalog import) and picks the feed row whose `network` matches it. If nothing matches, vet402 picks the first row in the same sort order as `sellers.json` (`url`, then `method`, then `network`, then `endpoint_id`).
- **By resource:** there is no network query parameter today. When several rows match URL and method, vet402 returns the first row in that same sort order.

## HTTP APIs

| Method | Path | Role |
| --- | --- | --- |
| GET | `/api/v1/delivery/by-resource?url=` | Return `delivery` for one resource URL. Optional `method` query. |
| POST | `/api/v1/delivery/annotate` | JSON body `{ "items": [ … Bazaar items … ] }`, at most 100 items, body limit 2 MiB. Each item is returned with a `delivery` field added. |

Both routes work without an API key. Rate limits are separate per route: `GET /api/v1/delivery/by-resource` uses bucket `delivery-bazaar` (30 requests per minute per IP), `POST /api/v1/delivery/annotate` uses `delivery-bazaar-annotate` (30 per minute per IP). `GET /api/v1/delivery/sellers.json` uses `delivery-sellers` (30 per minute per IP).

OpenAPI: `docs/openapi.yaml`.