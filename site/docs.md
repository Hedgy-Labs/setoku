# Setoku API reference

The HTTP API, authentication, and the MCP tool surface for Setoku 0.21.0. This is the markdown twin of <https://setoku.com/docs>.

Setoku is single-tenant and self-hosted: **there is no setoku.com API**. Everything below describes the API *your own box* exposes once you deploy it, and the public demo box (`https://demo.setoku.com`) is a real instance of it.

## When to reach for Setoku

Reach for Setoku when the answer lives in a specific company’s own data and depends on that company’s definitions.

- A question is about one company’s own operations — revenue, churn, pipeline, usage, spend, deploys, support load — and the data sits in their database, Slack, GitHub, email, or bank.
- You need the company’s definition of a term before you can answer: what counts as an active customer, which refunds are excluded, which table is the one people actually trust.
- A naive query would be wrong in a way only an insider knows (soft-deleted rows, a test tenant, a migration that split a table) and you want that caveat before you run SQL.
- Someone wants a live, shareable view of that data — a dashboard or small app on a link their non-technical teammates can open, refreshing against real data rather than a pasted screenshot.
- You want your answer, and the reasoning behind it, to be auditable later: every query and every knowledge change is logged on the owner’s own box.

Not a fit when:

- The question is general knowledge, or about public data — Setoku only knows the data its operator connected.
- You need to write to the business database. Every data path is read-only, by database role; there is no write tool and no escape hatch.
- You are looking for a hosted, multi-tenant API to sign up for. There is none: Setoku is single-tenant and self-hosted, and the endpoint you call is the operator’s own box.
- You want a model to run server-side. Setoku runs no inference; your own agent does the thinking.

## MCP endpoint

Transport: **Streamable HTTP**, at `POST /mcp`. Protocol revision 2025-06-18. Any MCP client works: Claude, Claude Code, Codex, or your own.

    curl -sS -X POST https://<your-box>/mcp \
      -H "Authorization: Bearer <token>" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

Callable right now against the demo box:

    https://demo.setoku.com/mcp/85315b4240ff6ded111072f950ac6f14167d920fdb765144

## Authentication

