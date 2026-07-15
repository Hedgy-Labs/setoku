# Deploying the Setoku gateway (HTTP profile, single container)

> **The reference deployment is now the single-box compose stack** — see the
> repo-root `docker-compose.yml`, [oracle-free.md](./oracle-free.md) (prototype)
> and [hetzner.md](./hetzner.md) (recommended). This doc remains for the
> gateway-only profile (no lake/ingest) used by the original pilot.

One small container per company. Knowledge store on a persistent volume; business data reached via the biz.* ClickHouse mirror (the gateway holds no database credential of its own); users connect from Claude Code or Cowork with a bearer token.

## 1. Database role (you run this — Setoku never executes DDL)

Edit and run [`readonly-role.sql`](./readonly-role.sql) against the target database (staging recommended). Result: a `postgresql://setoku_ro:...` URL — consumed by the **pg-mirror** container (which fills biz.*), never by the gateway.

## 2. Build, with your knowledge seed baked in

```bash
# optional: bake your company's context seed into the image (imports on first boot)
# add to deploy/Dockerfile:  COPY hedgy/.setoku/context /project/.setoku/context
docker build -f deploy/Dockerfile -t setoku-gateway .
```

(Alternatively skip baking and push knowledge later via `upsert_context` / `/setoku:generate` against the running gateway.)

## 3. Run

Generate one token per user (`openssl rand -hex 24`). Then e.g. locally:

```bash
docker run -d --name setoku -p 8787:8787 -v setoku-data:/data \
  -e SETOKU_LAKE_URL='http://setoku_ro:...@clickhouse:8123/setoku' \
  -e SETOKU_TOKENS='<tok-a>=alice@co.com,<tok-b>=bob@co.com' \
  setoku-gateway
curl localhost:8787/health
```

