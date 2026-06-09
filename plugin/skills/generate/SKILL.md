---
name: generate
description: Generate or refresh the Setoku context artifact (.setoku/context/) by reading this repository's code — ORM schemas, business logic, migrations, existing docs. Use when the user asks to generate/update/refresh business context, when setoku tools report a missing artifact, or when schema drift is detected.
---

# Setoku context generation

You are deriving the business's **verified context artifact** from its codebase. The code is the source of truth for business semantics; your job is to compress it into compact, retrievable docs **grounded in `file:line` references** so a human can verify every claim. Accuracy beats coverage: a wrong annotation is worse than a missing one.

## What to read (adapt to the stack — nothing here is framework-specific)

1. **Schema source:** Prisma (`*.prisma`), ActiveRecord (`db/schema.rb`), Django models, SQLAlchemy, dbt (`models/*.yml`), raw migrations — whatever defines tables.
2. **Business logic:** where eligibility/status/billing/lifecycle rules live (search for the table names; follow billing, "active", "paying", "eligible", soft-delete patterns).
3. **Existing knowledge:** README/docs, code comments, `.setoku/corrections.jsonl` (fold accepted corrections in), any team memory/notes files the user points at.
4. **Live schema:** call `get_schema` to cross-check that what the code says matches the database; note mismatches for the user rather than guessing which is right.

## Artifact format (write exactly this structure)

All files in `.setoku/context/`. Frontmatter is simple `key: value` (inline `[a, b]` arrays allowed).

```
.setoku/context/
  overview.md            # 10–20 lines: what the business does, core objects, money flow
  entities/<Name>.md     # one per business-relevant table (skip pure join/system tables)
  metrics/<slug>.md      # canonical metric definitions WITH exact SQL
  queries/<slug>.md      # known-good SQL for common questions
  gotchas.md             # flat bullet list of non-obvious traps
```

**entities/Order.md:**

```markdown
---
name: Order
table: public.orders
summary: A customer purchase; the grain of revenue.
keywords: [purchase, sale, revenue, checkout]
---

## Semantics

What a row means, lifecycle/status values and what each implies, soft-delete convention.

## Joins

customer_id → public.customers.id (the buyer). One order : many order_items.

## Watch out

- status='refunded' rows must be excluded from revenue (src/billing/refunds.ts:42)

## Sources

- prisma/schema.prisma:120 (model definition)
- src/billing/charge.ts:88 (status transitions)
```

**metrics/revenue.md:**

````markdown
---
name: revenue
summary: Recognized revenue — paid orders net of refunds.
keywords: [sales, income, mrr, gmv]
---

## Definition

Sum of order totals where status = 'paid'. Refunded orders excluded entirely (not netted).

## Canonical SQL

```sql
SELECT date_trunc('month', o.created_at) AS month, SUM(o.total_cents)/100.0 AS revenue
FROM orders o
WHERE o.status = 'paid'
GROUP BY 1 ORDER BY 1;
```

## Caveats

- total_cents is integer cents (src/models/order.ts:31)

## Sources

- src/billing/reports.ts:14 (the production revenue query)
````

**gotchas.md:** flat bullets, each self-contained with its source:

```markdown
- Customers with deleted_at set are soft-deleted — exclude from all counts unless asked (src/models/customer.ts:12)
- orders.status 'pending_review' counts as paid for revenue but NOT for fulfillment metrics (src/billing/recognize.ts:77)
```

## Process

1. Inventory the schema source; list candidate entities; confirm scope with the user if the table count is large (document business tables; skip framework/system tables).
2. Write entity docs (batch sensibly). Every non-obvious claim gets a `file:line` source. Don't pad: if a table is self-explanatory, 5 lines is fine.
3. Hunt metrics: find how the business _actually_ computes its key numbers in code, and encode them with exact SQL.
4. Hunt gotchas: soft deletes, magic enum values, null-means-something columns, double-counting traps, timezone issues. These are the highest-value lines in the artifact.
5. Fold in `.setoku/corrections.jsonl` entries (then tell the user which were applied so they can clear them).
6. Cross-check with `get_schema`; list any code↔DB drift.
7. **Review with the user** — show a summary of what you wrote and where you were least confident. Then remind them to commit `.setoku/`.

## Refresh mode (artifact already exists)

Diff-driven: identify which entities/metrics are affected by recent code changes (`git diff`, migrations since the artifact was last touched) and update only those docs. Never silently rewrite verified content the user curated — call out anything you changed.
