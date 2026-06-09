# Setoku

**Governed agentic BI on your own Claude subscription.**

Setoku turns your codebase into a verified business-context layer and gives Claude governed, read-only access to your database — so it answers business questions the way your business actually computes them, instead of guessing from column names. All reasoning runs inside your interactive Claude Code / Cowork session (no API keys, no separate LLM billing); Setoku itself never makes an LLM call.

_Setoku = **set** (math) × **oku** (奥, innermost): the innermost set — the intelligence layer underneath your AI._ See [SPEC.md](./SPEC.md) for the full design and [NAMES.md](./NAMES.md) for the naming saga.

## How it works

```
You ⇄ Claude Code  ──skills──▶  setoku MCP gateway  ──▶  .setoku/context/   (verified business context, derived from your code)
        (your seat)                 (this plugin)    ──▶  your Postgres      (read-only, row-capped, audited)
```

- **Context tools** — `find_context`, `list_entities`, `describe_entity`, `get_metric`, `report_correction`: retrieval over a versioned, human-verified context artifact (entity semantics, canonical metric SQL, gotchas) that lives in your repo at `.setoku/`.
- **Data tools** — `get_schema`, `run_query`: live Postgres access through a choke point — READ ONLY transactions, statement timeout, row cap, table allow-list, and a JSONL audit log of every call with user attribution.
- **Skills** — `/setoku:onboard` (setup interview), `/setoku:generate` (derive the context artifact from your code, grounded in `file:line`), `/setoku:analyst` (the BI workflow: retrieve context → canonical SQL → answer), `/setoku:eval` (golden-question scorecard).

## Install

Requires [Bun](https://bun.sh) and Claude Code.

```bash
claude plugin marketplace add Hedgy-Labs/setoku
claude plugin install setoku@setoku
```

Then, in any business repo:

```
/setoku:onboard
```

The onboarding skill writes `.setoku/config.json` (your DB credential stays in your env / .env file — only the _env var name_ goes in config), verifies connectivity, offers to generate the context artifact from your code, and runs your first question end-to-end.

Commit `.setoku/` — config, context, and corrections are shared with your team via git (audit logs are auto-gitignored).

## Repo layout

```
.claude-plugin/marketplace.json   # this repo is a plugin marketplace
plugin/                           # the installable plugin
  .claude-plugin/plugin.json
  .mcp.json                       # launches the gateway (bun, stdio)
  hooks/hooks.json                # SessionStart: bun install for gateway deps
  gateway/                        # MCP server (TypeScript, run by bun)
  skills/{onboard,generate,analyst,eval}/
test/                             # e2e: real Postgres ⇄ real MCP client ⇄ real server
```

## Development

```bash
bun install
bun run typecheck
bun test          # needs a local Postgres; uses unix socket at /tmp by default
                  # override: SETOKU_E2E_PG_HOST, SETOKU_E2E_DB_URL, SETOKU_E2E_PG_MAINTENANCE_DB
```

The e2e suite creates a `setoku_e2e` database with a synthetic shop schema (deliberate gotchas: soft deletes, refunds, integer cents), spawns the exact server the plugin ships over stdio, and drives it with a real MCP client: tool surface, allow-list scoping, read-only enforcement (including CTE-smuggled writes), row caps, timeouts, retrieval quality (metric + gotcha surfacing), corrections, and audit attribution.

## Status

v0 prototype. Per [SPEC.md](./SPEC.md): stdio transport for now (HTTP + per-user bearer tokens is the v1 hardening step — tool contracts won't change); table-level allow-list (RLS/masking later); Postgres only (BigQuery / DuckDB lake next).
