<!-- SPDX-License-Identifier: Apache-2.0 -->

# Live apps

> Supersedes the v0.10 **Reports** surface (PR #20). A "report" is now the
> degenerate case of an app: a frozen template with zero data panels. "Dashboard"
> survives only as an informal name for the read-only kind — a dashboard-style app.

## The problem

The agent is good at making visualizations — charts, tables, written-up
answers — and serializing them to self-contained HTML. But `publish_report`
froze the **data** into that HTML at publish time. The number on the page is a
photograph: correct the moment it shipped, stale forever after. People want a
link that stays current — and, increasingly, a little **app** they can interact
with, not just a static picture.

## The idea: split presentation from data

An app is two things the box keeps separately:

- **Presentation** — frozen, agent-authored. The HTML/CSS/JS the agent designs.
  This is its creative strength and we keep it: a self-contained template,
  rendered in a sandboxed iframe.
- **Data** — live, box-executed. A set of named **panels**, each bound to a
  *saved query* (`sql` + `dialect`). The box re-runs each query through the
  existing governed `run_query` path and hands the results to the template.

An app *view* = render the template with **freshly-executed query results
injected**. The template reads them off `window.__SETOKU__`:

```js
// inside the agent-authored template
const { rows, columns } = window.__SETOKU__.panels["revenue_by_month"];
```

Because the data is *injected* by the box rather than fetched by the template,
the template needs **no network at all** — which lets us lock the iframe down
hard (see Security). Its only channel back to the box is a narrow, mediated
`postMessage` bridge for its own private state (see **Per-app state**).

## Data model

One table, extended in place from `published` (idempotent `ensureColumn`
migrations). Two upgrade cases are handled automatically: v0.10 boxes keep their
legacy rows (`format='html'`, no panels), and the v0.20 Dashboards→Apps rename
backfills the stored format value with a one-time
`UPDATE published SET format='app' WHERE format='dashboard'` on startup, so
dashboards published *before* the rename keep rendering as apps instead of
silently falling back to the legacy path:

```
published(
  id, title,
  format,          -- 'app' (renders via the runtime path) | 'html' (legacy frozen report)
  body,            -- the agent-authored template (fragment for apps)
  panels,          -- JSON: [{ key, title?, sql, dialect, metricId? }]  (NULL/[] for a state-only app)
  params,          -- JSON: [{ name, type, default, … }]  declared interactive inputs (NULL for none)
  refresh_seconds, -- TTL for cached panel data (default 300, min 30)
  visibility,      -- 'team' (default) | 'public'  — promotion is a human action
  created_by, created_at, archived_at
)

app_cache(app_id, panel_key, columns, rows, row_count, computed_at, error)
  PRIMARY KEY (app_id, panel_key)   -- panel_key folds in the param variant; capped per app
```

An app is `format='app'` whether or not it has data panels: a chart app has
panels, a **state-only app** (a todo list, a poll) has none but still renders
through the runtime path (chart helpers + `Setoku.state` + the no-network frame).
Only a *zero-panel full HTML document* is a legacy `'html'` report, served as-is.
`publish_app` makes that call automatically (a fragment ⇒ `app`).

A panel:

```ts
interface AppPanel {
  key: string;        // stable id the template reads off window.__SETOKU__.panels[key]
  title?: string;     // human label for the provenance drawer
  sql: string;        // the executable binding — validated read-only SQL
  dialect?: "clickhouse";  // the default and the only runnable dialect ("postgres" is retired)
  metricId?: string;  // optional link to a curated metric doc (provenance only)
}
```

`dialect` is `clickhouse` (the default): every panel runs on the box's ClickHouse
engine — the lake **and the `biz.*` business-DB mirror** (see ingest/pg-mirror).
The direct postgres path is retired: publish/update REJECT a postgres-dialect
panel, and a legacy stored postgres panel surfaces a "retired" error at render
until it's re-authored against `biz.*`. The app chrome shows the mirror's
"data as of" beside the cache stamp.

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
 │  ┌─ <iframe sandbox="allow-scripts allow-forms" src=".../frame"> ┐ │
 │  │  agent template + <script>window.__SETOKU__=…</script>        │ │
 │  │  (strict CSP: default-src 'none' — no network at all)         │ │
 │  └───────────────────────────────────────────────────────────────┘ │
 │  shell mediates state ops + reloads the frame every TTL          │
 └────────────────────────────────────────────────────────────────────┘
```

Endpoints:

| Surface | Shell | Frame (strict CSP) | Provenance JSON | State |
| --- | --- | --- | --- | --- |
| **Public** (`visibility=public`) | `GET /p/<id>` | `GET /p/<id>/frame` | `GET /p/<id>/data` — **no SQL** | `GET·POST /p/<id>/state` |
| **Team** (signed-in) | `/apps/<id>` (React) | `GET /admin/frame/<id>` | `GET /admin/api/app_data?id=` — **with SQL** | `GET·POST /admin/api/app_state` |

- The **frame** document re-runs the panels (TTL-cached) and serves the template
  with data injected, under a strict CSP. It is the only place the agent's HTML
  runs.
- The **shell** is ours: it frames the sandboxed document, renders the
  provenance chrome *outside* the sandbox (so the agent's template can neither
  spoof nor hide how a number was computed), renders the **param control bar**
  (see Viewer params), and **mediates the app's state bridge** (below).
- Auto-refresh = the shell reloads the child frame on the app's `refreshSeconds`
  and re-reads the provenance endpoint.

**Re-execution runs under the gateway's own read-only lake role — never a
stored user token.** Same credentials the gateway already holds, same caps,
same allow/deny list, every run audited (the app id rides in the payload).

The frame sandbox grants `allow-scripts allow-forms` — apps commonly use a
`<form>`, and without `allow-forms` the browser silently blocks the submit
event. Granting it is safe because the frame CSP pins `form-action 'none'`: the
app's JS handles the submit in-page, but no actual submission can leave the
sandbox.

### Freshness / caching

`app_cache` holds each panel's last result + `computed_at`. A view serves the
cached rows when they're within `refreshSeconds`, and re-runs the query when
they're stale (lazy refresh). This bounds DB load on a hammered public link and
gives an honest "updated N ago" stamp. `publish_app` seeds the cache with its
dry-run results so the first view is instant. (A future cron can pre-warm panels
so views are always instant — see SPEC.)

For a parameterized app each **param variant** caches separately (the variant
hash is folded into `panel_key`), so different viewer selections don't clobber
each other. To keep that from growing without bound on a public link — where an
open-domain param (`text`, an unbounded `int`) could otherwise mint a fresh cache
row per distinct value — the cache is **capped per app**: the newest ~256 rows
are kept and the oldest are evicted on write.

The cap bounds storage but not *execution* — distinct param values still miss the
cache, and each miss is a live lake query. So the **credential-free** `/p/<id>`
surface also bounds the *rate* of fresh runs with a per-app token bucket (`~30`
burst, refilling `~30/min`): each would-be cache-miss panel run spends one token,
and once empty a panel renders cache-only (last good rows, else "data temporarily
unavailable") rather than hitting the DB. Charged per execution, so cached hits
are free and a normal viewer never notices; an anonymous hammer streaming distinct
`?p.<name>=` values can't amplify load against the lake. Authenticated
Team app views are not rate-limited (the viewer is logged in and audited).

## Viewer params — interactive apps

An app can declare typed **inputs** the viewer changes — a date range, a region
dropdown, a "first N" limit — and the box re-runs the panels bound to the new
value. The whole point is to do this **without** opening an injection hole: a
viewer's input is untrusted text, so it reaches SQL only as an *engine-bound
parameter*, never spliced in.

An app declares its params alongside its panels (`publish_app` / `update_app`):

```ts
interface AppParam {
  name: string;                       // a panel binds it as :name
  label?: string;                     // shown on the control
  type: "date" | "int" | "text" | "bool" | "enum";
  default: string | number | boolean; // REQUIRED — the app must render with no input
  options?: { value, label? }[];      // enum: the closed set of accepted values
  min?, max?, maxLength?;             // int / text bounds
}
```

A panel's SQL references one by name:

```sql
select month, revenue from monthly_revenue where region = :region order by month
```

At render, `renderApp` resolves each param to the viewer's value (coerced to the
declared type) or the default, then **compiles + binds** it through `lib/params.ts`:
`:name` → `{name:Type}` for ClickHouse, with the value passed as a bound
parameter to `runLakeQuery`. Because the value is
bound, never concatenated, it is **injection-safe** and can't name a table or
column or drive a write — an `enum` value that isn't in `options`, or a `text`
value over `maxLength`, is rejected and the default is used. Publish is rejected
if a panel references a `:token` that isn't declared, or if a `default` doesn't
coerce — so a broken interactive app is caught in-loop, not at a viewer's
keystroke.

The **control bar** renders the declared params as stone widgets — on *both*
surfaces: the public shell (`/p/<id>`, server-rendered) and the React `AppView`
(`/apps/<id>`). Changing a control re-requests the frame with `?p.<name>=…`,
which re-runs the panels bound to the new value (the param variant caches
separately — see Freshness). Controls are chrome: they live in the trusted shell,
not the sandboxed template, so the agent never hand-rolls input widgets.

### App-driven param changes (`Setoku.setParam`)

The control bar is the viewer's door; `Setoku.setParam(name, value)` is the
*template's* door to the same room. An in-frame widget — a search box, an
autocomplete list, a "next page" button — calls it to change a declared param and
re-run the panels bound to it, which is the **only** way the no-network frame can
fetch new data on demand (it can't reach the box itself). This is what lets an app
load a slim list up front and then pull one row's detail *async* when the viewer
picks it, instead of shipping every row's detail in the first payload.

It rides the same `postMessage` bridge as `Setoku.state`, and it **spends no
trust**: the value takes the identical path as a control change — coerced to the
param's declared type and engine-bound in `renderApp` (never spliced into SQL) —
so it can't name a table/column or drive a write, exactly like `?p.<name>=`. The
shell honors it **only for a declared param** (an unknown name has no control and
is ignored, so a template can't mint arbitrary query keys). It's fire-and-forget
(the shell reloads the frame; there's no reply to await). On a box that predates
this it's a harmless no-op, so feature-detect (`typeof Setoku.setParam ===
"function"`) and keep a control-bar fallback.

## Per-app state — an app's own datastore

An app can **read** governed company data, but it can never **write** to a
business source — the read-only GRANT stays absolute (I1). What it gets instead
is a private sandbox of its own: a gateway-owned key-value store
(`lib/app-store.ts`, a separate `app_state` table) keyed by app, where the
template may freely persist state — todos, poll votes, annotations, "reviewed"
flags, draft scenarios. The template reaches it through `window.Setoku.state`:

```js
await Setoku.state.set("app", "tasks", [{ text: "ship it", done: false }]);
const tasks = await Setoku.state.get("app", "tasks");   // → value | null
const all   = await Setoku.state.list("viewer");        // → [{ key, value, updatedAt }]
await Setoku.state.del("viewer", "draft");
```

All four methods return Promises. Two **scopes**:

- **`"app"`** — shared across everyone who opens the app (a team todo list, a
  shared poll tally).
- **`"viewer"`** — private to one viewer. On the team surface that's the
  signed-in identity; on a public link it's an anonymous per-browser id the
  shell mints (unguessable, so practically isolated — but, lacking a login, it's
  best-effort per-browser privacy, not a hard security boundary).

Quotas bound the store: ≤ 100k chars per value, ≤ 256 chars per key, ≤ 1000 keys
and ≤ 5M chars per owner — a hammered app can't fill the disk, and an over-quota
write fails with a 413 (`AppStoreQuotaError`).

### How it stays safe (the bridge)

The frame has **no network** (strict CSP), so it can't reach the state endpoint
directly. It `postMessage`s state ops up to the **trusted shell**, which is the
single policy gate. The shell **injects the app id** (the template never names
it — so an app can only ever touch *its own* state), accepts messages only from
its own iframe, and calls the state endpoint:

- **Team** → session-gated `GET·POST /admin/api/app_state` (any signed-in user,
  members included; the React `AppView` mediator carries the session + CSRF).
- **Public** → credential-free `GET·POST /p/<id>/state`, reachable only for
  public-visibility apps (a team app's state is never writable without a
  session). The public shell passes the anonymous per-browser id as the owner
  for `viewer` scope.

Why this needs **no per-write human gate** (unlike curated-knowledge writes): app
state is neither the lake (untrusted bulk text) nor curated knowledge
(authority). Writing it commits nothing *trusted* and crosses no membrane
(I2/I9) — worst case an app corrupts its own state. The only human gate stays
where it already is: **publishing the app** (and promoting it to public).

### The overlay pattern

Combine a governed **read** with a private **write** to annotate production data
*without writing production*: key app state by a business row's id.

```
the read-only biz.* mirror:  order-4821, order-4822, …   (governed read)
app state (private):  "order-4821" → { reviewed: true, by: "alice" }
render:               join the two — a "reviewed" column that lives in the app
```

That's a triage queue, an annotation layer, a "mark as handled" flag — all the
things people *think* require business writes, delivered without one.

## Inspection — "how is this calculated?"

Inspection is read-only transparency: every panel exposes its provenance,
rendered by the **trusted shell**, not the sandboxed template:

- the **SQL** and the **source/dialect** it ran against (**team surface only**),
- the **"as of" timestamp** + row count from the last execution,
- if the panel set `metricId`, the curated metric's **verified definition** +
  gotchas, pulled live from the knowledge store.

Two audiences, two surfaces:

1. **Humans** → the provenance drawer in the shell chrome.
2. **The agent** → the read-only `get_app({ id })` MCP tool returns the panel
   definitions (sql/dialect/metricId, last-run stamps) so Claude can audit or
   iterate a published app.

**Public apps never expose raw SQL** (it would leak schema/table names). The
public `/p/<id>/data` endpoint omits `sql` and the metric *body* (also canonical
SQL); it shows methodology — the panel title and the curated metric name +
summary. Raw SQL and the author identity live only on the authenticated team
surface. The same scrub applies to **error text**: a raw DB error can name
tables/columns/env-vars, so on every public surface (both `/data` *and* the
injected frame) a panel error is replaced with a generic "data temporarily
unavailable" — the detail is team-only.

**Payload + freshness bounds.** The served panel rows are byte-capped once in
`renderApp` (shared by the frame and the drawer, so they always agree — heaviest
panels' rows are dropped and marked errored past the cap). `refreshSeconds` is
clamped to `[30s, 1d]` so a "live" link can't silently serve day-old data behind
a fresh-looking UI, and a panel whose refresh keeps failing stops masking the
last-good rows past a staleness ceiling (it surfaces a hard error rather than
presenting numbers the query can no longer produce).

## Tool surface

Replaces `publish_report` / `list_published` / `unpublish_report`:

- **`publish_app({ title, html, panels?, params?, refreshSeconds? })`** — dry-runs
  every panel through the governed path **at publish time** (with the params bound
  to their defaults); a broken query, a table the engine refuses, an undeclared
  `:token`, a default that won't coerce, or (on a curator session) a lake read is
  rejected with the offending panel key + error, so the agent fixes it in-loop
  instead of shipping a dead panel. Seeds the cache with the dry-run results.
  Returns the team-only URL. `panels` omitted/empty + a fragment body ⇒ a
  state-only app; only a zero-panel full HTML document is a static report.
- **`update_app({ id, title?, html?, panels?, params?, refreshSeconds? })`** — edit
  an app **you authored**, in place (same id/link). Only the author can edit;
  `panels` / `params` each replace the whole set (re-validated + dry-run). Changing
  `panels` on a *public* app reverts it to team-only — the data it exposes changed,
  so an admin must re-approve (the human public-promotion gate, I9).
- **`list_apps()`** / **`unpublish_app({ id })`** — unchanged semantics from the
  old list/unpublish.
- **`get_app({ id })`** — read-only inspection of panel definitions + last-run
  stamps.

The agent already develops and eyeball-validates SQL in-session with `run_query`;
`publish_app` promotes those exact validated queries to live bindings. (The app's
title can also be renamed in place from the app detail page — author or
admin, no agent round-trip.)

## Reliable rendering (the agent publishes blind)

The agent never sees the rendered pixels, so hand-rolled SVG/CSS repeatedly broke
the same ways — an inline `<span>` ignores `width`/`height` (blank bars), and
SQL numerics can arrive as **strings** so chart math silently NaNs to zero. Two
mitigations:

- **Tested chart helpers** (`lib/app-runtime.ts`) are injected into every frame as
  `window.Setoku.*`: `bar`, `table`, `stat`, `line` (plus `state` and `setParam`,
  above). They
  coerce numeric strings, size correctly (`display:block`), and render
  empty/error states — so the agent calls a known-good primitive instead of
  reinventing it. Covered by `test/app-runtime.test.ts` via a DOM stub. Custom
  HTML stays the escape hatch; raw data is still at
  `window.__SETOKU__.panels[key]`.
- **Publish-time render lint** (`lintAppTemplate`) returns non-blocking warnings
  on `publish_app` / `update_app`: a panel that's never referenced, a `panels.X`
  reference to a key that doesn't exist, and a `<span>` sized without `display`
  (the exact blank-bar bug). The agent self-corrects without a render.

A visual **screenshot preview** (render the frame to a PNG the agent inspects) is
the deferred next step — it pairs with `update_app` for a see-then-fix loop.

## Why this stays inside the invariants

- **I1 (DBs never public).** The browser only ever receives JSON the gateway
  produced; SQL and credentials stay server-side. The frame's strict CSP
  (`default-src 'none'`) means even the agent's template can't reach the network.
  App state is a *separate* gateway-owned store — there is no code path from it to
  a business source, so an app can read company data but never write it.
- **I8 (no server-side inference).** Refresh re-runs saved SQL — zero LLM.
- **I2 / I9 (the membrane).** An app is a *publish* artifact, not a
  curated-knowledge write: it never touches `upsert_context` /
  `resolve_correction`, so the write-membrane is untouched. Per-app state writes
  cross no membrane either (state is neither the lake nor curated knowledge), so
  they need no per-write human gate. Team apps expose nothing beyond what the
  viewer's own token already grants. The one escalation risk — an injection-driven
  **public** exfil — is closed by reusing the report rule verbatim: **the agent
  can only publish team-only; flipping to public is a human click in the web console**
  (the agent holds no web session).
- **Renders run under the gateway role, not a session.** Panel re-execution
  carries no `denyLakeRead` — the membrane is enforced at *authorship* (a curator
  session can't publish a lake-backed panel), not at render. So a public
  lake-backed app does stream fresh lake rows to anyone with the link, but that is
  the publisher's explicit, human-promoted choice — rendering involves no agent,
  so it can't couple write-capability with untrusted text (which is what I2/I9
  actually governs).
- **Security bonus.** Because data is injected, not fetched, the frame needs no
  network, so we serve it under `default-src 'none'; style-src 'unsafe-inline';
  script-src 'unsafe-inline'; img-src data:; form-action 'none'` + `sandbox
  allow-scripts allow-forms`. That closes the exfil-via-author-JS hole that
  today's *static* reports actually have (their inline JS can POST inline data to
  any host). Live apps end up **safer** than the reports they replace.

## Out of scope (v1)

- **Scheduled pre-warm cron.** The TTL cache refreshes lazily on view; an
  `app-refresh` cron (mirroring `curate-cron.sh`) is a later optimization.
- **Drill-down / linked apps.** Viewer params (above) cover filtering; navigating
  *between* apps or into a row's detail is a later step.

(Viewer interactivity via bound params — listed here through v0.19 — **shipped**
in v0.20: see *Viewer params* above.)
