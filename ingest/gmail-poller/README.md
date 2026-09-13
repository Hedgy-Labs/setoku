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

- **Archive walk:** pulls history backwards from today to
  `GMAIL_BACKFILL_DAYS` (default 90) via `users.messages.list`, one
  `GMAIL_BACKFILL_CHUNK_DAYS` window at a time, **checkpointing after every
  chunk**. Newest mail lands first and the archive fills in behind it.
- **Steady state:** `users.history.list` from the stored `historyId` — only new
  messages. Runs on every tick *including while the walk is still going*, so new
  mail never queues behind a long backfill. If the cursor has aged out (long
  downtime), it resyncs a recent window (`GMAIL_RESYNC_DAYS`) by date.
- Fetches each id with `format=full`, extracts the plain-text body (falls back to
  stripped HTML), parses From/To/Subject/labels, and POSTs NDJSON to Vector at
  `/ingest/gmail/messages`.
- Beats liveness to `/ingest/heartbeat` (connector `gmail-poller`).

Messages are **mutable** (labels change), so the table is a `ReplacingMergeTree`
keyed by `(account, message_id)` — **query with `FINAL`**. State (the historyId
cursor and the walk's checkpoint) lives on the `/state` volume so restarts don't
re-backfill.

### Pulling a whole mailbox

`GMAIL_BACKFILL_DAYS` is safe to set to years. The walk spends
`GMAIL_BACKFILL_BUDGET_MS` per tick and then resumes on the next one, ticking
every 30s while a backfill is outstanding and settling back to
`GMAIL_POLL_INTERVAL_MS` once it reaches the horizon. Re-ingest is idempotent
(ReplacingMergeTree), so an interrupted walk costs time, never data.

**Expect this to take hours, and plan for it to run unattended.** Throughput is
quota-bound, not code-bound: Gmail enforces a *Units per minute per user* budget
whose real ceiling is set per Google-Cloud-project and cannot be read from the
API. Measured on one real box:

| paced target | achieved | throttled |
|---|---|---|
| 2/s | 2.0/s | 0 |
| 5/s | 2.7/s | 140 |

That is ~600 units/min clean — about **2 `messages.get`/sec**, roughly a
twentieth of the published 15,000 units/min default. At that rate a 122k-message
archive is ~13 hours. Short burst probes badly overstate it (a 50-message burst
measures ~29/s); only a sustained run tells the truth.

Because the ceiling is per-project and unknowable, the poller **discovers** it: a
shared governor spends each rolling minute's budget as fast as the API will take
it, waits exactly long enough for the window to roll, and adapts the budget
itself — trimming it on a throttle, reaching for a little more after a run of
clean responses. Modelling the server's own shape matters: an earlier version
paced to a smooth average requests/sec and measured *worse than no pacing at
all* (0.8/s against 2.5/s), because smoothing leaves most of each minute unspent.
Two consequences:

- `GMAIL_FETCH_CONCURRENCY` bounds parallelism but **does not set speed** — the
  governor does. Raising it does not make the backfill faster.
- Running just *under* the limit beats running over it. Once the per-minute
  bucket is empty Gmail rejects `messages.list` too, which stalls the poller
  wholesale rather than merely slowing it.

`GMAIL_RATE_START` / `GMAIL_RATE_MAX` are the governor's starting guess and cap,
in requests per rolling minute.
If a mailbox is slower than you expect, check the per-chunk log line (it prints
the settled pace and the throttle count) before touching anything — and if the
pace has settled far below the published default, the fix is the project's quota
in Cloud Console, not a poller setting.

`GMAIL_BACKFILL_QUERY_EXTRA` is the other lever worth knowing: appended to the
**walk** query only, never to steady state. `-category:promotions
-category:social` typically drops a third of a personal mailbox (years of
marketing) without touching receipts and notifications, which live in
`category:updates`.

Sizing: rows run ~2.6 KiB each on disk, so a 200k-message lifetime archive is
roughly half a gigabyte.

⚠ The lake table's retention TTL is set in `ingest/schemas/080_gmail_messages.sql`,
which only runs on a **fresh** ClickHouse. Widening the backfill on a box that is
already up means also running the `ALTER TABLE … MODIFY TTL` noted in that file —
otherwise the engine prunes the history you just pulled.

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

Retention: a 20-year `TTL` on the table (see
`ingest/schemas/080_gmail_messages.sql`) — a bound so the table can't grow
forever, not a trim of history.

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
| `GMAIL_BACKFILL_DAYS` | `90` | how far back the archive walk goes; safe to set to years |
| `GMAIL_BACKFILL_CHUNK_DAYS` | `30` | one walk step; bounds work lost to a crash |
| `GMAIL_BACKFILL_BUDGET_MS` | `600000` | wall clock spent walking per tick |
| `GMAIL_BACKFILL_QUERY_EXTRA` | — | appended to the **walk** query only, e.g. `-category:promotions -category:social` |
| `GMAIL_FETCH_CONCURRENCY` | `4` | in-flight `messages.get` calls — bounds parallelism, does NOT set the pace |
| `GMAIL_RATE_START` | `150` | governor's initial requests per rolling minute; it adapts from here |
| `GMAIL_RATE_MAX` | `3000` | ceiling for that adaptation (the published per-user default) |
| `GMAIL_RESYNC_DAYS` | `7` | fallback window when the history cursor expired |
| `GMAIL_QUERY_EXTRA` | `-in:chats` | appended to every list query |
| `GMAIL_BODY_CAP` | `50000` | plain-text body cap (chars) |
| `GMAIL_DROP_AUTH` | `1` | `0` keeps auth/2FA mail |
| `GMAIL_STATE_DIR` | `/state` | cursor lives here |

## Adding a mailbox later

No new service, no restart: in `/admin → Sources → Gmail`, click **Connect a
mailbox** and consent. The new mailbox starts its archive walk on the next tick; existing
mailboxes keep their cursors. Per-mailbox state in `/state/gmail-poller.json` is
keyed by the credential (a hash of the refresh token), so a disconnect+reconnect
mints a new token → a fresh backfill (no gap-mail lost).

## Known limitations

- **Labels are as-of-ingest, not live.** The incremental sync only watches
  `messageAdded`, so a message reclassified AFTER ingest (INBOX → SPAM/TRASH,
  archive, read/unread) isn't re-observed until a full resync. Mail that *arrives*
  as spam/trash is excluded; mail marked spam *later* stays queryable with stale
  labels until the retention TTL. Re-observing label changes (via `labelAdded` /
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