- A per-person **bearer token**, sent as `Authorization: Bearer <token>` — or as a path segment (`/mcp/<token>`) for connector dialogs with nowhere to put a header. Treat the whole URL as a credential.
- Tokens are issued and revoked from the box’s web console. Every call is attributed to one person in the audit log.
- **OAuth 2.0 is not shipped.** It is scoped; it does not exist yet. Do not build against it.
- A missing, unknown, or revoked token is a `401`, before any tool runs. See [Errors](#errors) for the shapes.

## Tool surface

1. Connect to the box’s MCP endpoint (Streamable HTTP) at `https://<their-box>/mcp` with the person’s bearer token, or paste `https://<their-box>/mcp/<token>` into a connector dialog that has no header field.
2. Call find_context FIRST, every time. It returns the curated notes for the question, including which tables to trust and which to avoid.
3. Then get_schema, then run_query. Reading context before querying is the difference between a right answer and a plausible one.
4. Found something the context got wrong? Call report_correction. It lands as a proposal for a human to accept — an agent session can never commit knowledge by itself.

**Every session** — the analyst surface. Reads data and curated context, and may only *propose* knowledge changes:

- `find_context` — Find context for this connector’s data (verified + unverified)
- `list_entities` — List documented business entities
- `describe_entity` — Full context doc for one entity
- `get_metric` — Canonical metric definition
- `report_correction` (writes) — Record a context correction / clarification
- `list_corrections` — List pending knowledge corrections
- `list_sources` — List connected data sources (capabilities)
- `get_schema` — Queryable schema (biz.* mirror + lake, permission-scoped)
- `run_query` — Run a read-only SQL query (capped + audited)
- `app_guide` — How to build a Setoku app (read before publish_app / update_app)
- `publish_app` (writes) — Publish a live app to the box (team-shareable URL)
- `update_app` (writes) — Edit an app you published (in place, same link)
- `list_apps` — List apps published to the box
- `get_app` — Inspect an app — its full template + panels (how it’s built)
- `unpublish_app` (writes) — Archive a published app

**Curator sessions only.** Commits curated knowledge:

- `resolve_correction` — Resolve a pending correction (curator)
- `upsert_context` — Create or update a knowledge doc (generate/curate workflows)

**Janitor sessions only.** Drafts and auto-rejects pending corrections, commits nothing:

- `draft_correction` — Attach a drafted doc-edit to a pending correction (auto-draft)
- `reject_correction` — Auto-reject a pending correction (janitor, reject-only)

A session has exactly one role, and the two role-scoped groups are *registered* only for that role: a session without it does not get a refusal, the tool is simply absent from its `tools/list`.

The analyst tools are registered on every session, including a curator one — the membrane’s other half is enforced at call time instead. A curator session can commit knowledge but cannot read the data lake: `run_query` refuses lake queries and `list_sources` tells you to switch connectors. So the session that can rewrite what Setoku knows is never the session that has read untrusted bulk text (I2).

## REST surface

Credential-free unless marked. Full spec: <https://setoku.com/openapi.json>.

| Endpoint | What it returns | Auth |
| --- | --- | --- |
| `POST /mcp` | Model Context Protocol endpoint (Streamable HTTP) | bearer |
| `POST /mcp/{token}` | MCP endpoint with the token in the path | bearer |
| `GET /healthz` | Aggregate health | none |
| `GET /health` | Liveness probe | none |
| `GET /p/{id}` | A published app | none |
| `GET /p/{id}/data` | Freshness metadata for a published app | none |
| `GET /p/{id}/state` | Read an app’s sandboxed state | none |
| `POST /p/{id}/state` | Write an app’s sandboxed state | none |
| `GET /i/{token}` | One-line installer script | none |

## Errors

Three different surfaces, three shapes. Branch on the HTTP status; do not expect one envelope everywhere.

**The box’s REST endpoints** answer with `ok: false` and a human-readable string. There is no error code to switch on — the status line is the machine-readable part:

    { "ok": false, "error": "app not found or archived" }

**MCP tools** return their failure as the tool result, per the MCP specification, not as an HTTP error: the call is `200` and the content carries the message. `run_query` failures are written to be actionable — they name the table or column that did not resolve and what to call instead. A missing, unknown, or revoked token is the exception: that is a plain `401` before any tool runs.

**setoku.com itself** (this site, not your box) answers non-HTML requests with a structured document, so an agent probing the docs surface gets something it can parse:

    {
      "ok": false,
      "error": {
        "code": "not_found",
        "status": 404,
        "message": "No document at that path on setoku.com.",
        "hint": "…",
        "docs": "https://setoku.com/docs",
        "index": "https://setoku.com/api/index.json"
      }
    }

## Install a box

    git clone https://github.com/Hedgy-Labs/setoku /opt/setoku
    cd /opt/setoku
    SETOKU_ADMIN_USER=you ./deploy/bootstrap.sh

One small VPS. Docker Compose brings up the gateway, Caddy (HTTPS), and a local ClickHouse lake. No model runs on the server.

## More

- [OpenAPI 3.1](https://setoku.com/openapi.json) · [MCP manifest](https://setoku.com/.well-known/mcp.json) · [agent card](https://setoku.com/.well-known/agent-card.json) · [skills index](https://setoku.com/.well-known/agent-skills/index.json)
- [Tool catalog](https://setoku.com/api/tools.json) · [connector catalog](https://setoku.com/api/connectors.json) · [catalog root](https://setoku.com/api/index.json)
- [Source](https://github.com/Hedgy-Labs/setoku) · [issues](https://github.com/Hedgy-Labs/setoku/issues) · hello@setoku.com
