# Knowledge conventions (the wiki's "schema layer")

**Status:** built on `experiment/llm-wiki`. This is the document Karpathy's LLM-wiki
pattern calls the *schema*: the config that defines how the wiki is organized so an
agent maintaining it keeps the structure consistent instead of reinventing it every
run. `/setoku:generate` and `/setoku:curate` should follow these rules; the
`/knowledge` browser and the lint in `lib/facts.ts` assume them.

It is **conventions, not enforcement**. Nothing here is a new authority path —
knowledge still lands as proposals and a human commits (I2/I9). These rules make
the proposals consistent.

## Doc types (the only five)

| type | one per | holds |
| --- | --- | --- |
| `overview` | store | the map: what the business is, the top entities/metrics, links out to them. The wiki's `index.md` — the hub everything connects from. |
| `entity` | table / domain object | what a row means, its key columns, soft-delete/status semantics, how it joins. |
| `metric` | business metric | the canonical definition **and the exact SQL**. If a metric exists, its SQL is the answer — don't reinvent it. |
| `query` | reusable pattern | a known-good multi-step query (e.g. identity resolution) worth reusing verbatim. |
| `gotcha` | one rule | a single sentence that prevents a wrong answer (a `relates_to` ties it to its entity/metric). |

Don't invent new types. If something doesn't fit, it's usually a `gotcha` on an
existing subject or a section in an existing doc.

## Naming

- **entity** — the domain name as it reads in the business (`Customer`, `Order`,
  `TicketingAccount`), matching the code's model name where one exists. Set
  `meta.table` to the real table so retrieval and joins resolve.
- **metric** — `snake_case` noun phrase a person would say (`active_customers`,
  `net_revenue`, `season_renewal_rate`). A metric is canonical in exactly one
  dialect (I5): set `meta.dialect` (`postgres` default | `clickhouse`) so
  `run_query` routing and knowledge-lint execute the SQL against the engine it
  was written for. On boxes with the biz.* business-DB mirror, metrics over
  mirrored tables are `clickhouse`.
- **gotcha** — a short kebab slug naming the rule (`refunds-excluded`,
  `money-is-cents`, `soft-delete`), not a sentence.
- Names are the retrieval key and the link target — keep them stable. Renaming a
  doc orphans its inbound links until they're repointed.
- **Name + `keywords` are the heaviest-weighted retrieval fields** (+6 / +4 vs +2
  for summary, +≤3 for body), so put the words a person would actually ask into
  them. See [llm-wiki.md → How a query ranks](llm-wiki.md).

## When to make a new doc vs. extend one

- A new **subject** (a distinct entity/metric/pattern) → new doc.
- A new fact **about an existing subject** → extend that doc (or add a `gotcha`
  with `relates_to`), don't create a near-duplicate. Two docs that say the same
  thing show up as a **merge** candidate in lint; that's the smell.
- One concise claim per fact. Reasoning/evidence goes in `context` (corrections)
  or commentary, never into the stored claim (see [knowledge-facts.md](knowledge-facts.md)).

## Linking (the interlink layer)

Links live in `meta.links` — an array of target **doc names**. A gotcha's
`relates_to` counts as a link automatically. See [llm-wiki.md](llm-wiki.md).

Link generously; the graph is what makes retrieval and navigation work:
- **metric → the entities its SQL reads** and **the gotchas that constrain it**
  (`net_revenue` → `revenue`, `refunds-excluded`).
- **entity → entities it joins to** (`Order` → `Customer`) and its gotchas.
- **overview → the top entities and metrics** (it's the hub).
- A new doc should link to its obvious neighbors *as it's written* — that's the
  "ingest reconciles neighbors" discipline. Note the curated-write path
  (`upsert_context`) rejects a save whose links don't resolve to an existing
  doc, so save link *targets* before the docs that point at them (overview
  last), or add the link when the target lands.

Lint will flag the failures of this convention:
- **orphan** — a canonical doc with no link in or out (connect it to the graph).
- **suggested connection** — two docs that clearly overlap but aren't linked
  (add the link).
- **broken link** — a `meta.links` entry pointing at a name that doesn't exist
  (fix the name or create the doc).

## Keep docs concise

A doc whose body runs long (lint flags it **verbose**) is usually carrying
commentary that belongs elsewhere, or two subjects that should split. The concise
claim is what retrieval surfaces and what an answer quotes; the rest is drill-in.

## The loop these conventions serve

ingest (generate / report_correction) → query (find_context, map-first) → lint
(orphans, connections, contradictions, duplicates, verbose, stale) → a human
curates. Following the conventions keeps every stage cheap: consistent names make
retrieval hit, generous links make map-first work, one-claim docs keep lint quiet.
