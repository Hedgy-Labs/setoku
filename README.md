# Setoku

**Give claude access to your data + context to answer questions.**

- **The problem.** What your data *means* lives in people's heads — which metric is the real one, why "paying customer" is trickier than it looks, the gotchas that make an obvious query wrong. Agents never had that, so they guess and get it confidently wrong.
- **What it does.** It remembers those definitions and gotchas and hands them to Claude right before it answers, so it computes things the way you actually do.
- **It's safe to point at your data.** The agent only runs read-only, audited queries, and can't change what Setoku knows — a human approves that, outside the agent's loop.
- **It's cheap.** No AI runs in Setoku itself; the thinking happens in the Claude you already pay for. A whole deployment is one small VPS.

Today it's mostly about **data** (what your tables and metrics mean). The same idea could hold more — personal context, house design conventions — see [docs/memory.md](./docs/memory.md).

_Setoku = **set** (math) × **oku** (奥, innermost): the innermost layer underneath your AI.

---

## Try it live

There's a public demo wired to a synthetic dataset for a fictional pro baseball club — the **Riverside Stags** — covering ticketing, fans/CRM, sponsorship, merchandise, concessions, staffing, payroll, and marketing.

1. In **Claude.ai → Settings → Connectors → Add custom connector**, paste this as the server URL (there's no header field — the token rides in the URL):
   ```
   https://stags.setoku.com/mcp/1097598a5d333b1e012d517e0380898f39ffea51e0830be9
   ```
2. Ask in plain language — e.g. *"What was our ticket revenue this season, and which games sold best?"* Setoku feeds Claude the curated definitions first (comps are free, `scanned` = attended, money is in cents), so it computes the number the way the business actually does instead of guessing from column names.

Full walkthrough, the `/admin` approval surface, and the data model: [`demo/README.md`](./demo/README.md).

---

## What it is

Setoku is a small self-hosted server that sits between your AI (Claude) and your data. It does two things:

1. **Holds curated knowledge about your data** — what your tables and metrics actually mean, the canonical SQL for each metric, and the gotchas that make naive queries wrong (e.g. "active user" excludes internal test accounts; refunds must be subtracted from revenue; a status column is current-state only, so you count events from the log table instead).
2. **Gives the agent a governed way to query** — read-only, with a row cap, a statement timeout, a table allow-list, and an append-only audit log of who ran what.

The agent looks up the context first, then runs the query — so it answers the way your business actually computes things instead of guessing from column names.

It ships **tools, not models**. No AI runs on the server; all the reasoning happens in your Claude. That means no AI API keys and no per-query AI cost — a whole deployment is one small VPS plus the Claude seats your team already has.

## Why we built it

Claude is good at SQL but doesn't know our business. It would write a clean query against the wrong definition — what "paying customer" means, which metric counts, the small gotchas that make an obvious query wrong — and give us a confident, wrong number. The knowledge to get it right was in our heads, not anywhere an agent could read.

We didn't want to pay for a second AI to fix that; we already pay for Claude. So Setoku doesn't run a model of its own — it just hands context and a safe way to query to the Claude we already have. A whole deployment is one small box.

We also didn't want an agent able to do damage with our data, so queries are read-only (the database enforces it) and the agent can't change what Setoku knows — a human signs off on that, outside the loop.

It's a small thing, but it's been useful for us. Maybe it's useful for you.

## How to deploy it

One command on a fresh Ubuntu VPS (~$12/mo):

```bash
git clone https://github.com/Hedgy-Labs/setoku /opt/setoku && cd /opt/setoku
SETOKU_ADMIN_USER=you ./deploy/bootstrap.sh
```

It installs Docker, generates secrets, gets a real HTTPS certificate (uses `<your-ip>.sslip.io` if you don't have a domain yet), and brings the whole stack up. It prints the command to connect Claude and the token for log drains. (`SETOKU_ADMIN_USER` is the `/admin` login it creates; set it so the script runs unattended — omit it and it asks once, interactively.)

Then point Claude at the box and run `/setoku:onboard` in a business repo — it wires up your database (the credential stays in your env; only the env-var *name* goes in config) and generates the first knowledge from your code.

The point isn't that Claude can query your Postgres — if you're an engineer, it already can. The point is that the *meaning* gets captured once and **shared with the whole team**: `add-teammate` mints a connector for anyone, and a non-technical teammate can then query and visualize their own data in plain language on claude.ai ("show me signups by week") — and get the *right* number, because your annotations ride along.

## High level architecture

Everything is one `docker compose` on one VPS. Only the web proxy faces the internet; the databases are never exposed.

```mermaid
flowchart LR
    A["You + Claude / Claude Code"]

    subgraph box["Your VPS — docker compose (only the proxy is public)"]
        GW["Gateway (MCP)<br/>context + read-only query tools"]
        K[("Knowledge store<br/>what your data means")]
        LAKE[("Lake — optional<br/>logs · events · SaaS/bank data")]
        ADMIN["Approval page<br/>human accepts knowledge changes"]
    end

    DATA[("Your data<br/>Postgres · SaaS APIs · logs")]

    A -- "MCP" --> GW
    GW --> K
    GW -- "read-only, live" --> DATA
    GW --> LAKE
    A -. "propose knowledge" .-> ADMIN
    ADMIN --> K
```

**Two pieces:**

1. **A provisioner** that hooks each data source up on demand — query a Postgres live (read-only), ingest logs and events, pull an API on a schedule, archive Slack. You maintain a handful of proven patterns, not one connector per vendor.
2. **A gateway** that gives agents two kinds of tools over MCP: *context* tools (look up what the data means) and *data* tools (`get_schema`, `run_query` — read-only, audited, routed to whichever store the data lives in).

**The membrane — what makes it injection-safe.** Agents can only *propose* knowledge; a human accepts it on the approval page, outside the agent loop. The deployed gateway holds no tool that commits curated knowledge. So an agent tricked by a malicious log line can propose nonsense, but nothing takes effect without a human click.

**What runs in the box:**

| Component | Role |
|---|---|
| **Caddy** | HTTPS edge — the only public-facing container |
| **Gateway** | the MCP server (context + query tools) and the `/admin` approval surface |
| **Postgres** | the knowledge store and admin accounts |
| **ClickHouse + Vector** *(optional)* | a lake for logs/events/telemetry — only when there's more than Postgres should hold |

Your operational data stays where it is — Setoku queries Postgres **live and read-only**; it doesn't copy your database. Read-only is enforced by the database engine (a SELECT-only role), not by parsing SQL in our code.

---

Apache-2.0 ([LICENSE](./LICENSE)). Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md) (DCO sign-off). Security & token posture: [SECURITY.md](./SECURITY.md). Design & roadmap: [SPEC.md](./SPEC.md). The safety invariants the code preserves (I1–I9): [docs/invariants.md](./docs/invariants.md). The structured fact model + compaction/auto-judgement design (#10): [docs/knowledge-facts.md](./docs/knowledge-facts.md).
