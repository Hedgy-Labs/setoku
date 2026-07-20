<!-- SPDX-License-Identifier: Apache-2.0 -->
# gmail-poller

Pull-based Gmail → Setoku ingest bridge. Polls the Gmail REST API (read-only) and
lands parsed messages in the lake table `setoku.gmail_messages`.
`ingest/github-poller` is the structural template.

**One poller serves every mailbox.** A family box has several (yours, your
spouse's, …); all authorize the same OAuth client and each contributes a refresh
token to `GMAIL_REFRESH_TOKENS`. Every account's rows share the table under its own
`account` (the mailbox email), with an independent sync cursor — one account
failing never resets another.

## What it does

- **First run:** backfills `GMAIL_BACKFILL_DAYS` (default 90) of mail via
  `users.messages.list` over `after:<date>`.
- **Steady state:** `users.history.list` from the stored `historyId` — only new
  messages. If the cursor has aged out (long downtime), it resyncs a recent
  window (`GMAIL_RESYNC_DAYS`) by date.
- Fetches each id with `format=full`, extracts the plain-text body (falls back to
  stripped HTML), parses From/To/Subject/labels, and POSTs NDJSON to Vector at
  `/ingest/gmail/messages`.
- Beats liveness to `/ingest/heartbeat` (connector `gmail-poller`).

Messages are **mutable** (labels change), so the table is a `ReplacingMergeTree`
keyed by `(account, message_id)` — **query with `FINAL`**. State (the historyId
cursor) lives on the `/state` volume so restarts don't re-backfill.

## What is deliberately NOT ingested

- **Spam & Trash** — never listed (`messages.list` excludes them by default).
  Also the highest injection-risk text, so this shrinks the attack surface.
- **Auth mail** — 2FA codes, password resets, magic links are dropped at the
  poller (`GMAIL_DROP_AUTH=1`, default): zero query value, pure liability.
- **Raw payloads** — no `raw` column; the raw MIME is just the body again.

**Marketing** (a `List-Unsubscribe` header) is kept but flagged `is_bulk=1`, so a
miscategorized receipt is still recoverable; queries default to `WHERE is_bulk = 0`.

`subject` / `snippet` / `body` / `from_name` are **untrusted free text** — anyone
can email you. The read/write membrane (I2/I9) is what contains that; treat this
data as hostile downstream.

Retention: an 18-month `TTL` on the table self-prunes old mail (see
`ingest/schemas/080_gmail_messages.sql`).

## Auth — scheme #1: per-user OAuth (`gmail.readonly`)

Works for consumer `@gmail.com` AND Google Workspace users — the one scheme that
spans both. A future scheme #2 (Workspace domain-wide delegation) slots into
`mailboxHandles()` for O(1) enterprise onboarding; select it with
`GMAIL_AUTH_MODE=dwd` (not yet implemented).

**Primary path — the admin Connect button (no SSH, no CLI):**

1. One-time: create a Google Cloud **Web application** OAuth client, set
   `SETOKU_GMAIL_CLIENT_ID` / `SETOKU_GMAIL_CLIENT_SECRET` on the box, and register
   the redirect URI shown on the **Connectors** page
   (`<public-url>/admin/api/gmail/oauth/callback`).
2. Bring the (single) poller up — it idles healthily until a mailbox is connected:
   ```bash
   docker compose --profile gmail up -d --build gmail-poller
   ```
3. In `/admin → Connectors`, click **Connect a mailbox** and consent. The gateway
   writes the refresh token to `/data/gmail-tokens.json` (the poller reads it
   read-only); syncing starts on the next tick. Repeat per mailbox — one poller
   serves them all. Connecting is admin-only and audited (I9).

**CLI/dev fallback** (headless boxes, no browser round-trip): mint tokens with
`deploy/set-gmail-token.ts` (loopback OAuth) into `SETOKU_GMAIL_REFRESH_TOKENS`.
The tokens file wins when it exists; env is used only when it doesn't.

## Env

| var | default | notes |
|-----|---------|-------|
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | — | the one shared OAuth client (operator-set) |
| `GMAIL_TOKENS_FILE` | `/gateway-data/gmail-tokens.json` | refresh tokens written by the admin Connect flow; read fresh each tick; wins over the env below when present |
| `GMAIL_REFRESH_TOKENS` | — | CLI/dev fallback; comma-separated, one token per mailbox (`GMAIL_REFRESH_TOKEN` singular also accepted) |
| `GMAIL_AUTH_MODE` | `oauth` | `dwd` (Workspace domain-wide delegation) is scheme #2, not yet implemented |
| `GMAIL_VECTOR_URL` | `http://vector:8080` | base; paths appended |
| `GMAIL_POLL_INTERVAL_MS` | `900000` | 15 min |
| `GMAIL_BACKFILL_DAYS` | `90` | first-run lookback; bump later, no code change |
| `GMAIL_RESYNC_DAYS` | `7` | fallback window when the history cursor expired |
| `GMAIL_QUERY_EXTRA` | `-in:chats` | appended to backfill/resync query |
| `GMAIL_BODY_CAP` | `50000` | plain-text body cap (chars) |
| `GMAIL_DROP_AUTH` | `1` | `0` keeps auth/2FA mail |
| `GMAIL_STATE_DIR` | `/state` | cursor lives here |

## Adding a mailbox later

No new service, no restart: in `/admin → Sources → Gmail`, click **Connect a
mailbox** and consent. The new mailbox backfills on its next tick; existing
mailboxes keep their cursors. Per-mailbox state in `/state/gmail-poller.json` is
keyed by the credential (a hash of the refresh token), so a disconnect+reconnect
mints a new token → a fresh backfill (no gap-mail lost).

## Known limitations

- **Labels are as-of-ingest, not live.** The incremental sync only watches
  `messageAdded`, so a message reclassified AFTER ingest (INBOX → SPAM/TRASH,
  archive, read/unread) isn't re-observed until a full resync. Mail that *arrives*
  as spam/trash is excluded; mail marked spam *later* stays queryable with stale
  labels until the 18-month TTL. Re-observing label changes (via `labelAdded` /
  `labelRemoved` history + a delete path) is a follow-up.
- **`/admin` manages OAuth-connected mailboxes only.** Mailboxes seeded via
  `GMAIL_REFRESH_TOKENS` (the `set-gmail-token.ts` CLI path) still sync (union with
  the file), but the gateway can't see the poller's env, so they don't appear in
  the Gmail card and can't be disconnected from the UI — manage those on the box.
  Don't mix the CLI and admin paths for the same mailbox.
- **Liveness goes dark on an all-mailbox failure.** If every mailbox errors in a
  tick (e.g. Vector briefly unreachable), no heartbeat is emitted until the next
  clean tick, so `/admin` can show the poller stale for up to one poll interval on
  a transient hiccup. This matches the other pollers' convention.
