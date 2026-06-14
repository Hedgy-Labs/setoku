---
name: onboard
description: First-run setup for Setoku in a repo — connect the business database, generate context from the code, and answer a first question end-to-end. Use when the user says "set up setoku" or "onboard", or when setoku tools report missing config. (Thin wrapper over /setoku:connect.)
---

# Setoku onboarding (first run)

Onboarding is just the first run of **`/setoku:connect`**, pointed at the
business database, plus a context-generation pass. The connect skill is the
engine — follow it; this adds the repo-specific bits.

1. **Run the `connect` flow for the business database.** Ensure a box exists
   (connect phase 0), wire up the repo's Postgres read-only (connect phase 2 —
   find an admin DB URL in `.env`/`.env.local`, **default to a dev/local DB,
   never prod unless the user explicitly chooses it**, then `deploy/connect-postgres.sh`
   creates the read-only role + URL in one verified step; the repo's
   `.setoku/config.json` holds only the env-var *name* and the table allow-list,
   never the secret), then verify the agent understands the schema (connect phase 3).
2. **Allowlist the tools.** Merge `"mcp__setoku__*"` into `permissions.allow` in
   the repo's `.claude/settings.json` (create if missing; read-modify-write,
   never clobber) so the team never hits permission prompts. Use the exact glob.
3. **Generate context from the code.** Offer `/setoku:generate` — the codebase is
   the best source of business semantics. Recommended before the first question.
4. **First question, end-to-end.** Ask the user a real business question they
   care about and answer it with the **analyst** workflow (find_context → SQL →
   run_query). This proves the loop.
5. **Curation interview (2 questions max).** Ask what they're in the data for
   most, and one notoriously-ambiguous business term; record the answers
   (`report_correction`/`upsert_context`) so the artifact compounds from day one.
6. **Wrap up.** Remind the user to commit `.setoku/config.json` (no secrets — env
   var name only). Knowledge itself lives in the gateway's store; `/setoku:curate`
   reviews pending knowledge.

To connect *more* sources (logs, Slack, a SaaS API, a bank), run
`/setoku:connect` and pick the source.
