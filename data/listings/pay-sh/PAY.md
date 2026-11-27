---
name: 'rwa-facts'
title: 'vet402 RWA facts on Robinhood Chain'
description: 'Paid x402 route that returns the same Robinhood Chain RWA facts JSON as the free facts route, settled in USDC on Base through the Coinbase CDP facilitator, with CDP Bazaar discovery metadata on the 402.'
use_case: 'Use when an agent needs signed Robinhood Chain (chain 4663) RWA reconstruction facts for one wallet and can pay per call in USDC on Base through x402.'
category: 'data'
service_url: >-
    https://vet402.com
openapi:
  path: 'openapi.json'
---

Paid x402 lane for vet402 RWA facts. Settlement is USDC on Base via the Coinbase CDP facilitator.
The 402 includes `extensions.bazaar` for CDP Bazaar discovery.
Full API reference for every public route lives at https://vet402.com/openapi.json.

