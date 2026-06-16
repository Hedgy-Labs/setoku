---
name: generate
description: Generate or refresh Setoku's business-context knowledge by reading this repository's code — ORM schemas, business logic, migrations, existing docs — and saving it to the knowledge store (commits directly on a curator connector, or proposes for human approval on the everyday analyst connector — no SSH needed). Use when the user asks to generate/update/refresh business context, when setoku tools report an empty knowledge store, or when schema drift is detected.
---

# Setoku context generation

You are deriving the business's **verified context** from its codebase and saving it into the gateway's knowledge store. The code is the source of truth for business semantics; your job is to compress it into compact, retrievable docs **grounded in `file:line` references** so a human can verify every claim. Accuracy beats coverage: a wrong annotation is worse than a missing one.

> **Two ways to save — use whichever connector you're on; generation never requires SSH.**
> - **Analyst connector (the default, propose-only):** save each doc as a `report_correction` (`kind` = the doc type, `fact` = the concise claim, `context` = supporting detail/evidence, `relates_to` = the entity/metric name — always set it). They land in **Pending** for a human to approve at `/admin` — a perfect first-run path. (On approval, gotchas fold into the store automatically; entities/metrics are shaped into structured docs in a later curator pass.)
> - **Curator connector (optional, commits directly):** if `upsert_context` is available you're on a curator token — save structured docs directly with it. Generation is a deliberate session reading the **repo's own code** (trusted, unlike runtime lake/Slack data), and the curator token is lake-blind, so it structurally can't ingest untrusted bulk text (the I2/I9 membrane). Never run generation in a session that is also analyzing untrusted data.
>
> **Detect the mode:** if `upsert_context` is in your tools → curator; otherwise → analyst (use `report_correction`). Don't send the human to SSH for a curator token just to generate — proposing on the analyst connector gets real context into the store today.

## What to read (adapt to the stack — nothing here is framework-specific)

1. **Schema source:** Prisma (`*.prisma`), ActiveRecord (`db/schema.rb`), Django models, SQLAlchemy, dbt (`models/*.yml`), raw migrations — whatever defines tables. No codebase? Use `get_schema` + the platform's standard semantics (e.g. Shopify/HubSpot schemas) + an interview with the user.
2. **Business logic:** where eligibility/status/billing/lifecycle rules live (search for the table names; follow billing, "active", "paying", "eligible", soft-delete patterns).
3. **Existing knowledge:** README/docs, code comments, pending corrections (`list_corrections`), any team memory/notes the user points at.
4. **Live schema:** call `get_schema` to cross-check that what the code says matches the database; note mismatches for the user rather than guessing which is right.

## Doc types and content

Save each via `upsert_context` (curator) **or** `report_correction` (analyst — set
`kind` to the doc type below, `fact` to the concise claim, `context` to the
supporting detail, and `relates_to` to the entity/metric name).
The structure below is the *content* to produce either way.

**entity** — one per business-relevant table (skip pure join/system tables). `meta`: `table` (qualified, e.g. `public.orders`), `summary` (one line), `keywords` (synonyms users say). Body sections:

```markdown
## Semantics

What a row means; lifecycle/status values and what each implies; soft-delete convention.

## Joins

customer_id → public.customers.id (the buyer). One order : many order_items.

## Watch out

- status='refunded' rows must be excluded from revenue (src/billing/refunds.ts:42)

## Sources

- prisma/schema.prisma:120 (model definition)
```

**metric** — canonical business numbers. `meta`: `summary`, `keywords`. Body: `## Definition` (prose), `## Canonical SQL` (fenced sql block — the exact production logic), `## Caveats`, `## Sources` (file:line).

**query** — known-good SQL for a recurring question. `meta`: `question`, `keywords`. Body: fenced sql.

**gotcha** — one-liner traps, each self-contained with its source. `name` = short slug, `body` = the line, e.g. `Customers with deleted_at set are soft-deleted — exclude from all counts (src/models/customer.ts:12)`.

**overview** — 10–20 lines: what the business does, core objects, money flow.

## Process

1. Inventory the schema source; list candidate entities; confirm scope with the user if the table count is large (document business tables; skip framework/system tables).
2. Save entity docs — `upsert_context` (curator) or `report_correction` (analyst), batched sensibly. Every non-obvious claim gets a `file:line` source. Don't pad: if a table is self-explanatory, 5 lines is fine.
3. Hunt metrics: find how the business _actually_ computes its key numbers in code, and encode them with exact SQL (verify each runs via `run_query` before saving).
4. Hunt gotchas: soft deletes, magic enum values, null-means-something columns, double-counting traps, timezone issues. These are the highest-value docs in the store.
5. Fold in pending corrections (`list_corrections`) — curator only: apply via `upsert_context` → `resolve_correction` accepted. (On analyst, leave them; they're already pending for the human.)
6. Cross-check with `get_schema`; list any code↔DB drift.
7. **Review with the user** — summarize what you saved/proposed (`list_entities`, `list_corrections`) and where you were least confident. On analyst, point them to `/admin` to approve the pending proposals.

## Refresh mode (knowledge already exists)

Diff-driven: identify which entities/metrics are affected by recent code changes (`git diff`, migrations since last refresh) and re-save only those docs (`upsert_context` on curator, or `report_correction` on analyst). Never silently rewrite verified content a curator shaped — call out anything you changed (revisions are recorded automatically).
