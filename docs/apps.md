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
  format,          -- 'app' (renders via the runtime path) | 'file' (a shared file, see Files) | 'html' (legacy frozen report)
  body,            -- the agent-authored template (fragment for apps; '' for a file)
  panels,          -- JSON: [{ key, title?, sql, dialect, metricId? }]  (NULL/[] for a state-only app)
  params,          -- JSON: [{ name, type, default, … }]  declared interactive inputs (NULL for none)
  refresh_seconds, -- TTL for cached panel data (default 300, min 30)
  visibility,      -- 'team' (default) | 'public'  — promotion is a human action
  password_hash,   -- argon2id; NULL = the public link alone opens it
  created_by, created_at, archived_at
)

app_cache(app_id, panel_key, columns, rows, row_count, computed_at, error)
  PRIMARY KEY (app_id, panel_key)   -- panel_key folds in the param variant; capped per app

app_access(token, app_id, expires, created_at)   -- one live unlock of a protected link

-- files.db (its own SQLite file, like apps.db — see Files below)
published_files(published_id, name, mime, size, sha256, bytes, uploaded_by, uploaded_at)
  PRIMARY KEY (published_id, name)   -- attachments on an app, or THE file of a 'file' row
file_uploads(nonce, published_id, app_id, name, mime, title, created_by, model, expires, created_at)
  -- a minted-but-unfulfilled upload URL; the published row does not exist yet
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
| **Public + password** | same, behind the gate at `GET /p/<id>` → `POST /p/<id>/unlock` | | | |
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

## Password-protected public links

A public link is credential-free by design — that is right for a channel, and
wrong for a customer or a board. So an admin can put **one shared password** in
front of a public app (`published.password_hash`, argon2id via `Bun.password`;
the plaintext never touches disk or a log).

- `GET /p/<id>` on a protected app serves a **gate page** instead of the shell: a
  title, one password field, no JavaScript at all (its CSP has no `script-src`,
  and `form-action 'self'`). The app's title is the only thing about it that
  shows before the password.
- The gate is checked **ahead of every sub-path**, so `/frame`, `/data` and
  `/state` all 401 without a grant — the gate is not merely on the shell.
- `POST /p/<id>/unlock` (form-encoded, POST only so the password never rides in
  a URL) verifies and, on a match, mints an opaque grant in `app_access` bound to
  that one app, handed back as an `HttpOnly`, path-scoped (`/p/<id>`),
  `SameSite=Lax` cookie for 7 days. Lax, not Strict: these links are opened from
  Slack and email, and a Strict cookie would be withheld on that navigation and
  re-prompt every time.
- The grant is **server-side, not a signed cookie**, so changing or clearing the
  password (or pulling the app back to team-only, or archiving it) revokes every
  outstanding one on the next request.
- Attempts are rate-limited per (app, **client**), 10 burst then ~3/min, on top
  of argon2id's own cost, and a token is refunded on a correct password, so the
  brake only bites guessing. Per client, not per app: `POST /p/<id>/unlock` is a
  CORS-simple request, so a per-app bucket could be held empty from anywhere and
  nobody with the right password would ever get in. The client is the last
  `X-Forwarded-For` hop (the one Caddy appended, so not viewer-supplied). The
  total work one app can be made to do is bounded instead by a concurrency gate:
  at most 2 verifications at once (each argon2id pass holds ~64MB, a memory
  spike on a small box), a short queue behind it, load shed past that. Shedding
  clears the moment the flood pauses, so it can't hold anyone out.
- Rejected attempts are audited at most once per app per minute, carrying how
  many they stand for: the audit table has no retention and this path is
  anonymous and floodable.
- Protected pages are served `Cache-Control: no-store`.

**It is a viewing gate, not an identity.** There is no account, no per-person
audit trail, and everyone with the link shares one word. Unlocking grants exactly
what the open public link already granted — the rendered app — never a session,
never a tool, never a write. It sits entirely outside the membrane and cannot
grant authority (I9).

Who may change it: **setting or changing** a password only narrows access, so the
app's author may do it (as may an admin). **Removing** one widens the link to
everyone who has it — the same exposure as promoting to public — so it takes the
same admin bar. A password **survives** a `public → team → public` round trip on
purpose: re-publishing must not silently drop the gate the link had last time.

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
  hidden?: boolean;                   // render NO visible control; drive it via Setoku.setParam
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

When an in-frame widget *owns* a param end-to-end (an autocomplete that IS the
input), declare that param `hidden: true`: the shell renders no visible control
for it — so the toolbar doesn't show a redundant second box next to the widget —
but it still binds and stays fully drivable by `setParam`. On the public shell a
hidden param is emitted as a `type="hidden"` input (keeping its `data-pname` in the
DOM so the reload/echo/`setParam` plumbing still finds it); on the team shell the
control bar simply skips it (and renders nothing at all if every param is hidden).

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
  `panels` / `params` each replace the whole set (re-validated + dry-run). The edit
  lands on the app's existing link: a public app stays public (and keeps any shared
  password), so the change is live for everyone holding that link — see "Editing a
  public app" below.
- **`list_apps()`** / **`unpublish_app({ id })`** — list and archive. Archiving
  is **author-only** (like `update_app`); an admin archives anything from the
  app's page.
- **`get_app({ id })`** — read-only inspection of panel definitions + last-run
  stamps (and, for a file, its metadata: never the bytes).
