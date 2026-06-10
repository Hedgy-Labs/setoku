# Deploying the Setoku gateway (HTTP profile)

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

- Every call is audited with the token's identity (SQLite `audit` table on the volume).
- Same tool surface as the local stdio profile; `.setoku/` in the repo remains the seed/interchange format.
- Rotate a user: change `SETOKU_TOKENS`, restart (fast). Token loss = read access to allowed tables — scope the DB role accordingly.
