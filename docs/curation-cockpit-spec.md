<!-- SPDX-License-Identifier: Apache-2.0 -->
# Curation workflow: cockpit, auto-draft, pre-filter, maintenance

Spec for making the **curator role coherent and low-friction**. Self-contained —
implement from this without the originating conversation.

## Problem

The curator's recurring job — tending the pending-corrections inbox — is
underbuilt and confusing:

- **Accepting a non-gotcha correction does nothing to the knowledge.**
  `applyApprovalAction` (`lib/approval.ts`) only folds `kind === "gotcha"` into a
  curated doc on accept; for metric/entity/other kinds it just flips the queue
  status and tells you "shape it into a doc in a curator session." So the human
  accepts, then has to *separately* `upsert_context` the real edit. That gap is
  the friction.
- Three surfaces (curator MCP connector, skills, `/admin`) with no obvious "home."
- A pending correction is a raw note, not a ready change — encoding it into a doc
  edit is mental work done at approval time.

**Design principle:** automate the *drafting* (no security cost — a draft grants
no authority); keep the *blessing* a password-gated human click. Make that click a
one-line review of a finished change.

## Security invariants this MUST preserve (verified against the code)

The membrane (I2/I9) is structural, and these facts are load-bearing:

- **Analyst** session (reads untrusted lake/logs) holds **no** write/accept tool —
  only `report_correction` (lands pending, inert).
- **Curator** session holds `upsert_context` (real curated write) + `resolve_correction`
  but is **`denyLakeRead`** — the session with the write tool cannot read the
  untrusted source where injection lives.
- `resolve_correction` = **queue status only** (`UPDATE corrections SET status`),
  grants zero knowledge authority.
- **Accept = `applyApprovalAction` on `/admin`, gated by username+password** (a
  local account, NOT the MCP bearer token). An injected agent holds its token but
  never the human's password, so it cannot self-approve. This is the airtight bless.
