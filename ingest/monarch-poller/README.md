# Monarch Money → Setoku ingest bridge

Pull-based poller (profile `monarch`). Monarch has **no official data API** and no
push stream; access is its private GraphQL endpoint (`/graphql`). So we poll on a
loop, like the Mercury and Render bridges.

## What it ingests

| tick step | endpoint (Vector) | lake table | engine |
|---|---|---|---|
| account + balance snapshot | `/ingest/monarch/accounts` | `monarch_accounts` | MergeTree (append-only time series) |
| daily net-worth history | `/ingest/monarch/networth` | `monarch_net_worth` | ReplacingMergeTree(ingested_at) |
| rolling window of transactions | `/ingest/monarch/transactions` | `monarch_transactions` | ReplacingMergeTree(ingested_at) |
| monthly budget vs. actual | `/ingest/monarch/budgets` | `monarch_budgets` | ReplacingMergeTree(ingested_at) |
| investment portfolio breakdown | `/ingest/monarch/holdings` | `monarch_holdings` | MergeTree (append-only time series) |

Monarch objects are **mutable** (a transaction is recategorized, a pending charge
posts, a day's net worth is revised on institution back-fill), so we re-emit rolling
windows and the newest observation wins via `ingested_at`. Accounts and holdings are
append-only per-tick snapshots (latest snapshot = current state).

`monarch_net_worth.balance` is Monarch's own aggregate — assets minus liabilities,
signs already resolved. `monarch_accounts.current_balance` is **signed** (liabilities
negative); net worth = `SUM(current_balance)`, never assets−liabilities and never
`SUM(display_balance)` (the UI flips liability signs). `monarch_transactions.amount`
is signed (negative = money out); exclude `hide_from_reports=1` from spend/income.

## Auth — browser session cookies (there is no API key)

Monarch has no read-only API token, and its `/auth/login/` endpoint **blocks
automated password logins** (returns a CAPTCHA challenge, an app-version gate, or a
Cloudflare block from datacenter IPs). The working method — the same one the
maintained community libraries moved to — is to lift a **session from a logged-in
browser**: the `session_id` and `csrftoken` cookies, sent with an `X-Csrftoken`
header.

Grab them from your browser (DevTools → Network → any `api.monarch.com/graphql`
request → **Cookie** request header), then on the box:

```
deploy/set-monarch-cookie.sh --env-file /opt/setoku/.env
```

It writes `SETOKU_MONARCH_SESSION_ID` + `SETOKU_MONARCH_CSRFTOKEN` (hidden prompt;
nothing else persisted). The session lasts days-to-weeks; when it expires the poller
logs a `401` and stops updating — re-run the helper with fresh cookies and
`docker compose restart monarch-poller`. (Set `MONARCH_API_BASE=https://api.monarch.com`
if your session was minted against the newer host.)

> Monitoring tip: `max(monarch_accounts.snapshot_ts)` should stay under ~90 min.
> If it goes stale, the cookie expired.

## Schedule

Reads run every tick (hourly, aligned to the top of the hour). A **force-refresh**
(the UI's "refresh" button — an institution sync) fires at most **once/day** at
`MONARCH_REFRESH_HOUR` Pacific (default 13:00 = US market close), waits ~5 min for
the sync, then reads. This keeps balances fresh without hammering the banks. Set
`MONARCH_FORCE_REFRESH=0` to disable, or `MONARCH_RUN_ONCE=1` for a single cron-style run.

## Run

```
# .env: add `monarch` to COMPOSE_PROFILES, set the two SETOKU_MONARCH_* cookies
docker compose --profile monarch up -d --build monarch-poller
docker compose logs -f monarch-poller
```

First tick backfills deep (txns 3y, net worth 5y, budgets 18mo); later ticks scan
recent windows. State on the `monarch_state` volume gates this.

## ⚠ Fragility

Unofficial. Monarch moved the API host (`monarchmoney.com` → `monarch.com`) in 2026
and can change the GraphQL schema without notice. `MONARCH_API_BASE` repoints the
host without a code change. If a query starts erroring, diff the fragments against
the current community `monarchmoney` Python library, which tracks the live schema.