- **`publish_file({ name, title?, content?, encoding?, appId? })`** — share a
  file (see *Files* below). Team-only like an app; `appId` attaches it to an app
  you authored, or replaces a file you shared before.

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
- **Editing a public app does not re-gate it.** An `update_app` that changes
  panels or params on a public app used to drop it back to team-only until an
  admin re-approved the link. In practice that fired on every ordinary iteration
  of an app whose whole point was to be public: the link went dark mid-session,
  and the human clicking it back was re-approving their own edit, one they had
  just asked for. The gate now sits where I9 actually puts it — on **promotion**,
  which no agent can perform — and an edit rides on the link the human already
  blessed. The residual risk is real and named: an injection-driven `update_app`
  on an already-public app can change what that link exposes without a further
  click. What still stands against it: only the app's **author** can edit it, and
  panels run under that creator's source grants, so an edit can never expose more
  than its author may already read (per-source denies still bite); every edit is
  audited with a `public` marker saying the change landed on a live link
  (`update_app` and the web restore alike); each edit appends a version snapshot a
  human can restore; the team's activity notification announces agent edits on
  boxes that have a notify webhook configured; and locking an app freezes it
  against agent edits entirely.
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

## Files — share anything, not just apps

Not every result is an app. A CSV Claude computed locally, a markdown memo, a
chart PNG, a PDF, a spreadsheet: none of those can come from a panel (a panel is
SQL the box runs), so `publish_file` is the second kind of published thing.
**One concept, two formats:** a `published` row is `format='app'` (it *runs*)
or `format='file'` (it is *viewed or downloaded*), and either may carry attached
files. A standalone shared file is a `file` row with exactly one attachment.
Because it keys on `published.id`, a file gets everything an app has for free:
the share id, team/public visibility, the shared password, lock, archive,
rename, the audit log, the Slack notice, the admin list and detail page.

**Getting the bytes onto the box.** Two paths, one tool. Small content the
model just produced rides inline (`content`, ≤ 1 MB, base64 for binary).
Anything already on disk goes over HTTP: with `content` omitted the tool mints
a one-time, ten-minute `PUT /u/<nonce>` URL and returns the exact `curl -T`
line. This is load-bearing, not a nicety: a model re-emitting a 500 KB CSV
through a tool call is ~150k output tokens. The nonce is the credential (no
bearer token in a shell line), and the `published` row is created only when
the bytes land, so nothing (list, admin, Slack, `/p`) ever sees a half-published
file.

**Storage.** `files.db`, a sibling of `apps.db`, bytes as BLOBs. Kept out of
`knowledge.db` so the nightly `VACUUM INTO` snapshot of curated knowledge stays
small; `deploy/backup/backup.sh` snapshots all three files (I4). Caps: 1 MB
inline, 50 MB per upload, 20 files / 200 MB per record, and a box-wide total
(2 GB, `SETOKU_FILES_MAX_BYTES`). Files are **not versioned**: the revision
snapshot diffs title/body/panels/params, so replacing a file's bytes appends no
version and revert never touches files; the audit log and `uploadedAt` record
the replacement.

**Serving.** `GET /p/<id>/files/<name>` (public: same visibility and password
gate as the frame, per-record download budget) and `GET /admin/files/<id>/<name>`
(team: session-gated; it lives under `/admin/` because the SPA owns every
`/apps/*` path). Every response: the mime from **our** allowlist by extension
(the client never supplies one), `X-Content-Type-Options: nosniff`,
`Content-Disposition: attachment` unless the type is inert (images, PDF, plain
text, CSV, JSON, markdown), `Content-Security-Policy: default-src 'none'; sandbox`
(PDF drops `sandbox`, or Chrome's viewer won't render), `Cross-Origin-Resource-Policy:
same-origin`, a strong ETag (the sha256) with 304. `.html`/`.js` are refused at
publish (that's an app); `.svg`/`.xml` are stored but only ever downloaded.
Untrusted bytes never execute on the box origin.

**Viewing.** A `file` row renders through the **same sandboxed frame** an app
uses (`frameDocument` + the `Setoku.*` runtime), so neither the public shell nor
the SPA needs a second frame URL. CSV/TSV/JSON parse server-side into a synthetic
`file` panel that `Setoku.table` renders; markdown renders via a small built-in
subset (every character escaped first); text shows as `<pre>`; an image inlines
as a `data:` URI (the frame CSP allows `img-src data:`); PDF and everything else
are a download card whose link opens a top-level tab. **The frame never fetches
files**: its origin is opaque (no session cookie) and its CSP is `default-src
'none'`. Attachments on an app are listed by the trusted shell under the frame
as download links — for people, not for the template. Data an app renders still
comes from panels.

**Not knowledge.** Files are evidence and output, not context. They are never
indexed into `find_context` or the embedding store. Why: an analyst session
(which reads untrusted lake text) could otherwise write a memo every other
session retrieves as truth, a path around the corrections queue (I2); a CSV is
data with no query path (making it one means "CSV as a lake table", a separate
project needing a writer credential the gateway deliberately lacks, I9); and
knowledge is durable meaning while an analysis memo is point-in-time and goes
stale. What a file *means* is captured by `report_correction` and a human
approval, as today. Flipping a file public stays an admin click in `/admin`.

**Later.** A panel that binds to an attached file instead of SQL
(`{ key, file: "data.csv" }`), parsed at render time into columns/rows and
cached in `app_cache` — file-backed data through the existing injection path
with no CSP change. That is what makes "Claude did the analysis locally, now
build a dashboard on it" work.

## Out of scope (v1)

- **Scheduled pre-warm cron.** The TTL cache refreshes lazily on view; an
  `app-refresh` cron (mirroring `curate-cron.sh`) is a later optimization.
- **Drill-down / linked apps.** Viewer params (above) cover filtering; navigating
  *between* apps or into a row's detail is a later step.

(Viewer interactivity via bound params — listed here through v0.19 — **shipped**
in v0.20: see *Viewer params* above.)
