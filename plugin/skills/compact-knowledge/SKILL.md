---
name: compact-knowledge
description: Periodically tidy the Setoku knowledge store in a curator session — merge duplicate facts, resolve contradictions, tighten verbose docs, and flag stale knowledge. Use when the user asks to compact / clean up / dedupe / tidy knowledge, or when /admin/knowledge shows merge / contradiction / verbose flags.
---

# Setoku compaction ("REM sleep")

The periodic pass that keeps the knowledge store from drifting into the verbose,
duplicated, contradictory mess it tends toward as facts accumulate. The
`/admin/knowledge` health bar only **detects** signals (cheap, deterministic);
this workflow actually **does** the work — you read the knowledge, judge it, and
commit the cleanup. All the judgment happens **right here in this session** — no
server-side inference (I8). You are the compactor; the heuristics are just a map.

> **Requires the curator connector.** Compaction commits curated knowledge
> (`upsert_context`, and `resolve_correction` for pending), so it needs a
> **curator token** (the `<name>-setoku-curator` connector — the box's connector
> name plus `-curator`), not an everyday analyst token. If those tools aren't in
> your toolset, you're propose-only — reconnect via `<name>-setoku-curator`. The
> curator token is lake-blind (it can't ingest
> untrusted bulk text), which is what keeps the I2/I9 membrane intact. The human
> curator stays in the loop: confirm before you commit.

## What compaction does (priority order)

1. **Merge duplicates** — facts that say the same thing (a metric defined twice,
   one gotcha worded three ways). Combine into one canonical doc; fold or delete
   the rest. Keep every distinct detail and the strongest provenance.
2. **Resolve contradictions** — facts that genuinely conflict ("revenue excludes
   refunds" vs "includes refunds"; "÷100" vs "÷1000"). Decide which is right —
   **check the data with `run_query` when you can**, otherwise **ask the human**.
   Never guess. Keep the correct fact; fix or drop the wrong one.
3. **Tighten verbose docs** — a doc whose body buries the fact under commentary.
   Rewrite to the concise claim, keeping essential detail (canonical SQL, joins,
   `file:line` sources). Store the fact, not the essay.
4. **Fix organization / flag stale** — split a multi-claim doc into separate
   facts; add a missing `relates_to`/subject; flag a fact whose `file:line`
   source no longer exists for the human to confirm before removal.

## Process

1. **Survey.** `list_entities` for the index; read docs (`describe_entity` /
   `get_metric`) and the pending queue (`list_corrections`). The
   `/admin/knowledge` health counts (contradictions / duplicates / verbose /
   stale) are a quick starting map — but find the real work by reading, because
   you judge the semantics the heuristics can't.
2. **Cluster by subject.** Group everything about each entity/metric together —
   that's where duplicates and contradictions hide.
3. **Work each cluster, conversationally.** For each finding:
   - Show it plainly — the duplicate set, the conflict, or the verbose doc.
   - For a contradiction: state both sides, your evidence (a `run_query` check, a
     `file:line`), and your call — or ask if you genuinely can't tell.
   - Propose the concrete change (the merged fact, the tightened body, the
     resolution). Default to **confirm before committing** a batch.
4. **Apply** via `upsert_context` (merged / tightened docs), deleting superseded
   docs, and `resolve_correction` for any pending proposal you fold in or reject.
   Carry provenance and attribution forward.
5. **Summarize** — what merged, what conflicts resolved (and how), what
   tightened, what flagged stale.

## Boundaries

- **Never fabricate a contradiction resolution.** If the data and the code don't
  tell you which fact is right, ask — don't pick.
- **Don't delete knowledge without confirmation.** Merges and removals are the
  curator's call; you propose, they decide.
- **Preserve provenance.** Carry `file:line` sources and attribution into merged
  or rewritten docs.
- There is no auto-apply: compaction commits only through the curator membrane,
  with a human in the loop (I9).
