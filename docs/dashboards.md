<!-- SPDX-License-Identifier: Apache-2.0 -->

# Live dashboards

> Supersedes the v0.10 **Reports** surface (PR #20). A "report" is now the
> degenerate case of a dashboard: a frozen template with zero data panels.

## The problem

The agent is good at making visualizations — charts, tables, written-up
answers — and serializing them to self-contained HTML. But `publish_report`
froze the **data** into that HTML at publish time. The number on the page is a
photograph: correct the moment it shipped, stale forever after. People want a
link that stays current.

## The idea: split presentation from data

A dashboard is two things the box keeps separately:

- **Presentation** — frozen, agent-authored. The HTML/CSS/JS the agent designs.
  This is its creative strength and we keep it: a self-contained template,
  rendered in a sandboxed iframe.
- **Data** — live, box-executed. A set of named **panels**, each bound to a
  *saved query* (`sql` + `dialect`). The box re-runs each query through the
  existing governed `run_query` path and hands the results to the template.

A dashboard *view* = render the template with **freshly-executed query results
injected**. The template reads them off `window.__SETOKU__`:

```js
// inside the agent-authored template
const { rows, columns } = window.__SETOKU__.panels["revenue_by_month"];
```

Because the data is *injected* by the box rather than fetched by the template,
the template needs **no network at all** — which lets us lock the iframe down
hard (see Security).

## Data model

One table, extended in place from `published` (idempotent `ensureColumn`
migration — pre-dashboard boxes keep working, their rows are `format='html'`
with no panels):

```
published(
  id, title,
  format,          -- 'html' (legacy frozen report) | 'dashboard'
  body,            -- the agent-authored template (fragment for dashboards)
  panels,          -- JSON: [{ key, title?, sql, dialect, metricId? }]  (NULL for legacy)
  refresh_seconds, -- TTL for cached panel data (default 300, min 30)
  visibility,      -- 'team' (default) | 'public'  — promotion is a human action
  created_by, created_at, archived_at
)

dashboard_cache(dashboard_id, panel_key, columns, rows, row_count, computed_at, error)
  PRIMARY KEY (dashboard_id, panel_key)
```

A panel:

```ts
interface DashboardPanel {
  key: string;        // stable id the template reads off window.__SETOKU__.panels[key]
  title?: string;     // human label for the provenance drawer
  sql: string;        // the executable binding — validated read-only SQL
  dialect: "postgres" | "clickhouse";
  metricId?: string;  // optional link to a curated metric doc (provenance only)
}
```

`sql` is always the executable binding. `metricId` is **provenance only** — it
links a panel to a curated metric so the "how is this calculated" drawer can show
the team's *verified* definition and gotchas. We do not re-parse SQL out of a
metric's markdown body at render time (fragile); the agent passes the metric's
SQL as `sql` and sets `metricId` to link the two. Single execution path.

## Rendering & refresh — one architecture, two doors

Both the public and the team surfaces use the same shape: a **trusted outer
shell (ours)** hosting a **sandboxed inner frame (the agent's template +
injected data)**, with data produced by the box's governed read path.

```
 ┌─ outer shell (our HTML, trusted, NOT sandboxed) ──────────────┐
 │  title · "updated 2m ago · refreshes every 5m" · ⓘ provenance │
 │  ┌─ <iframe sandbox="allow-scripts" src=".../frame"> ───────┐ │
 │  │  agent template + <script>window.__SETOKU__=…</script>   │ │
 │  │  (strict CSP: default-src 'none' — no network at all)    │ │
 │  └──────────────────────────────────────────────────────────┘ │
 │  shell JS reloads the frame + re-reads provenance every TTL    │
 └────────────────────────────────────────────────────────────────┘
```

Endpoints:

| Surface | Shell | Frame (strict CSP) | Provenance JSON |
| --- | --- | --- | --- |
| **Public** (`visibility=public`) | `GET /p/<id>` | `GET /p/<id>/frame` | `GET /p/<id>/data` — **no SQL** |
| **Team** (signed-in) | `/admin/p/<id>` (React) | `GET /admin/frame/<id>` | `GET /admin/api/dashboard_data?id=` — **with SQL** |

- The **frame** document re-runs the panels (TTL-cached) and serves the template
  with data injected, under a strict CSP. It is the only place the agent's HTML
  runs.
- The **shell** is ours: it frames the sandboxed document and renders the
  provenance chrome *outside* the sandbox, so the agent's template can neither
  spoof nor hide how a number was computed.
- Auto-refresh = the shell reloads the child frame on the dashboard's
  `refreshSeconds` and re-reads the provenance endpoint.

**Re-execution runs under the gateway's own read-only DB/lake role — never a
stored user token.** Same credentials the gateway already holds, same caps,
same allow/deny list, every run audited (`actor = dashboard:<id>`).

### Freshness / caching

`dashboard_cache` holds each panel's last result + `computed_at`. A view serves
the cached rows when they're within `refreshSeconds`, and re-runs the query when
they're stale (lazy refresh). This bounds DB load on a hammered public link and
gives an honest "updated N ago" stamp. `publish_dashboard` seeds the cache with
its dry-run results so the first view is instant. (A future cron can pre-warm
panels so views are always instant — see SPEC.)

## Inspection — "how is this calculated?"

Distinct from interactivity (viewer-supplied params, deferred to v2). Inspection
is read-only transparency: every panel exposes its provenance, rendered by the
**trusted shell**, not the sandboxed template:

- the **SQL** and the **source/dialect** it ran against (**team surface only**),
- the **"as of" timestamp** + row count from the last execution,
- if the panel set `metricId`, the curated metric's **verified definition** +
  gotchas, pulled live from the knowledge store.

Two audiences, two surfaces:

1. **Humans** → the provenance drawer in the shell chrome.
2. **The agent** → the read-only `get_dashboard({ id })` MCP tool returns the
   panel definitions (sql/dialect/metricId, last-run stamps) so Claude can audit
   or iterate a published board.

**Public dashboards never expose raw SQL** (it would leak schema/table names).
The public `/p/<id>/data` endpoint omits `sql` and the metric *body* (also
canonical SQL); it shows methodology — the panel title and the curated metric
name + summary. Raw SQL and the author identity live only on the authenticated
team surface. The same scrub applies to **error text**: a raw DB error can name
tables/columns/env-vars, so on every public surface (both `/data` *and* the
injected frame) a panel error is replaced with a generic "data temporarily
unavailable" — the detail is team-only.

**Payload + freshness bounds.** The served panel rows are byte-capped once in
`renderDashboard` (shared by the frame and the drawer, so they always agree —
heaviest panels' rows are dropped and marked errored past the cap).
`refreshSeconds` is clamped to `[30s, 1d]` so a "live" link can't silently serve
day-old data behind a fresh-looking UI, and a panel whose refresh keeps failing
stops masking the last-good rows past a staleness ceiling (it surfaces a hard
error rather than presenting numbers the query can no longer produce).

## Tool surface

Replaces `publish_report` / `list_published` / `unpublish_report`:

- **`publish_dashboard({ title, html, panels?, refreshSeconds? })`** — dry-runs
  every panel through the governed path **at publish time**; a broken query, an
  off-allow-list table, or (on a curator session) a lake read is rejected with
  the offending panel key + error, so the agent fixes it in-loop instead of
  shipping a dead panel. Seeds the cache with the dry-run results. Returns the
  team-only URL. `panels` omitted/empty ⇒ a static report (back-compat).
- **`list_dashboards()`** / **`unpublish_dashboard({ id })`** — unchanged
  semantics from the old list/unpublish.
- **`get_dashboard({ id })`** — read-only inspection of panel definitions +
  last-run stamps.

The agent already develops and eyeball-validates SQL in-session with
`run_query`; `publish_dashboard` promotes those exact validated queries to live
bindings. The `frontend-design` skill makes the template sharp.

## Why this stays inside the invariants

- **I1 (DBs never public).** The browser only ever receives JSON the gateway
  produced; SQL and credentials stay server-side. The frame's strict CSP
  (`default-src 'none'`) means even the agent's template can't reach the
  network.
- **I8 (no server-side inference).** Refresh re-runs saved SQL — zero LLM.
- **I2 / I9 (the membrane).** A dashboard is a *publish* artifact, not a
  curated-knowledge write: it never touches `upsert_context` /
  `resolve_correction`, so the write-membrane is untouched. Team dashboards
  expose nothing beyond what the viewer's own token already grants. The one
  escalation risk — an injection-driven **public** exfil — is closed by reusing
  the report rule verbatim: **the agent can only publish team-only; flipping to
  public is a human click in `/admin`** (the agent holds no web session).
- **Renders run under the gateway role, not a session.** Panel re-execution
  carries no `denyLakeRead` — the membrane is enforced at *authorship* (a curator
  session can't publish a lake-backed panel), not at render. So a public
  lake-backed dashboard does stream fresh lake rows to anyone with the link, but
  that is the publisher's explicit, human-promoted choice — rendering involves no
  agent, so it can't couple write-capability with untrusted text (which is what
  I2/I9 actually governs).
- **Security bonus.** Because data is injected, not fetched, the frame needs no
  network, so we serve it under `default-src 'none'; style-src 'unsafe-inline';
  script-src 'unsafe-inline'; img-src data:` + `sandbox allow-scripts`. That
  closes the exfil-via-author-JS hole that today's *static* reports actually
  have (their inline JS can POST inline data to any host). Live dashboards end up
  **safer** than the reports they replace.

## Out of scope (v1)

- **Viewer interactivity** (date-range / dropdown filters / drill-down). Powerful
  but needs typed, **bound** params ($1, whitelisted) — never string-interpolated
  — to stay injection-safe. Ship frozen-query dashboards first; add params in v2.
- **Scheduled pre-warm cron.** The TTL cache refreshes lazily on view; a
  `dashboard-refresh` cron (mirroring `curate-cron.sh`) is a later optimization.
