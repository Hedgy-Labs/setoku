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
4. **Prove the difference (not just the query).** The user is an engineer who
   likely already has Claude on their Postgres — a plain SELECT won't impress.
   Answer a real question where the captured knowledge **changes the answer**
   (find_context → SQL → run_query) and show the contrast: "without the gotcha
   you'd get X; the right answer is Y." That's the moment it lands.
5. **Curation interview (2 questions max).** Ask what they're in the data for
   most, and one notoriously-ambiguous business term; record the answers
   (`report_correction`/`upsert_context`) so the artifact compounds from day one.
6. **Share with the team (the real payoff).** The knowledge is now everyone's.
   Offer to add a teammate or two — the human can click **Invite** on
   `https://<domain>/admin/team`, or from the CLI: `docker compose exec server bun gateway/admin-cli.ts add-teammate <email>`. Both show a dev one-liner + claude.ai steps.
   Call out the non-technical win — a founder/PM querying *and visualizing* their
   own data in plain language, getting the right number because the annotations
   ride along — it's often the biggest magic moment.
7. **Show them the approval page, then wrap up.** Point the user to their curation
   surface — `https://<domain>/admin` — and have them sign in once with the login
   `bootstrap` printed (reset with `admin-cli set-password <user>` if lost). That
   page is where every proposal you filed this session waits to be accepted, and
   the *only* place knowledge is committed — by a human, outside the agent's loop.
   Then remind them to commit `.setoku/config.json` (no secrets — env-var name
   only). Close on the reassuring note: connected, read-only confirmed, and
   nothing can change what Setoku knows without their approval.

To connect *more* sources (logs, Slack, a SaaS API, a bank), run
`/setoku:connect` and pick the source.