(No `SETOKU_DATABASE_URL` — the gateway has no direct business-DB path. `SETOKU_DATABASE_URL` belongs in the pg-mirror container's env.)

On Fly.io: `fly launch --no-deploy` (port 8787, add a volume mounted at `/data`), `fly secrets set SETOKU_DATABASE_URL=... SETOKU_TOKENS=...`, `fly deploy`.

## 3b. Create the operator (login + connector, one identity)

The web approval surface (`/admin`) authenticates with **local accounts**, not
the MCP tokens — a human signs in with a username + password an agent never
holds, so it can't self-approve (I9). On a compose box, create the operator as
ONE person: a web login plus a read-only analyst connector under the same
identity (users ↔ connectors are 1:1):

```bash
docker compose exec server bun gateway/admin-cli.ts add-person <email> --role admin
# prompts for a password (or pass SETOKU_NEW_PASSWORD=… for unattended setup)
# and prints the connector token once (`token=…`)
```

Then visit `https://<your-host>/admin` and sign in. (`--role member` adds a
person who can use the agent and view but not approve; `create-user` still
exists as a login-only escape hatch.)

## 4. Connect users

**Claude Code:** (name the connector `<name>-setoku` after this box, not the bare
`setoku` — otherwise a second box collides with an existing `setoku` connector.
The `/i/<token>` installer does this for you.)

```bash
claude mcp add --transport http <name>-setoku https://<your-host>/mcp \
  --header "Authorization: Bearer <their-token>"
```

**Cowork:** admin-provisioned remote connector (managed MCP), e.g.:

```json
{
  "managedMcpServers": {
    "setoku": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer <their-token>" }
    }
  }
}
```

Skills reach Cowork/Claude Code via the org plugin (`Hedgy-Labs/setoku`); without the plugin, tool descriptions carry enough workflow guidance for a degraded-but-sane experience.

## 5. Curator workflow (auto-draft + drift canary, with a human bless)

Keeping curated knowledge healthy is **three jobs around one human click**. The design principle: *automate the drafting, keep the bless a password-gated human click* — committing untrusted-derived knowledge must stay a person on `/admin` (I2/I9), but everything up to that click is automated.

| Job | Token / actor | What it does | Where it runs |
| --- | --- | --- | --- |
| **Drift canary** | none (model-free) | runs each metric's canonical SQL against the live DB, files anything broken/out-of-bounds as a pending correction | **on the box** (`docker compose exec`) |
| **Auto-draft + triage** | **janitor** token (draft + reject only) | drafts each pending correction into a finished doc-edit, lints it, flags dupes/contradictions, auto-rejects *objective* junk — commits nothing | **wherever Claude is authed** (not the VPS) |
| **`generate`** | **curator** token (commit; lake-blocked) | re-derives context from the company's own code/schema on a new `main` commit | the curation runner (needs a repo checkout) |
| **The bless** | a human (username+password) | Approve/Edit/Reject the finished cards | `/admin` |

### One-time setup

1. **Mint the tokens** on the box (printed once; append to `.env`, restart):

   ```bash
   docker compose exec server bun gateway/admin-cli.ts create-curator-token curator@co.com
   docker compose exec server bun gateway/admin-cli.ts create-janitor-token janitor@co.com
   # → append to SETOKU_CURATOR_TOKENS / SETOKU_JANITOR_TOKENS in /opt/setoku/.env, then:
   docker compose up -d server
   ```

   The **curator** token can commit (`upsert_context`/`resolve_correction`) but can't read the lake. The **janitor** token can *only* draft + reject — both grant zero authority — so it can read untrusted pending content without ever committing. They never coexist on one session.

2. **Env file for the curation runner** (the machine that has Claude Code authenticated — a workstation, CI, or a small always-on box; **not** the VPS, which runs only containers). Keep it uncommitted, e.g. `/etc/setoku/curate.env`:

   ```sh
   SETOKU_MCP_URL=https://setoku.yourco.com/mcp
   SETOKU_CURATOR_TOKEN=<the curator token>
   SETOKU_JANITOR_TOKEN=<the janitor token>
   SETOKU_REPO_DIR=/path/to/business-repo-checkout   # generate reads the code here
   # SETOKU_GENERATE_PULL=1                           # pull --ff-only before checking for new commits
   ```

   The runner also needs Claude authenticated — a persisted claude.ai subscription login, or `ANTHROPIC_API_KEY` in the env.

### Schedule it (cron)

```cron
# on the box — deterministic drift canary, daily
23 5 * * *  cd /opt/setoku && deploy/monitor/knowledge-canary.sh >> /var/log/setoku/canary.log 2>&1

# on the curation runner — generate (gated) + auto-draft/triage, hourly
0 * * * *  cd /path/to/business-repo && set -a && . /etc/setoku/curate.env && set +a \
           && /opt/setoku/deploy/monitor/curate-cron.sh >> /var/log/setoku/curate.log 2>&1
```

`curate-cron.sh` runs two **isolated** Claude sessions — one per token, each pinned with `--mcp-config <its token> --strict-mcp-config`, so neither session ever holds the other's token. **`generate` self-gates:** it runs only when `SETOKU_REPO_DIR` is on `main` *and* `HEAD` has advanced since the last successful run (marker in `.git/setoku-generate.sha`, advanced only on success) — so it's a no-op between code changes and never rewrites curated knowledge from an unreviewed branch. The triage pass runs every time.

The net loop: canary + generate + triage turn every pending item into a linted, flagged, ready-to-commit card → a human opens `/admin` and clicks down a short list.

`deploy.sh` also runs the lint once after each deploy as a **warn-only** step (it never blocks a ship). See [`deploy/backup/cron.example`](./backup/cron.example) for the full crontab.

## 6. Rolling out per-user source access (existing boxes)

Per-user data access (the Team page "Data access…" dialog) rides on ClickHouse
roles defined in [`clickhouse/lake-users.xml`](./clickhouse/lake-users.xml) —
one `setoku_src_<family>` role per source family, activated per request via the
HTTP `role` parameter (ClickHouse ≥ 24.5; the compose pins 25.3). Deploy order
on an existing box (rsync via `scripts/deploy.sh` already carries the XML):

1. After the rsync, confirm ClickHouse picked up the users.d change (it
   hot-reloads; if the roles don't appear, `docker compose restart clickhouse`
   — Vector buffers to disk, so nothing drops, I4):

   ```bash
   docker compose exec clickhouse clickhouse-client -q "SHOW ROLES" | grep setoku_src_
   ```

2. Verify the three engine facts as `setoku_ro` (curl the lake port from the
   box; `$RO` = `http://setoku_ro:<CLICKHOUSE_RO_PASSWORD>@127.0.0.1:8123`):

   ```bash
   # (a) no role param → default roles → full access (new connectors opt in)
   curl -s "$RO/?readonly=2" -d 'SELECT count() FROM setoku.slack_messages'
   # (b) an explicit role list denies everything outside it…
   curl -s "$RO/?readonly=2&role=setoku_src_github" -d 'SELECT count() FROM setoku.slack_messages'   # ACCESS_DENIED
   # …while direct core grants survive it
   curl -s "$RO/?readonly=2&role=setoku_src_github" -d 'SELECT count() FROM setoku.ingest_heartbeats' # works
   # (c) the deny-everything role grants nothing but the core
   curl -s "$RO/?readonly=2&role=setoku_src_none" -d 'SELECT count() FROM setoku.slack_messages'      # ACCESS_DENIED
   ```

3. Then restart the gateway (`docker compose up -d --build server`). Until an
   admin actually unchecks a source, the gateway sends no `role` parameter, so
   a half-applied state degrades to today's behavior, never an outage.

Kill-switch: `SETOKU_SOURCE_ACCESS=0` in the server env disables the role
subsetting entirely (for a hand-rolled box on ClickHouse < 24.5).

## 7. Activity notifications (optional)

Set `SETOKU_NOTIFY_WEBHOOK` in `/opt/setoku/.env` to a Slack incoming-webhook URL and the box posts a line when an app is **published** or **updated** (with the author’s update note), and when a **new version is deployed** (fired once, on the first boot of a changed version). It uses the same `{"text": …}` shape as the alert webhook, so any Slack-compatible endpoint works. Unset means notifications are off. To read the URL from a different env var, set `notifications.slackWebhookEnv` in `.setoku/config.json`; the URL itself never lives in config (so it never reaches the model).

## Notes

- **Analyst tokens are propose-only (I2/I9).** They get the read tools +
  `report_correction` (proposals land pending); the curated-write tools
  (`upsert_context`, `resolve_correction`) are never exposed to them — a deployed
  agent reads untrusted lake/Slack data and is prompt-injectable, so it must not
  be able to commit knowledge. Curation/generation uses a separate **curator
  token** (`SETOKU_CURATOR_TOKENS`, minted with `admin-cli create-curator-token`)
  that can write but is blocked from reading the lake; team-proposed knowledge is
  accepted on the web approval surface. A third **janitor token**
  (`SETOKU_JANITOR_TOKENS`, minted with `admin-cli create-janitor-token`) holds
  *only* draft + reject — both granting zero authority — and powers the curation
  cron (§5); it can never commit or accept.
- Every call is audited with the token's identity (SQLite `audit` table on the volume).
- One gateway (this box); `.setoku/` in the repo remains the seed/interchange format.
- Rotate a user: `/admin/team` → **Reset agent connector** (immediate, no restart). Legacy env-pinned tokens instead need a `SETOKU_TOKENS` edit + restart. Token loss = read access to allowed tables — scope the DB role accordingly.
