# Deploying & operating a Setoku box

How to ship code changes, add a data source, and verify a Setoku deployment. Written
to be **deployment-agnostic** — substitute your own values for the placeholders:

- `BOX` — SSH target for your VPS, e.g. `ubuntu@1.2.3.4`
- `DOMAIN` — the box's public domain, e.g. `setoku.yourco.com` (or `<ip>.sslip.io`)
- `DIR` — where the stack lives on the box (bootstrap uses `/opt/setoku`)

Everything runs as one `docker compose` project on the box; only Caddy is public. The
gateway is the **`server`** service. Code lives under `DIR`; secrets live in `DIR/.env`
(never in git, never rsynced).

## 1. Ship a code change to the box

There are two deploy models depending on how the box was set up.

### A. Git clone (the default — `bootstrap.sh` does `git clone … /opt/setoku`)
```bash
ssh BOX 'cd DIR && git pull && docker compose up -d --build server'
```
If a non-gateway service changed too (poller/vector/caddy), rebuild it as well, e.g.
`docker compose up -d --build mercury-poller`. The `server` rebuild recreates the
gateway container in place — no data loss (knowledge + lake live on named volumes).

### B. Rsync (box isn't a git checkout)
From a clean local checkout of the branch you want live:
```bash
# dirs WITHOUT trailing slashes (a trailing slash flattens them into DIR/ — a real footgun)
rsync -az --exclude='.env' --exclude='.git' --exclude='node_modules' \
  plugin deploy docker-compose.yml Caddyfile BOX:DIR/
ssh BOX 'cd DIR && docker compose up -d --build server'
```
`--exclude='.env'` is mandatory — it holds the box's secrets and DB URL.

> Prefer model A. If your box is rsync-based, consider converting it to a git clone
> once (clone fresh, copy the existing `.env` + leave the `setoku_data` volume) so
> future deploys are a one-line `git pull && up -d --build`.

## 2. Verify the deploy
```bash
curl -s https://DOMAIN/health      # {"ok":true,"version":"X.Y.Z","docs":N}
```
Confirm `version` matches the code you shipped (if it didn't change, the build cached
old code — rebuild with `--no-cache` or check you synced the right files). Then, as an
agent on an analyst connector, `list_sources` and `get_schema` should answer.

## 3. Add a data-source connector
The pattern is the same for every source: **provider credential → box `.env` → enable
its compose profile → restart**. (Per-source specifics — env var names, profiles — are
in the `/setoku:connect` skill's Recipes; this is the deploy mechanics.)
```bash
# 1) put the credential + config on the box
ssh BOX '$EDITOR DIR/.env'        # e.g. RENDER_API_KEY=…, SLACK_BOT_TOKEN=…, MERCURY_API_TOKEN=…
#    business DB: prefer deploy/connect-postgres.sh (creates a read-only role + URL)

# 2) enable the source's compose profile (profiles are off unless listed)
#    add it to COMPOSE_PROFILES=… in DIR/.env, then:
ssh BOX 'cd DIR && docker compose --profile NAME up -d SERVICE'   # e.g. --profile render up -d render-poller

# 3) restart the gateway so it picks up new env / config
ssh BOX 'cd DIR && docker compose up -d server'
```
Verify: `list_sources` (the new source should appear), then query it.

## 4. Rollback
```bash
ssh BOX 'cd DIR && git checkout <previous-sha> && docker compose up -d --build server'
# (rsync model: re-sync the previous checkout, then rebuild)
```

## 5. Troubleshooting
- **`/health` version didn't change after deploy** → the image cached old code. Re-sync
  the right paths (watch the rsync trailing-slash footgun), or `docker compose build --no-cache server`.
- **`get_schema` returns 0 tables / "permission denied for schema public"** → the
  business-DB role lost its grants (common after an app DB migration), or
  `SETOKU_DATABASE_URL` points at the wrong DB (e.g. staging vs prod). Re-grant
  `USAGE`+`SELECT` on the right project, or repoint the URL. For Supabase, use the
  **direct/non-pooling** URL for role/grant DDL (the pooler can cache stale grants).
- **A connector "fails to connect"** → check `https://DOMAIN/health`, then
  `docker compose logs server` on the box. A stale local/old connector pointing at a
  dead URL (e.g. a torn-down host) 5xx's independently of the live box.

## Box-specific facts
The placeholders above (`BOX`, `DOMAIN`, `DIR`, deploy model) differ per deployment.
An agent should get them from the operator (or a non-secret `.setoku/deploy` note in the
repo) — SSH access is always operator-provided, never stored in the knowledge store.
