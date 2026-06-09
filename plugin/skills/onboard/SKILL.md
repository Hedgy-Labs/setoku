---
name: onboard
description: Set up Setoku in the current repository — create .setoku/config.json, verify database connectivity, and run the first question end-to-end. Use when the user says "set up setoku", "onboard", or when setoku tools report missing config.
---

# Setoku onboarding

Goal: from zero to a verified working loop in minutes, conversationally. Everything happens in this repo; nothing is sent anywhere except the user's own database.

## Steps

1. **Check state.** Does `.setoku/config.json` exist? If yes, skip to step 4. If `.setoku/context/` also exists, skip to step 5.
2. **Interview for config (keep it to 2–3 questions).**
   - Find the database connection yourself first: look for env files (`.env`, `.env.local`) and config referencing a Postgres URL; propose the most likely env var name and confirm with the user. Ask rather than guess if multiple candidates (dev vs prod!). **Default to a dev/local database — never prod without the user explicitly choosing it.**
   - Which tables are in scope? Default `["public.*"]`; offer to exclude system/noise schemas.
3. **Write `.setoku/config.json`** (never put the credential itself in the file — reference the env var):

```json
{
  "dataSource": {
    "kind": "postgres",
    "urlEnv": "DATABASE_URL",
    "envFile": ".env"
  },
  "allowTables": ["public.*"],
  "denyTables": [],
  "rowCap": 200,
  "statementTimeoutMs": 15000
}
```

4. **Verify connectivity.** Call `get_schema` (no args). Show the user a short summary of what's visible (table count, notable tables). If it fails, debug the config with the user (wrong env var, env file path, db not running).
5. **Generate context.** If `list_entities` reports an empty knowledge store, tell the user the answers will be far better with business context and offer to run `/setoku:generate` now (recommended). If they decline, continue — the gateway works schema-only.
6. **First question, end-to-end.** Ask the user for a real business question they care about (or propose one from the schema). Answer it using the **analyst** workflow (find_context → SQL → run_query → answer). This proves the loop.
7. **Curation interview (2 questions max).** Ask: (a) what role they're in / what questions they ask most, (b) one business term that's notoriously ambiguous in their company. Record the answers via `report_correction` (kind: `entity`/`metric`/`gotcha` as appropriate) so the artifact starts compounding from day one.
8. **Wrap up.** Remind the user to commit `.setoku/config.json` (no secrets — env var name only). The knowledge itself lives in the gateway's store (SQLite, service-owned); `/setoku:curate` reviews pending knowledge.
