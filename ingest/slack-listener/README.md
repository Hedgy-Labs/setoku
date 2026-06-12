# slack-listener — Slack → the lake

Two zero-dependency Bun programs (tasks 3.3/3.4):

- **`listener.ts`** — a Socket Mode daemon that archives `message` events from
  public channels the bot is in into `setoku.slack_messages` (ClickHouse), live.
- **`backfill.ts`** — a one-shot, resumable job that imports the retrievable
  history (`conversations.history` + `conversations.replies`) into the same table.

No Slack SDK, no npm packages — `fetch`, `WebSocket`, and `node:fs` only.

> **Start the listener before anything else ships.** On Slack's free plan only
> ~90 days of history is retrievable through the API; everything older is gone.
> The archive only accrues forward — every day without the listener running is
> a day of workspace history you can never get back.

## 1. Create the Slack app (one human, ~3 minutes)

The app definition is checked in as [`manifest.json`](./manifest.json)
(Socket Mode on; bot scopes `channels:history`, `channels:read`, `users:read`;
event subscription `message.channels`).

1. Open the app-creation page: **<https://api.slack.com/apps?new_app=1>** →
   choose **"From a manifest"** → pick your workspace → paste the contents of
   `manifest.json` (JSON tab) → **Create**. (Slack also accepts a pre-filled
   share link of the form `https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded manifest>`
   if you want a true one-click URL for someone else.)
2. **App-level token** (`SLACK_APP_TOKEN`, `xapp-…`): in the app's
   **Basic Information → App-Level Tokens → Generate Token and Scopes**, add the
   `connections:write` scope. This token only opens the Socket Mode connection.
3. **Bot token** (`SLACK_BOT_TOKEN`, `xoxb-…`): **Install App → Install to
   Workspace** → approve → copy the *Bot User OAuth Token*. This token is used
   for the web API (channel listing, history backfill).
4. Invite the bot to the channels you want archived: `/invite @Setoku`
   in each channel. It only ever sees channels it has been invited to.

Put both tokens in the box's `.env`. They are credentials — never in git.

## 2. Run it

The intended compose service is in [`compose-snippet.yml`](./compose-snippet.yml)
(profile `slack`, named volume `slack_spool:/spool`, healthcheck on
`:8686/health`); the root `docker-compose.yml` merge is tracked separately.
Once merged:

```bash
# live listener (long-running daemon)
COMPOSE_PROFILES=lake,ingest,slack docker compose up -d

# one-shot history backfill (same image; safe to re-run any time)
docker compose run --rm slack-listener bun backfill.ts

# backfill only specific channels
docker compose run --rm -e SLACK_BACKFILL_CHANNELS=C0123456789,C0987654321 \
  slack-listener bun backfill.ts
```

Locally, outside compose:

```bash
SLACK_APP_TOKEN=xapp-… CLICKHOUSE_URL=http://localhost:8123 \
CLICKHOUSE_PASSWORD=… SETOKU_SPOOL_DIR=./spool bun listener.ts

SLACK_BOT_TOKEN=xoxb-… CLICKHOUSE_URL=http://localhost:8123 \
CLICKHOUSE_PASSWORD=… SETOKU_SPOOL_DIR=./spool bun backfill.ts
```

| Env | Default | Used by |
|---|---|---|
| `SLACK_APP_TOKEN` | required | listener (Socket Mode) |
| `SLACK_BOT_TOKEN` | required for backfill | backfill (web API) |
| `SLACK_BACKFILL_CHANNELS` | all public channels the bot is in | backfill |
| `CLICKHOUSE_URL` | `http://clickhouse:8123` | both |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `setoku` / empty | both |
| `CLICKHOUSE_DB` | `setoku` | both |
| `SETOKU_SPOOL_DIR` | `/spool` | both (spool + backfill state) |

Health: `GET :8686/health` → `{ connected, spool_depth, inserted_total }`
(compose-network only; nothing is published — I1).

## 3. Durability model (I4)

The lake may hold the **only** copy of messages older than the free-plan
window, so the listener is spool-first:

1. Every event is appended to an NDJSON spool file on the `/spool` volume
   **before** any insert is attempted.
2. Batches flush to ClickHouse every ~2 s (or 100 events). A byte-offset file
   marks delivered progress.
3. If ClickHouse is down, events keep spooling and inserts retry with jittered
   backoff. On startup, any un-acked spool remainder drains first.

Result: a ClickHouse restart, a listener restart, or both lose nothing.
Delivery is **at-least-once**, which is correct here: the table is
`ReplacingMergeTree(ingested_at) ORDER BY (channel, ts)`
([schema](../schemas/030_slack_messages.sql)), so redelivered rows, edits
(`message_changed` is keyed on the original ts), and listener/backfill overlap
all collapse to one row per `(channel, ts)`.

The backfill is resumable the same way: per-channel progress is checkpointed
to `<spool>/slack-backfill-state.json` after every page, so a killed run
continues where it stopped, and a completed channel re-runs incrementally.

## 4. Rate limits (I7 — verified June 2026; these churn, re-verify)

Slack's `conversations.*` limits depend on how the app is distributed:

- **Internal customer-built apps** (you created the app in your own workspace
  from this manifest — the normal self-hosted Setoku case): the generous tier,
  roughly **50 req/min** with up to ~1000 objects per page.
- **Commercially distributed, non-Marketplace apps**: capped at roughly
  **1 req/min and 15 objects per response** (Slack extended enforcement to
  existing installs in 2026). A hosted Setoku SaaS would need Slack
  Marketplace approval to escape this; the OSS self-host model sidesteps it
  entirely because every org runs its *own internal* app.

`backfill.ts` honors `429 Retry-After` always, and auto-detects the tier: it
asks for 200-message pages, and if a `has_more` response comes back with ≤15
messages it drops its request budget to 1/min and logs which tier it detected.
At the capped rate a busy channel can take hours — the live listener is not
affected (Socket Mode delivery is not paginated reads).

When the backfill finishes it prints the **oldest message it could reach per
channel** — on a free plan that is the ~90-day horizon, and everything older
is unreachable for good.

## 5. Tests

```bash
bun test ingest/slack-listener/
```

No network and no real Slack/ClickHouse: the suite runs a fake Slack
(`apps.connections.open` + a scripted Socket Mode WebSocket) and a fake
ClickHouse (which can be told to fail) on loopback, and covers: every envelope
acked, exact row shape, reconnect after Slack's `disconnect`, zero loss across
a ClickHouse outage, and a restart-mid-spool drain by a fresh instance.
