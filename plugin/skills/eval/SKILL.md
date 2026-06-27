---
name: eval
description: Run the Setoku golden-question eval for this repository and report a scorecard. Use when the user asks to eval/test setoku answer quality, or after significant context-artifact changes.
---

# Setoku eval

Run the repo's golden questions end-to-end through the normal retrieve-then-query path and score the results. This is how we measure whether the context artifact actually improves answers. All inference happens right here in this session — no harness, no API keys.

## Golden questions file

`.setoku/eval/questions.md` — one section per question:

```markdown
## Q: How much revenue did we make last month?

expect: a single number; must exclude refunded orders
expect_sql_includes: status = 'paid'
tolerance: exact

## Q: How many active customers do we have?

expect: number; soft-deleted customers excluded
tolerance: exact
```

`expect` is the rubric (plain language, checkable). Optional `expect_sql_includes` asserts the generated SQL contains a fragment (case-insensitive). `tolerance`: `exact` | `±N%` | `judgment`.

If the file doesn't exist, offer to create it: propose 5–10 questions from the artifact's metrics + gotchas (each gotcha should have at least one question that would expose ignoring it), confirm expected answers with the user (or compute them together and have the user verify), then write the file.

## Run protocol (per question, in order)

1. Answer the question **exactly as you would for a real question** (find_context → get_metric → SQL → run_query). Do not peek at the `expect` line until your answer is produced.
2. Then compare against the rubric: PASS / FAIL / PARTIAL, one line of reasoning.
3. On FAIL, diagnose the layer: retrieval miss (find_context didn't surface the right doc) / context gap (doc missing or wrong) / SQL error / rubric stale. Propose the fix; for context gaps, draft the `report_correction` call and make it.

## Scorecard (end of run)

| #   | Question | Result | Layer at fault | Fix |
| --- | -------- | ------ | -------------- | --- |

Summarize: pass rate, the dominant failure layer, and the top 1–2 artifact improvements that would raise the score. Offer to apply them via `/setoku:generate` (refresh mode).

## Structural quality metrics (the fact database itself — issue #10)

The golden-question run above scores the *answer*. To credit (or catch regressions in) changes to the **knowledge store's structure** — concise facts, compaction, auto-judgement — score the intermediate layers directly. These are **deterministic** (pure token/set math reusing the production retrieval scorer), so they need **no model and no API key** and run for free in CI (I8):

```bash
bun run eval:knowledge --spec <spec.json> [--db <knowledge.db>] [--gate]
```

The spec (see `test/fixtures/eval/knowledge.json` for the shape) carries frozen, representation-agnostic ground truth — questions and doc **names**, never internal ids, so the goldens survive a migration of the fact representation. Dimensions:

- **Retrieval** — `precision/recall@k`, hit rate, MRR against labeled `question → relevant doc names`. Catches retrieval misses and coverage gaps.
- **Redundancy** — near-duplicate doc pairs (Jaccard); the deterministic signal behind "merge repetitive facts".
- **Auto-judgement** — confusion matrix vs human-gold accept/reject labels. The headline is **false-accept rate** (FP/(FP+TN)): the I2/I9 number, since false-accepts are an agent waving bad knowledge past the human-click membrane.
- **Defect detection** — precision/recall of the compaction ("REM sleep") pass against **planted** contradictions/duplicates (ground truth you seeded).

`--gate` enforces threshold floors (`minHitRate`, `maxFalseAcceptRate`, …) and exits non-zero — wire it into CI alongside the fast suite.

**Cost split.** The structural metrics are free (deterministic, automatable in CI). The *fuzzy detectors that produce the labels* — does fact X contradict fact Y? did the auto-judge decide right? — run in **this session on the Max subscription** (no server-side inference, I8). Reserve those for interactive runs after a structural change; gate the deterministic metrics continuously.

## Compaction (the companion pass — issue #10)

Compaction ("REM sleep") — merging duplicate facts, resolving contradictions, tightening verbose docs — is judgment work, so it runs **in a curator session** via [`/setoku:compact-knowledge`](../compact-knowledge/SKILL.md), not as a server-side job (I8). The `/admin/knowledge` health bar surfaces the deterministic signals (contradictions / duplicates / verbose / stale counts) as a cheap map; the skill does the actual semantic cleanup and commits it through the curator membrane (I9). The metrics above are how you check that a compaction pass actually improved the store.
