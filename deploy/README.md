# Deploying the Setoku gateway (HTTP profile, single container)

> **The reference deployment is now the single-box compose stack** — see the
> repo-root `docker-compose.yml`, [oracle-free.md](./oracle-free.md) (prototype)
> and [hetzner.md](./hetzner.md) (recommended). This doc remains for the
> gateway-only profile (no lake/ingest) used by the original pilot.

One small container per company. Knowledge store on a persistent volume; database reached with a read-only role; users connect from Claude Code or Cowork with a bearer token.

## 1. Database role (you run this — Setoku never executes DDL)

Edit and run [`readonly-role.sql`](./readonly-role.sql) against the target database (staging recommended). Result: a `postgresql://setoku_ro:...` URL.

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
  -e SETOKU_DATABASE_URL='postgresql://setoku_ro:...@host:5432/db' \
  -e SETOKU_TOKENS='<tok-a>=alice@co.com,<tok-b>=bob@co.com' \
  setoku-gateway
curl localhost:8787/health
```

On Fly.io: `fly launch --no-deploy` (port 8787, add a volume mounted at `/data`), `fly secrets set SETOKU_DATABASE_URL=... SETOKU_TOKENS=...`, `fly deploy`.

## 3b. Create an admin account (for the approval surface)

The web approval surface (`/admin`) authenticates with **local accounts**, not
the MCP tokens — a human signs in with a username + password an agent never
holds, so it can't self-approve (I9). Bootstrap the first admin on the box:

```bash
docker compose exec server bun gateway/admin-cli.ts create-user <name> --role admin
# prompts for a password (or pass SETOKU_NEW_PASSWORD=… for unattended setup)
```

Then visit `https://<your-host>/admin` and sign in. (`--role member` makes a
view-only account that can read the queue but not approve.)

## 4. Connect users

**Claude Code:**

```bash
claude mcp add --transport http setoku https://<your-host>/mcp \
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

## Notes

- **The deployed gateway is propose-only (I2/I9).** Tokens get the read tools +
  `report_correction` (proposals land pending); the curated-write tools
  (`upsert_context`, `resolve_correction`) are never exposed here — a deployed
  agent reads untrusted lake/Slack data and is prompt-injectable, so it must not
  be able to commit knowledge. Curation/generation runs in a separate local
  `SETOKU_CURATOR_MODE=1` session (and, once it exists, the Phase 5 web approval
  surface).
- Every call is audited with the token's identity (SQLite `audit` table on the volume).
- Same tool surface as the local stdio profile; `.setoku/` in the repo remains the seed/interchange format.
- Rotate a user: change `SETOKU_TOKENS`, restart (fast). Token loss = read access to allowed tables — scope the DB role accordingly.
