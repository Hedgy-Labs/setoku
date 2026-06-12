<!-- SPDX-License-Identifier: Apache-2.0 -->
# Mercury Bank ingest bridge

Pulls Mercury account balances and transactions into the Setoku lake. Mercury is
API-only with no self-serve push stream, so we poll — the same pull-bridge
pattern as the Render logs bridge.

## What it does each tick (default every 5 min)

1. `GET /accounts` → one **balance snapshot** row per account →
   `setoku.mercury_accounts` (append-only time series; trend it for runway).
2. `GET /account/{id}/transactions?start=…` over a **rolling window** →
   `setoku.mercury_transactions` (a `ReplacingMergeTree` keyed by id, so the
   newest observation of a mutable transaction wins).

The first run backfills `MERCURY_BACKFILL_DAYS` (default 730); after that it only
re-scans `MERCURY_WINDOW_DAYS` (default 35), enough to catch `pending → posted`
status changes and late `postedAt` fills. State (`backfilledThrough`) lives on the
`mercury_state` volume so a restart neither re-backfills nor loses the window.

## Why re-poll instead of append-only

A bank transaction is **mutable**: it moves `pending → sent/posted` (or fails),
and `postedAt` arrives later. An append-only log would freeze the first
observation. Re-emitting the recent window + `ReplacingMergeTree(ingested_at)`
keeps current state correct. **Query `mercury_transactions` with `FINAL`** (or
`argMax`/`LIMIT 1 BY id`) so you read one current row per transaction and don't
double-count `amount` over an in-flight update.

## Data minimization

Full account numbers are **never** stored. The poller redacts `accountNumber` to
the last 4 digits in both the typed column and `raw` before anything leaves the
process. Counterparty names / notes / memos are user free text — treat them as
untrusted (the analyst reads the lake under the propose-only membrane, so they
can't drive a curated write regardless).

## Config

| env | required | default | meaning |
|-----|----------|---------|---------|
| `MERCURY_API_TOKEN` | ✅ | — | `secret-token:mercury_…` read-only token (Mercury → Settings → Tokens) |
| `MERCURY_POLL_INTERVAL_MS` | | `300000` | poll cadence |
| `MERCURY_WINDOW_DAYS` | | `35` | steady-state lookback |
| `MERCURY_BACKFILL_DAYS` | | `730` | first-run lookback |

Run it: `docker compose --profile mercury up -d mercury-poller`.

## Optional: webhooks (lower latency)

Mercury can also POST real-time events when transactions change. Setoku captures
these losslessly in `setoku.mercury_events` (append-only) — it does **not** merge
partial webhook patches into `mercury_transactions` (that would clobber unchanged
columns), so the poller stays the source of truth and the webhook is pure
latency. To enable: in Mercury's dashboard set the webhook URL to

```
https://<your-domain>/ingest/mercury/<SETOKU_INGEST_TOKEN>
```

Caddy verifies the path token, strips it, and forwards to Vector's
`/ingest/mercury` route. **Hardening TODO:** Mercury also signs webhooks (HMAC
with a Partner Secret); we currently authenticate by the unguessable path token
only (same posture as the Render route). Add signature verification on the raw
bytes before trusting `mercury_events` for anything beyond observability.