- **Rules that fall out, and must hold for everything below:**
  1. **Drafting is free** — produce/store a draft, never commit. Drafts grant no authority.
  2. **Committing untrusted-derived content stays the password-gated human click.** Never auto-commit it.
  3. **Auto-reject is safe** (removes from queue, never grants authority); auto-accept is not.
  4. Capabilities are partitioned by **grant vs remove** authority and enforced at the **capability** level, never by instruction.
  5. The **curator MCP write** (`upsert_context`) is safe only for **trusted-source** content (generate from the company's own code/schema). Untrusted-derived promotion goes through `/admin`.

## Existing data model

- `corrections(id, ts, user, kind, content, fact, relates_to, status, resolved_by, resolved_ts)`.
  Kinds include `gotcha` and others. `fact` = the concise claim; `content` = supporting context.
- `docs(type, name, meta, body, verified, updated_by, updated_at)` + append-only revisions + audit log.
- `applyApprovalAction(store, identity, {id, action, reason})` → `resolveCorrection` + (gotcha only) `upsertDoc`.
- `/admin/api/*` is session-cookie gated (username+password login), mutations carry a CSRF header; routes live in `http.ts`.

---

## A. `/admin` curation cockpit  (piece #1 — the hub, highest UX win)

Turn each pending correction into a one-click, ready-to-approve change.

**Per pending item, show:**
- the raw proposal (`user`, `kind`, `content`, `fact`, `relates_to`, `ts`);
- a **drafted doc-edit** — the exact `upsert` payload `{type, name, body, meta}` that
  approving would commit (from piece B; for gotchas the existing fold IS the draft);
- **flags**: `dupe` (matches an existing doc name/keywords), `contradiction`
  (conflicts an existing doc), `lint` (drafted SQL runs + value sane), `provenance`
  (`proposed_by`, untrusted-derived?);
- **actions: Approve / Edit / Reject** (Edit = tweak the drafted body/meta, then approve).

**Changes:**
1. **Generalize `applyApprovalAction`**: on `accepted`, `upsertDoc` the **drafted**
   doc `{type,name,body,meta}` for **all kinds**, not just gotchas. If the request
   carries an edited draft, commit that. Keep session+password+CSRF gating. This is
   the change that closes the "accept does nothing for non-gotchas" gap.
2. **Persist the draft + flags** alongside the correction (see Data model changes).
   Advisory only — not authority.
3. **API** (`/admin/api`, session-gated):
   - `GET corrections` → pending list **including** `draft` and `flags`.
   - `POST approve` body `{id, action: "accepted"|"rejected", draft?: {type,name,body,meta}, reason?}`
     → `applyApprovalAction(store, identity, {id, action, draft, reason})`. CSRF required.
4. **SPA** (`web/app/`): a Pending view rendering each item as a review card —
   proposal, the drafted change (rendered, editable), flags as badges, Approve/Edit/Reject.
   Rebuild `app.css`/`dist/app.js` artifacts (`bun run build:admin`).

## B. Auto-draft job  (piece #2 — fills the drafts)

A **curator-Claude** run (scheduled or via `/setoku:curate`) that, per *undrafted*
pending correction:
- reads the correction + related doc (`get_metric`/`describe_entity`) + `get_schema`;
- produces the drafted `upsert` payload (add a gotcha bullet, edit a metric's
  SQL/WHERE, edit an entity doc);
- runs the drafted SQL via `run_query` (lint) and records pass/fail + computed value;
- writes the **draft + flags** back onto the correction — **without committing knowledge**.

**Security:** it reads untrusted pending content + trusted sources, and writes only a
draft (no authority). It must hold a **draft-only** capability — NOT `upsert_context`,
NOT accept. Add `draft_correction(id, draft)` (writes draft/flags to the correction row;
touches no curated doc). Capability-enforced. The commit remains the human `/admin` click.

## C. Pre-filter / auto-reject janitor  (piece #3 — short, high-signal inbox)

New **reject-only** primitive (the one load-bearing auth addition):
- `reject_correction(id, reason)` — resolves a pending correction to `rejected` **only**.
  Capability-enforced (a reject-capable identity); never accept-capable. (Splitting
  reject out of the accept-or-reject space is the whole safety argument.)

A janitor run (curator-Claude or deterministic) auto-rejects pending items failing
**objective** checks only: drafted SQL errors, references a denied table, malformed,
contradicts a **trusted** source (re-derivation), exact dupe of existing curated
knowledge. **Escalate (leave pending) anything semantic/uncertain.**

**Safety:** reject removes from the queue, never grants authority. Scope = **pending
only** (never delete curated docs). Make rejects **soft + audited + reversible**:
record `rejected_by_bot` + reason, keep recoverable (un-reject in the cockpit), audit
each one — so an attacker using the janitor to *suppress* good proposals is detectable
and undoable.

## D. Maintenance cadence  (piece #5 — drift canary feeding the cockpit)

- **Generalize `knowledge-lint` to the LIVE store**: read `KnowledgeStore.listDocs()`
  (metric/query), pull canonical SQL, run read-only against the business DB, bounds-check.
  Works on any box (not just the demo repo files). Model-free (I8). Ship it as a
  `plugin/gateway` CLI.
- **Run it**: (a) last step of `scripts/deploy.sh` — **warn, do not gate**; (b) a
  scheduled canary (cron, `deploy/monitor/`). On failure it **files a pending
  correction** ("metric X SQL errors: column `foo` missing") → appears in the cockpit
  → piece B drafts the fix → human approves. ("Heals up to the gate": detect
  deterministically → draft fix → human blesses.)
- **bounds-in-doc**: metric frontmatter may declare invariants (`expect: 0 < value <= 1`,
  `unit: cents`, `expect_nonempty`); the lint verifies the author's claim instead of a
  guessed heuristic (kills false positives).
- `/setoku:compact-knowledge` (existing) on a cadence for dedupe/contradiction/verbose, feeding
  flags into the cockpit.

---

## Data model changes

- `corrections` — add via the existing `ensureColumn` migration pattern (or a
  `correction_drafts` side table): `draft_type`, `draft_name`, `draft_body TEXT`,
  `draft_meta TEXT` (JSON), `flags TEXT` (JSON), `drafted_by`, `drafted_ts`,
  `rejected_by_bot INTEGER DEFAULT 0`, `reject_reason TEXT`.
- metric docs — optional `expect` / `unit` frontmatter for the lint.

## New capabilities (auth)

- `draft_correction(id, draft)` — draft-only; writes draft/flags; no curated write. (piece B)
- `reject_correction(id, reason)` — reject-only; pending status only; not accept-capable. (piece C)
- Accept stays `applyApprovalAction` on `/admin` (password). **Do NOT add an accept MCP tool.**
- The auto-draft/janitor Claude authenticates with a **draft/reject-only token**, never a
  curator (accept/upsert) token.
- Decide during impl: does `reject_correction` supersede `resolve_correction`, or coexist
  (it's harmless status today).

## Phasing (implementation order)

1. **Cockpit** — generalize `applyApprovalAction` to upsert the drafted doc for all
   kinds; `/admin` API returns draft+flags; SPA review cards with Approve/Edit/Reject.
   (Closes the non-gotcha gap; biggest win; works with hand-typed drafts before B exists.)
2. **`draft_correction` + auto-draft job** — fills drafts+flags so the cockpit shows
   finished changes.
3. **`reject_correction` + janitor** — objective auto-reject, soft/reversible/audited.
4. **Live-store `knowledge-lint`** + `deploy.sh` warn-hook + canary cron filing drift as
   pending corrections + bounds-in-doc.

## Test plan

- Cockpit: accept a metric correction → the metric doc actually changes (regression for the
  non-gotcha gap); fast suite + e2e.
- Draft/reject capabilities: a draft/reject-only token cannot `upsert_context` or accept
  (capability test). Auto-reject is reversible (un-reject restores pending).
- Lint: live-store version flags a deliberately-broken metric; passes clean store.
- Security: confirm no MCP path commits untrusted-derived knowledge without the `/admin`
  password (the membrane regression).

## Non-goals (explicitly skipped)

- **Notifications/digest** (skipped per request).
- **Auto-accept of untrusted-derived content** (forbidden — accept stays the human click).
